import fs from 'fs';
import path from 'path';
import { StrictPgPool, withPgTransaction } from '../postgres';
import { normalizePhoneNumber } from '../../utils/phone';

const EMAIL_FORMAT_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export const S14A_MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'database-schemas',
  'merchant-db',
  'migrations',
  '001_s1_4_a_seller_accounts_and_memberships.sql'
);

export type BackfillConflictCode =
  | 'INVALID_PHONE'
  | 'MISSING_OR_INVALID_EMAIL'
  | 'MISSING_PASSWORD_HASH'
  | 'PHONE_EMAIL_MISMATCH'
  | 'EMAIL_PHONE_MISMATCH'
  | 'PASSWORD_HASH_CONFLICT'
  | 'EXISTING_ACCOUNT_CONFLICT';

export interface BackfillConflict {
  code: BackfillConflictCode;
  merchantIds: string[];
  reason: string;
}

export interface SellerIdentityMigrationResult {
  applied: boolean;
  totalMerchantsScanned: number;
  alreadyMappedStores: number;
  sellerAccountsCreated: number;
  sellerAccountsReused: number;
  membershipsCreated: number;
  conflicts: BackfillConflict[];
}

export class MerchantIdentityBackfillError extends Error {
  public readonly conflicts: BackfillConflict[];

  constructor(conflicts: BackfillConflict[]) {
    const summary = conflicts
      .map((c) => `[${c.code}] merchants=[${c.merchantIds.join(',')}]: ${c.reason}`)
      .join(' | ');
    super(`Merchant identity backfill aborted safely due to ${conflicts.length} conflict(s): ${summary}`);
    this.name = 'MerchantIdentityBackfillError';
    this.conflicts = conflicts;
    Object.setPrototypeOf(this, MerchantIdentityBackfillError.prototype);
  }
}

interface LegacyMerchantRow {
  id: string;
  owner_phone: string | null;
  owner_email: string | null;
  password_hash: string | null;
}

interface ExistingSellerAccountRow {
  id: string;
  phone: string;
  email: string;
  password_hash: string | null;
  is_email_verified: boolean;
  status: string;
}

interface ExistingMembershipRow {
  merchant_id: string;
  seller_account_id: string;
  role: string;
  status: string;
}

interface NormalizedCandidate {
  merchantId: string;
  phone: string;
  email: string;
  passwordHash: string;
}

interface OwnerIdentityGroup {
  key: string;
  phone: string;
  email: string;
  passwordHash: string;
  existingAccountId?: string;
  merchantIds: string[];
}

export function loadS14aMigrationSql(): string {
  return fs.readFileSync(S14A_MIGRATION_SQL_PATH, 'utf8');
}

/**
 * Validates and applies S1.4-A schema migration (seller_accounts, store_memberships)
 * and atomically backfills existing `merchants` rows into Seller Accounts and OWNER
 * memberships inside a single Merchant DB transaction.
 *
 * Refuses to invent missing credentials/emails or arbitrarily merge conflicting owner
 * identities; any ambiguity triggers rollback and raises MerchantIdentityBackfillError.
 */
