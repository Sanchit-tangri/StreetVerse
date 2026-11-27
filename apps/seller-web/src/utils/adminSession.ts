import { DocumentRequirement } from './sellerOnboarding';
import { SessionStorageLike } from './sellerSession';

/**
 * Isolated Administrative Auth & Operations API Client (`apps/seller-web`).
 *
 * Strict identity separation:
 * - Uses ONLY `streetverse_admin_token` (`ADMIN_TOKEN_STORAGE_KEY`).
 * - NEVER reads or reuses `streetverse_seller_token`, `streetverse_buyer_token`,
 *   or Seller store selection storage keys.
 * - Hydrates identity, role (`ADMIN`), active status, and permissions exclusively from
 *   `GET /api/v1/admin/me`.
 * - Never fabricates admin sessions or bypasses server checks.
 */

export const ADMIN_TOKEN_STORAGE_KEY = 'streetverse_admin_token';
const DEFAULT_API_URL = 'https://clatter-mousiness-smugness.ngrok-free.dev';
const DEFAULT_TIMEOUT_MS = 12000;
const JWT_FORMAT_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type AdminPermission =
  | 'KYC_QUEUE_READ'
  | 'KYC_SUBMISSION_READ'
  | 'KYC_REVIEW_DECIDE'
  | 'STORE_COMPLIANCE_MANAGE';

