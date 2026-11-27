import fs from 'fs';
import path from 'path';
import { StrictPgPool, StrictPgClient, withPgTransaction } from '../postgres';

export const MOA_MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '..', '..', '..', '..', '..',
  'packages', 'database-schemas', 'merchant-db', 'migrations',
  '002_merchant_onboarding_and_kyc.sql'
);

export type OnboardingMigrationConflictCode =
  | 'MISSING_S14A_PREREQUISITE'
  | 'INVALID_MERCHANT_IDENTITY'
  | 'INVALID_MERCHANT_COORDINATES'
  | 'CORRUPTED_ONBOARDING_APPROVAL'
  | 'DUPLICATE_REQUIREMENT_DEFINITION';

export interface OnboardingMigrationConflict {
  code: OnboardingMigrationConflictCode;
  merchantIds: string[];
  reason: string;
}

export interface OnboardingMigrationResult {
  applied: boolean;
  totalMerchantsScanned: number;
  alreadyMigratedProfiles: number;
  profilesCreated: number;
  legacyStoresClosed: number;
  ignoredLegacyIsVerifiedCount: number;
  requirementsActiveCount: number;
  decisions: string[];
}

export class MerchantOnboardingMigrationError extends Error {
  public readonly conflicts: OnboardingMigrationConflict[];

  constructor(conflicts: OnboardingMigrationConflict[]) {
    const summary = conflicts
      .map((c) => `[${c.code}] merchants=[${c.merchantIds.join(',')}]: ${c.reason}`)
      .join(' | ');
    super(`Merchant onboarding migration aborted safely due to ${conflicts.length} conflict(s): ${summary}`);
    this.name = 'MerchantOnboardingMigrationError';
    this.conflicts = conflicts;
    Object.setPrototypeOf(this, MerchantOnboardingMigrationError.prototype);
  }
}

export function loadMoaMigrationSql(): string {
  return fs.readFileSync(MOA_MIGRATION_SQL_PATH, 'utf8');
}

/**
 * Validates prerequisites and existing Merchant DB state, executes MO-A schema
 * migration `002_merchant_onboarding_and_kyc.sql`, initializes PENDING_SUBMISSION
 * onboarding profiles (never setting APPROVED or relying on `merchants.is_verified`),
 * closes unapproved legacy stores by default, records audit decisions, and rolls
 * back atomically on any conflict or ambiguity.
 */
