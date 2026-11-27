import { StrictPgPool, StrictPgClient, withPgTransaction } from '../db/postgres';
import {
  KycDocumentStorage,
  KycStorageNotFoundError,
  KycStorageUnavailableError,
  KycStorageValidationError
} from '../storage/kycDocumentStorage';
import { STORE_UUID_REGEX } from './sellerRbac';
import { classifyHttpError, sanitizeErrorForLog } from '../utils/infraErrors';

// =========================================================================
// MO-A: Merchant Onboarding Service
//
// Operates strictly on Merchant PostgreSQL + KycDocumentStorage.
// Never invents KYC approvals, never reads `merchants.is_verified`, and
// never enables store operations/openness automatically.
// =========================================================================

export type OnboardingStatus =
  | 'PENDING_SUBMISSION'
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'MORE_INFO_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'REVERIFICATION_REQUIRED';

export type PremisesOwnershipType = 'OWNED' | 'RENTED' | 'LEASED';

export const ALLOWED_STORE_CATEGORIES = new Set<string>([
  'GROCERY',
  'SALON',
  'PHARMACY',
  'RESTAURANT',
  'FLORIST',
  'PET_SHOP',
  'HARDWARE',
  'SPORTS',
  'STATIONERY',
  'CLOTHING',
  'ELECTRONICS'
]);

export const MAX_PREMISES_PHOTOS_PER_SUBMISSION = 5;
export const MAX_DOCUMENTS_PER_SUBMISSION = 10;
export const LOCATION_CHANGE_THRESHOLD_METERS = 100;

/** Statuses in which the Store Owner can modify onboarding draft fields. */
const EDITABLE_DRAFT_STATUSES = new Set<OnboardingStatus>([
  'PENDING_SUBMISSION',
  'DRAFT',
  'MORE_INFO_REQUIRED',
  'REJECTED',
  'REVERIFICATION_REQUIRED'
]);

/** Statuses in which the Store Owner can upload/delete draft documents. */
const UPLOADABLE_DRAFT_STATUSES = new Set<OnboardingStatus>([
  'PENDING_SUBMISSION',
  'DRAFT',
  'MORE_INFO_REQUIRED',
  'REJECTED',
  'REVERIFICATION_REQUIRED'
]);

/** Statuses from which a formal submission can be created. */
const SUBMITTABLE_STATUSES = new Set<OnboardingStatus>([
  'PENDING_SUBMISSION',
  'DRAFT',
  'MORE_INFO_REQUIRED',
  'REJECTED',
  'REVERIFICATION_REQUIRED'
]);

export interface OnboardingProfile {
  id: string;
  merchantId: string;
  businessName: string | null;
  category: string | null;
  businessType: 'FIXED_SHOP';
  businessTypeConfirmed: boolean;
  fixedPremisesConfirmed: boolean;
  premisesOwnershipType: PremisesOwnershipType | null;
  address: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  gpsCapturedAt: string | null;
  gpsAccuracyMeters: number | null;
  status: OnboardingStatus;
  currentSubmissionId: string | null;
  draftSubmissionId: string | null;
  approvedSubmissionId: string | null;
  reverificationRequired: boolean;
  reverificationReason: string | null;
  hasApprovedLocationHistory: boolean;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRequirement {
  requirementKey: string;
  category: string | null;
  isMandatory: boolean;
  documentType: string;
  label: string;
  description: string | null;
  sortOrder: number;
  effectiveVersion: number;
}

export interface KycDocumentSummary {
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
}

export interface SubmissionSummary {
  id: string;
  submissionVersion: number;
  status: string;
  businessNameSnapshot: string;
  categorySnapshot: string;
  addressSnapshot: string;
  pincodeSnapshot: string;
  latitudeSnapshot: number | null;
  longitudeSnapshot: number | null;
  submittedRequirementsVersion: number;
  isReverification: boolean;
  feedbackReason: string | null;
  requestedRequirements: string[] | null;
  rejectionCategory: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingDraftUpdate {
  businessName?: string;
  category?: string;
  businessType?: string;
  premisesType?: string;
  operatingModel?: string;
  businessTypeConfirmed?: boolean;
  fixedPremisesConfirmed?: boolean;
  premisesOwnershipType?: string;
  address?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracyMeters?: number;
}

export interface OnboardingOverview {
  profile: OnboardingProfile;
  store: {
    id: string;
    businessName: string;
    category: string;
    isOpen: boolean;
  };
  verificationStatus: {
    status: OnboardingStatus;
    reverificationRequired: boolean;
    reverificationReason: string | null;
  };
  requirements: Array<DocumentRequirement & { fulfilled: boolean }>;
  documents: KycDocumentSummary[];
  latestSubmission: SubmissionSummary | null;
  draftSubmission: SubmissionSummary | null;
  missingRequirements: string[];
  missingGps: boolean;
  missingPremisesConfirmation: boolean;
  missingAddress: boolean;
  availableActions: {
    canEditDraft: boolean;
    canUploadDocuments: boolean;
    canDeleteDraftDocuments: boolean;
    canSubmit: boolean;
    requiresReverification: boolean;
  };
}

export type OnboardingServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 403 | 404 | 409 | 503; code: string; error: string; details?: Record<string, unknown> };

// -------------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------------

/** Calculates great-circle distance in metres between two WGS-84 points. */
export function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeAddress(addr: string | null | undefined): string {
  return typeof addr === 'string' ? addr.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function isDisallowedBusinessType(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  const norm = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return norm !== 'FIXED_SHOP' && norm !== 'PHYSICAL_SHOP' && norm !== 'PHYSICAL_STORE';
}

function isValidGpsCoordinates(lat: number, lng: number): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return false;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return false;
  }
  // Reject exact (0, 0) Null Island coordinates for physical stores
  if (lat === 0 && lng === 0) {
    return false;
  }
  return true;
}