export interface AdminAccountPublic {
  id: string;
  email: string;
  fullName: string;
  role: 'ADMIN';
  permissions: readonly AdminPermission[];
  principalType: 'ADMIN_ACCOUNT';
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSessionHydrationResult {
  status: 'authenticated' | 'unauthenticated' | 'forbidden' | 'service_unavailable';
  admin: AdminAccountPublic | null;
  token: string | null;
  errorMessage: string | null;
  errorCode: string | null;
}

export interface AdminApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  code: string | null;
  retryAfterSeconds?: number | null;
  authExpired: boolean;
  forbidden: boolean;
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

export interface SafeEvidenceRef {
  kind: string;
  referenceId?: string;
  label: string;
}

export interface AdminStoreWarning {
  id: string;
  storeId: string;
  warningNumber: number;
  violationCategory: string;
  severity: string;
  isFormalOrdinary: boolean;
  reason: string;
  requiredCorrectiveAction: string;
  issuedByAdminId: string;
  issuedAt: string;
  correctiveDeadline: string | null;
  status: 'OPEN' | 'RESOLVED';
  isOverdue: boolean;
  escalatedAt: string | null;
  escalatedByAdminId: string | null;
  escalationNotes: string | null;
  resolvedByAdminId: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  resolutionEvidenceChecked: boolean;
  evidenceReferences: SafeEvidenceRef[];
  responses: Array<{
    id: string;
    warningId: string;
    respondedBySellerAccountId: string;
    responseMessage: string;
    evidenceReferences: SafeEvidenceRef[];
    createdAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface AdminStoreComplianceView {
  store: {
    id: string;
    businessName: string;
    category: string;
    isOpen: boolean;
  };
  complianceState: {
    onboardingStatus: string;
    preSuspensionStatus: string | null;
    isSuspended: boolean;
    suspendedAt: string | null;
    suspendedByAdminId: string | null;
    suspensionType: string | null;
    suspensionReason: string | null;
    suspensionEvidence: SafeEvidenceRef[] | null;
    ownerSuspensionResponse: string | null;
    ownerSuspensionEvidence: SafeEvidenceRef[] | null;
    ownerSuspensionRespondedAt: string | null;
    lastReactivatedAt: string | null;
    lastReactivatedByAdminId: string | null;
    lastReactivationReason: string | null;
  };
  warningCounts: {
    openOrdinaryWarnings: number;
    openSeriousWarnings: number;
    totalOpenWarnings: number;
    overdueOpenWarnings: number;
    resolvedWarnings: number;
    totalWarningsIssued: number;
  };
  warnings: AdminStoreWarning[];
  auditEvents: Array<{
    id: string;
    actorType: string;
    actorId: string | null;
    eventType: string;
    eventMetadata: unknown;
    createdAt: string;
  }>;
  notificationEvents: Array<{
    id: string;
    warningId: string | null;
    recipientRole: string;
    eventType: string;
    deliveryStatus: string;
    createdAt: string;
  }>;
}

export interface AdminOutboxSummary {
  counts: {
    pending: number;
    processing: number;
    retrying: number;
    delivered: number;
    terminalFailed: number;
    cancelled: number;
    total: number;
    unconfiguredEmailCount: number;
    failedEmailCount: number;
    staleProcessingCount: number;
  };
  worker: {
    workerId: string;
    enabled: boolean;
    running: boolean;
    stopping: boolean;
    activeCount: number;
    totalTicks: number;
    totalClaimed: number;
    totalDelivered: number;
    totalRetried: number;
    totalTerminalFailed: number;
    lastTickAt: string | null;
    lastError: string | null;
  } | null;
}

export interface AdminOutboxEventRecord {
  id: string;
  storeId: string;
  storeBusinessName: string;
  recipientRole: string;
  ownerSellerAccountId: string;
  resolvedRecipientSellerAccountId: string | null;
  eventType: string;
  deliveryStatus: string;
  inAppStatus: string;
  emailStatus: string;
  emailError: string | null;
  deliveryAttempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  failedAt: string | null;
  replayedAt: string | null;
  replayedByAdminId: string | null;
  dispatchedAt: string | null;
  createdAt: string;
}

export function resolveAdminApiUrl(override?: string): string {
  const raw = override || process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

export function isPlausibleAdminJwtFormat(token: unknown): token is string {
  return typeof token === 'string' && JWT_FORMAT_REGEX.test(token.trim());
}

function getStorage(override?: SessionStorageLike | null): SessionStorageLike | null {
  if (override !== undefined) return override;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readAdminAccessToken(storageOverride?: SessionStorageLike | null): string | null {
  const storage = getStorage(storageOverride);
  if (!storage) return null;
  try {
    const raw = storage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (!raw || !isPlausibleAdminJwtFormat(raw)) {
      if (raw !== null) storage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      return null;
    }
    return raw.trim();
  } catch {
    return null;
  }
}

export function saveAdminAccessToken(
  token: string,
  storageOverride?: SessionStorageLike | null
): boolean {
  const storage = getStorage(storageOverride);
  if (!isPlausibleAdminJwtFormat(token)) {
    if (storage) {
      try {
        storage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      } catch {
        // ignore storage removal failures
      }
    }
    return false;
  }
  if (storage) {
    try {
      storage.setItem(ADMIN_TOKEN_STORAGE_KEY, token.trim());
    } catch {
      // ignore write error
    }
  }
  return true;
}

export function clearAdminSession(storageOverride?: SessionStorageLike | null): void {
  const storage = getStorage(storageOverride);
  if (!storage) return;
  try {
    storage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    // ignore removal failures
  }
}

export function buildAdminAuthHeaders(
  token: string | null | undefined,
  extraHeaders?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    'ngrok-skip-browser-warning': 'true',
    ...(extraHeaders || {})
  };
  if (isPlausibleAdminJwtFormat(token)) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

export function hasAdminPermission(
  admin: AdminAccountPublic | null | undefined,
  permission: AdminPermission
): boolean {
  if (!admin || admin.principalType !== 'ADMIN_ACCOUNT' || admin.role !== 'ADMIN') return false;
  if (admin.status !== 'ACTIVE') return false;
  return Array.isArray(admin.permissions) && admin.permissions.includes(permission);
}

function normalizeAdminAccount(raw: any): AdminAccountPublic | null {
  if (!raw || typeof raw !== 'object') return null;
  if (
    typeof raw.id !== 'string' ||
    !raw.id.trim() ||
    raw.role !== 'ADMIN' ||
    raw.principalType !== 'ADMIN_ACCOUNT'
  ) {
    return null;
  }
  return {
    id: raw.id.trim(),
    email: typeof raw.email === 'string' ? raw.email : '',
    fullName: typeof raw.fullName === 'string' ? raw.fullName : 'Admin',
    role: 'ADMIN',
    permissions: Array.isArray(raw.permissions) ? (raw.permissions as AdminPermission[]) : [],
    principalType: 'ADMIN_ACCOUNT',
    status: typeof raw.status === 'string' ? raw.status : 'ACTIVE',
    lastLoginAt: typeof raw.lastLoginAt === 'string' ? raw.lastLoginAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
  };
}

function extractError(data: any, fallback: string): string {
  if (data && typeof data.error === 'string' && data.error.trim().length > 0) {
    return data.error.trim();
  }
  if (data && typeof data.message === 'string' && data.message.trim().length > 0) {
    return data.message.trim();
  }
  return fallback;
}

async function requestAdminJson<T>(params: {
  apiUrl?: string;
  token: string | null | undefined;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  skipAuthHeader?: boolean;
}): Promise<AdminApiResult<T>> {
  if (!params.skipAuthHeader && !isPlausibleAdminJwtFormat(params.token)) {
    return {
      ok: false,
      status: 401,
      data: null,
      error: 'Admin session authentication required.',
      code: 'ADMIN_AUTH_REQUIRED',
      authExpired: true,
      forbidden: false
    };
  }

  const fetchImpl = params.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Network client is unavailable.',
      code: 'FETCH_UNAVAILABLE',
      authExpired: false,
      forbidden: false
    };
  }

  const baseUrl = resolveAdminApiUrl(params.apiUrl);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const headers = params.skipAuthHeader
      ? {
          'ngrok-skip-browser-warning': 'true',
          ...(params.body !== undefined ? { 'Content-Type': 'application/json' } : {})
        }
      : buildAdminAuthHeaders(
          params.token,
          params.body !== undefined ? { 'Content-Type': 'application/json' } : undefined
        );

    const res = await fetchImpl(`${baseUrl}${params.path}`, {
      method: params.method || 'GET',
      headers,
      credentials: 'include',
      ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
      ...(controller ? { signal: controller.signal } : {})
    });

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    const retryHeader = res.headers?.get?.('Retry-After');
    const retryAfterSeconds =
      retryHeader && Number.isFinite(Number(retryHeader))
        ? Number(retryHeader)
        : typeof data?.retryAfterSeconds === 'number'
          ? data.retryAfterSeconds
          : null;

    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        data: null,
        error: extractError(data, 'Admin session expired or invalid. Please authenticate again.'),
        code: typeof data?.code === 'string' ? data.code : 'UNAUTHORIZED',
        authExpired: true,
        forbidden: false
      };
    }