export async function migrateAndBackfillSellerIdentities(
  merchantPool: StrictPgPool,
  options: { migrationSql?: string } = {}
): Promise<SellerIdentityMigrationResult> {
  const migrationSql = options.migrationSql ?? loadS14aMigrationSql();

  return withPgTransaction(merchantPool, async (client) => {
    await client.query(migrationSql);
    await client.query('LOCK TABLE merchants, seller_accounts, store_memberships IN SHARE ROW EXCLUSIVE MODE');

    const merchRes = await client.query(
      `SELECT id, owner_phone, owner_email, password_hash
       FROM merchants
       ORDER BY created_at ASC, id ASC`
    );
    const acctRes = await client.query(
      `SELECT id, phone, email, password_hash, is_email_verified, status
       FROM seller_accounts`
    );
    const memRes = await client.query(
      `SELECT merchant_id, seller_account_id, role, status
       FROM store_memberships`
    );

    const merchants = merchRes.rows as LegacyMerchantRow[];
    const existingAccounts = acctRes.rows as ExistingSellerAccountRow[];
    const existingMemberships = memRes.rows as ExistingMembershipRow[];

    const ownerLinkedMerchantIds = new Set<string>();
    const existingMembershipPairs = new Set<string>();
    for (const mem of existingMemberships) {
      existingMembershipPairs.add(`${mem.seller_account_id}:${mem.merchant_id}`);
      if (mem.role === 'OWNER') {
        ownerLinkedMerchantIds.add(mem.merchant_id);
      }
    }

    const accountByPhone = new Map<string, ExistingSellerAccountRow>();
    const accountByEmail = new Map<string, ExistingSellerAccountRow>();
    for (const acct of existingAccounts) {
      accountByPhone.set(acct.phone, acct);
      accountByEmail.set(acct.email.trim().toLowerCase(), acct);
    }

    const conflicts: BackfillConflict[] = [];
    const candidates: NormalizedCandidate[] = [];
    let alreadyMappedStores = 0;

    for (const m of merchants) {
      if (ownerLinkedMerchantIds.has(m.id)) {
        alreadyMappedStores += 1;
        continue;
      }

      const phoneNorm = normalizePhoneNumber(typeof m.owner_phone === 'string' ? m.owner_phone : '');
      if (!phoneNorm.valid || !phoneNorm.e164) {
        conflicts.push({
          code: 'INVALID_PHONE',
          merchantIds: [m.id],
          reason: phoneNorm.error || 'Missing or invalid owner_phone; cannot normalize to E.164.'
        });
        continue;
      }

      const normalizedEmail = typeof m.owner_email === 'string' ? m.owner_email.trim().toLowerCase() : '';
      if (!normalizedEmail || !EMAIL_FORMAT_REGEX.test(normalizedEmail)) {
        conflicts.push({
          code: 'MISSING_OR_INVALID_EMAIL',
          merchantIds: [m.id],
          reason: 'Missing or invalid owner_email; refusing to invent email identity.'
        });
        continue;
      }

      const passwordHash = typeof m.password_hash === 'string' ? m.password_hash.trim() : '';
      if (!passwordHash) {
        conflicts.push({
          code: 'MISSING_PASSWORD_HASH',
          merchantIds: [m.id],
          reason: 'Missing password_hash; refusing to create credential-less Seller Account.'
        });
        continue;
      }

      candidates.push({
        merchantId: m.id,
        phone: phoneNorm.e164,
        email: normalizedEmail,
        passwordHash
      });
    }

    const phoneIndex = new Map<string, NormalizedCandidate[]>();
    const emailIndex = new Map<string, NormalizedCandidate[]>();
    for (const c of candidates) {
      const pList = phoneIndex.get(c.phone) || [];
      pList.push(c);
      phoneIndex.set(c.phone, pList);

      const eList = emailIndex.get(c.email) || [];
      eList.push(c);
      emailIndex.set(c.email, eList);
    }

    // Detect same-phone / different-email conflicts
    for (const [phone, list] of phoneIndex.entries()) {
      const emails = Array.from(new Set(list.map((c) => c.email)));
      if (emails.length > 1) {
        conflicts.push({
          code: 'PHONE_EMAIL_MISMATCH',
          merchantIds: list.map((c) => c.merchantId),
          reason: `Multiple merchant rows normalize to phone ${phone} with different owner emails.`
        });
      }
    }

    // Detect same-email / different-phone conflicts
    for (const [email, list] of emailIndex.entries()) {
      const phones = Array.from(new Set(list.map((c) => c.phone)));
      if (phones.length > 1) {
        conflicts.push({
          code: 'EMAIL_PHONE_MISMATCH',
          merchantIds: list.map((c) => c.merchantId),
          reason: `Multiple merchant rows share email ${email} with different phone numbers.`
        });
      }
    }

    // Group clean candidates by (phone, email) and verify passwordHash & existing account consistency.
    // Legacy `merchants.is_verified` is intentionally ignored because historical KYC/seed/OTP writes
    // gave it ambiguous meaning; newly backfilled accounts start with `is_email_verified = false`.
    const groups = new Map<string, OwnerIdentityGroup>();
    for (const c of candidates) {
      const key = `${c.phone}::${c.email}`;
      let grp = groups.get(key);
      if (!grp) {
        grp = {
          key,
          phone: c.phone,
          email: c.email,
          passwordHash: c.passwordHash,
          merchantIds: [c.merchantId]
        };
        groups.set(key, grp);
      } else {
        if (grp.passwordHash !== c.passwordHash) {
          conflicts.push({
            code: 'PASSWORD_HASH_CONFLICT',
            merchantIds: [...grp.merchantIds, c.merchantId],
            reason: `Conflicting password hashes for owner ${c.email} / ${c.phone}.`
          });
        }
        grp.merchantIds.push(c.merchantId);
      }
    }

    // Validate against any pre-existing Seller Accounts
    for (const grp of groups.values()) {
      const existingByPhone = accountByPhone.get(grp.phone);
      const existingByEmail = accountByEmail.get(grp.email);

      if (existingByPhone && existingByEmail && existingByPhone.id !== existingByEmail.id) {
        conflicts.push({
          code: 'EXISTING_ACCOUNT_CONFLICT',
          merchantIds: grp.merchantIds,
          reason: `Normalized phone and email match two distinct existing seller_accounts rows.`
        });
        continue;
      }

      const existing = existingByPhone || existingByEmail;
      if (existing) {
        if (
          existing.phone !== grp.phone ||
          existing.email.trim().toLowerCase() !== grp.email
        ) {
          conflicts.push({
            code: 'EXISTING_ACCOUNT_CONFLICT',
            merchantIds: grp.merchantIds,
            reason: `Store owner identity partially conflicts with an existing seller_accounts row.`
          });
          continue;
        }
        if ((existing.password_hash || '') !== grp.passwordHash) {
          conflicts.push({
            code: 'PASSWORD_HASH_CONFLICT',
            merchantIds: grp.merchantIds,
            reason: `Store password_hash does not match existing Seller Account for ${grp.email}.`
          });
          continue;
        }
        const conflictingStores = grp.merchantIds.filter((mid) =>
          existingMembershipPairs.has(`${existing.id}:${mid}`)
        );
        if (conflictingStores.length > 0) {
          conflicts.push({
            code: 'EXISTING_ACCOUNT_CONFLICT',
            merchantIds: conflictingStores,
            reason: `Existing Seller Account ${existing.id} already holds a non-OWNER membership on store(s).`
          });
          continue;
        }
        grp.existingAccountId = existing.id;
      }
    }

    if (conflicts.length > 0) {
      throw new MerchantIdentityBackfillError(conflicts);
    }

    let sellerAccountsCreated = 0;
    let sellerAccountsReused = 0;
    let membershipsCreated = 0;

    for (const grp of groups.values()) {
      let sellerAccountId = grp.existingAccountId;
      if (!sellerAccountId) {
        // Require fresh email OTP verification for all newly backfilled Seller Accounts
        // because legacy `merchants.is_verified` cannot reliably prove email ownership.
        const insertedAcct = await client.query(
          `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
           VALUES ($1, $2, $3, false, 'ACTIVE')
           RETURNING id`,
          [grp.phone, grp.email, grp.passwordHash]
        );
        sellerAccountId = String(insertedAcct.rows[0].id);
        sellerAccountsCreated += 1;
      } else {
        sellerAccountsReused += 1;
      }

      for (const merchantId of grp.merchantIds) {
        await client.query(
          `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status)
           VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
          [sellerAccountId, merchantId]
        );
        membershipsCreated += 1;
      }
    }

    return {
      applied: true,
      totalMerchantsScanned: merchants.length,
      alreadyMappedStores,
      sellerAccountsCreated,
      sellerAccountsReused,
      membershipsCreated,
      conflicts: []
    };
  });
}