function mapProfileRow(row: Record<string, unknown>): OnboardingProfile {
  return {
    id: String(row.id),
    merchantId: String(row.merchant_id),
    businessName: row.business_name ? String(row.business_name) : null,
    category: row.category ? String(row.category) : null,
    businessType: 'FIXED_SHOP',
    businessTypeConfirmed: Boolean(row.business_type_confirmed),
    fixedPremisesConfirmed: Boolean(row.fixed_premises_confirmed),
    premisesOwnershipType: row.premises_ownership_type
      ? (String(row.premises_ownership_type) as PremisesOwnershipType)
      : null,
    address: row.address ? String(row.address) : null,
    pincode: row.pincode ? String(row.pincode) : null,
    latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
    longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
    gpsCapturedAt: row.gps_captured_at ? String(row.gps_captured_at) : null,
    gpsAccuracyMeters:
      row.gps_accuracy_meters !== null && row.gps_accuracy_meters !== undefined
        ? Number(row.gps_accuracy_meters)
        : null,
    status: row.status as OnboardingStatus,
    currentSubmissionId: row.current_submission_id ? String(row.current_submission_id) : null,
    draftSubmissionId: row.draft_submission_id ? String(row.draft_submission_id) : null,
    approvedSubmissionId: row.approved_submission_id ? String(row.approved_submission_id) : null,
    reverificationRequired: Boolean(row.reverification_required),
    reverificationReason: row.reverification_reason ? String(row.reverification_reason) : null,
    hasApprovedLocationHistory: Boolean(
      row.approved_submission_id ||
      row.approved_address ||
      (row.approved_latitude !== null && row.approved_latitude !== undefined)
    ),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapSubmissionRow(row: Record<string, unknown>): SubmissionSummary {
  return {
    id: String(row.id),
    submissionVersion: Number(row.submission_version),
    status: String(row.status),
    businessNameSnapshot: String(row.business_name_snapshot),
    categorySnapshot: String(row.category_snapshot),
    addressSnapshot: String(row.address_snapshot),
    pincodeSnapshot: String(row.pincode_snapshot),
    latitudeSnapshot:
      row.latitude_snapshot !== null && row.latitude_snapshot !== undefined ? Number(row.latitude_snapshot) : null,
    longitudeSnapshot:
      row.longitude_snapshot !== null && row.longitude_snapshot !== undefined ? Number(row.longitude_snapshot) : null,
    submittedRequirementsVersion: Number(row.submitted_requirements_version ?? 1),
    isReverification: Boolean(row.is_reverification),
    feedbackReason: row.owner_feedback_reason ? String(row.owner_feedback_reason) : null,
    requestedRequirements: Array.isArray(row.requested_requirements)
      ? row.requested_requirements.map((item) => String(item))
      : null,
    rejectionCategory: row.rejection_category ? String(row.rejection_category) : null,
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapDocumentRow(row: Record<string, unknown>): KycDocumentSummary {
  return {
    id: String(row.id),
    submissionId: String(row.submission_id),
    requirementKey: String(row.requirement_key),
    documentType: String(row.document_type),
    originalFilenameSanitized: String(row.original_filename_sanitized),
    mimeType: String(row.mime_type),
    fileSizeBytes: Number(row.file_size_bytes),
    sha256Checksum: String(row.sha256_checksum),
    uploadedAt: String(row.uploaded_at),
    isStorefrontPhoto: Boolean(row.is_storefront_photo),
    isPremisesProof: Boolean(row.is_premises_proof)
  };
}

function mapServiceError<T>(err: unknown, context: string): OnboardingServiceResult<T> {
  const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
  if (mapped.status === 503 || mapped.status === 400 || mapped.status === 409) {
    return { ok: false, status: mapped.status as 400 | 409 | 503, code: mapped.code, error: mapped.message };
  }
  console.error(`[Onboarding:${context}] Unexpected error: ${sanitizeErrorForLog(err)}`);
  return { ok: false, status: 503, code: 'INTERNAL_ERROR', error: 'Internal server error.' };
}

const PROFILE_SELECT_COLS = `
  id, merchant_id, business_name, category, business_type,
  business_type_confirmed, fixed_premises_confirmed, premises_ownership_type,
  address, pincode, latitude, longitude, gps_captured_at, gps_accuracy_meters,
  status, current_submission_id, draft_submission_id, approved_submission_id,
  reverification_required, reverification_reason,
  approved_address, approved_pincode, approved_latitude, approved_longitude, approved_at,
  created_at, updated_at`;

const SUBMISSION_BASE_PUBLIC_COLS = `
  id, submission_version, status, business_name_snapshot, category_snapshot,
  address_snapshot, pincode_snapshot, latitude_snapshot, longitude_snapshot,
  submitted_requirements_version, is_reverification,
  submitted_at, reviewed_at, created_at, updated_at`;

const SUBMISSION_PUBLIC_COLS = `
  id, submission_version, status, business_name_snapshot, category_snapshot,
  address_snapshot, pincode_snapshot, latitude_snapshot, longitude_snapshot,
  submitted_requirements_version, is_reverification,
  owner_feedback_reason, requested_requirements, rejection_category,
  submitted_at, reviewed_at, created_at, updated_at`;

async function resolveSubmissionPublicCols(executor: Pick<StrictPgPool, 'query'>): Promise<string> {
  const res = await executor.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'store_kyc_submissions'
         AND column_name = 'owner_feedback_reason'
     ) AS has_mob2_feedback`
  );
  return res.rows[0]?.has_mob2_feedback ? SUBMISSION_PUBLIC_COLS : SUBMISSION_BASE_PUBLIC_COLS;
}

// -------------------------------------------------------------------------
// Read / overview operations
// -------------------------------------------------------------------------

/**
 * Retrieves applicable active KYC document requirements for a store category
 * (combining universal requirements and category-specific requirements).
 */
export async function getApplicableRequirements(
  merchantPool: Pick<StrictPgPool, 'query'>,
  category: string
): Promise<OnboardingServiceResult<DocumentRequirement[]>> {
  try {
    const res = await merchantPool.query(
      `SELECT requirement_key, category, is_mandatory, document_type, label, description, sort_order, effective_version
       FROM kyc_document_requirements
       WHERE is_active = true
         AND (category IS NULL OR category = $1)
       ORDER BY sort_order ASC, requirement_key ASC`,
      [category.trim().toUpperCase()]
    );

    return {
      ok: true,
      data: res.rows.map((r) => ({
        requirementKey: String(r.requirement_key),
        category: r.category ? String(r.category) : null,
        isMandatory: Boolean(r.is_mandatory),
        documentType: String(r.document_type),
        label: String(r.label),
        description: r.description ? String(r.description) : null,
        sortOrder: Number(r.sort_order),
        effectiveVersion: Number(r.effective_version ?? 1)
      }))
    };
  } catch (err) {
    return mapServiceError(err, 'getApplicableRequirements');
  }
}

/**
 * Fetches or lazily initializes the onboarding profile and complete overview
 * (requirements checklist, current/draft documents, latest submission, missing
 * evidence, and allowed actions) without exposing private paths or admin notes.
 */
export async function getOnboardingOverview(
  merchantPool: StrictPgPool,
  merchantId: string
): Promise<OnboardingServiceResult<OnboardingOverview>> {
  try {
    const merchRes = await merchantPool.query(
      `SELECT id, business_name, category, is_open FROM merchants WHERE id = $1`,
      [merchantId]
    );
    if (merchRes.rows.length === 0) {
      return { ok: false, status: 404, code: 'MERCHANT_NOT_FOUND', error: 'Merchant store not found.' };
    }
    const storeRow = merchRes.rows[0];

    let profileRes = await merchantPool.query(
      `SELECT ${PROFILE_SELECT_COLS} FROM store_onboarding_profiles WHERE merchant_id = $1`,
      [merchantId]
    );
    if (profileRes.rows.length === 0) {
      profileRes = await merchantPool.query(
        `INSERT INTO store_onboarding_profiles (merchant_id, business_name, category, status)
         VALUES ($1, $2, $3, 'PENDING_SUBMISSION')
         ON CONFLICT (merchant_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING ${PROFILE_SELECT_COLS}`,
        [merchantId, String(storeRow.business_name), String(storeRow.category).toUpperCase()]
      );
    }

    const profile = mapProfileRow(profileRes.rows[0]);
    const effectiveCategory = (profile.category || String(storeRow.category)).toUpperCase();
    const effectiveBusinessName = profile.businessName || String(storeRow.business_name);

    const reqRes = await getApplicableRequirements(merchantPool, effectiveCategory);
    if (!reqRes.ok) return reqRes;

    const targetSubId = profile.draftSubmissionId || profile.currentSubmissionId;
    let documents: KycDocumentSummary[] = [];
    if (targetSubId) {
      const docsRes = await merchantPool.query(
        `SELECT id, submission_id, requirement_key, document_type, original_filename_sanitized,
                mime_type, file_size_bytes, sha256_checksum, uploaded_at,
                is_storefront_photo, is_premises_proof
         FROM kyc_documents
         WHERE submission_id = $1 AND merchant_id = $2
         ORDER BY uploaded_at ASC`,
        [targetSubId, merchantId]
      );
      documents = docsRes.rows.map(mapDocumentRow);
    }

    const submissionPublicCols =
      profile.currentSubmissionId || profile.draftSubmissionId
        ? await resolveSubmissionPublicCols(merchantPool)
        : SUBMISSION_BASE_PUBLIC_COLS;

    let latestSubmission: SubmissionSummary | null = null;
    if (profile.currentSubmissionId) {
      const subRes = await merchantPool.query(
        `SELECT ${submissionPublicCols}
         FROM store_kyc_submissions
         WHERE id = $1 AND merchant_id = $2`,
        [profile.currentSubmissionId, merchantId]
      );
      if (subRes.rows.length > 0) {
        latestSubmission = mapSubmissionRow(subRes.rows[0]);
      }
    }

    let draftSubmission: SubmissionSummary | null = null;
    if (profile.draftSubmissionId) {
      const draftRes = await merchantPool.query(
        `SELECT ${submissionPublicCols}
         FROM store_kyc_submissions
         WHERE id = $1 AND merchant_id = $2`,
        [profile.draftSubmissionId, merchantId]
      );
      if (draftRes.rows.length > 0) {
        draftSubmission = mapSubmissionRow(draftRes.rows[0]);
      }
    }

    // Active checklist tracks uploaded items on the current draft (or active submission if none)
    const checklistDocs = profile.draftSubmissionId
      ? documents
      : profile.status === 'REVERIFICATION_REQUIRED'
        ? [] // Old approved docs do not satisfy fresh re-verification checklist
        : documents;

    const uploadedKeys = new Set(checklistDocs.map((d) => d.requirementKey));
    const requirements = reqRes.data.map((r) => ({
      ...r,
      fulfilled: uploadedKeys.has(r.requirementKey)
    }));

    const missingRequirements = reqRes.data
      .filter((r) => r.isMandatory && !uploadedKeys.has(r.requirementKey))
      .map((r) => r.requirementKey);

    const missingGps =
      profile.latitude === null ||
      profile.longitude === null ||
      profile.gpsCapturedAt === null ||
      !isValidGpsCoordinates(profile.latitude, profile.longitude);
    const missingPremisesConfirmation = !profile.businessTypeConfirmed || !profile.fixedPremisesConfirmed;
    const missingAddress = !profile.address?.trim() || !profile.pincode?.trim();

    const canEditDraft = EDITABLE_DRAFT_STATUSES.has(profile.status) || profile.status === 'APPROVED';
    const canUploadDocuments = UPLOADABLE_DRAFT_STATUSES.has(profile.status);
    const canDeleteDraftDocuments = Boolean(profile.draftSubmissionId) && UPLOADABLE_DRAFT_STATUSES.has(profile.status);
    const canSubmit =
      SUBMITTABLE_STATUSES.has(profile.status) &&
      !missingGps &&
      !missingPremisesConfirmation &&
      !missingAddress &&
      missingRequirements.length === 0;

    return {
      ok: true,
      data: {
        profile: {
          ...profile,
          businessName: effectiveBusinessName,
          category: effectiveCategory
        },
        store: {
          id: String(storeRow.id),
          businessName: String(storeRow.business_name),
          category: String(storeRow.category),
          isOpen: Boolean(storeRow.is_open)
        },
        verificationStatus: {
          status: profile.status,
          reverificationRequired: profile.reverificationRequired,
          reverificationReason: profile.reverificationReason
        },
        requirements,
        documents,
        latestSubmission,
        draftSubmission,
        missingRequirements,
        missingGps,
        missingPremisesConfirmation,
        missingAddress,
        availableActions: {
          canEditDraft,
          canUploadDocuments,
          canDeleteDraftDocuments,
          canSubmit,
          requiresReverification: profile.reverificationRequired
        }
      }
    };
  } catch (err) {
    return mapServiceError(err, 'getOnboardingOverview');
  }
}

// -------------------------------------------------------------------------
// Draft editing & location-change re-verification detection
// -------------------------------------------------------------------------

/**
 * Updates editable onboarding draft details for a physical shop store.
 * Validates business category, rejects home-based/mobile vendor models,
 * validates coordinates, and enforces re-verification while preserving old
 * approved location evidence when an APPROVED store alters its address/GPS.
 */
export async function updateOnboardingDraft(
  merchantPool: StrictPgPool,
  merchantId: string,
  sellerAccountId: string,
  update: OnboardingDraftUpdate
): Promise<OnboardingServiceResult<{ profile: OnboardingProfile; locationChangeDetected: boolean }>> {
  if (
    isDisallowedBusinessType(update.businessType) ||
    isDisallowedBusinessType(update.premisesType) ||
    isDisallowedBusinessType(update.operatingModel)
  ) {
    return {
      ok: false,
      status: 400,
      code: 'INELIGIBLE_BUSINESS_TYPE',
      error:
        'Only genuine businesses operating from fixed permanent shop premises are eligible. Home-based, mobile, online-only, and service-area-only vendors are excluded.'
    };
  }

  if (update.fixedPremisesConfirmed === false) {
    return {
      ok: false,
      status: 400,
      code: 'FIXED_PREMISES_REQUIRED',
      error: 'Fixed physical shop premises confirmation is required.'
    };
  }

  if (update.businessTypeConfirmed === false) {
    return {
      ok: false,
      status: 400,
      code: 'BUSINESS_TYPE_CONFIRMATION_REQUIRED',
      error: 'Fixed-shop business type confirmation is required.'
    };
  }

  let normalizedCategory: string | undefined;
  if (update.category !== undefined) {
    normalizedCategory = String(update.category).trim().toUpperCase();
    if (!ALLOWED_STORE_CATEGORIES.has(normalizedCategory)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_CATEGORY',
        error: `Unsupported store category. Allowed categories: ${Array.from(ALLOWED_STORE_CATEGORIES).join(', ')}.`
      };
    }
  }

  let normalizedBusinessName: string | undefined;
  if (update.businessName !== undefined) {
    normalizedBusinessName = String(update.businessName).trim();
    if (!normalizedBusinessName || normalizedBusinessName.length > 150) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_BUSINESS_NAME',
        error: 'Business name must be between 1 and 150 characters.'
      };
    }
  }

  let normalizedOwnership: PremisesOwnershipType | undefined;
  if (update.premisesOwnershipType !== undefined) {
    const val = String(update.premisesOwnershipType).trim().toUpperCase();
    if (val !== 'OWNED' && val !== 'RENTED' && val !== 'LEASED') {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_OWNERSHIP_TYPE',
        error: 'premisesOwnershipType must be OWNED, RENTED, or LEASED.'
      };
    }
    normalizedOwnership = val;
  }

  let normalizedAddress: string | undefined;
  if (update.address !== undefined) {
    normalizedAddress = String(update.address).trim();
    if (!normalizedAddress || normalizedAddress.length > 500) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_ADDRESS',
        error: 'Physical shop address must be a non-empty string under 500 characters.'
      };
    }
  }

  let normalizedPincode: string | undefined;
  if (update.pincode !== undefined) {
    normalizedPincode = String(update.pincode).trim();
    if (!/^[A-Za-z0-9\-\s]{4,10}$/.test(normalizedPincode)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_PINCODE',
        error: 'Pincode must be 4-10 alphanumeric characters.'
      };
    }
  }

  if (update.latitude !== undefined || update.longitude !== undefined) {
    if (update.latitude === undefined || update.longitude === undefined) {
      return {
        ok: false,
        status: 400,
        code: 'GPS_INCOMPLETE',
        error: 'Both latitude and longitude must be provided together.'
      };
    }
    if (!isValidGpsCoordinates(update.latitude, update.longitude)) {
      return {
        ok: false,
        status: 400,
        code: 'GPS_INVALID',
        error: 'GPS coordinates must be finite valid latitude (-90..90) and longitude (-180..180) values.'
      };
    }
  }

  if (
    update.gpsAccuracyMeters !== undefined &&
    (typeof update.gpsAccuracyMeters !== 'number' ||
      !Number.isFinite(update.gpsAccuracyMeters) ||
      update.gpsAccuracyMeters < 0)
  ) {
    return {
      ok: false,
      status: 400,
      code: 'GPS_ACCURACY_INVALID',
      error: 'gpsAccuracyMeters must be a non-negative number.'
    };
  }

  try {
    return await withPgTransaction(merchantPool, async (client: StrictPgClient) => {
      const merchRes = await client.query(
        `SELECT id, business_name, category FROM merchants WHERE id = $1`,
        [merchantId]
      );
      if (merchRes.rows.length === 0) {
        return { ok: false as const, status: 404 as const, code: 'MERCHANT_NOT_FOUND', error: 'Merchant store not found.' };
      }

      let profileRes = await client.query(
        `SELECT ${PROFILE_SELECT_COLS} FROM store_onboarding_profiles WHERE merchant_id = $1 FOR UPDATE`,
        [merchantId]
      );

      if (profileRes.rows.length === 0) {
        profileRes = await client.query(
          `INSERT INTO store_onboarding_profiles (merchant_id, business_name, category, status)
           VALUES ($1, $2, $3, 'PENDING_SUBMISSION')
           RETURNING ${PROFILE_SELECT_COLS}`,
          [merchantId, String(merchRes.rows[0].business_name), String(merchRes.rows[0].category).toUpperCase()]
        );
      }

      const row = profileRes.rows[0];
      const currentStatus = row.status as OnboardingStatus;

      if (!EDITABLE_DRAFT_STATUSES.has(currentStatus) && currentStatus !== 'APPROVED') {
        return {
          ok: false as const,
          status: 403 as const,
          code: 'DRAFT_NOT_EDITABLE',
          error: `Onboarding profile cannot be modified while status is '${currentStatus}'.`
        };
      }

      let locationChangeDetected = false;
      let nextStatus: OnboardingStatus = currentStatus === 'PENDING_SUBMISSION' ? 'DRAFT' : currentStatus;
      let clearDraftAndOldGps = false;

      if (currentStatus === 'APPROVED') {
        const refAddress = row.approved_address ?? row.address;
        const refPincode = row.approved_pincode ?? row.pincode;
        const refLat = row.approved_latitude !== null && row.approved_latitude !== undefined
          ? Number(row.approved_latitude)
          : row.latitude !== null && row.latitude !== undefined
            ? Number(row.latitude)
            : null;
        const refLng = row.approved_longitude !== null && row.approved_longitude !== undefined
          ? Number(row.approved_longitude)
          : row.longitude !== null && row.longitude !== undefined
            ? Number(row.longitude)
            : null;

        const addressChanged =
          normalizedAddress !== undefined && normalizeAddress(normalizedAddress) !== normalizeAddress(refAddress);
        const pincodeChanged =
          normalizedPincode !== undefined && normalizedPincode !== (refPincode ? String(refPincode).trim() : '');
        const gpsChanged =
          update.latitude !== undefined &&
          update.longitude !== undefined &&
          refLat !== null &&
          refLng !== null &&
          haversineDistanceMeters(refLat, refLng, update.latitude, update.longitude) > LOCATION_CHANGE_THRESHOLD_METERS;

        if (addressChanged || pincodeChanged || gpsChanged) {
          locationChangeDetected = true;
          nextStatus = 'REVERIFICATION_REQUIRED';
          clearDraftAndOldGps = update.latitude === undefined;
        }
      }

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      const addField = (col: string, val: unknown) => {
        setClauses.push(`${col} = $${idx++}`);
        values.push(val);
      };

      if (normalizedBusinessName !== undefined) addField('business_name', normalizedBusinessName);
      if (normalizedCategory !== undefined) addField('category', normalizedCategory);
      if (update.businessTypeConfirmed !== undefined) addField('business_type_confirmed', update.businessTypeConfirmed);
      if (update.fixedPremisesConfirmed !== undefined) addField('fixed_premises_confirmed', update.fixedPremisesConfirmed);
      if (normalizedOwnership !== undefined) addField('premises_ownership_type', normalizedOwnership);
      if (normalizedAddress !== undefined) addField('address', normalizedAddress);
      if (normalizedPincode !== undefined) addField('pincode', normalizedPincode);

      if (update.latitude !== undefined && update.longitude !== undefined) {
        addField('latitude', update.latitude);
        addField('longitude', update.longitude);
        addField('gps_captured_at', new Date().toISOString());
      } else if (clearDraftAndOldGps) {
        // Address shifted on an approved store without providing new GPS: require fresh GPS capture
        addField('latitude', null);
        addField('longitude', null);
        addField('gps_captured_at', null);
      }

      if (update.gpsAccuracyMeters !== undefined) {
        addField('gps_accuracy_meters', update.gpsAccuracyMeters);
      }

      addField('status', nextStatus);

      if (locationChangeDetected) {
        // Preserve existing approved_* snapshot fields if not yet backed into approved_* columns
        if (row.approved_submission_id === null && row.current_submission_id !== null) {
          addField('approved_submission_id', row.current_submission_id);
        }
        if (row.approved_address === null && row.address !== null) {
          addField('approved_address', row.address);
        }
        if (row.approved_pincode === null && row.pincode !== null) {
          addField('approved_pincode', row.pincode);
        }
        if (row.approved_latitude === null && row.latitude !== null) {
          addField('approved_latitude', Number(row.latitude));
        }
        if (row.approved_longitude === null && row.longitude !== null) {
          addField('approved_longitude', Number(row.longitude));
        }
        addField('reverification_required', true);
        addField('reverification_reason', 'ADDRESS_OR_LOCATION_CHANGED');
        // Clear any stale draft submission so fresh storefront photos and premises proof are mandatory
        addField('draft_submission_id', null);
        // Require fresh premises re-confirmation if not re-confirmed in this request
        if (update.fixedPremisesConfirmed === undefined) {
          addField('fixed_premises_confirmed', false);
        }
      }

      addField('updated_at', new Date().toISOString());

      values.push(merchantId);
      const updated = await client.query(
        `UPDATE store_onboarding_profiles
         SET ${setClauses.join(', ')}
         WHERE merchant_id = $${idx}
         RETURNING ${PROFILE_SELECT_COLS}`,
        values
      );

      if (locationChangeDetected) {
        // Ensure store is not left open on public discovery without verified re-approval
        await client.query(`UPDATE merchants SET is_open = false WHERE id = $1`, [merchantId]);
      }

      await client.query(
        `INSERT INTO store_onboarding_audit_events
           (merchant_id, actor_type, actor_id, event_type, event_metadata)
         VALUES ($1, 'SELLER', $2, $3, $4::jsonb)`,
        [
          merchantId,
          sellerAccountId,
          locationChangeDetected ? 'REVERIFICATION_REQUIRED' : 'DRAFT_UPDATED',
          JSON.stringify({
            actorType: 'SELLER',
            actorId: sellerAccountId,
            storeId: merchantId,
            action: locationChangeDetected ? 'LOCATION_CHANGE_REVERIFICATION' : 'UPDATE_ONBOARDING_DRAFT',
            submissionId: row.draft_submission_id ?? null,
            updatedFields: Object.keys(update),
            locationChangeDetected,
            previousStatus: currentStatus,
            newStatus: nextStatus,
            timestamp: new Date().toISOString()
          })
        ]
      );

      return {
        ok: true as const,
        data: {
          profile: mapProfileRow(updated.rows[0]),
          locationChangeDetected
        }
      };
    });
  } catch (err) {
    return mapServiceError(err, 'updateOnboardingDraft');
  }
}

// -------------------------------------------------------------------------
// Document upload, retrieval & removal
// -------------------------------------------------------------------------

export interface UploadDocumentInput {
  merchantId: string;
  sellerAccountId: string;
  requirementKey: string;
  fileBuffer: Buffer;
  declaredMimeType: string;
  originalFilename: string;
}

/**
 * Validates the store's onboarding state, category requirement applicability,
 * photo quotas, and file signature, stores the document in private storage,
 * and records metadata inside an atomic DB transaction.
 * Automatically deletes any written physical file if the DB transaction fails.
 */
class OnboardingTxAbortError extends Error {
  constructor(public readonly outcome: OnboardingServiceResult<any>) {
    super('ONBOARDING_TX_ABORT');
  }
}

export async function uploadDraftDocument(
  merchantPool: StrictPgPool,
  kycStorage: KycDocumentStorage,
  input: UploadDocumentInput
): Promise<OnboardingServiceResult<KycDocumentSummary>> {
  const requirementKey = input.requirementKey.trim().toUpperCase();
  if (!requirementKey) {
    return { ok: false, status: 400, code: 'REQUIREMENT_KEY_REQUIRED', error: 'requirementKey is required.' };
  }

  let storedFileKey: string | null = null;
  try {
    // Store & validate magic bytes/MIME/size upfront; cleanup automatically on any downstream error
    const stored = await kycStorage.store({
      buffer: input.fileBuffer,
      mimeType: input.declaredMimeType,
      originalFilename: input.originalFilename
    });
    storedFileKey = stored.storageKey;

    return await withPgTransaction(merchantPool, async (client: StrictPgClient) => {
      const merchRes = await client.query(
        `SELECT id, business_name, category, address, pincode FROM merchants WHERE id = $1`,
        [input.merchantId]
      );
      if (merchRes.rows.length === 0) {
        return { ok: false as const, status: 404 as const, code: 'MERCHANT_NOT_FOUND', error: 'Merchant store not found.' };
      }
      const merchRow = merchRes.rows[0];

      let profileRes = await client.query(
        `SELECT ${PROFILE_SELECT_COLS} FROM store_onboarding_profiles WHERE merchant_id = $1 FOR UPDATE`,
        [input.merchantId]
      );
      if (profileRes.rows.length === 0) {
        profileRes = await client.query(
          `INSERT INTO store_onboarding_profiles (merchant_id, business_name, category, status)
           VALUES ($1, $2, $3, 'PENDING_SUBMISSION')
           RETURNING ${PROFILE_SELECT_COLS}`,
          [input.merchantId, String(merchRow.business_name), String(merchRow.category).toUpperCase()]
        );
      }

      const profile = mapProfileRow(profileRes.rows[0]);
      if (!UPLOADABLE_DRAFT_STATUSES.has(profile.status)) {
        throw new OnboardingTxAbortError({
          ok: false as const,
          status: 403 as const,
          code: 'UPLOAD_NOT_PERMITTED',
          error: `Document uploads are not permitted while onboarding status is '${profile.status}'.`
        });
      }

      const effectiveCategory = (profile.category || String(merchRow.category)).toUpperCase();
      const effectiveBusinessName = profile.businessName || String(merchRow.business_name);

      // Verify requirement applies to this category
      const reqRes = await client.query(
        `SELECT requirement_key, document_type, is_mandatory
         FROM kyc_document_requirements
         WHERE requirement_key = $1
           AND is_active = true
           AND (category IS NULL OR category = $2)
         LIMIT 1`,
        [requirementKey, effectiveCategory]
      );
      if (reqRes.rows.length === 0) {
        throw new OnboardingTxAbortError({
          ok: false as const,
          status: 400 as const,
          code: 'INVALID_REQUIREMENT_KEY',
          error: `Requirement '${requirementKey}' is not applicable for store category '${effectiveCategory}'.`
        });
      }
      const reqRow = reqRes.rows[0];
      const docType = String(reqRow.document_type);
      const isStorefrontPhoto = docType === 'STOREFRONT_PHOTO';
      const isPremisesProof = docType === 'PREMISES_PROOF';

      if (isStorefrontPhoto && stored.mimeType === 'application/pdf') {
        throw new OnboardingTxAbortError({
          ok: false as const,
          status: 400 as const,
          code: 'PHOTO_MUST_BE_IMAGE',
          error: 'Storefront photographs must be uploaded as JPEG or PNG images.'
        });
      }

      // Reuse active DRAFT submission or allocate the next version cleanly
      let draftSubmissionId = profile.draftSubmissionId;
      let draftVersion: number | null = null;
      let createdDraftOrChangedProfile = false;

      if (draftSubmissionId) {
        const subCheck = await client.query(
          `SELECT id, status, submission_version FROM store_kyc_submissions WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
          [draftSubmissionId, input.merchantId]
        );
        if (subCheck.rows.length === 0 || subCheck.rows[0].status !== 'DRAFT') {
          draftSubmissionId = null;
        } else if (subCheck.rows[0].submission_version !== undefined && subCheck.rows[0].submission_version !== null) {
          draftVersion = Number(subCheck.rows[0].submission_version);
        }
      }

      if (!draftSubmissionId) {
        // Also check partial unique draft row in case profile column wasn't set
        const existingDraft = await client.query(
          `SELECT id, submission_version FROM store_kyc_submissions WHERE merchant_id = $1 AND status = 'DRAFT' FOR UPDATE`,
          [input.merchantId]
        );
        if (existingDraft.rows.length > 0) {
          draftSubmissionId = String(existingDraft.rows[0].id);
          if (existingDraft.rows[0].submission_version !== undefined && existingDraft.rows[0].submission_version !== null) {
            draftVersion = Number(existingDraft.rows[0].submission_version);
          }
        } else {
          const verRes = await client.query(
            `SELECT COALESCE(MAX(submission_version), 0) + 1 AS next_version
             FROM store_kyc_submissions
             WHERE merchant_id = $1`,
            [input.merchantId]
          );
          const nextVersion = Number(verRes.rows[0].next_version);
          draftVersion = nextVersion;
          const subIns = await client.query(
            `INSERT INTO store_kyc_submissions
               (merchant_id, submission_version, submitted_by_seller_account_id, status,
                business_name_snapshot, category_snapshot, address_snapshot, pincode_snapshot,
                is_reverification)
             VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              input.merchantId,
              nextVersion,
              input.sellerAccountId,
              effectiveBusinessName,
              effectiveCategory,
              profile.address || String(merchRow.address || ''),
              profile.pincode || String(merchRow.pincode || ''),
              profile.reverificationRequired
            ]
          );
          draftSubmissionId = String(subIns.rows[0].id);
          createdDraftOrChangedProfile = true;
        }

        const nextProfileStatus: OnboardingStatus =
          profile.status === 'PENDING_SUBMISSION' ? 'DRAFT' : profile.status;
        await client.query(
          `UPDATE store_onboarding_profiles
           SET draft_submission_id = $1,
               status = $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE merchant_id = $3`,
          [draftSubmissionId, nextProfileStatus, input.merchantId]
        );
        createdDraftOrChangedProfile = true;
      }

      // Check existing documents attached to this draft for duplicates & limits
      const existingDocsRes = await client.query(
        `SELECT id, requirement_key, sha256_checksum, mime_type, is_storefront_photo, is_premises_proof
         FROM kyc_documents
         WHERE submission_id = $1 AND merchant_id = $2`,
        [draftSubmissionId, input.merchantId]
      );
      const existingDocs = existingDocsRes.rows;

      if (existingDocs.some((d) => String(d.sha256_checksum) === stored.sha256)) {
        const resErr = {
          ok: false as const,
          status: 409 as const,
          code: 'DUPLICATE_DOCUMENT',
          error: 'An identical file has already been uploaded for this onboarding draft.'
        };
        if (createdDraftOrChangedProfile) throw new OnboardingTxAbortError(resErr);
        return resErr;
      }

      const allowsMultipleForRequirement =
        requirementKey.startsWith('ADDITIONAL_') || requirementKey.startsWith('SUPPORTING_');
      if (!allowsMultipleForRequirement && existingDocs.some((d) => String(d.requirement_key) === requirementKey)) {
        const resErr = {
          ok: false as const,
          status: 409 as const,
          code: 'REQUIREMENT_DOCUMENT_EXISTS',
          error: `A document for '${requirementKey}' is already present in this draft. Delete it before uploading a replacement.`
        };
        if (createdDraftOrChangedProfile) throw new OnboardingTxAbortError(resErr);
        return resErr;
      }

      if (existingDocs.length >= MAX_DOCUMENTS_PER_SUBMISSION) {
        throw new OnboardingTxAbortError({
          ok: false as const,
          status: 400 as const,
          code: 'MAX_DOCUMENTS_EXCEEDED',
          error: `Maximum of ${MAX_DOCUMENTS_PER_SUBMISSION} documents per submission reached.`
        });
      }

      const existingPhotoCount = existingDocs.filter(
        (d) =>
          (Boolean(d.is_storefront_photo) || Boolean(d.is_premises_proof)) &&
          (d.mime_type === 'image/jpeg' || d.mime_type === 'image/png')
      ).length;
      const incomingIsPhoto =
        (isStorefrontPhoto || isPremisesProof) &&
        (stored.mimeType === 'image/jpeg' || stored.mimeType === 'image/png');

      if (incomingIsPhoto && existingPhotoCount >= MAX_PREMISES_PHOTOS_PER_SUBMISSION) {
        throw new OnboardingTxAbortError({
          ok: false as const,
          status: 400 as const,
          code: 'MAX_PREMISES_PHOTOS_EXCEEDED',
          error: `Maximum of ${MAX_PREMISES_PHOTOS_PER_SUBMISSION} storefront/premises photographs per submission allowed.`
        });
      }

      const inserted = await client.query(
        `INSERT INTO kyc_documents
           (submission_id, merchant_id, requirement_key, document_type,
            original_filename_sanitized, storage_key, mime_type, file_size_bytes,
            sha256_checksum, uploaded_by_seller_account_id,
            is_storefront_photo, is_premises_proof)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, submission_id, requirement_key, document_type, original_filename_sanitized,
                   mime_type, file_size_bytes, sha256_checksum, uploaded_at,
                   is_storefront_photo, is_premises_proof`,
        [
          draftSubmissionId,
          input.merchantId,
          requirementKey,
          docType,
          stored.originalFilenameSanitized,
          stored.storageKey,
          stored.mimeType,
          stored.fileSizeBytes,
          stored.sha256,
          input.sellerAccountId,
          isStorefrontPhoto,
          isPremisesProof
        ]
      );

      await client.query(
        `INSERT INTO store_onboarding_audit_events
           (merchant_id, actor_type, actor_id, event_type, event_metadata)
         VALUES ($1, 'SELLER', $2, 'DOCUMENT_UPLOADED', $3::jsonb)`,
        [
          input.merchantId,
          input.sellerAccountId,
          JSON.stringify({
            actorType: 'SELLER',
            actorId: input.sellerAccountId,
            storeId: input.merchantId,
            action: 'UPLOAD_DOCUMENT',
            submissionId: draftSubmissionId,
            submissionVersion: draftVersion,
            documentId: inserted.rows[0].id,
            requirementKey,
            documentType: docType,
            mimeType: stored.mimeType,
            fileSizeBytes: stored.fileSizeBytes,
            sha256Checksum: stored.sha256,
            previousStatus: profile.status,
            newStatus: profile.status === 'PENDING_SUBMISSION' ? 'DRAFT' : profile.status,
            timestamp: new Date().toISOString()
          })
        ]
      );

      // DB commit succeeded: prevent cleanup in catch/finally
      storedFileKey = null;
      return { ok: true as const, data: mapDocumentRow(inserted.rows[0]) };
    }).then(async (res) => {
      if (!res.ok && storedFileKey) {
        await kycStorage.delete(storedFileKey).catch(() => { });
      }
      return res;
    });
  } catch (err) {
    if (storedFileKey) {
      await kycStorage.delete(storedFileKey).catch(() => { });
    }
    if (err instanceof OnboardingTxAbortError) {
      return err.outcome;
    }
    if (err instanceof KycStorageValidationError) {
      return { ok: false, status: 400, code: err.code, error: err.message };
    }
    if (err instanceof KycStorageUnavailableError) {
      return { ok: false, status: 503, code: err.code, error: err.message };
    }
    return mapServiceError(err, 'uploadDraftDocument');
  }
}

/**
 * Retrieves an uploaded document belonging to the requested store through
 * authorised backend code, safely mapping storage errors without path leaks.
 */
export async function retrieveStoreDocumentContent(
  merchantPool: Pick<StrictPgPool, 'query'>,
  kycStorage: KycDocumentStorage,
  merchantId: string,
  documentId: string
): Promise<
  OnboardingServiceResult<{
    buffer: Buffer;
    mimeType: string;
    originalFilenameSanitized: string;
  }>
> {
  if (!STORE_UUID_REGEX.test(documentId.trim())) {
    return { ok: false, status: 400, code: 'INVALID_DOCUMENT_ID', error: 'Invalid documentId format.' };
  }

  try {
    const res = await merchantPool.query(
      `SELECT storage_key, mime_type, original_filename_sanitized
       FROM kyc_documents
       WHERE id = $1 AND merchant_id = $2`,
      [documentId.trim(), merchantId]
    );
    if (res.rows.length === 0) {
      return { ok: false, status: 404, code: 'DOCUMENT_NOT_FOUND', error: 'Document not found.' };
    }

    const row = res.rows[0];
    const buffer = await kycStorage.retrieve(String(row.storage_key));

    return {
      ok: true,
      data: {
        buffer,
        mimeType: String(row.mime_type),
        originalFilenameSanitized: String(row.original_filename_sanitized)
      }
    };
  } catch (err) {
    if (err instanceof KycStorageNotFoundError) {
      return { ok: false, status: 404, code: err.code, error: 'Document file is unavailable.' };
    }
    if (err instanceof KycStorageUnavailableError) {
      return { ok: false, status: 503, code: err.code, error: err.message };
    }
    if (err instanceof KycStorageValidationError) {
      return { ok: false, status: 400, code: err.code, error: err.message };
    }
    return mapServiceError(err, 'retrieveStoreDocumentContent');
  }
}

/**
 * Deletes a document ONLY if it belongs to the store and its parent submission
 * is still in editable 'DRAFT' state. Never deletes historical submitted docs.
 */
export async function deleteDraftDocument(
  merchantPool: StrictPgPool,
  kycStorage: KycDocumentStorage,
  merchantId: string,
  documentId: string,
  sellerAccountId: string
): Promise<OnboardingServiceResult<{ deleted: boolean }>> {
  if (!STORE_UUID_REGEX.test(documentId.trim())) {
    return { ok: false, status: 400, code: 'INVALID_DOCUMENT_ID', error: 'Invalid documentId format.' };
  }

  try {
    const txRes = await withPgTransaction(merchantPool, async (client: StrictPgClient) => {
      const docRes = await client.query(
        `SELECT d.id, d.storage_key, d.submission_id, d.requirement_key, d.document_type,
                s.status AS submission_status, s.submission_version,
                p.status AS profile_status, p.draft_submission_id
         FROM kyc_documents d
         JOIN store_kyc_submissions s ON s.id = d.submission_id
         JOIN store_onboarding_profiles p ON p.merchant_id = d.merchant_id
         WHERE d.id = $1 AND d.merchant_id = $2
         FOR UPDATE OF d, s`,
        [documentId.trim(), merchantId]
      );

      if (docRes.rows.length === 0) {
        return {
          ok: false as const,
          status: 404 as const,
          code: 'DOCUMENT_NOT_FOUND',
          error: 'Document not found.'
        };
      }

      const row = docRes.rows[0];
      if (
        row.submission_status !== 'DRAFT' ||
        String(row.submission_id) !== String(row.draft_submission_id) ||
        !UPLOADABLE_DRAFT_STATUSES.has(row.profile_status as OnboardingStatus)
      ) {
        return {
          ok: false as const,
          status: 403 as const,
          code: 'HISTORICAL_DOCUMENT_IMMUTABLE',
          error: 'Documents attached to submitted or historical KYC versions cannot be deleted.'
        };
      }

      await client.query(`DELETE FROM kyc_documents WHERE id = $1 AND merchant_id = $2`, [
        row.id,
        merchantId
      ]);

      await client.query(
        `INSERT INTO store_onboarding_audit_events
           (merchant_id, actor_type, actor_id, event_type, event_metadata)
         VALUES ($1, 'SELLER', $2, 'DOCUMENT_DELETED', $3::jsonb)`,
        [
          merchantId,
          sellerAccountId,
          JSON.stringify({
            actorType: 'SELLER',
            actorId: sellerAccountId,
            storeId: merchantId,
            action: 'DELETE_DOCUMENT',
            documentId: row.id,
            submissionId: row.submission_id,
            submissionVersion: row.submission_version ?? null,
            requirementKey: row.requirement_key ?? null,
            documentType: row.document_type ?? null,
            timestamp: new Date().toISOString()
          })
        ]
      );

      return { ok: true as const, data: { storageKey: String(row.storage_key) } };
    });

    if (!txRes.ok) return txRes;

    try {
      await kycStorage.delete(txRes.data.storageKey);
    } catch (storageErr) {
      if (!(storageErr instanceof KycStorageNotFoundError)) {
        console.error(`[Onboarding:deleteDraftDocument] Storage cleanup warning: ${sanitizeErrorForLog(storageErr)}`);
      }
    }

    return { ok: true, data: { deleted: true } };
  } catch (err) {
    return mapServiceError(err, 'deleteDraftDocument');
  }
}

// -------------------------------------------------------------------------
// Submission & resubmission
// -------------------------------------------------------------------------

/**
 * Validates the complete onboarding checklist (verified seller account,
 * fixed physical shop premises confirmation, valid GPS, address, >=2 storefront
 * photos, >=1 premises proof, category mandatory licenses, <=5 premises photos)
 * and transitions the active DRAFT submission to immutable 'SUBMITTED' status.
 *
 * Never marks a store APPROVED, KYC-verified, or open (`is_open = true`).
 */
export async function submitOnboardingApplication(
  merchantPool: StrictPgPool,
  merchantId: string,
  sellerAccountId: string
): Promise<OnboardingServiceResult<{ submission: SubmissionSummary; status: OnboardingStatus }>> {
  try {
    return await withPgTransaction(merchantPool, async (client: StrictPgClient) => {
      // 1. Verify authenticated Seller Account has verified contact details
      const acctRes = await client.query(
        `SELECT id, phone, email, is_email_verified, status
         FROM seller_accounts
         WHERE id = $1`,
        [sellerAccountId]
      );
      if (acctRes.rows.length === 0 || acctRes.rows[0].status !== 'ACTIVE') {
        return {
          ok: false as const,
          status: 403 as const,
          code: 'SELLER_ACCOUNT_INACTIVE',
          error: 'Active seller account is required.'
        };
      }
      const acct = acctRes.rows[0];
      if (!acct.is_email_verified || !acct.phone || !acct.email) {
        return {
          ok: false as const,
          status: 403 as const,
          code: 'SELLER_CONTACT_UNVERIFIED',
          error: 'Verified Seller Account email and phone contact information are required before submitting store KYC.'
        };
      }

      // 2. Lock merchant and onboarding profile
      const merchLockRes = await client.query(
        `SELECT business_name AS m_business_name, category AS m_category
         FROM merchants
         WHERE id = $1
         FOR UPDATE`,
        [merchantId]
      );
      if (merchLockRes.rows.length === 0) {
        return { ok: false as const, status: 404 as const, code: 'MERCHANT_NOT_FOUND', error: 'Merchant store not found.' };
      }

      const profLockRes = await client.query(
        `SELECT ${PROFILE_SELECT_COLS}
         FROM store_onboarding_profiles
         WHERE merchant_id = $1
         FOR UPDATE`,
        [merchantId]
      );
      if (profLockRes.rows.length === 0) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'CHECKLIST_INCOMPLETE',
          error: 'Onboarding draft has not been completed.',
          details: { missingGps: true, missingPremisesConfirmation: true }
        };
      }
      const row = {
        ...merchLockRes.rows[0],
        ...profLockRes.rows[0]
      };

      const currentStatus = row.status as OnboardingStatus;
      if (currentStatus === 'SUBMITTED' || currentStatus === 'UNDER_REVIEW') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'SUBMISSION_ALREADY_PENDING',
          error: `A KYC submission is already ${currentStatus.toLowerCase().replace('_', ' ')} for this store.`
        };
      }
      if (currentStatus === 'APPROVED') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'STORE_ALREADY_APPROVED',
          error: 'This store is already approved and has no pending location re-verification.'
        };
      }
      if (!SUBMITTABLE_STATUSES.has(currentStatus)) {
        return {
          ok: false as const,
          status: 403 as const,
          code: 'SUBMISSION_NOT_PERMITTED',
          error: `Submission is not permitted while store onboarding status is '${currentStatus}'.`
        };
      }

      const businessName = String(row.business_name || row.m_business_name || '').trim();
      const category = String(row.category || row.m_category || '').trim().toUpperCase();
      const address = String(row.address || '').trim();
      const pincode = String(row.pincode || '').trim();
      const lat = row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : NaN;
      const lng = row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : NaN;

      if (!businessName || !ALLOWED_STORE_CATEGORIES.has(category)) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'INVALID_BUSINESS_IDENTITY',
          error: 'Valid business name and supported store category are required.'
        };
      }
      if (row.business_type !== 'FIXED_SHOP' || !row.business_type_confirmed || !row.fixed_premises_confirmed) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'PREMISES_CONFIRMATION_REQUIRED',
          error: 'Fixed physical shop business type and premises confirmation are required before submission.'
        };
      }
      if (!address || !pincode) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'ADDRESS_REQUIRED',
          error: 'Complete physical shop address and pincode are required.'
        };
      }
      if (!row.gps_captured_at || !isValidGpsCoordinates(lat, lng)) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'GPS_REQUIRED',
          error: 'Valid GPS coordinates for the physical premises must be captured before submission.'
        };
      }

      const draftSubId = row.draft_submission_id ? String(row.draft_submission_id) : null;
      if (!draftSubId) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'CHECKLIST_INCOMPLETE',
          error: 'Required storefront photographs, premises proof, and category documents must be uploaded before submitting.'
        };
      }

      const draftRes = await client.query(
        `SELECT id, submission_version, status
         FROM store_kyc_submissions
         WHERE id = $1 AND merchant_id = $2
         FOR UPDATE`,
        [draftSubId, merchantId]
      );
      if (draftRes.rows.length === 0 || draftRes.rows[0].status !== 'DRAFT') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'DRAFT_SUBMISSION_MISSING',
          error: 'No active editable draft submission was found. Please upload required documents.'
        };
      }

      // Validate checklist against applicable active requirement definitions
      const reqRes = await client.query(
        `SELECT requirement_key, category, is_mandatory, document_type, label, effective_version
         FROM kyc_document_requirements
         WHERE is_active = true AND (category IS NULL OR category = $1)
         ORDER BY sort_order ASC, requirement_key ASC`,
        [category]
      );
      const activeRequirements = reqRes.rows;
      const requirementsVersion = activeRequirements.reduce(
        (max: number, r: any) => Math.max(max, Number(r.effective_version ?? 1)),
        1
      );

      const docsRes = await client.query(
        `SELECT id, requirement_key, document_type, mime_type, is_storefront_photo, is_premises_proof
         FROM kyc_documents
         WHERE submission_id = $1 AND merchant_id = $2`,
        [draftSubId, merchantId]
      );
      const draftDocs = docsRes.rows;
      const uploadedKeys = new Set(draftDocs.map((d) => String(d.requirement_key)));

      const missingRequirements = activeRequirements
        .filter((r) => Boolean(r.is_mandatory) && !uploadedKeys.has(String(r.requirement_key)))
        .map((r) => String(r.requirement_key));

      const storefrontPhotoCount = draftDocs.filter((d) => Boolean(d.is_storefront_photo)).length;
      const premisesProofCount = draftDocs.filter((d) => Boolean(d.is_premises_proof)).length;
      const totalPremisesPhotos = draftDocs.filter(
        (d) =>
          (Boolean(d.is_storefront_photo) || Boolean(d.is_premises_proof)) &&
          (d.mime_type === 'image/jpeg' || d.mime_type === 'image/png')
      ).length;

      if (missingRequirements.length > 0 || storefrontPhotoCount < 2 || premisesProofCount < 1) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'CHECKLIST_INCOMPLETE',
          error: `Submission checklist incomplete. Missing or insufficient documents: ${missingRequirements.length > 0
            ? missingRequirements.join(', ')
            : storefrontPhotoCount < 2
              ? 'at least 2 storefront photos required'
              : 'premises proof required'
            }.`,
          details: { missingRequirements, storefrontPhotoCount, premisesProofCount }
        };
      }

      if (totalPremisesPhotos > MAX_PREMISES_PHOTOS_PER_SUBMISSION) {
        return {
          ok: false as const,
          status: 400 as const,
          code: 'MAX_PREMISES_PHOTOS_EXCEEDED',
          error: `Maximum of ${MAX_PREMISES_PHOTOS_PER_SUBMISSION} storefront/premises photographs per submission allowed.`
        };
      }

      const isResubmission = Boolean(row.current_submission_id);
      const isReverification = Boolean(row.reverification_required);
      const submissionPublicCols = await resolveSubmissionPublicCols(client);

      // Lock snapshot and mark submission SUBMITTED (now protected by DB immutability triggers)
      const subUpdateRes = await client.query(
        `UPDATE store_kyc_submissions
         SET status = 'SUBMITTED',
             submitted_by_seller_account_id = $1,
             business_name_snapshot = $2,
             category_snapshot = $3,
             business_type_snapshot = 'FIXED_SHOP',
             fixed_premises_confirmed_snapshot = true,
             address_snapshot = $4,
             pincode_snapshot = $5,
             latitude_snapshot = $6,
             longitude_snapshot = $7,
             gps_captured_at_snapshot = $8,
             gps_accuracy_meters_snapshot = $9,
             submitted_requirements_version = $10,
             requirements_snapshot = $11::jsonb,
             seller_contact_snapshot = $12::jsonb,
             is_reverification = $13,
             submitted_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $14 AND merchant_id = $15 AND status = 'DRAFT'
         RETURNING ${submissionPublicCols}`,
        [
          sellerAccountId,
          businessName,
          category,
          address,
          pincode,
          lat,
          lng,
          row.gps_captured_at,
          row.gps_accuracy_meters,
          requirementsVersion,
          JSON.stringify(
            activeRequirements.map((r) => ({
              requirementKey: String(r.requirement_key),
              documentType: String(r.document_type),
              isMandatory: Boolean(r.is_mandatory),
              effectiveVersion: Number(r.effective_version ?? 1)
            }))
          ),
          JSON.stringify({
            sellerAccountId,
            email: String(acct.email),
            phone: String(acct.phone),
            isEmailVerified: Boolean(acct.is_email_verified)
          }),
          isReverification,
          draftSubId,
          merchantId
        ]
      );

      if (subUpdateRes.rows.length === 0) {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'SUBMISSION_CONFLICT',
          error: 'Draft submission state changed concurrently. Please refresh and try again.'
        };
      }

      // Transition onboarding profile to SUBMITTED; preserve reverification_required & approved_*
      await client.query(
        `UPDATE store_onboarding_profiles
         SET status = 'SUBMITTED',
             current_submission_id = $1,
             draft_submission_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = $2`,
        [draftSubId, merchantId]
      );

      // Keep store closed until formal Admin approval (MO-B/MO-C)
      await client.query(`UPDATE merchants SET is_open = false WHERE id = $1`, [merchantId]);

      const submission = mapSubmissionRow(subUpdateRes.rows[0]);
      await client.query(
        `INSERT INTO store_onboarding_audit_events
           (merchant_id, actor_type, actor_id, event_type, event_metadata)
         VALUES ($1, 'SELLER', $2, $3, $4::jsonb)`,
        [
          merchantId,
          sellerAccountId,
          isResubmission ? 'RESUBMISSION_CREATED' : 'SUBMISSION_CREATED',
          JSON.stringify({
            actorType: 'SELLER',
            actorId: sellerAccountId,
            storeId: merchantId,
            action: isResubmission ? 'RESUBMIT_APPLICATION' : 'SUBMIT_APPLICATION',
            submissionId: submission.id,
            submissionVersion: submission.submissionVersion,
            previousStatus: currentStatus,
            newStatus: 'SUBMITTED',
            isReverification,
            requirementsVersion,
            documentCount: draftDocs.length,
            timestamp: submission.submittedAt ?? new Date().toISOString()
          })
        ]
      );

      return {
        ok: true as const,
        data: {
          submission,
          status: 'SUBMITTED' as OnboardingStatus
        }
      };
    });
  } catch (err) {
    return mapServiceError(err, 'submitOnboardingApplication');
  }
}

/**
 * Returns the store's submission history in reverse chronological order,
 * excluding Admin-internal notes (`review_notes`, `reviewed_by_admin_id`).
 */
export async function listStoreSubmissions(
  merchantPool: Pick<StrictPgPool, 'query'>,
  merchantId: string
): Promise<OnboardingServiceResult<SubmissionSummary[]>> {
  try {
    const submissionPublicCols = await resolveSubmissionPublicCols(merchantPool);
    const res = await merchantPool.query(
      `SELECT ${submissionPublicCols}
       FROM store_kyc_submissions
       WHERE merchant_id = $1
         AND status <> 'DRAFT'
       ORDER BY submission_version DESC`,
      [merchantId]
    );
    return { ok: true, data: res.rows.map(mapSubmissionRow) };
  } catch (err) {
    return mapServiceError(err, 'listStoreSubmissions');
  }
}