    if (res.status === 403) {
      return {
        ok: false,
        status: 403,
        data: null,
        error: extractError(data, 'Your administrative account lacks permission for this action.'),
        code: typeof data?.code === 'string' ? data.code : 'FORBIDDEN',
        authExpired: false,
        forbidden: true
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: extractError(data, `Request failed with status ${res.status}.`),
        code: typeof data?.code === 'string' ? data.code : 'REQUEST_FAILED',
        retryAfterSeconds,
        authExpired: false,
        forbidden: false
      };
    }

    return {
      ok: true,
      status: res.status,
      data: data as T,
      error: null,
      code: null,
      authExpired: false,
      forbidden: false
    };
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      data: null,
      error: isAbort
        ? 'Request timed out contacting Admin API.'
        : 'Unable to reach StreetVerse Admin API.',
      code: isAbort ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      authExpired: false,
      forbidden: false
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function loginAdminAccount(params: {
  apiUrl?: string;
  email: string;
  password: string;
  storage?: SessionStorageLike | null;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ token: string; expiresIn: string; admin: AdminAccountPublic }>> {
  const res = await requestAdminJson<{
    success: true;
    token: string;
    expiresIn: string;
    admin: any;
  }>({
    apiUrl: params.apiUrl,
    token: null,
    skipAuthHeader: true,
    path: '/api/v1/admin/auth/login',
    method: 'POST',
    body: {
      email: params.email.trim(),
      password: params.password
    },
    fetchImpl: params.fetchImpl
  });

  if (!res.ok || !res.data) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: res.error,
      code: res.code,
      retryAfterSeconds: res.retryAfterSeconds,
      authExpired: false,
      forbidden: res.forbidden
    };
  }

  const admin = normalizeAdminAccount(res.data.admin);
  if (!admin || !saveAdminAccessToken(res.data.token, params.storage)) {
    clearAdminSession(params.storage);
    return {
      ok: false,
      status: 403,
      data: null,
      error: 'Received invalid administrative session credentials.',
      code: 'INVALID_ADMIN_TOKEN',
      authExpired: false,
      forbidden: true
    };
  }

