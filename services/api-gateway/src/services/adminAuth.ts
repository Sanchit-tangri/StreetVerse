import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { StrictPgPool, withPgTransaction } from '../db/postgres';
import {
  ADMIN_ACCOUNT_PRINCIPAL_TYPE,
  AdminPermission,
  AdminPrincipalType,
  AdminRole,
  AuthenticatedRequest,
  getPermissionsForAdminRole,
  JwtAuthConfig,
  resolveJwtAdminAudience,
  resolveJwtAdminExpiresIn
} from '../middleware/authJwt';
import {
  ALLOWED_STORE_CATEGORIES,
  getApplicableRequirements,
  DocumentRequirement,
  OnboardingStatus
} from './onboarding';
import { STORE_UUID_REGEX } from './sellerRbac';
import { classifyHttpError, sanitizeErrorForLog } from '../utils/infraErrors';

// =========================================================================
// MO-B1: Administrative Identity, Authentication & Queue Prerequisite Service
//
// Security invariants:
//   - Admin credentials live exclusively in `admin_accounts` (Merchant DB).
//   - No public self-registration endpoint or helper is exposed on HTTP routes.
//   - Passwords require >= 12 characters with complexity and are bcrypt-hashed.
//   - Admin JWTs carry `aud = resolveJwtAdminAudience(config)`, `role = 'ADMIN'`,
//     and `principalType = 'ADMIN_ACCOUNT'`.
//   - Reviewer identity is always derived from verified DB-backed `req.adminAuth`,
//     never from client-supplied `reviewedByAdminId`, `adminId`, or `actorId`.
//   - Queue & store inspection responses never expose `password_hash`, raw
//     `storage_key`, filesystem paths, or Seller credentials.
// =========================================================================

export const ADMIN_BCRYPT_SALT_ROUNDS = 10;

// Constant bcrypt hash used when email is not found so unknown-email and wrong-password
// checks remain indistinguishable in both status/message and verification cost.
const DUMMY_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDER_PASSWORD_VALUES = new Set([
  'replace_with_strong_admin_password',
  'your_admin_password_here',
  'password',
  'password123',
  'admin123',
  'changeme'
]);

const ALLOWED_QUEUE_STATUS_FILTERS = new Set<string>([
  'PENDING_SUBMISSION',
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'MORE_INFO_REQUIRED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'REVERIFICATION_REQUIRED'
]);

const DEFAULT_QUEUE_STATUSES: readonly OnboardingStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'MORE_INFO_REQUIRED',
  'REVERIFICATION_REQUIRED'
];

export type AdminServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 503; code: string; error: string };

