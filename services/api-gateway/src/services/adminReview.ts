import { StrictPgClient, StrictPgPool, withPgTransaction } from '../db/postgres';
import {
  computeSha256,
  detectMimeFromMagicBytes,
  KYC_ALLOWED_MIME_TYPES,
  KycDocumentStorage,
  KycStorageNotFoundError,
  KycStorageUnavailableError,
  KycStorageValidationError
} from '../storage/kycDocumentStorage';
import { ALLOWED_STORE_CATEGORIES, getApplicableRequirements } from './onboarding';
import { STORE_UUID_REGEX } from './sellerRbac';
import { classifyHttpError, sanitizeErrorForLog } from '../utils/infraErrors';
import { AdminServiceResult } from './adminAuth';

// =========================================================================
// MO-B2: Administrative Document Verification, Checklist Validation &
//        Submission Review Decisions (with Transactional Outbox)
//
// Invariants:
//   - Only authenticated ACTIVE Admins (`req.adminAuth`) may invoke decisions
//     or stream KYC documents; reviewer ID never comes from request body/query.
//   - Approval strictly enforces mandatory physical-shop checks + submission's
//     captured `requirements_snapshot` (never invents blanket GST).
//   - `store_kyc_submissions` + `store_onboarding_profiles` + `merchants` rows
//     are locked via `FOR UPDATE` to prevent race conditions or stale approvals.
//   - Store approval NEVER automatically sets `merchants.is_open = true`.
//   - Decision transactions write an append-only audit event AND a durable
//     outbox row in `owner_notification_events` without depending on SMTP.
// =========================================================================

export const ALLOWED_REJECTION_CATEGORIES = new Set<string>([
  'INVALID_DOCUMENT',
  'MISSING_REQUIRED_DOCUMENT',
  'UNVERIFIED_PREMISES',
  'INELIGIBLE_BUSINESS_TYPE',
  'LOCATION_MISMATCH',
  'IDENTITY_MISMATCH',
  'INCONSISTENT_INFORMATION',
  'OTHER'
]);

const ADDITIONAL_REQUESTABLE_TOPICS = new Set<string>([
  'STOREFRONT_LOCATION',
  'GPS_COORDINATES',
  'SHOP_ADDRESS',
  'PREMISES_CONFIRMATION'
]);

export interface AdminReviewChecklistInput {
  sellerIdentityReviewed: boolean;
  businessNameAndCategoryConfirmed: boolean;
  fixedPhysicalShopConfirmed: boolean;
  gpsLocationChecked: boolean;
  storefrontPhotosInspected: boolean;
  premisesEvidenceChecked: boolean;
  categoryDocumentsChecked: boolean;
  informationConsistent: boolean;
  noUnresolvedDiscrepancy: boolean;
  confirmedRequirementKeys: string[];
}

export interface AdminDocumentStreamResult {
  buffer: Buffer;
  mimeType: string;
  originalFilenameSanitized: string;
  sha256Checksum: string;
  documentId: string;
  submissionId: string;
  merchantId: string;
  requirementKey: string;
}

export interface ReviewDecisionOutcome {
  storeId: string;
  submissionId: string;
  submissionVersion: number;
  previousStatus: string;
  newStatus: string;
  reviewedByAdminId: string;
  reviewedAt: string;
  storeOnboardingStatus: string;
  isOpen: boolean;
  notificationEventId: string | null;
}

const REQUIRED_CHECKLIST_FLAGS: ReadonlyArray<{
  key: keyof Omit<AdminReviewChecklistInput, 'confirmedRequirementKeys'>;
  label: string;
}> = [
  { key: 'sellerIdentityReviewed', label: 'Seller and business identity reviewed' },
  { key: 'businessNameAndCategoryConfirmed', label: 'Business name and category confirmed' },
  { key: 'fixedPhysicalShopConfirmed', label: 'Fixed physical shop premises confirmed' },
  { key: 'gpsLocationChecked', label: 'GPS location evidence checked' },
  { key: 'storefrontPhotosInspected', label: 'Storefront photographs inspected' },
  { key: 'premisesEvidenceChecked', label: 'Premises occupancy evidence checked' },
  { key: 'categoryDocumentsChecked', label: 'Category-specific mandatory documents checked' },
  { key: 'informationConsistent', label: 'Submitted information is consistent' },
  { key: 'noUnresolvedDiscrepancy', label: 'No unresolved material discrepancy' }
];

function toIsoTimestamp(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const parsed = new Date(val);
    return Number.isNaN(parsed.getTime()) ? val : parsed.toISOString();
  }
  return new Date().toISOString();
}

function normalizeOptionalReviewNotes(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'reviewNotes must be a string when provided.' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > 2000) {
    return { ok: false, error: 'reviewNotes must be at most 2000 characters.' };
  }
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
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
 * Validates that every required Admin verification flag and every applicable mandatory
 * requirement key from the submission's snapshot is explicitly confirmed prior to approval.
 */