  return {
    ok: true,
    status: res.status,
    data: {
      token: res.data.token.trim(),
      expiresIn: res.data.expiresIn,
      admin
    },
    error: null,
    code: null,
    authExpired: false,
    forbidden: false
  };
}

export async function hydrateAdminSession(params: {
  apiUrl?: string;
  token?: string | null;
  storage?: SessionStorageLike | null;
  fetchImpl?: typeof fetch;
}): Promise<AdminSessionHydrationResult> {
  const storage = getStorage(params.storage);
  const candidateToken =
    params.token !== undefined
      ? typeof params.token === 'string'
        ? params.token.trim()
        : null
      : readAdminAccessToken(storage);

  if (!isPlausibleAdminJwtFormat(candidateToken)) {
    clearAdminSession(storage);
    return {
      status: 'unauthenticated',
      admin: null,
      token: null,
      errorMessage: null,
      errorCode: null
    };
  }

  const res = await requestAdminJson<{ success: true; admin: any }>({
    apiUrl: params.apiUrl,
    token: candidateToken,
    path: '/api/v1/admin/me',
    fetchImpl: params.fetchImpl
  });

  if (res.authExpired) {
    clearAdminSession(storage);
    return {
      status: 'unauthenticated',
      admin: null,
      token: null,
      errorMessage: res.error,
      errorCode: res.code
    };
  }

  if (res.forbidden || res.status === 404) {
    clearAdminSession(storage);
    return {
      status: 'forbidden',
      admin: null,
      token: null,
      errorMessage: res.error || 'Admin access revoked or inactive.',
      errorCode: res.code
    };
  }

  if (res.status >= 500 || res.status === 429 || res.status === 0) {
    return {
      status: 'service_unavailable',
      admin: null,
      token: candidateToken,
      errorMessage: res.error || 'Admin session check unavailable.',
      errorCode: res.code
    };
  }

  const admin = normalizeAdminAccount(res.data?.admin);
  if (!res.ok || !admin || admin.status !== 'ACTIVE') {
    clearAdminSession(storage);
    return {
      status: 'forbidden',
      admin: null,
      token: null,
      errorMessage: 'Session is not an active Admin account.',
      errorCode: 'ADMIN_SESSION_INVALID'
    };
  }

  return {
    status: 'authenticated',
    admin,
    token: candidateToken,
    errorMessage: null,
    errorCode: null
  };
}

export async function fetchAdminOnboardingQueue(params: {
  apiUrl?: string;
  token: string;
  status?: string;
  category?: string;
  search?: string;
  sort?: 'submitted_asc' | 'submitted_desc';
  limit?: number;
  offset?: number;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true } & AdminOnboardingQueueResult>> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.category) qs.set('category', params.category);
  if (params.search && params.search.trim()) qs.set('search', params.search.trim());
  if (params.sort) qs.set('sort', params.sort);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : '';

  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/onboarding/queue${query}`,
    fetchImpl: params.fetchImpl
  });
}

export async function fetchAdminStoreDetails(params: {
  apiUrl?: string;
  token: string;
  storeId: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true } & AdminStoreOnboardingDetails>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/onboarding/stores/${encodeURIComponent(params.storeId)}`,
    fetchImpl: params.fetchImpl
  });
}

export async function fetchAdminDocumentBlob(params: {
  apiUrl?: string;
  token: string;
  submissionId: string;
  documentId: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ blob: Blob; mimeType: string; filename: string }>> {
  if (!isPlausibleAdminJwtFormat(params.token)) {
    return {
      ok: false,
      status: 401,
      data: null,
      error: 'Admin session required.',
      code: 'ADMIN_AUTH_REQUIRED',
      authExpired: true,
      forbidden: false
    };
  }
  const fetchImpl = params.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Network client unavailable.',
      code: 'FETCH_UNAVAILABLE',
      authExpired: false,
      forbidden: false
    };
  }

  const baseUrl = resolveAdminApiUrl(params.apiUrl);
  try {
    const res = await fetchImpl(
      `${baseUrl}/api/v1/admin/onboarding/submissions/${encodeURIComponent(
        params.submissionId
      )}/documents/${encodeURIComponent(params.documentId)}/content`,
      {
        method: 'GET',
        headers: buildAdminAuthHeaders(params.token),
        credentials: 'include'
      }
    );

    if (!res.ok) {
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return {
        ok: false,
        status: res.status,
        data: null,
        error: extractError(data, 'Unable to stream KYC document.'),
        code: typeof data?.code === 'string' ? data.code : 'DOCUMENT_STREAM_FAILED',
        authExpired: res.status === 401,
        forbidden: res.status === 403
      };
    }

    const blob = await res.blob();
    const mimeType = res.headers.get('content-type') || blob.type || 'application/octet-stream';
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/i);
    const filename = match ? match[1] : `kyc-${params.documentId}`;

    return {
      ok: true,
      status: res.status,
      data: { blob, mimeType, filename },
      error: null,
      code: null,
      authExpired: false,
      forbidden: false
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Network error streaming document.',
      code: 'NETWORK_ERROR',
      authExpired: false,
      forbidden: false
    };
  }
}