export interface AdminAccountPublic {
  id: string;
  email: string;
  fullName: string;
  role: AdminRole;
  permissions: readonly AdminPermission[];
  principalType: AdminPrincipalType;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisionAdminInput {
  email: string;
  fullName: string;
  password: string;
}

export interface AdminLoginInput {
  email: unknown;
  password: unknown;
}

export interface AdminLoginResult {
  token: string;
  expiresIn: string;
  admin: AdminAccountPublic;
}

export interface VerifiedAdminActor {
  actorType: 'ADMIN';
  actorId: string;
  role: AdminRole;
  permissions: readonly AdminPermission[];
  email: string;
  fullName: string;
}

export interface AdminQueueItem {
  storeId: string;
  businessName: string;
  category: string;
  isOpen: boolean;
  onboardingStatus: string;
  reverificationRequired: boolean;
  reverificationReason: string | null;
  pincode: string | null;
  currentLocation: {
    address: string | null;
    pincode: string | null;
    latitude: number | null;
    longitude: number | null;
    gpsCapturedAt: string | null;
  };
  profileUpdatedAt: string | null;
  isResubmission: boolean;
  hasPreviousDecision: boolean;
  previousDecision: {
    submissionVersion: number;
    status: string;
    reviewedAt: string | null;
    ownerFeedbackReason: string | null;
  } | null;
  currentSubmission: {
    id: string;
    submissionVersion: number;
    status: string;
    submittedAt: string | null;
    reviewStartedAt: string | null;
    reviewedAt: string | null;
    reviewedByAdminId: string | null;
    isReverification: boolean;
    documentCount: number;
    requiredDocumentSummary: {
      mandatoryRequiredCount: number;
      mandatoryUploadedCount: number;
      missingMandatoryKeys: string[];
    };
  } | null;
  primaryOwner: {
    sellerAccountId: string;
    email: string;
    isEmailVerified: boolean;
  } | null;
}

export interface AdminOnboardingQueueResult {
  filterStatus: string;
  filterCategory: string | null;
  search: string | null;
  sort: 'submitted_asc' | 'submitted_desc';
  totalCount: number;
  limit: number;
  offset: number;
  statusCounts: Record<string, number>;
  items: AdminQueueItem[];
}

export interface AdminStoreOnboardingDetails {
  store: {
    id: string;
    businessName: string;
    category: string;
    isOpen: boolean;
    address: string;
    pincode: string;
    latitude: number;
    longitude: number;
    createdAt: string;
  };
  profile: {
    id: string;
    status: string;
    businessType: string;
    businessTypeConfirmed: boolean;
    fixedPremisesConfirmed: boolean;
    premisesOwnershipType: string | null;
    address: string | null;
    pincode: string | null;
    latitude: number | null;
    longitude: number | null;
    gpsCapturedAt: string | null;
    gpsAccuracyMeters: number | null;
    currentSubmissionId: string | null;
    draftSubmissionId: string | null;
    approvedSubmissionId: string | null;
    reverificationRequired: boolean;
    reverificationReason: string | null;
    approvedAddress: string | null;
    approvedPincode: string | null;
    approvedLatitude: number | null;
    approvedLongitude: number | null;
    approvedAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  memberships: Array<{
    membershipId: string;
    sellerAccountId: string;
    email: string;
    isEmailVerified: boolean;
    accountStatus: string;
    role: string;
    membershipStatus: string;
  }>;
  requirements: Array<DocumentRequirement & { fulfilled: boolean }>;
  prerequisiteCheck: {
    hasProfile: boolean;
    hasCurrentSubmission: boolean;
    missingRequirements: string[];
    missingGps: boolean;
    missingPremisesConfirmation: boolean;
    missingAddress: boolean;
  };
  submissions: Array<{
    id: string;
    submissionVersion: number;
    status: string;
    submittedBySellerAccountId: string;
    businessNameSnapshot: string;
    categorySnapshot: string;
    businessTypeSnapshot: string;
    fixedPremisesConfirmedSnapshot: boolean;
    addressSnapshot: string;
    pincodeSnapshot: string;
    latitudeSnapshot: number | null;
    longitudeSnapshot: number | null;
    gpsCapturedAtSnapshot: string | null;
    gpsAccuracyMetersSnapshot: number | null;
    submittedRequirementsVersion: number;
    requirementsSnapshot: unknown;
    sellerContactSnapshot: unknown;
    isReverification: boolean;
    submittedAt: string | null;
    reviewStartedAt: string | null;
    reviewedAt: string | null;
    reviewedByAdminId: string | null;
    reviewNotes: string | null;
    reviewChecklist: unknown;
    ownerFeedbackReason: string | null;
    requestedRequirements: string[] | null;
    rejectionCategory: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  documents: Array<{
    id: string;
    submissionId: string;
    requirementKey: string;
    documentType: string;
    originalFilenameSanitized: string;
    mimeType: string;
    fileSizeBytes: number;
    sha256Checksum: string;
    uploadedAt: string;
    isStorefrontPhoto: boolean;
    isPremisesProof: boolean;
  }>;
  auditEvents: Array<{
    id: string;
    actorType: string;
    actorId: string | null;
    eventType: string;
    eventMetadata: unknown;
    createdAt: string;
  }>;
  ownerNotificationEvents: Array<{
    id: string;
    submissionId: string | null;
    submissionVersion: number | null;
    ownerSellerAccountId: string;
    eventType: string;
    deliveryStatus: string;
    deliveryAttempts: number;
    createdAt: string;
    dispatchedAt: string | null;
  }>;
}

function mapAdminAccountRow(row: Record<string, unknown>): AdminAccountPublic {
  const role: AdminRole = 'ADMIN';
  return {
    id: String(row.id),
    email: String(row.email),
    fullName: String(row.full_name),
    role,
    permissions: getPermissionsForAdminRole(String(row.role ?? 'ADMIN')),
    principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE,
    status: String(row.status),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function isValidGps(lat: number | null, lng: number | null): boolean {
  return (
    lat !== null &&
    lng !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * Validates operational Admin bootstrap password complexity.
 */
export function validateAdminPasswordStrength(
  password: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Admin password must be a string.' };
  }
  if (password.length < 12 || password.length > 128) {
    return { ok: false, error: 'Admin password must be between 12 and 128 characters.' };
  }
  if (password.trim() !== password) {
    return { ok: false, error: 'Admin password must not have leading or trailing whitespace.' };
  }
  const lower = password.toLowerCase();
  if (
    PLACEHOLDER_PASSWORD_VALUES.has(lower) ||
    lower.startsWith('replace_with_') ||
    lower.startsWith('your_')
  ) {
    return { ok: false, error: 'Admin password must not use a placeholder or default value.' };
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) {
    return {
      ok: false,
      error: 'Admin password must include uppercase, lowercase, numeric, and special characters.'
    };
  }
  return { ok: true, value: password };
}

/**
 * Operational provisioning service for creating an isolated Admin account in Merchant DB.
 * Invoked exclusively via CLI provisioning script or controlled internal bootstrap — never
 * exposed via public HTTP registration endpoints.
 */
export async function provisionAdminAccount(
  merchantPool: StrictPgPool,
  input: ProvisionAdminInput
): Promise<AdminServiceResult<AdminAccountPublic>> {
  const emailNormalized = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!emailNormalized || emailNormalized.length > 255 || !EMAIL_REGEX.test(emailNormalized)) {
    return { ok: false, status: 400, code: 'INVALID_ADMIN_EMAIL', error: 'A valid admin email is required.' };
  }

  const fullNameTrimmed = typeof input.fullName === 'string' ? input.fullName.trim() : '';
  if (fullNameTrimmed.length < 2 || fullNameTrimmed.length > 150) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_ADMIN_NAME',
      error: 'Admin full name must be between 2 and 150 characters.'
    };
  }

  const pwCheck = validateAdminPasswordStrength(input.password);
  if (!pwCheck.ok) {
    return { ok: false, status: 400, code: 'WEAK_ADMIN_PASSWORD', error: pwCheck.error };
  }

  try {
    const passwordHash = await bcrypt.hash(pwCheck.value, ADMIN_BCRYPT_SALT_ROUNDS);

    const inserted = await withPgTransaction(merchantPool, async (client) => {
      const res = await client.query(
        `INSERT INTO admin_accounts (email, full_name, password_hash, role, status)
         VALUES ($1, $2, $3, 'ADMIN', 'ACTIVE')
         RETURNING id, email, full_name, role, status, last_login_at, created_at, updated_at`,
        [emailNormalized, fullNameTrimmed, passwordHash]
      );
      return res.rows[0] as Record<string, unknown>;
    });

    return { ok: true, data: mapAdminAccountRow(inserted) };
  } catch (err: unknown) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode === '23505') {
      return {
        ok: false,
        status: 409,
        code: 'ADMIN_EMAIL_CONFLICT',
        error: 'An admin account with this email already exists.'
      };
    }
    const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
    if (mapped.status === 503 || mapped.status === 400 || mapped.status === 409) {
      return { ok: false, status: mapped.status as 400 | 409 | 503, code: mapped.code, error: mapped.message };
    }
    console.error(`[Admin Provision Error]: ${sanitizeErrorForLog(err)}`);
    return { ok: false, status: 503, code: 'INTERNAL_ERROR', error: 'Unable to provision admin account.' };
  }
}

/**
 * Authenticates an existing Admin account against `admin_accounts` strictly,
 * verifies ACTIVE status, updates `last_login_at`, and issues an Admin-scoped JWT
 * with `aud = resolveJwtAdminAudience(jwtConfig)` and `principalType = 'ADMIN_ACCOUNT'`.
 */
export async function authenticateAdminAccount(
  merchantPool: StrictPgPool,
  jwtConfig: JwtAuthConfig,
  input: AdminLoginInput
): Promise<AdminServiceResult<AdminLoginResult>> {
  const emailNormalized = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';

  if (!emailNormalized || !EMAIL_REGEX.test(emailNormalized) || !password) {
    return {
      ok: false,
      status: 400,
      code: 'ADMIN_INVALID_INPUT',
      error: 'Valid email and password are required.'
    };
  }

  try {
    const accountRes = await merchantPool.query(
      `SELECT id, email, full_name, password_hash, role, status, last_login_at, created_at, updated_at
       FROM admin_accounts
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [emailNormalized]
    );

    if (accountRes.rows.length === 0) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      return {
        ok: false,
        status: 401,
        code: 'ADMIN_INVALID_CREDENTIALS',
        error: 'Invalid email or password.'
      };
    }

    const row = accountRes.rows[0] as Record<string, unknown>;
    const passwordHash = typeof row.password_hash === 'string' ? row.password_hash : '';
    const passwordMatches = passwordHash ? await bcrypt.compare(password, passwordHash) : false;

    if (!passwordMatches) {
      return {
        ok: false,
        status: 401,
        code: 'ADMIN_INVALID_CREDENTIALS',
        error: 'Invalid email or password.'
      };
    }

    if (row.status !== 'ACTIVE') {
      return {
        ok: false,
        status: 403,
        code: 'ADMIN_ACCOUNT_INACTIVE',
        error: 'Admin account is suspended or disabled.'
      };
    }

    if (row.role !== 'ADMIN') {
      return {
        ok: false,
        status: 403,
        code: 'ADMIN_FORBIDDEN',
        error: 'Insufficient administrative privileges.'
      };
    }

    const updatedRes = await merchantPool.query(
      `UPDATE admin_accounts
       SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, email, full_name, role, status, last_login_at, created_at, updated_at`,
      [row.id]
    );

    const updatedRow = (updatedRes.rows[0] ?? row) as Record<string, unknown>;
    const admin = mapAdminAccountRow(updatedRow);
    const expiresIn = resolveJwtAdminExpiresIn(jwtConfig);
    const adminAudience = resolveJwtAdminAudience(jwtConfig);

    const token = jwt.sign(
      {
        sub: admin.id,
        role: admin.role,
        principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE,
        email: admin.email
      },
      jwtConfig.jwtSecret,
      {
        expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
        issuer: jwtConfig.jwtIssuer,
        audience: adminAudience
      }
    );

    return {
      ok: true,
      data: {
        token,
        expiresIn,
        admin
      }
    };
  } catch (err: unknown) {
    const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
    if (mapped.status === 503 || mapped.status === 400) {
      return { ok: false, status: mapped.status as 400 | 503, code: mapped.code, error: mapped.message };
    }
    console.error(`[Admin Login Error]: ${sanitizeErrorForLog(err)}`);
    return { ok: false, status: 503, code: 'INTERNAL_ERROR', error: 'Admin authentication unavailable.' };
  }
}

/**
 * Derives the verified Admin actor exclusively from DB-authenticated `req.adminAuth`.
 * Guarantees downstream review & audit services never accept client-supplied
 * `reviewedByAdminId`, `adminId`, or `actorId` values from request body or query params.
 */
export function resolveVerifiedAdminActor(
  req: AuthenticatedRequest
): { ok: true; actor: VerifiedAdminActor } | { ok: false; status: 401 | 403; code: string; error: string } {
  const ctx = req.adminAuth;
  if (!ctx || ctx.principalType !== ADMIN_ACCOUNT_PRINCIPAL_TYPE || !ctx.adminAccountId) {
    return {
      ok: false,
      status: 401,
      code: 'ADMIN_AUTH_REQUIRED',
      error: 'Verified admin authentication context is required.'
    };
  }

  if (ctx.status !== 'ACTIVE') {
    return {
      ok: false,
      status: 403,
      code: 'ADMIN_ACCOUNT_INACTIVE',
      error: 'Admin account is suspended or disabled.'
    };
  }

  if (ctx.role !== 'ADMIN') {
    return {
      ok: false,
      status: 403,
      code: 'ADMIN_FORBIDDEN',
      error: 'Admin role required.'
    };
  }

  return {
    ok: true,
    actor: {
      actorType: 'ADMIN',
      actorId: ctx.adminAccountId,
      role: ctx.role,
      permissions: ctx.permissions,
      email: ctx.email,
      fullName: ctx.fullName
    }
  };
}

async function detectMob2Capabilities(
  executor: Pick<StrictPgPool, 'query'>
): Promise<{ hasReviewCols: boolean; hasNotifTable: boolean }> {
  const res = await executor.query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'store_kyc_submissions'
           AND column_name = 'owner_feedback_reason'
       ) AS has_review_cols,
       (to_regclass('owner_notification_events') IS NOT NULL) AS has_notif_table`
  );
  const row = res.rows[0] as { has_review_cols?: boolean; has_notif_table?: boolean } | undefined;
  return {
    hasReviewCols: Boolean(row?.has_review_cols),
    hasNotifTable: Boolean(row?.has_notif_table)
  };
}

/**
 * Read-only Admin onboarding queue endpoint service (`GET /api/v1/admin/onboarding/queue`).
 * Includes ONLY applications with persisted non-DRAFT submissions, supports status, category,
 * store name / ID search, priority-neutral chronological sorting, status counts, and O(1)
 * document-completion summaries without exposing storage keys, filesystem paths, or credentials.
 */
export async function getAdminOnboardingQueue(
  merchantPool: Pick<StrictPgPool, 'query'>,
  options: {
    status?: string;
    category?: string;
    search?: string;
    storeId?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<AdminServiceResult<AdminOnboardingQueueResult>> {
  const rawStatus = options.status?.trim().toUpperCase();
  let filterLabel = 'QUEUE_DEFAULT';
  let statusList: readonly string[] | null = DEFAULT_QUEUE_STATUSES;

  if (rawStatus && rawStatus.length > 0) {
    if (rawStatus === 'ALL') {
      filterLabel = 'ALL';
      statusList = null;
    } else if (ALLOWED_QUEUE_STATUS_FILTERS.has(rawStatus)) {
      filterLabel = rawStatus;
      statusList = [rawStatus];
    } else {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_STATUS_FILTER',
        error: `Invalid onboarding status filter: ${rawStatus}`
      };
    }
  }

  const rawCategory = options.category?.trim().toUpperCase();
  if (rawCategory && !ALLOWED_STORE_CATEGORIES.has(rawCategory)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CATEGORY',
      error: `Invalid store category filter: ${rawCategory}`
    };
  }

  const rawStoreId = options.storeId?.trim();
  if (rawStoreId && !STORE_UUID_REGEX.test(rawStoreId)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_STORE_ID',
      error: 'Valid storeId UUID is required.'
    };
  }

  const rawSort = (options.sort?.trim().toLowerCase() || 'submitted_asc') as string;
  if (rawSort !== 'submitted_asc' && rawSort !== 'submitted_desc') {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SORT',
      error: `Unsupported queue sort '${rawSort}'. Use 'submitted_asc' or 'submitted_desc'.`
    };
  }
  const sort: 'submitted_asc' | 'submitted_desc' = rawSort;