export function validateStructuredReviewChecklist(
  rawChecklist: unknown,
  expectedMandatoryKeys: readonly string[]
): { ok: true; checklist: AdminReviewChecklistInput } | { ok: false; error: string } {
  if (!rawChecklist || typeof rawChecklist !== 'object' || Array.isArray(rawChecklist)) {
    return { ok: false, error: 'Structured verification checklist object is required for approval.' };
  }

  const obj = rawChecklist as Record<string, unknown>;
  const missingFlags: string[] = [];
  for (const field of REQUIRED_CHECKLIST_FLAGS) {
    if (obj[field.key] !== true) {
      missingFlags.push(field.key);
    }
  }
  if (missingFlags.length > 0) {
    return {
      ok: false,
      error: `Approval blocked: incomplete verification checklist items (${missingFlags.join(', ')}).`
    };
  }

  if (!Array.isArray(obj.confirmedRequirementKeys)) {
    return {
      ok: false,
      error: 'confirmedRequirementKeys array is required in checklist.'
    };
  }

  const normalizedConfirmed = Array.from(
    new Set(
      obj.confirmedRequirementKeys
        .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        .map((k) => k.trim().toUpperCase())
    )
  );
  const confirmedSet = new Set(normalizedConfirmed);
  const missingRequirementConfirmations = expectedMandatoryKeys.filter((k) => !confirmedSet.has(k));

  if (missingRequirementConfirmations.length > 0) {
    return {
      ok: false,
      error: `Approval blocked: mandatory requirement confirmations missing (${missingRequirementConfirmations.join(', ')}).`
    };
  }

  return {
    ok: true,
    checklist: {
      sellerIdentityReviewed: true,
      businessNameAndCategoryConfirmed: true,
      fixedPhysicalShopConfirmed: true,
      gpsLocationChecked: true,
      storefrontPhotosInspected: true,
      premisesEvidenceChecked: true,
      categoryDocumentsChecked: true,
      informationConsistent: true,
      noUnresolvedDiscrepancy: true,
      confirmedRequirementKeys: normalizedConfirmed
    }
  };
}

async function resolveOwnerSellerAccountId(
  client: StrictPgClient,
  merchantId: string,
  fallbackSellerAccountId: string
): Promise<string> {
  const ownerRes = await client.query(
    `SELECT sm.seller_account_id
     FROM store_memberships sm
     JOIN seller_accounts sa ON sa.id = sm.seller_account_id
     WHERE sm.merchant_id = $1
       AND sm.role = 'OWNER'
       AND sm.status = 'ACTIVE'
       AND sa.status = 'ACTIVE'
     ORDER BY sm.created_at ASC
     LIMIT 1`,
    [merchantId]
  );
  if (ownerRes.rows.length > 0 && ownerRes.rows[0].seller_account_id) {
    return String(ownerRes.rows[0].seller_account_id);
  }
  return fallbackSellerAccountId;
}