export async function startAdminSubmissionReview(params: {
  apiUrl?: string;
  token: string;
  submissionId: string;
  reviewNotes?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true; decision: unknown }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/onboarding/submissions/${encodeURIComponent(params.submissionId)}/start-review`,
    method: 'POST',
    body: params.reviewNotes ? { reviewNotes: params.reviewNotes } : {},
    fetchImpl: params.fetchImpl
  });
}

export async function approveAdminSubmission(params: {
  apiUrl?: string;
  token: string;
  submissionId: string;
  checklist: AdminReviewChecklistInput;
  reviewNotes?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true; decision: unknown }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/onboarding/submissions/${encodeURIComponent(params.submissionId)}/approve`,
    method: 'POST',
    body: {
      checklist: params.checklist,
      ...(params.reviewNotes ? { reviewNotes: params.reviewNotes } : {})
    },
    fetchImpl: params.fetchImpl
  });
}

export async function requestAdminSubmissionInfo(params: {
  apiUrl?: string;
  token: string;
  submissionId: string;
  reason: string;
  requestedCorrections?: string[];
  requestedRequirements?: string[];
  reviewNotes?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true; decision: unknown }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/onboarding/submissions/${encodeURIComponent(
      params.submissionId
    )}/request-information`,
    method: 'POST',
    body: {
      reason: params.reason,
      requestedCorrections: params.requestedCorrections || [],
      requestedRequirements: params.requestedRequirements || [],
      ...(params.reviewNotes ? { reviewNotes: params.reviewNotes } : {})
    },
    fetchImpl: params.fetchImpl
  });
}

export async function rejectAdminSubmission(params: {
  apiUrl?: string;
  token: string;
  submissionId: string;
  reason: string;
  rejectionCategory: string;
  reviewNotes?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true; decision: unknown }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/onboarding/submissions/${encodeURIComponent(params.submissionId)}/reject`,
    method: 'POST',
    body: {
      reason: params.reason,
      rejectionCategory: params.rejectionCategory,
      ...(params.reviewNotes ? { reviewNotes: params.reviewNotes } : {})
    },
    fetchImpl: params.fetchImpl
  });
}

export async function fetchAdminWarningsList(params: {
  apiUrl?: string;
  token: string;
  status?: string;
  overdueOnly?: boolean;
  severity?: string;
  storeId?: string;
  limit?: number;
  offset?: number;
  fetchImpl?: typeof fetch;
}): Promise<
  AdminApiResult<{
    success: true;
    totalCount: number;
    limit: number;
    offset: number;
    warnings: Array<AdminStoreWarning & { businessName: string; category: string }>;
  }>
> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.overdueOnly) qs.set('overdueOnly', 'true');
  if (params.severity) qs.set('severity', params.severity);
  if (params.storeId) qs.set('storeId', params.storeId);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : '';

  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/compliance/warnings${query}`,
    fetchImpl: params.fetchImpl
  });
}

export async function fetchAdminStoreCompliance(params: {
  apiUrl?: string;
  token: string;
  storeId: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true } & AdminStoreComplianceView>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/stores/${encodeURIComponent(params.storeId)}/compliance`,
    fetchImpl: params.fetchImpl
  });
}

export async function issueAdminComplianceWarning(params: {
  apiUrl?: string;
  token: string;
  storeId: string;
  violationCategory: string;
  severity: string;
  reason: string;
  requiredCorrectiveAction: string;
  correctiveDeadline?: string;
  evidenceReferences?: SafeEvidenceRef[];
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/stores/${encodeURIComponent(params.storeId)}/compliance/warnings`,
    method: 'POST',
    body: {
      violationCategory: params.violationCategory,
      severity: params.severity,
      reason: params.reason,
      requiredCorrectiveAction: params.requiredCorrectiveAction,
      ...(params.correctiveDeadline ? { correctiveDeadline: params.correctiveDeadline } : {}),
      evidenceReferences: params.evidenceReferences || []
    },
    fetchImpl: params.fetchImpl
  });
}

export async function escalateAdminWarning(params: {
  apiUrl?: string;
  token: string;
  storeId: string;
  warningId: string;
  notes: string;
  evidenceReferences?: SafeEvidenceRef[];
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/stores/${encodeURIComponent(
      params.storeId
    )}/compliance/warnings/${encodeURIComponent(params.warningId)}/escalate`,
    method: 'POST',
    body: {
      notes: params.notes,
      evidenceReferences: params.evidenceReferences || []
    },
    fetchImpl: params.fetchImpl
  });
}