export async function applyMoaMigration(
  merchantPool: StrictPgPool,
  options: { migrationSql?: string } = {}
): Promise<OnboardingMigrationResult> {
  const migrationSql = options.migrationSql ?? loadMoaMigrationSql();

  return withPgTransaction(merchantPool, async (client: StrictPgClient) => {
    const decisions: string[] = [];
    const conflicts: OnboardingMigrationConflict[] = [];

    // 1. Verify S1.4-A prerequisite tables exist
    const prereqRes = await client.query(
      `SELECT
         to_regclass('public.merchants') AS merchants_tbl,
         to_regclass('public.seller_accounts') AS seller_accounts_tbl,
         to_regclass('public.store_memberships') AS memberships_tbl`
    );
    const prereq = prereqRes.rows[0] || {};
    if (!prereq.merchants_tbl || !prereq.seller_accounts_tbl || !prereq.memberships_tbl) {
      conflicts.push({
        code: 'MISSING_S14A_PREREQUISITE',
        merchantIds: [],
        reason: 'Required S1.4-A tables (merchants, seller_accounts, store_memberships) must exist before MO-A migration.'
      });
      throw new MerchantOnboardingMigrationError(conflicts);
    }

    // Lock merchants (and store_onboarding_profiles if it already exists)
    await client.query('LOCK TABLE merchants IN SHARE ROW EXCLUSIVE MODE');

    // 2. Scan existing merchants before applying migration
    const merchRes = await client.query(
      `SELECT id, business_name, category, latitude, longitude, is_verified, is_open
       FROM merchants
       ORDER BY created_at ASC, id ASC`
    );
    const merchants = merchRes.rows as Array<{
      id: string;
      business_name: string | null;
      category: string | null;
      latitude: string | number | null;
      longitude: string | number | null;
      is_verified: boolean;
      is_open: boolean;
    }>;

    let ignoredLegacyIsVerifiedCount = 0;
    for (const m of merchants) {
      if (m.is_verified === true) {
        ignoredLegacyIsVerifiedCount += 1;
      }
      if (!m.business_name || !String(m.business_name).trim() || !m.category || !String(m.category).trim()) {
        conflicts.push({
          code: 'INVALID_MERCHANT_IDENTITY',
          merchantIds: [String(m.id)],
          reason: 'Existing merchant row is missing business_name or category.'
        });
        continue;
      }
      const lat = Number(m.latitude);
      const lng = Number(m.longitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        conflicts.push({
          code: 'INVALID_MERCHANT_COORDINATES',
          merchantIds: [String(m.id)],
          reason: 'Existing merchant row has invalid or out-of-range coordinates.'
        });
      }
    }

    // 3. Detect pre-existing conflicting onboarding states if tables already exist
    const existingProfilesTbl = await client.query(
      `SELECT to_regclass('public.store_onboarding_profiles') AS tbl,
              to_regclass('public.store_kyc_submissions') AS sub_tbl`
    );
    const preExistingProfileMerchants = new Set<string>();

    if (existingProfilesTbl.rows[0]?.tbl && existingProfilesTbl.rows[0]?.sub_tbl) {
      const existingProfRes = await client.query(
        `SELECT p.merchant_id, p.status, p.approved_submission_id, s.status AS approved_sub_status
         FROM store_onboarding_profiles p
         LEFT JOIN store_kyc_submissions s ON s.id = p.approved_submission_id`
      );
      for (const row of existingProfRes.rows) {
        preExistingProfileMerchants.add(String(row.merchant_id));
        if (row.status === 'APPROVED' && (!row.approved_submission_id || row.approved_sub_status !== 'APPROVED')) {
          conflicts.push({
            code: 'CORRUPTED_ONBOARDING_APPROVAL',
            merchantIds: [String(row.merchant_id)],
            reason: 'Existing APPROVED onboarding profile lacks a backing APPROVED submission record.'
          });
        }
      }
    }

    if (conflicts.length > 0) {
      throw new MerchantOnboardingMigrationError(conflicts);
    }

    // 4. Execute DDL, triggers, seed catalogue, and backfill SQL atomically
    await client.query(migrationSql);

    // Count newly initialized onboarding profiles vs pre-existing
    const postProfRes = await client.query(
      `SELECT merchant_id, status FROM store_onboarding_profiles`
    );
    const newlyCreatedIds: string[] = [];
    for (const row of postProfRes.rows) {
      const mid = String(row.merchant_id);
      if (!preExistingProfileMerchants.has(mid)) {
        newlyCreatedIds.push(mid);
      }
    }

    // Record audit events only for newly initialized legacy stores (idempotent across reruns)
    for (const merchantId of newlyCreatedIds) {
      const m = merchants.find((item) => String(item.id) === merchantId);
      await client.query(
        `INSERT INTO store_onboarding_audit_events
           (merchant_id, actor_type, actor_id, event_type, event_metadata)
         VALUES ($1, 'SYSTEM', NULL, 'LEGACY_MIGRATION_INITIALIZED', $2::jsonb)`,
        [
          merchantId,
          JSON.stringify({
            initialStatus: 'PENDING_SUBMISSION',
            legacyIsVerifiedIgnored: Boolean(m?.is_verified),
            closedByDefault: true
          })
        ]
      );
    }

    // Count how many previously open unapproved stores were closed by migration
    let legacyStoresClosed = 0;
    const postMerchRes = await client.query(`SELECT id, is_open FROM merchants`);
    const postOpenById = new Map<string, boolean>(
      postMerchRes.rows.map((r: { id: string; is_open: boolean }) => [String(r.id), Boolean(r.is_open)])
    );
    for (const m of merchants) {
      if (m.is_open === true && postOpenById.get(String(m.id)) === false) {
        legacyStoresClosed += 1;
      }
    }

    const reqCountRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM kyc_document_requirements WHERE is_active = true`
    );
    const requirementsActiveCount = Number(reqCountRes.rows[0]?.cnt ?? 0);

    decisions.push(
      `Scanned ${merchants.length} existing merchant store(s).`,
      `Created ${newlyCreatedIds.length} PENDING_SUBMISSION onboarding profile(s); skipped ${preExistingProfileMerchants.size} already-migrated profile(s).`,
      `Ignored legacy merchants.is_verified=true on ${ignoredLegacyIsVerifiedCount} store(s); zero stores auto-approved.`,
      `Closed ${legacyStoresClosed} unapproved store(s) by setting is_open=false; new stores default to is_open=false.`,
      `Active KYC requirement definitions present: ${requirementsActiveCount}.`
    );

    return {
      applied: true,
      totalMerchantsScanned: merchants.length,
      alreadyMigratedProfiles: preExistingProfileMerchants.size,
      profilesCreated: newlyCreatedIds.length,
      legacyStoresClosed,
      ignoredLegacyIsVerifiedCount,
      requirementsActiveCount,
      decisions
    };
  });
}