async function insertAdminReviewAuditEvent(
  client: StrictPgClient | Pick<StrictPgPool, 'query'>,
  params: {
    merchantId: string;
    adminId: string;
    eventType: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO store_onboarding_audit_events
       (merchant_id, actor_type, actor_id, event_type, event_metadata)
     VALUES ($1, 'ADMIN', $2, $3, $4::jsonb)`,
    [params.merchantId, params.adminId, params.eventType, JSON.stringify(params.metadata)]
  );
}

async function insertOwnerNotificationEvent(
  client: StrictPgClient,
  params: {
    merchantId: string;
    submissionId: string;
    submissionVersion: number;
    ownerSellerAccountId: string;
    eventType: 'ONBOARDING_APPROVED' | 'ONBOARDING_MORE_INFO_REQUIRED' | 'ONBOARDING_REJECTED';
    payload: Record<string, unknown>;
  }
): Promise<string> {
  const ins = await client.query(
    `INSERT INTO owner_notification_events
       (merchant_id, submission_id, submission_version, owner_seller_account_id, event_type, payload, delivery_status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PENDING')
     RETURNING id`,
    [
      params.merchantId,
      params.submissionId,
      params.submissionVersion,
      params.ownerSellerAccountId,
      params.eventType,
      JSON.stringify(params.payload)
    ]
  );
  return String(ins.rows[0].id);
}

interface LockedUnderReviewContext {
  sub: Record<string, unknown>;
  profile: Record<string, unknown>;
  merchant: Record<string, unknown>;
  merchantId: string;
  submissionVersion: number;
}

async function lockEligibleUnderReviewSubmission(
  client: StrictPgClient,
  submissionId: string,
  adminId: string
): Promise<AdminServiceResult<LockedUnderReviewContext>> {
  const subLock = await client.query(
    `SELECT *
     FROM store_kyc_submissions
     WHERE id = $1
     FOR UPDATE`,
    [submissionId]
  );
  if (subLock.rows.length === 0) {
    return { ok: false, status: 404, code: 'SUBMISSION_NOT_FOUND', error: 'KYC submission not found.' };
  }
  const sub = subLock.rows[0] as Record<string, unknown>;
  const merchantId = String(sub.merchant_id);
  const submissionVersion = Number(sub.submission_version);

  const merchLock = await client.query(
    `SELECT id, business_name, category, is_open
     FROM merchants
     WHERE id = $1
     FOR UPDATE`,
    [merchantId]
  );
  if (merchLock.rows.length === 0) {
    return { ok: false, status: 404, code: 'STORE_NOT_FOUND', error: 'Merchant store not found.' };
  }

  const profLock = await client.query(
    `SELECT *
     FROM store_onboarding_profiles
     WHERE merchant_id = $1
     FOR UPDATE`,
    [merchantId]
  );
  if (profLock.rows.length === 0) {
    return {
      ok: false,
      status: 409,
      code: 'ONBOARDING_PROFILE_MISSING',
      error: 'Store onboarding profile not found.'
    };
  }
  const profile = profLock.rows[0] as Record<string, unknown>;

  // Reject stale/superseded submission versions even if an old tab attempts a review action
  const newerRes = await client.query(
    `SELECT id
     FROM store_kyc_submissions
     WHERE merchant_id = $1
       AND submission_version > $2
       AND status <> 'DRAFT'
     LIMIT 1`,
    [merchantId, submissionVersion]
  );
  if (
    newerRes.rows.length > 0 ||
    (profile.current_submission_id && String(profile.current_submission_id) !== submissionId)
  ) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_SUBMISSION',
      error: 'This submission has been superseded by a newer application version and can no longer be reviewed.'
    };
  }

  const subStatus = String(sub.status);
  const profStatus = String(profile.status);

  if (
    subStatus === 'APPROVED' ||
    subStatus === 'REJECTED' ||
    subStatus === 'MORE_INFO_REQUIRED' ||
    subStatus === 'SUSPENDED'
  ) {
    return {
      ok: false,
      status: 409,
      code: 'DECISION_ALREADY_RECORDED',
      error: `A decision ('${subStatus}') has already been recorded for this submission version.`
    };
  }

  if (subStatus !== 'UNDER_REVIEW' || profStatus !== 'UNDER_REVIEW') {
    return {
      ok: false,
      status: 409,
      code: subStatus === 'SUBMITTED' ? 'REVIEW_NOT_STARTED' : 'INVALID_SUBMISSION_STATE',
      error:
        subStatus === 'SUBMITTED'
          ? 'Review must be started before recording a final decision.'
          : `Decision not permitted while submission status is '${subStatus}'.`
    };
  }

  if (sub.reviewed_by_admin_id && String(sub.reviewed_by_admin_id) !== adminId) {
    return {
      ok: false,
      status: 409,
      code: 'REVIEW_CLAIMED_BY_ANOTHER_ADMIN',
      error: 'This submission is currently claimed under review by another administrator.'
    };
  }

  return {
    ok: true,
    data: {
      sub,
      profile,
      merchant: merchLock.rows[0] as Record<string, unknown>,
      merchantId,
      submissionVersion
    }
  };
}

function mapReviewTxError<T>(err: unknown, context: string): AdminServiceResult<T> {
  const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
  if (mapped.status === 503 || mapped.status === 400 || mapped.status === 409) {
    return { ok: false, status: mapped.status as 400 | 409 | 503, code: mapped.code, error: mapped.message };
  }
  console.error(`[AdminReview:${context}] Unexpected error: ${sanitizeErrorForLog(err)}`);
  return { ok: false, status: 503, code: 'INTERNAL_ERROR', error: 'Unable to complete administrative review action.' };
}

// -------------------------------------------------------------------------
// 1. Protected Document Inspection with Checksum Verification & Audit
// -------------------------------------------------------------------------

export async function retrieveAdminSubmissionDocumentContent(
  merchantPool: StrictPgPool,
  kycStorage: KycDocumentStorage,
  params: { submissionId: string; documentId: string; adminId: string }
): Promise<AdminServiceResult<AdminDocumentStreamResult> | { ok: false; status: 422; code: string; error: string }> {
  const submissionId = typeof params.submissionId === 'string' ? params.submissionId.trim() : '';
  const documentId = typeof params.documentId === 'string' ? params.documentId.trim() : '';

  if (!STORE_UUID_REGEX.test(submissionId) || !STORE_UUID_REGEX.test(documentId)) {
    return { ok: false, status: 400, code: 'INVALID_IDENTIFIER', error: 'Valid submissionId and documentId UUIDs are required.' };
  }

  try {
    const docRes = await merchantPool.query(
      `SELECT d.id, d.submission_id, d.merchant_id, d.requirement_key, d.document_type,
              d.original_filename_sanitized, d.storage_key, d.mime_type,
              d.file_size_bytes, d.sha256_checksum, s.submission_version
       FROM kyc_documents d
       JOIN store_kyc_submissions s ON s.id = d.submission_id
       WHERE d.id = $1 AND d.submission_id = $2
       LIMIT 1`,
      [documentId, submissionId]
    );

    if (docRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        code: 'DOCUMENT_NOT_FOUND',
        error: 'Document not found for the specified submission.'
      };
    }

    const row = docRes.rows[0] as Record<string, unknown>;
    const merchantId = String(row.merchant_id);
    const recordedMime = String(row.mime_type).trim().toLowerCase();
    const expectedSize = Number(row.file_size_bytes);
    const expectedSha256 = String(row.sha256_checksum);
    const requirementKey = String(row.requirement_key);
    const documentType = String(row.document_type);
    const submissionVersion = Number(row.submission_version);

    const buffer = await kycStorage.retrieve(String(row.storage_key));
    const actualSha256 = computeSha256(buffer);
    const detectedMime = detectMimeFromMagicBytes(buffer);

    if (
      actualSha256 !== expectedSha256 ||
      buffer.length !== expectedSize ||
      !KYC_ALLOWED_MIME_TYPES.has(recordedMime) ||
      detectedMime !== recordedMime
    ) {
      await insertAdminReviewAuditEvent(merchantPool, {
        merchantId,
        adminId: params.adminId,
        eventType: 'ADMIN_DOCUMENT_INTEGRITY_FAILURE',
        metadata: {
          adminAccountId: params.adminId,
          storeId: merchantId,
          submissionId,
          submissionVersion,
          documentId,
          requirementKey,
          expectedSizeBytes: expectedSize,
          actualSizeBytes: buffer.length,
          checksumMismatch: actualSha256 !== expectedSha256,
          mimeMismatch: detectedMime !== recordedMime,
          timestamp: new Date().toISOString()
        }
      });

      return {
        ok: false,
        status: 422,
        code: 'DOCUMENT_CHECKSUM_MISMATCH',
        error: 'Stored document failed integrity checksum or content-type verification.'
      };
    }

    await insertAdminReviewAuditEvent(merchantPool, {
      merchantId,
      adminId: params.adminId,
      eventType: 'ADMIN_DOCUMENT_VIEWED',
      metadata: {
        adminAccountId: params.adminId,
        storeId: merchantId,
        submissionId,
        submissionVersion,
        documentId,
        requirementKey,
        documentType,
        mimeType: recordedMime,
        timestamp: new Date().toISOString()
      }
    });

    return {
      ok: true,
      data: {
        buffer,
        mimeType: recordedMime,
        originalFilenameSanitized: String(row.original_filename_sanitized),
        sha256Checksum: expectedSha256,
        documentId,
        submissionId,
        merchantId,
        requirementKey
      }
    };
  } catch (err: unknown) {
    if (err instanceof KycStorageNotFoundError) {
      return { ok: false, status: 404, code: err.code, error: 'Stored document file does not exist.' };
    }
    if (err instanceof KycStorageUnavailableError) {
      return { ok: false, status: 503, code: err.code, error: err.message };
    }
    if (err instanceof KycStorageValidationError) {
      return { ok: false, status: 400, code: err.code, error: err.message };
    }
    return mapReviewTxError(err, 'retrieveAdminSubmissionDocumentContent');
  }
}

// -------------------------------------------------------------------------
// 2. Start Review (`SUBMITTED` -> `UNDER_REVIEW`)
// -------------------------------------------------------------------------

export async function startSubmissionReview(
  merchantPool: StrictPgPool,
  params: { submissionId: string; adminId: string; reviewNotes?: unknown }
): Promise<AdminServiceResult<ReviewDecisionOutcome>> {
  const submissionId = typeof params.submissionId === 'string' ? params.submissionId.trim() : '';
  if (!STORE_UUID_REGEX.test(submissionId)) {
    return { ok: false, status: 400, code: 'INVALID_SUBMISSION_ID', error: 'Valid submission UUID is required.' };
  }

  const notesCheck = normalizeOptionalReviewNotes(params.reviewNotes);
  if (!notesCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_REVIEW_NOTES', error: notesCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const subLock = await client.query(
        `SELECT id, merchant_id, submission_version, status, reviewed_by_admin_id
         FROM store_kyc_submissions
         WHERE id = $1
         FOR UPDATE`,
        [submissionId]
      );
      if (subLock.rows.length === 0) {
        return { ok: false as const, status: 404 as const, code: 'SUBMISSION_NOT_FOUND', error: 'KYC submission not found.' };
      }
      const sub = subLock.rows[0] as Record<string, unknown>;
      const merchantId = String(sub.merchant_id);
      const submissionVersion = Number(sub.submission_version);

      const profLock = await client.query(
        `SELECT status, current_submission_id
         FROM store_onboarding_profiles
         WHERE merchant_id = $1
         FOR UPDATE`,
        [merchantId]
      );
      if (profLock.rows.length === 0) {
        return { ok: false as const, status: 409 as const, code: 'ONBOARDING_PROFILE_MISSING', error: 'Store onboarding profile missing.' };
      }
      const profile = profLock.rows[0] as Record<string, unknown>;

      const newerRes = await client.query(
        `SELECT id FROM store_kyc_submissions
         WHERE merchant_id = $1 AND submission_version > $2 AND status <> 'DRAFT' LIMIT 1`,
        [merchantId, submissionVersion]
      );
      if (
        newerRes.rows.length > 0 ||
        (profile.current_submission_id && String(profile.current_submission_id) !== submissionId)
      ) {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'STALE_SUBMISSION',
          error: 'Submission has been superseded by a newer application version.'
        };
      }

      const subStatus = String(sub.status);
      if (subStatus === 'UNDER_REVIEW') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'REVIEW_ALREADY_IN_PROGRESS',
          error: 'Submission is already under review and cannot be silently reassigned.'
        };
      }

      if (subStatus !== 'SUBMITTED' || String(profile.status) !== 'SUBMITTED') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'INVALID_SUBMISSION_STATE',
          error: `Review can only start when status is 'SUBMITTED' (current status: '${subStatus}').`
        };
      }

      const updSub = await client.query(
        `UPDATE store_kyc_submissions
         SET status = 'UNDER_REVIEW',
             reviewed_by_admin_id = $1,
             review_started_at = CURRENT_TIMESTAMP,
             review_notes = COALESCE($2, review_notes),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND status = 'SUBMITTED'
         RETURNING review_started_at, updated_at`,
        [params.adminId, notesCheck.value, submissionId]
      );
      if (updSub.rows.length === 0) {
        return { ok: false as const, status: 409 as const, code: 'REVIEW_ALREADY_IN_PROGRESS', error: 'Submission state changed concurrently.' };
      }

      await client.query(
        `UPDATE store_onboarding_profiles
         SET status = 'UNDER_REVIEW',
             updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = $1`,
        [merchantId]
      );

      const startedAt = toIsoTimestamp(updSub.rows[0].review_started_at ?? updSub.rows[0].updated_at);
      await insertAdminReviewAuditEvent(client, {
        merchantId,
        adminId: params.adminId,
        eventType: 'REVIEW_STARTED',
        metadata: {
          adminAccountId: params.adminId,
          storeId: merchantId,
          submissionId,
          submissionVersion,
          previousStatus: 'SUBMITTED',
          newStatus: 'UNDER_REVIEW',
          actionType: 'START_REVIEW',
          timestamp: startedAt
        }
      });

      return {
        ok: true as const,
        data: {
          storeId: merchantId,
          submissionId,
          submissionVersion,
          previousStatus: 'SUBMITTED',
          newStatus: 'UNDER_REVIEW',
          reviewedByAdminId: params.adminId,
          reviewedAt: startedAt,
          storeOnboardingStatus: 'UNDER_REVIEW',
          isOpen: false,
          notificationEventId: null
        }
      };
    });
  } catch (err: unknown) {
    return mapReviewTxError(err, 'startSubmissionReview');
  }
}

// -------------------------------------------------------------------------
// 3. Approve Submission (`UNDER_REVIEW` -> `APPROVED`)
// -------------------------------------------------------------------------

export async function approveSubmissionDecision(
  merchantPool: StrictPgPool,
  params: {
    submissionId: string;
    adminId: string;
    checklist: unknown;
    reviewNotes?: unknown;
  }
): Promise<AdminServiceResult<ReviewDecisionOutcome>> {
  const submissionId = typeof params.submissionId === 'string' ? params.submissionId.trim() : '';
  if (!STORE_UUID_REGEX.test(submissionId)) {
    return { ok: false, status: 400, code: 'INVALID_SUBMISSION_ID', error: 'Valid submission UUID is required.' };
  }

  const notesCheck = normalizeOptionalReviewNotes(params.reviewNotes);
  if (!notesCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_REVIEW_NOTES', error: notesCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await lockEligibleUnderReviewSubmission(client, submissionId, params.adminId);
      if (!lockRes.ok) return lockRes;
      const { sub, merchant, merchantId, submissionVersion } = lockRes.data;

      // Verify submission snapshot meets physical shop and contact prerequisites
      const category = String(sub.category_snapshot || '').trim().toUpperCase();
      const address = String(sub.address_snapshot || '').trim();
      const pincode = String(sub.pincode_snapshot || '').trim();
      const lat = sub.latitude_snapshot !== null && sub.latitude_snapshot !== undefined ? Number(sub.latitude_snapshot) : null;
      const lng = sub.longitude_snapshot !== null && sub.longitude_snapshot !== undefined ? Number(sub.longitude_snapshot) : null;
      const contactSnap = (sub.seller_contact_snapshot ?? {}) as Record<string, unknown>;

      if (
        String(sub.business_type_snapshot) !== 'FIXED_SHOP' ||
        !Boolean(sub.fixed_premises_confirmed_snapshot) ||
        !ALLOWED_STORE_CATEGORIES.has(category) ||
        !address ||
        !pincode ||
        !isValidGps(lat, lng) ||
        contactSnap.isEmailVerified !== true
      ) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'APPROVAL_PREREQUISITES_UNMET',
          error: 'Submission lacks required physical shop confirmation, GPS coordinates, address, or verified Seller identity.'
        };
      }

      // Derive mandatory requirements strictly from captured `requirements_snapshot` (fallback to active category catalog)
      let expectedMandatoryKeys: string[] = [];
      if (Array.isArray(sub.requirements_snapshot) && sub.requirements_snapshot.length > 0) {
        expectedMandatoryKeys = (sub.requirements_snapshot as Array<{ requirementKey?: string; isMandatory?: boolean }>)
          .filter((r) => Boolean(r.isMandatory) && typeof r.requirementKey === 'string')
          .map((r) => String(r.requirementKey).trim().toUpperCase());
      } else {
        const reqRes = await getApplicableRequirements(merchantPool, category);
        if (!reqRes.ok) return reqRes;
        expectedMandatoryKeys = reqRes.data.filter((r) => r.isMandatory).map((r) => r.requirementKey);
      }

      const checklistCheck = validateStructuredReviewChecklist(params.checklist, expectedMandatoryKeys);
      if (!checklistCheck.ok) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'CHECKLIST_INCOMPLETE',
          error: checklistCheck.error
        };
      }

      // Confirm uploaded documents on this submission fulfill all mandatory requirements & photo rules
      const docsRes = await client.query(
        `SELECT id, requirement_key, is_storefront_photo, is_premises_proof, sha256_checksum
         FROM kyc_documents
         WHERE submission_id = $1 AND merchant_id = $2`,
        [submissionId, merchantId]
      );
      const uploadedKeySet = new Set(docsRes.rows.map((d) => String(d.requirement_key).toUpperCase()));
      const missingDocs = expectedMandatoryKeys.filter((k) => !uploadedKeySet.has(k));
      const storefrontPhotoCount = docsRes.rows.filter((d) => Boolean(d.is_storefront_photo)).length;
      const premisesProofCount = docsRes.rows.filter((d) => Boolean(d.is_premises_proof)).length;

      if (missingDocs.length > 0 || storefrontPhotoCount < 2 || premisesProofCount < 1) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'MISSING_SUBMISSION_EVIDENCE',
          error: `Cannot approve: submission evidence incomplete (${
            missingDocs.length > 0 ? missingDocs.join(', ') : 'storefront photos / premises proof'
          }).`
        };
      }

      const updSub = await client.query(
        `UPDATE store_kyc_submissions
         SET status = 'APPROVED',
             reviewed_by_admin_id = $1,
             reviewed_at = CURRENT_TIMESTAMP,
             review_checklist = $2::jsonb,
             review_notes = COALESCE($3, review_notes),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4 AND status = 'UNDER_REVIEW'
         RETURNING reviewed_at`,
        [params.adminId, JSON.stringify(checklistCheck.checklist), notesCheck.value, submissionId]
      );
      if (updSub.rows.length === 0) {
        return { ok: false as const, status: 409 as const, code: 'DECISION_CONFLICT', error: 'Submission state changed concurrently.' };
      }

      const reviewedAt = toIsoTimestamp(updSub.rows[0].reviewed_at);

      await client.query(
        `UPDATE store_onboarding_profiles
         SET status = 'APPROVED',
             current_submission_id = $1,
             approved_submission_id = $1,
             reverification_required = false,
             reverification_reason = NULL,
             approved_address = $2,
             approved_pincode = $3,
             approved_latitude = $4,
             approved_longitude = $5,
             approved_at = $6::timestamptz,
             updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = $7`,
        [submissionId, address, pincode, lat, lng, reviewedAt, merchantId]
      );

      // Explicitly do NOT set merchants.is_open = true (activation & opening rules belong to MO-C)
      const isOpen = Boolean(merchant.is_open);

      const evidenceDocIds = docsRes.rows.map((d) => String(d.id));
      await insertAdminReviewAuditEvent(client, {
        merchantId,
        adminId: params.adminId,
        eventType: 'ADMIN_APPROVAL_GRANTED',
        metadata: {
          adminAccountId: params.adminId,
          storeId: merchantId,
          submissionId,
          submissionVersion,
          previousStatus: 'UNDER_REVIEW',
          newStatus: 'APPROVED',
          actionType: 'APPROVE',
          checklist: checklistCheck.checklist,
          evidenceDocumentIds: evidenceDocIds,
          approvedAddress: address,
          approvedPincode: pincode,
          timestamp: reviewedAt
        }
      });

      const ownerSellerAccountId = await resolveOwnerSellerAccountId(
        client,
        merchantId,
        String(sub.submitted_by_seller_account_id)
      );
      const notificationEventId = await insertOwnerNotificationEvent(client, {
        merchantId,
        submissionId,
        submissionVersion,
        ownerSellerAccountId,
        eventType: 'ONBOARDING_APPROVED',
        payload: {
          storeId: merchantId,
          businessName: String(sub.business_name_snapshot),
          category,
          submissionId,
          submissionVersion,
          status: 'APPROVED',
          decidedAt: reviewedAt
        }
      });

      return {
        ok: true as const,
        data: {
          storeId: merchantId,
          submissionId,
          submissionVersion,
          previousStatus: 'UNDER_REVIEW',
          newStatus: 'APPROVED',
          reviewedByAdminId: params.adminId,
          reviewedAt,
          storeOnboardingStatus: 'APPROVED',
          isOpen,
          notificationEventId
        }
      };
    });
  } catch (err: unknown) {
    return mapReviewTxError(err, 'approveSubmissionDecision');
  }
}

// -------------------------------------------------------------------------
// 4. Request Additional Information (`UNDER_REVIEW` -> `MORE_INFO_REQUIRED`)
// -------------------------------------------------------------------------

export async function requestMoreInfoSubmissionDecision(
  merchantPool: StrictPgPool,
  params: {
    submissionId: string;
    adminId: string;
    reason: unknown;
    requestedCorrections?: unknown;
    requestedRequirements?: unknown;
    reviewNotes?: unknown;
  }
): Promise<AdminServiceResult<ReviewDecisionOutcome>> {
  const submissionId = typeof params.submissionId === 'string' ? params.submissionId.trim() : '';
  if (!STORE_UUID_REGEX.test(submissionId)) {
    return { ok: false, status: 400, code: 'INVALID_SUBMISSION_ID', error: 'Valid submission UUID is required.' };
  }

  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length < 5 || reason.length > 1000) {
    return {
      ok: false,
      status: 400,
      code: 'REASON_REQUIRED',
      error: 'A clear explanation (5-1000 characters) specifying what is missing or needs correction is required.'
    };
  }

  const correctionsText =
    typeof params.requestedCorrections === 'string' ? params.requestedCorrections.trim() : '';
  if (correctionsText.length > 1000) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CORRECTIONS_TEXT',
      error: 'requestedCorrections must be at most 1000 characters.'
    };
  }

  let requestedReqKeys: string[] = [];
  if (params.requestedRequirements !== undefined) {
    if (!Array.isArray(params.requestedRequirements)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_REQUESTED_REQUIREMENTS',
        error: 'requestedRequirements must be an array of requirement identifiers.'
      };
    }
    requestedReqKeys = Array.from(
      new Set(
        params.requestedRequirements
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim().toUpperCase())
      )
    );
  }

  if (requestedReqKeys.length === 0 && !correctionsText) {
    return {
      ok: false,
      status: 400,
      code: 'CORRECTIONS_REQUIRED',
      error: 'Provide requestedRequirements or requestedCorrections explaining exactly what the Owner must update.'
    };
  }

  const notesCheck = normalizeOptionalReviewNotes(params.reviewNotes);
  if (!notesCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_REVIEW_NOTES', error: notesCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await lockEligibleUnderReviewSubmission(client, submissionId, params.adminId);
      if (!lockRes.ok) return lockRes;
      const { sub, merchantId, submissionVersion } = lockRes.data;
      const category = String(sub.category_snapshot || '').trim().toUpperCase();

      if (requestedReqKeys.length > 0) {
        const reqCatalogRes = await client.query(
          `SELECT requirement_key
           FROM kyc_document_requirements
           WHERE is_active = true AND (category IS NULL OR category = $1)`,
          [category]
        );
        const allowedKeys = new Set(reqCatalogRes.rows.map((r) => String(r.requirement_key).toUpperCase()));
        if (Array.isArray(sub.requirements_snapshot)) {
          for (const snapItem of sub.requirements_snapshot as Array<{ requirementKey?: string }>) {
            if (typeof snapItem?.requirementKey === 'string') {
              allowedKeys.add(snapItem.requirementKey.trim().toUpperCase());
            }
          }
        }
        for (const extra of ADDITIONAL_REQUESTABLE_TOPICS) {
          allowedKeys.add(extra);
        }

        const unknownKeys = requestedReqKeys.filter((k) => !allowedKeys.has(k));
        if (unknownKeys.length > 0) {
          return {
            ok: false as const,
            status: 400 as const,
            code: 'INVALID_REQUIREMENT_KEY',
            error: `Requirement identifier(s) not applicable to category '${category}': ${unknownKeys.join(', ')}.`
          };
        }
      }

      const ownerFeedbackCombined = correctionsText ? `${reason} (${correctionsText})` : reason;

      const updSub = await client.query(
        `UPDATE store_kyc_submissions
         SET status = 'MORE_INFO_REQUIRED',
             reviewed_by_admin_id = $1,
             reviewed_at = CURRENT_TIMESTAMP,
             owner_feedback_reason = $2,
             requested_requirements = $3::jsonb,
             review_notes = COALESCE($4, review_notes),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND status = 'UNDER_REVIEW'
         RETURNING reviewed_at`,
        [
          params.adminId,
          ownerFeedbackCombined,
          JSON.stringify(requestedReqKeys),
          notesCheck.value,
          submissionId
        ]
      );
      if (updSub.rows.length === 0) {
        return { ok: false as const, status: 409 as const, code: 'DECISION_CONFLICT', error: 'Submission state changed concurrently.' };
      }

      const reviewedAt = toIsoTimestamp(updSub.rows[0].reviewed_at);

      await client.query(
        `UPDATE store_onboarding_profiles
         SET status = 'MORE_INFO_REQUIRED',
             updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = $1`,
        [merchantId]
      );

      // Ensure store remains unavailable while incomplete
      await client.query(`UPDATE merchants SET is_open = false WHERE id = $1`, [merchantId]);

      await insertAdminReviewAuditEvent(client, {
        merchantId,
        adminId: params.adminId,
        eventType: 'ONBOARDING_MORE_INFO_REQUIRED',
        metadata: {
          adminAccountId: params.adminId,
          storeId: merchantId,
          submissionId,
          submissionVersion,
          previousStatus: 'UNDER_REVIEW',
          newStatus: 'MORE_INFO_REQUIRED',
          actionType: 'REQUEST_INFORMATION',
          reason: ownerFeedbackCombined,
          requestedRequirements: requestedReqKeys,
          timestamp: reviewedAt
        }
      });

      const ownerSellerAccountId = await resolveOwnerSellerAccountId(
        client,
        merchantId,
        String(sub.submitted_by_seller_account_id)
      );
      const notificationEventId = await insertOwnerNotificationEvent(client, {
        merchantId,
        submissionId,
        submissionVersion,
        ownerSellerAccountId,
        eventType: 'ONBOARDING_MORE_INFO_REQUIRED',
        payload: {
          storeId: merchantId,
          businessName: String(sub.business_name_snapshot),
          category,
          submissionId,
          submissionVersion,
          status: 'MORE_INFO_REQUIRED',
          reason: ownerFeedbackCombined,
          requestedRequirements: requestedReqKeys,
          decidedAt: reviewedAt
        }
      });

      return {
        ok: true as const,
        data: {
          storeId: merchantId,
          submissionId,
          submissionVersion,
          previousStatus: 'UNDER_REVIEW',
          newStatus: 'MORE_INFO_REQUIRED',
          reviewedByAdminId: params.adminId,
          reviewedAt,
          storeOnboardingStatus: 'MORE_INFO_REQUIRED',
          isOpen: false,
          notificationEventId
        }
      };
    });
  } catch (err: unknown) {
    return mapReviewTxError(err, 'requestMoreInfoSubmissionDecision');
  }
}

// -------------------------------------------------------------------------
// 5. Reject Submission (`UNDER_REVIEW` -> `REJECTED`)
// -------------------------------------------------------------------------

export async function rejectSubmissionDecision(
  merchantPool: StrictPgPool,
  params: {
    submissionId: string;
    adminId: string;
    reason: unknown;
    rejectionCategory: unknown;
    reviewNotes?: unknown;
  }
): Promise<AdminServiceResult<ReviewDecisionOutcome>> {
  const submissionId = typeof params.submissionId === 'string' ? params.submissionId.trim() : '';
  if (!STORE_UUID_REGEX.test(submissionId)) {
    return { ok: false, status: 400, code: 'INVALID_SUBMISSION_ID', error: 'Valid submission UUID is required.' };
  }

  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length < 5 || reason.length > 1000) {
    return {
      ok: false,
      status: 400,
      code: 'REASON_REQUIRED',
      error: 'A clear non-empty rejection reason (5-1000 characters) is required.'
    };
  }

  const rejectionCategory =
    typeof params.rejectionCategory === 'string' ? params.rejectionCategory.trim().toUpperCase() : '';
  if (!ALLOWED_REJECTION_CATEGORIES.has(rejectionCategory)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_REJECTION_CATEGORY',
      error: `Valid rejectionCategory is required (${Array.from(ALLOWED_REJECTION_CATEGORIES).join(', ')}).`
    };
  }

  const notesCheck = normalizeOptionalReviewNotes(params.reviewNotes);
  if (!notesCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_REVIEW_NOTES', error: notesCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await lockEligibleUnderReviewSubmission(client, submissionId, params.adminId);
      if (!lockRes.ok) return lockRes;
      const { sub, merchantId, submissionVersion } = lockRes.data;
      const category = String(sub.category_snapshot || '').trim().toUpperCase();

      const updSub = await client.query(
        `UPDATE store_kyc_submissions
         SET status = 'REJECTED',
             reviewed_by_admin_id = $1,
             reviewed_at = CURRENT_TIMESTAMP,
             owner_feedback_reason = $2,
             rejection_category = $3,
             review_notes = COALESCE($4, review_notes),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND status = 'UNDER_REVIEW'
         RETURNING reviewed_at`,
        [params.adminId, reason, rejectionCategory, notesCheck.value, submissionId]
      );
      if (updSub.rows.length === 0) {
        return { ok: false as const, status: 409 as const, code: 'DECISION_CONFLICT', error: 'Submission state changed concurrently.' };
      }

      const reviewedAt = toIsoTimestamp(updSub.rows[0].reviewed_at);

      await client.query(
        `UPDATE store_onboarding_profiles
         SET status = 'REJECTED',
             updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = $1`,
        [merchantId]
      );

      // Keep rejected store unavailable
      await client.query(`UPDATE merchants SET is_open = false WHERE id = $1`, [merchantId]);

      await insertAdminReviewAuditEvent(client, {
        merchantId,
        adminId: params.adminId,
        eventType: 'ONBOARDING_REJECTED',
        metadata: {
          adminAccountId: params.adminId,
          storeId: merchantId,
          submissionId,
          submissionVersion,
          previousStatus: 'UNDER_REVIEW',
          newStatus: 'REJECTED',
          actionType: 'REJECT',
          rejectionCategory,
          reason,
          timestamp: reviewedAt
        }
      });

      const ownerSellerAccountId = await resolveOwnerSellerAccountId(
        client,
        merchantId,
        String(sub.submitted_by_seller_account_id)
      );
      const notificationEventId = await insertOwnerNotificationEvent(client, {
        merchantId,
        submissionId,
        submissionVersion,
        ownerSellerAccountId,
        eventType: 'ONBOARDING_REJECTED',
        payload: {
          storeId: merchantId,
          businessName: String(sub.business_name_snapshot),
          category,
          submissionId,
          submissionVersion,
          status: 'REJECTED',
          rejectionCategory,
          reason,
          decidedAt: reviewedAt
        }
      });

      return {
        ok: true as const,
        data: {
          storeId: merchantId,
          submissionId,
          submissionVersion,
          previousStatus: 'UNDER_REVIEW',
          newStatus: 'REJECTED',
          reviewedByAdminId: params.adminId,
          reviewedAt,
          storeOnboardingStatus: 'REJECTED',
          isOpen: false,
          notificationEventId
        }
      };
    });
  } catch (err: unknown) {
    return mapReviewTxError(err, 'rejectSubmissionDecision');
  }
}