export async function resolveAdminWarning(params: {
  apiUrl?: string;
  token: string;
  storeId: string;
  warningId: string;
  reason: string;
  correctiveEvidenceChecked: boolean;
  allowResolutionWithoutOwnerResponse?: boolean;
  evidenceReferences?: SafeEvidenceRef[];
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/stores/${encodeURIComponent(
      params.storeId
    )}/compliance/warnings/${encodeURIComponent(params.warningId)}/resolve`,
    method: 'POST',
    body: {
      reason: params.reason,
      correctiveEvidenceChecked: params.correctiveEvidenceChecked,
      allowResolutionWithoutOwnerResponse: Boolean(params.allowResolutionWithoutOwnerResponse),
      evidenceReferences: params.evidenceReferences || []
    },
    fetchImpl: params.fetchImpl
  });
}

export async function suspendAdminStore(params: {
  apiUrl?: string;
  token: string;
  storeId: string;
  suspensionType: 'ORDINARY_VIOLATION' | 'PROTECTIVE_SERIOUS_RISK';
  violationCategory: string;
  reason: string;
  evidenceReferences?: SafeEvidenceRef[];
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/stores/${encodeURIComponent(params.storeId)}/compliance/suspend`,
    method: 'POST',
    body: {
      suspensionType: params.suspensionType,
      violationCategory: params.violationCategory,
      reason: params.reason,
      evidenceReferences: params.evidenceReferences || []
    },
    fetchImpl: params.fetchImpl
  });
}

export async function reactivateAdminStore(params: {
  apiUrl?: string;
  token: string;
  storeId: string;
  reason: string;
  correctiveEvidenceReviewed: boolean;
  evidenceReferences?: SafeEvidenceRef[];
  warningResolutions: Array<{
    warningId: string;
    reason: string;
    correctiveEvidenceChecked: boolean;
    allowResolutionWithoutOwnerResponse?: boolean;
    evidenceReferences?: SafeEvidenceRef[];
  }>;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/stores/${encodeURIComponent(params.storeId)}/compliance/reactivate`,
    method: 'POST',
    body: {
      reason: params.reason,
      correctiveEvidenceReviewed: params.correctiveEvidenceReviewed,
      evidenceReferences: params.evidenceReferences || [],
      warningResolutions: params.warningResolutions
    },
    fetchImpl: params.fetchImpl
  });
}

export async function fetchAdminOutboxSummary(params: {
  apiUrl?: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true } & AdminOutboxSummary>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: '/api/v1/admin/notifications/outbox/summary',
    fetchImpl: params.fetchImpl
  });
}

export async function fetchAdminOutboxEvents(params: {
  apiUrl?: string;
  token: string;
  status?: string;
  storeId?: string;
  eventType?: string;
  limit?: number;
  offset?: number;
  fetchImpl?: typeof fetch;
}): Promise<
  AdminApiResult<{
    success: true;
    totalCount: number;
    limit: number;
    offset: number;
    events: AdminOutboxEventRecord[];
  }>
> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.storeId) qs.set('storeId', params.storeId);
  if (params.eventType) qs.set('eventType', params.eventType);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : '';

  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/notifications/outbox${query}`,
    fetchImpl: params.fetchImpl
  });
}

export async function replayAdminOutboxEvent(params: {
  apiUrl?: string;
  token: string;
  eventId: string;
  reason?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdminApiResult<{ success: true; replay: unknown }>> {
  return requestAdminJson({
    apiUrl: params.apiUrl,
    token: params.token,
    path: `/api/v1/admin/notifications/outbox/${encodeURIComponent(params.eventId)}/replay`,
    method: 'POST',
    body: params.reason ? { reason: params.reason } : {},
    fetchImpl: params.fetchImpl
  });
}