  const rawSearch = options.search?.trim() || null;
  if (rawSearch && rawSearch.length > 150) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SEARCH',
      error: 'Search query must be at most 150 characters.'
    };
  }

  const parsedLimit = Number(options.limit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 100 ? parsedLimit : 50;
  const parsedOffset = Number(options.offset);
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

  try {
    const conditions: string[] = [`sub.status <> 'DRAFT'`];
    const params: unknown[] = [];
    let pIdx = 1;

    if (statusList) {
      conditions.push(`sop.status = ANY($${pIdx++}::text[])`);
      params.push(statusList);
    }

    if (rawCategory) {
      conditions.push(`UPPER(COALESCE(sop.category, m.category)) = $${pIdx++}`);
      params.push(rawCategory);
    }

    if (rawStoreId) {
      conditions.push(`m.id = $${pIdx++}`);
      params.push(rawStoreId);
    }

    if (rawSearch) {
      const escapedLike = rawSearch.toLowerCase().replace(/[\\%_]/g, '\\$&');
      const likeParam = `%${escapedLike}%`;
      if (STORE_UUID_REGEX.test(rawSearch)) {
        conditions.push(`(m.id = $${pIdx} OR LOWER(COALESCE(sop.business_name, m.business_name)) LIKE $${pIdx + 1} ESCAPE '\\')`);
        params.push(rawSearch, likeParam);
        pIdx += 2;
      } else {
        conditions.push(`LOWER(COALESCE(sop.business_name, m.business_name)) LIKE $${pIdx++} ESCAPE '\\'`);
        params.push(likeParam);
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Priority-neutral chronological ordering strictly by submitted_at timestamp
    const orderClause =
      sort === 'submitted_desc'
        ? `ORDER BY sub.submitted_at DESC NULLS LAST, sub.submission_version DESC, m.id ASC`
        : `ORDER BY sub.submitted_at ASC NULLS LAST, sub.submission_version ASC, m.id ASC`;

    const statusCountsRes = await merchantPool.query(
      `SELECT sop.status, COUNT(*)::int AS cnt
       FROM store_onboarding_profiles sop
       JOIN store_kyc_submissions sub ON sub.id = sop.current_submission_id
       WHERE sub.status <> 'DRAFT'
       GROUP BY sop.status`
    );
    const statusCounts: Record<string, number> = {};
    for (const row of statusCountsRes.rows) {
      statusCounts[String(row.status)] = Number(row.cnt ?? 0);
    }

    const countRes = await merchantPool.query(
      `SELECT COUNT(*)::int AS total
       FROM store_onboarding_profiles sop
       JOIN store_kyc_submissions sub ON sub.id = sop.current_submission_id
       JOIN merchants m ON m.id = sop.merchant_id
       ${whereClause}`,
      params
    );
    const totalCount = Number(countRes.rows[0]?.total ?? 0);

    const mob2Caps = await detectMob2Capabilities(merchantPool);
    const listParams = [...params, limit, offset];
    const limitParam = `$${pIdx}`;
    const offsetParam = `$${pIdx + 1}`;
    const reviewStartedSelect = mob2Caps.hasReviewCols
      ? 'sub.review_started_at'
      : 'NULL::timestamptz AS review_started_at';
    const prevFeedbackLateralCol = mob2Caps.hasReviewCols
      ? 'ps.owner_feedback_reason'
      : 'NULL::text AS owner_feedback_reason';

    const listRes = await merchantPool.query(
      `SELECT
         m.id AS store_id,
         COALESCE(sop.business_name, m.business_name) AS business_name,
         UPPER(COALESCE(sop.category, m.category)) AS category,
         m.is_open,
         sop.status AS onboarding_status,
         COALESCE(sop.reverification_required, false) AS reverification_required,
         sop.reverification_reason,
         COALESCE(sop.address, sub.address_snapshot, m.address) AS location_address,
         COALESCE(sop.pincode, sub.pincode_snapshot, m.pincode) AS pincode,
         COALESCE(sop.latitude, sub.latitude_snapshot) AS location_latitude,
         COALESCE(sop.longitude, sub.longitude_snapshot) AS location_longitude,
         COALESCE(sop.gps_captured_at, sub.gps_captured_at_snapshot) AS location_gps_captured_at,
         sop.updated_at AS profile_updated_at,
         sub.id AS current_submission_id,
         sub.submission_version,
         sub.status AS submission_status,
         sub.submitted_at,
         ${reviewStartedSelect},
         sub.reviewed_at,
         sub.reviewed_by_admin_id,
         sub.is_reverification,
         sub.requirements_snapshot,
         COALESCE(doc_stats.document_count, 0)::int AS document_count,
         COALESCE(doc_stats.uploaded_keys, ARRAY[]::text[]) AS uploaded_keys,
         prev_sub.submission_version AS prev_submission_version,
         prev_sub.status AS prev_status,
         prev_sub.reviewed_at AS prev_reviewed_at,
         prev_sub.owner_feedback_reason AS prev_feedback_reason,
         owner_info.seller_account_id AS owner_seller_account_id,
         owner_info.email AS owner_email,
         owner_info.is_email_verified AS owner_is_email_verified
       FROM store_onboarding_profiles sop
       JOIN store_kyc_submissions sub ON sub.id = sop.current_submission_id
       JOIN merchants m ON m.id = sop.merchant_id
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*)::int AS document_count,
           ARRAY_AGG(DISTINCT kd.requirement_key) AS uploaded_keys
         FROM kyc_documents kd
         WHERE kd.submission_id = sub.id
       ) doc_stats ON true
       LEFT JOIN LATERAL (
         SELECT ps.submission_version, ps.status, ps.reviewed_at, ${prevFeedbackLateralCol}
         FROM store_kyc_submissions ps
         WHERE ps.merchant_id = m.id
           AND ps.submission_version < sub.submission_version
           AND ps.status IN ('APPROVED', 'REJECTED', 'MORE_INFO_REQUIRED', 'SUSPENDED')
         ORDER BY ps.submission_version DESC
         LIMIT 1
       ) prev_sub ON true
       LEFT JOIN LATERAL (
         SELECT sa.id AS seller_account_id, sa.email, sa.is_email_verified
         FROM store_memberships sm
         JOIN seller_accounts sa ON sa.id = sm.seller_account_id
         WHERE sm.merchant_id = m.id
           AND sm.role = 'OWNER'
           AND sm.status = 'ACTIVE'
         ORDER BY sm.created_at ASC
         LIMIT 1
       ) owner_info ON true
       ${whereClause}
       ${orderClause}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      listParams
    );

    // Fetch active mandatory requirements in one O(1) lookup to avoid N+1 per-row queries
    const reqCatalogueRes = await merchantPool.query(
      `SELECT requirement_key, category
       FROM kyc_document_requirements
       WHERE is_active = true AND is_mandatory = true
       ORDER BY sort_order ASC, requirement_key ASC`
    );
    const universalMandatoryKeys: string[] = [];
    const categoryMandatoryMap = new Map<string, string[]>();
    for (const rq of reqCatalogueRes.rows) {
      const key = String(rq.requirement_key);
      if (!rq.category) {
        universalMandatoryKeys.push(key);
      } else {
        const cat = String(rq.category).toUpperCase();
        const list = categoryMandatoryMap.get(cat) ?? [];
        list.push(key);
        categoryMandatoryMap.set(cat, list);
      }
    }

    const items: AdminQueueItem[] = listRes.rows.map((r) => {
      const cat = String(r.category).toUpperCase();
      const uploadedKeySet = new Set(
        Array.isArray(r.uploaded_keys) ? r.uploaded_keys.map((k: unknown) => String(k)) : []
      );
      const snapshotReqs = Array.isArray(r.requirements_snapshot)
        ? (r.requirements_snapshot as Array<{ requirementKey?: string; isMandatory?: boolean }>)
          .filter((reqItem) => Boolean(reqItem.isMandatory) && typeof reqItem.requirementKey === 'string')
          .map((reqItem) => String(reqItem.requirementKey))
        : null;
      const mandatoryKeys =
        snapshotReqs && snapshotReqs.length > 0
          ? snapshotReqs
          : [...universalMandatoryKeys, ...(categoryMandatoryMap.get(cat) ?? [])];
      const missingMandatoryKeys = mandatoryKeys.filter((k) => !uploadedKeySet.has(k));
      const subVersion = Number(r.submission_version);

      return {
        storeId: String(r.store_id),
        businessName: String(r.business_name),
        category: cat,
        isOpen: Boolean(r.is_open),
        onboardingStatus: String(r.onboarding_status),
        reverificationRequired: Boolean(r.reverification_required),
        reverificationReason: r.reverification_reason ? String(r.reverification_reason) : null,
        pincode: r.pincode ? String(r.pincode) : null,
        currentLocation: {
          address: r.location_address ? String(r.location_address) : null,
          pincode: r.pincode ? String(r.pincode) : null,
          latitude:
            r.location_latitude !== null && r.location_latitude !== undefined
              ? Number(r.location_latitude)
              : null,
          longitude:
            r.location_longitude !== null && r.location_longitude !== undefined
              ? Number(r.location_longitude)
              : null,
          gpsCapturedAt: r.location_gps_captured_at ? String(r.location_gps_captured_at) : null
        },
        profileUpdatedAt: r.profile_updated_at ? String(r.profile_updated_at) : null,
        isResubmission: subVersion > 1,
        hasPreviousDecision: r.prev_status !== null && r.prev_status !== undefined,
        previousDecision: r.prev_status
          ? {
            submissionVersion: Number(r.prev_submission_version),
            status: String(r.prev_status),
            reviewedAt: r.prev_reviewed_at ? String(r.prev_reviewed_at) : null,
            ownerFeedbackReason: r.prev_feedback_reason ? String(r.prev_feedback_reason) : null
          }
          : null,
        currentSubmission: {
          id: String(r.current_submission_id),
          submissionVersion: subVersion,
          status: String(r.submission_status),
          submittedAt: r.submitted_at ? String(r.submitted_at) : null,
          reviewStartedAt: r.review_started_at ? String(r.review_started_at) : null,
          reviewedAt: r.reviewed_at ? String(r.reviewed_at) : null,
          reviewedByAdminId: r.reviewed_by_admin_id ? String(r.reviewed_by_admin_id) : null,
          isReverification: Boolean(r.is_reverification),
          documentCount: Number(r.document_count ?? 0),
          requiredDocumentSummary: {
            mandatoryRequiredCount: mandatoryKeys.length,
            mandatoryUploadedCount: mandatoryKeys.length - missingMandatoryKeys.length,
            missingMandatoryKeys
          }
        },
        primaryOwner: r.owner_seller_account_id
          ? {
            sellerAccountId: String(r.owner_seller_account_id),
            email: String(r.owner_email),
            isEmailVerified: Boolean(r.owner_is_email_verified)
          }
          : null
      };
    });

    return {
      ok: true,
      data: {
        filterStatus: filterLabel,
        filterCategory: rawCategory ?? null,
        search: rawSearch,
        sort,
        totalCount,
        limit,
        offset,
        statusCounts,
        items
      }
    };
  } catch (err: unknown) {
    const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
    if (mapped.status === 503 || mapped.status === 400) {
      return { ok: false, status: mapped.status as 400 | 503, code: mapped.code, error: mapped.message };
    }
    console.error(`[Admin Queue Error]: ${sanitizeErrorForLog(err)}`);
    return { ok: false, status: 503, code: 'INTERNAL_ERROR', error: 'Unable to fetch onboarding queue.' };
  }
}

/**
 * Read-only Admin store onboarding inspection service (`GET /api/v1/admin/onboarding/stores/:storeId`).
 * Does NOT mutate DB state, does NOT alter onboarding status, and omits `storage_key`,
 * filesystem paths, and Seller password hashes.
 */
export async function getAdminStoreOnboardingDetails(
  merchantPool: StrictPgPool,
  storeId: string
): Promise<AdminServiceResult<AdminStoreOnboardingDetails>> {
  const normalizedStoreId = typeof storeId === 'string' ? storeId.trim() : '';
  if (!STORE_UUID_REGEX.test(normalizedStoreId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid store UUID is required.' };
  }

  try {
    const storeRes = await merchantPool.query(
      `SELECT id, business_name, category, is_open, address, pincode, latitude, longitude, created_at
       FROM merchants
       WHERE id = $1
       LIMIT 1`,
      [normalizedStoreId]
    );
    if (storeRes.rows.length === 0) {
      return { ok: false, status: 404, code: 'STORE_NOT_FOUND', error: 'Merchant store not found.' };
    }
    const storeRow = storeRes.rows[0] as Record<string, unknown>;

    const profileRes = await merchantPool.query(
      `SELECT id, merchant_id, business_name, category, business_type,
              business_type_confirmed, fixed_premises_confirmed, premises_ownership_type,
              address, pincode, latitude, longitude, gps_captured_at, gps_accuracy_meters,
              status, current_submission_id, draft_submission_id, approved_submission_id,
              reverification_required, reverification_reason,
              approved_address, approved_pincode, approved_latitude, approved_longitude, approved_at,
              created_at, updated_at
       FROM store_onboarding_profiles
       WHERE merchant_id = $1
       LIMIT 1`,
      [normalizedStoreId]
    );
    const pRow = (profileRes.rows[0] ?? null) as Record<string, unknown> | null;

    const membershipRes = await merchantPool.query(
      `SELECT sm.id AS membership_id, sm.role, sm.status AS membership_status,
              sa.id AS seller_account_id, sa.email, sa.is_email_verified, sa.status AS account_status
       FROM store_memberships sm
       JOIN seller_accounts sa ON sa.id = sm.seller_account_id
       WHERE sm.merchant_id = $1
       ORDER BY CASE sm.role WHEN 'OWNER' THEN 0 ELSE 1 END, sm.created_at ASC`,
      [normalizedStoreId]
    );

    const mob2Caps = await detectMob2Capabilities(merchantPool);
    const reviewSubSelect = mob2Caps.hasReviewCols
      ? `review_started_at, reviewed_at, reviewed_by_admin_id,
         review_notes, review_checklist, owner_feedback_reason,
         requested_requirements, rejection_category,`
      : `NULL::timestamptz AS review_started_at, reviewed_at, reviewed_by_admin_id,
         review_notes, NULL::jsonb AS review_checklist, NULL::text AS owner_feedback_reason,
         NULL::jsonb AS requested_requirements, NULL::varchar AS rejection_category,`;

    const submissionsRes = await merchantPool.query(
      `SELECT id, submission_version, status, submitted_by_seller_account_id,
              business_name_snapshot, category_snapshot, business_type_snapshot,
              fixed_premises_confirmed_snapshot, address_snapshot, pincode_snapshot,
              latitude_snapshot, longitude_snapshot, gps_captured_at_snapshot,
              gps_accuracy_meters_snapshot, submitted_requirements_version,
              requirements_snapshot, seller_contact_snapshot, is_reverification,
              submitted_at, ${reviewSubSelect}
              created_at, updated_at
       FROM store_kyc_submissions
       WHERE merchant_id = $1
       ORDER BY submission_version DESC`,
      [normalizedStoreId]
    );

    // Deliberately exclude `storage_key` and internal `metadata` paths
    const docsRes = await merchantPool.query(
      `SELECT id, submission_id, requirement_key, document_type,
              original_filename_sanitized, mime_type, file_size_bytes,
              sha256_checksum, uploaded_at, is_storefront_photo, is_premises_proof
       FROM kyc_documents
       WHERE merchant_id = $1
       ORDER BY uploaded_at ASC`,
      [normalizedStoreId]
    );

    const auditRes = await merchantPool.query(
      `SELECT id, actor_type, actor_id, event_type, event_metadata, created_at
       FROM store_onboarding_audit_events
       WHERE merchant_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [normalizedStoreId]
    );

    const notifRes = mob2Caps.hasNotifTable
      ? await merchantPool.query(
        `SELECT id, submission_id, submission_version, owner_seller_account_id,
                  event_type, delivery_status, delivery_attempts, created_at, dispatched_at
           FROM owner_notification_events
           WHERE merchant_id = $1
           ORDER BY created_at DESC
           LIMIT 50`,
        [normalizedStoreId]
      )
      : { rows: [] };

    const effectiveCategory = String(pRow?.category || storeRow.category).toUpperCase();
    const reqRes = await getApplicableRequirements(merchantPool, effectiveCategory);
    if (!reqRes.ok) {
      return { ok: false, status: reqRes.status, code: reqRes.code, error: reqRes.error };
    }

    const mappedDocs = docsRes.rows.map((r) => ({
      id: String(r.id),
      submissionId: String(r.submission_id),
      requirementKey: String(r.requirement_key),
      documentType: String(r.document_type),
      originalFilenameSanitized: String(r.original_filename_sanitized),
      mimeType: String(r.mime_type),
      fileSizeBytes: Number(r.file_size_bytes),
      sha256Checksum: String(r.sha256_checksum),
      uploadedAt: String(r.uploaded_at),
      isStorefrontPhoto: Boolean(r.is_storefront_photo),
      isPremisesProof: Boolean(r.is_premises_proof)
    }));

    const activeSubmissionId = (pRow?.current_submission_id || pRow?.draft_submission_id || null) as string | null;
    const activeDocs = activeSubmissionId
      ? mappedDocs.filter((d) => d.submissionId === String(activeSubmissionId))
      : [];
    const uploadedKeys = new Set(activeDocs.map((d) => d.requirementKey));

    const requirements = reqRes.data.map((r) => ({
      ...r,
      fulfilled: uploadedKeys.has(r.requirementKey)
    }));

    const missingRequirements = reqRes.data
      .filter((r) => r.isMandatory && !uploadedKeys.has(r.requirementKey))
      .map((r) => r.requirementKey);

    const lat = pRow && pRow.latitude !== null && pRow.latitude !== undefined ? Number(pRow.latitude) : null;
    const lng = pRow && pRow.longitude !== null && pRow.longitude !== undefined ? Number(pRow.longitude) : null;
    const missingGps = !pRow || !pRow.gps_captured_at || !isValidGps(lat, lng);
    const missingPremisesConfirmation =
      !pRow || !Boolean(pRow.business_type_confirmed) || !Boolean(pRow.fixed_premises_confirmed);
    const missingAddress =
      !pRow || !String(pRow.address ?? '').trim() || !String(pRow.pincode ?? '').trim();

    return {
      ok: true,
      data: {
        store: {
          id: String(storeRow.id),
          businessName: String(storeRow.business_name),
          category: String(storeRow.category).toUpperCase(),
          isOpen: Boolean(storeRow.is_open),
          address: String(storeRow.address),
          pincode: String(storeRow.pincode),
          latitude: Number(storeRow.latitude),
          longitude: Number(storeRow.longitude),
          createdAt: String(storeRow.created_at)
        },
        profile: pRow
          ? {
            id: String(pRow.id),
            status: String(pRow.status),
            businessType: String(pRow.business_type),
            businessTypeConfirmed: Boolean(pRow.business_type_confirmed),
            fixedPremisesConfirmed: Boolean(pRow.fixed_premises_confirmed),
            premisesOwnershipType: pRow.premises_ownership_type ? String(pRow.premises_ownership_type) : null,
            address: pRow.address ? String(pRow.address) : null,
            pincode: pRow.pincode ? String(pRow.pincode) : null,
            latitude: lat,
            longitude: lng,
            gpsCapturedAt: pRow.gps_captured_at ? String(pRow.gps_captured_at) : null,
            gpsAccuracyMeters:
              pRow.gps_accuracy_meters !== null && pRow.gps_accuracy_meters !== undefined
                ? Number(pRow.gps_accuracy_meters)
                : null,
            currentSubmissionId: pRow.current_submission_id ? String(pRow.current_submission_id) : null,
            draftSubmissionId: pRow.draft_submission_id ? String(pRow.draft_submission_id) : null,
            approvedSubmissionId: pRow.approved_submission_id ? String(pRow.approved_submission_id) : null,
            reverificationRequired: Boolean(pRow.reverification_required),
            reverificationReason: pRow.reverification_reason ? String(pRow.reverification_reason) : null,
            approvedAddress: pRow.approved_address ? String(pRow.approved_address) : null,
            approvedPincode: pRow.approved_pincode ? String(pRow.approved_pincode) : null,
            approvedLatitude:
              pRow.approved_latitude !== null && pRow.approved_latitude !== undefined
                ? Number(pRow.approved_latitude)
                : null,
            approvedLongitude:
              pRow.approved_longitude !== null && pRow.approved_longitude !== undefined
                ? Number(pRow.approved_longitude)
                : null,
            approvedAt: pRow.approved_at ? String(pRow.approved_at) : null,
            createdAt: String(pRow.created_at),
            updatedAt: String(pRow.updated_at)
          }
          : null,
        memberships: membershipRes.rows.map((m) => ({
          membershipId: String(m.membership_id),
          sellerAccountId: String(m.seller_account_id),
          email: String(m.email),
          isEmailVerified: Boolean(m.is_email_verified),
          accountStatus: String(m.account_status),
          role: String(m.role),
          membershipStatus: String(m.membership_status)
        })),
        requirements,
        prerequisiteCheck: {
          hasProfile: Boolean(pRow),
          hasCurrentSubmission: Boolean(pRow?.current_submission_id),
          missingRequirements,
          missingGps,
          missingPremisesConfirmation,
          missingAddress
        },
        submissions: submissionsRes.rows.map((s) => ({
          id: String(s.id),
          submissionVersion: Number(s.submission_version),
          status: String(s.status),
          submittedBySellerAccountId: String(s.submitted_by_seller_account_id),
          businessNameSnapshot: String(s.business_name_snapshot),
          categorySnapshot: String(s.category_snapshot),
          businessTypeSnapshot: String(s.business_type_snapshot),
          fixedPremisesConfirmedSnapshot: Boolean(s.fixed_premises_confirmed_snapshot),
          addressSnapshot: String(s.address_snapshot),
          pincodeSnapshot: String(s.pincode_snapshot),
          latitudeSnapshot:
            s.latitude_snapshot !== null && s.latitude_snapshot !== undefined ? Number(s.latitude_snapshot) : null,
          longitudeSnapshot:
            s.longitude_snapshot !== null && s.longitude_snapshot !== undefined ? Number(s.longitude_snapshot) : null,
          gpsCapturedAtSnapshot: s.gps_captured_at_snapshot ? String(s.gps_captured_at_snapshot) : null,
          gpsAccuracyMetersSnapshot:
            s.gps_accuracy_meters_snapshot !== null && s.gps_accuracy_meters_snapshot !== undefined
              ? Number(s.gps_accuracy_meters_snapshot)
              : null,
          submittedRequirementsVersion: Number(s.submitted_requirements_version ?? 1),
          requirementsSnapshot: s.requirements_snapshot ?? null,
          sellerContactSnapshot: s.seller_contact_snapshot ?? null,
          isReverification: Boolean(s.is_reverification),
          submittedAt: s.submitted_at ? String(s.submitted_at) : null,
          reviewStartedAt: s.review_started_at ? String(s.review_started_at) : null,
          reviewedAt: s.reviewed_at ? String(s.reviewed_at) : null,
          reviewedByAdminId: s.reviewed_by_admin_id ? String(s.reviewed_by_admin_id) : null,
          reviewNotes: s.review_notes ? String(s.review_notes) : null,
          reviewChecklist: s.review_checklist ?? null,
          ownerFeedbackReason: s.owner_feedback_reason ? String(s.owner_feedback_reason) : null,
          requestedRequirements: Array.isArray(s.requested_requirements)
            ? s.requested_requirements.map((item: unknown) => String(item))
            : null,
          rejectionCategory: s.rejection_category ? String(s.rejection_category) : null,
          createdAt: String(s.created_at),
          updatedAt: String(s.updated_at)
        })),
        documents: mappedDocs,
        auditEvents: auditRes.rows.map((a) => ({
          id: String(a.id),
          actorType: String(a.actor_type),
          actorId: a.actor_id ? String(a.actor_id) : null,
          eventType: String(a.event_type),
          eventMetadata: a.event_metadata ?? null,
          createdAt: String(a.created_at)
        })),
        ownerNotificationEvents: notifRes.rows.map((n) => ({
          id: String(n.id),
          submissionId: n.submission_id ? String(n.submission_id) : null,
          submissionVersion:
            n.submission_version !== null && n.submission_version !== undefined
              ? Number(n.submission_version)
              : null,
          ownerSellerAccountId: String(n.owner_seller_account_id),
          eventType: String(n.event_type),
          deliveryStatus: String(n.delivery_status),
          deliveryAttempts: Number(n.delivery_attempts ?? 0),
          createdAt: String(n.created_at),
          dispatchedAt: n.dispatched_at ? String(n.dispatched_at) : null
        }))
      }
    };
  } catch (err: unknown) {
    const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
    if (mapped.status === 503 || mapped.status === 400) {
      return { ok: false, status: mapped.status as 400 | 503, code: mapped.code, error: mapped.message };
    }
    console.error(`[Admin Store Inspection Error]: ${sanitizeErrorForLog(err)}`);
    return { ok: false, status: 503, code: 'INTERNAL_ERROR', error: 'Unable to fetch store onboarding details.' };
  }
}
