import {
  AuthorizedSellerStore,
  buildSellerAuthHeaders,
  canManageStoreKyc,
  isPlausibleJwtFormat,
  resolveSellerApiUrl
} from './sellerSession';

/**
 * Authenticated Seller MO-A / MO-B3 / MO-B4 API Client for `apps/seller-web`.
 *
 * Security invariants:
 * - Always authenticates via `Authorization: Bearer <sellerToken>`.
 * - Every store-scoped onboarding, compliance, or store-notification call uses
 *   an explicitly selected `AuthorizedSellerStore` validated from `/api/v1/seller/stores`
 *   and enforces client pre-checks mirroring Owner `KYC_MANAGE` permission while
 *   treating backend authorization decisions as final authority.
 * - Never exposes or constructs server filesystem/storage paths; document previews/downloads
 *   stream through authenticated API endpoints using Bearer auth headers.
 */

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
  fulfilled?: boolean;
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

export interface OnboardingDraftPayload {
  businessName?: string;
  category?: string;
  businessType?: 'FIXED_SHOP';
  premisesType?: string;
  operatingModel?: string;
  businessTypeConfirmed?: boolean;
  fixedPremisesConfirmed?: boolean;
  premisesOwnershipType?: PremisesOwnershipType;
  address?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracyMeters?: number;
}

export interface SafeEvidenceReference {
  kind: string;
  referenceId?: string;
  label: string;
}

export interface WarningResponseRecord {
  id: string;
  warningId: string;
  respondedBySellerAccountId: string;
  responseMessage: string;
  evidenceReferences: SafeEvidenceReference[];
  createdAt: string;
}

export interface OwnerComplianceWarningSummary {
  id: string;
  storeId: string;
  warningNumber: number;
  violationCategory: string;
  severity: string;
  isFormalOrdinary: boolean;
  reason: string;
  requiredCorrectiveAction: string;
  issuedAt: string;
  correctiveDeadline: string | null;
  status: 'OPEN' | 'RESOLVED';
  isOverdue: boolean;
  isEscalated: boolean;
  escalatedAt: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  evidenceReferences: SafeEvidenceReference[];
  responses: WarningResponseRecord[];
}

export interface StoreWarningCounts {
  openOrdinaryWarnings: number;
  openSeriousWarnings: number;
  totalOpenWarnings: number;
  overdueOpenWarnings: number;
  resolvedWarnings: number;
  totalWarningsIssued: number;
}

export interface OwnerStoreComplianceView {
  store: {
    id: string;
    businessName: string;
    category: string;
    isOpen: boolean;
  };
  complianceState: {
    onboardingStatus: string;
    isSuspended: boolean;
    suspendedAt: string | null;
    suspensionType: string | null;
    suspensionReason: string | null;
    ownerSuspensionResponse: string | null;
    ownerSuspensionEvidence: SafeEvidenceReference[] | null;
    ownerSuspensionRespondedAt: string | null;
    lastReactivatedAt: string | null;
    lastReactivationReason: string | null;
  };
  warningCounts: StoreWarningCounts;
  warnings: OwnerComplianceWarningSummary[];
}

export interface OwnerNotificationRecord {
  id: string;
  outboxEventId: string;
  storeId: string;
  storeBusinessName: string;
  eventType: string;
  title: string;
  message: string;
  submissionId: string | null;
  submissionVersion: number | null;
  warningId: string | null;
  metadata: Record<string, unknown>;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface SellerApiCallResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  code: string | null;
  details?: Record<string, unknown> | null;
  authExpired: boolean;
  forbidden: boolean;
}

const DEFAULT_TIMEOUT_MS = 12000;

function extractError(data: any, fallback: string): string {
  if (data && typeof data.error === 'string' && data.error.trim().length > 0) {
    return data.error.trim();
  }
  if (data && typeof data.message === 'string' && data.message.trim().length > 0) {
    return data.message.trim();
  }
  return fallback;
}

function buildMissingAuthResult<T>(message: string, code: string, status = 401): SellerApiCallResult<T> {
  return {
    ok: false,
    status,
    data: null,
    error: message,
    code,
    authExpired: status === 401,
    forbidden: status === 403
  };
}

function guardStoreOwnerAccess<T>(
  token: string | null | undefined,
  activeStore: AuthorizedSellerStore | null | undefined
): SellerApiCallResult<T> | null {
  if (!isPlausibleJwtFormat(token)) {
    return buildMissingAuthResult<T>('Seller authentication is required. Please sign in again.', 'AUTH_REQUIRED', 401);
  }
  if (!activeStore || !activeStore.id) {
    return buildMissingAuthResult<T>('Please select an authorized store first.', 'STORE_REQUIRED', 400);
  }
  if (!canManageStoreKyc(activeStore)) {
    return buildMissingAuthResult<T>(
      `Owner access with KYC_MANAGE permission is required for ${activeStore.businessName} (current role: ${activeStore.role}).`,
      'OWNER_ROLE_REQUIRED',
      403
    );
  }
  return null;
}

async function requestSellerJson<T>(params: {
  apiUrl?: string;
  token: string;
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SellerApiCallResult<T>> {
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

  const baseUrl = resolveSellerApiUrl(params.apiUrl);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const headers = buildSellerAuthHeaders(
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

    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        data: null,
        error: extractError(data, 'Your seller session has expired. Please sign in again.'),
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
        error: extractError(data, 'Only the active Store Owner may perform this action.'),
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
        details: data && typeof data.details === 'object' ? data.details : null,
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
        ? 'Request timed out while contacting StreetVerse API.'
        : 'Unable to reach StreetVerse API Gateway. Check your connection.',
      code: isAbort ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      authExpired: false,
      forbidden: false
    };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export async function fetchSellerOnboardingOverview(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<SellerApiCallResult<{ success: true } & OnboardingOverview>> {
  const denied = guardStoreOwnerAccess<{ success: true } & OnboardingOverview>(
    params.token,
    params.activeStore
  );
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(params.activeStore!.id)}/onboarding`,
    fetchImpl: params.fetchImpl
  });
}

export async function saveSellerOnboardingDraft(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  payload: OnboardingDraftPayload;
  fetchImpl?: typeof fetch;
}): Promise<
  SellerApiCallResult<{
    success: true;
    profile: OnboardingProfile;
    locationChangeDetected: boolean;
    message?: string;
  }>
> {
  const denied = guardStoreOwnerAccess<{
    success: true;
    profile: OnboardingProfile;
    locationChangeDetected: boolean;
    message?: string;
  }>(params.token, params.activeStore);
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(params.activeStore!.id)}/onboarding`,
    method: 'PUT',
    body: params.payload,
    fetchImpl: params.fetchImpl
  });
}

export async function uploadSellerOnboardingDocumentWithProgress(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  requirementKey: string;
  file: File | Blob;
  filename?: string;
  onProgress?: (percent: number) => void;
  fetchImpl?: typeof fetch;
}): Promise<SellerApiCallResult<{ success: true; document: KycDocumentSummary }>> {
  const denied = guardStoreOwnerAccess<{ success: true; document: KycDocumentSummary }>(
    params.token,
    params.activeStore
  );
  if (denied) return denied;

  const baseUrl = resolveSellerApiUrl(params.apiUrl);
  const url = `${baseUrl}/api/v1/seller/stores/${encodeURIComponent(
    params.activeStore!.id
  )}/onboarding/documents`;
  const formData = new FormData();
  const safeName =
    params.filename || (typeof File !== 'undefined' && params.file instanceof File ? params.file.name : 'document');
  formData.append('requirementKey', params.requirementKey.trim().toUpperCase());
  formData.append('document', params.file, safeName);

  // Use XMLHttpRequest when running in a browser without an injected test fetchImpl so
  // callers receive real upload progress events.
  if (!params.fetchImpl && typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Authorization', `Bearer ${params.token!.trim()}`);
      xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');

      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && evt.total > 0 && params.onProgress) {
          const pct = Math.min(99, Math.round((evt.loaded / evt.total) * 100));
          params.onProgress(pct);
        }
      };

      xhr.onload = () => {
        let data: any = null;
        try {
          data = JSON.parse(xhr.responseText || '{}');
        } catch {
          data = null;
        }

        if (xhr.status === 401) {
          resolve({
            ok: false,
            status: 401,
            data: null,
            error: extractError(data, 'Your seller session has expired. Please sign in again.'),
            code: typeof data?.code === 'string' ? data.code : 'UNAUTHORIZED',
            authExpired: true,
            forbidden: false
          });
          return;
        }
        if (xhr.status === 403) {
          resolve({
            ok: false,
            status: 403,
            data: null,
            error: extractError(data, 'Only the active Store Owner can upload onboarding documents.'),
            code: typeof data?.code === 'string' ? data.code : 'FORBIDDEN',
            authExpired: false,
            forbidden: true
          });
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          resolve({
            ok: false,
            status: xhr.status,
            data: null,
            error: extractError(data, 'Document upload failed.'),
            code: typeof data?.code === 'string' ? data.code : 'UPLOAD_FAILED',
            authExpired: false,
            forbidden: false
          });
          return;
        }
        if (params.onProgress) params.onProgress(100);
        resolve({
          ok: true,
          status: xhr.status,
          data: data as { success: true; document: KycDocumentSummary },
          error: null,
          code: null,
          authExpired: false,
          forbidden: false
        });
      };

      xhr.onerror = () => {
        resolve({
          ok: false,
          status: 0,
          data: null,
          error: 'Network error during file upload.',
          code: 'NETWORK_ERROR',
          authExpired: false,
          forbidden: false
        });
      };

      xhr.send(formData);
    });
  }

  const fetchImpl = params.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Upload client is unavailable.',
      code: 'FETCH_UNAVAILABLE',
      authExpired: false,
      forbidden: false
    };
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: buildSellerAuthHeaders(params.token),
      credentials: 'include',
      body: formData
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (params.onProgress && res.ok) params.onProgress(100);
    return {
      ok: res.ok,
      status: res.status,
      data: res.ok ? (data as { success: true; document: KycDocumentSummary }) : null,
      error: res.ok ? null : extractError(data, 'Document upload failed.'),
      code: res.ok ? null : typeof data?.code === 'string' ? data.code : 'UPLOAD_FAILED',
      authExpired: res.status === 401,
      forbidden: res.status === 403
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Network error during document upload.',
      code: 'NETWORK_ERROR',
      authExpired: false,
      forbidden: false
    };
  }
}

export async function fetchSellerDocumentBlob(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  documentId: string;
  fetchImpl?: typeof fetch;
}): Promise<
  SellerApiCallResult<{
    blob: Blob;
    mimeType: string;
    filename: string;
  }>
> {
  const denied = guardStoreOwnerAccess<{ blob: Blob; mimeType: string; filename: string }>(
    params.token,
    params.activeStore
  );
  if (denied) return denied;

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

  const baseUrl = resolveSellerApiUrl(params.apiUrl);
  try {
    const res = await fetchImpl(
      `${baseUrl}/api/v1/seller/stores/${encodeURIComponent(
        params.activeStore!.id
      )}/onboarding/documents/${encodeURIComponent(params.documentId)}`,
      {
        method: 'GET',
        headers: buildSellerAuthHeaders(params.token),
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
        error: extractError(data, 'Unable to load document.'),
        code: typeof data?.code === 'string' ? data.code : 'DOCUMENT_READ_FAILED',
        authExpired: res.status === 401,
        forbidden: res.status === 403
      };
    }

    const blob = await res.blob();
    const mimeType = res.headers.get('content-type') || blob.type || 'application/octet-stream';
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/i);
    const filename = match ? match[1] : `kyc-document-${params.documentId}`;

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
      error: 'Network error while fetching document.',
      code: 'NETWORK_ERROR',
      authExpired: false,
      forbidden: false
    };
  }
}

export async function deleteSellerDraftDocument(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  documentId: string;
  fetchImpl?: typeof fetch;
}): Promise<SellerApiCallResult<{ success: true; deleted: boolean }>> {
  const denied = guardStoreOwnerAccess<{ success: true; deleted: boolean }>(
    params.token,
    params.activeStore
  );
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(
      params.activeStore!.id
    )}/onboarding/documents/${encodeURIComponent(params.documentId)}`,
    method: 'DELETE',
    fetchImpl: params.fetchImpl
  });
}

export async function submitSellerOnboardingApplication(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<
  SellerApiCallResult<{
    success: true;
    submission: SubmissionSummary;
    submissionId: string;
    submissionVersion: number;
    status: string;
    message: string;
  }>
> {
  const denied = guardStoreOwnerAccess<{
    success: true;
    submission: SubmissionSummary;
    submissionId: string;
    submissionVersion: number;
    status: string;
    message: string;
  }>(params.token, params.activeStore);
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(params.activeStore!.id)}/onboarding/submit`,
    method: 'POST',
    fetchImpl: params.fetchImpl
  });
}

export async function fetchSellerOnboardingSubmissions(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<SellerApiCallResult<{ success: true; submissions: SubmissionSummary[] }>> {
  const denied = guardStoreOwnerAccess<{ success: true; submissions: SubmissionSummary[] }>(
    params.token,
    params.activeStore
  );
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(params.activeStore!.id)}/onboarding/submissions`,
    fetchImpl: params.fetchImpl
  });
}

export async function fetchSellerStoreCompliance(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<SellerApiCallResult<{ success: true } & OwnerStoreComplianceView>> {
  const denied = guardStoreOwnerAccess<{ success: true } & OwnerStoreComplianceView>(
    params.token,
    params.activeStore
  );
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(params.activeStore!.id)}/compliance`,
    fetchImpl: params.fetchImpl
  });
}

export async function respondToSellerWarning(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  warningId: string;
  responseMessage: string;
  evidenceReferences?: SafeEvidenceReference[];
  fetchImpl?: typeof fetch;
}): Promise<
  SellerApiCallResult<{
    success: true;
    response: WarningResponseRecord;
    warningStatus: string;
    notificationEventId: string | null;
  }>
> {
  const denied = guardStoreOwnerAccess<{
    success: true;
    response: WarningResponseRecord;
    warningStatus: string;
    notificationEventId: string | null;
  }>(params.token, params.activeStore);
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(
      params.activeStore!.id
    )}/compliance/warnings/${encodeURIComponent(params.warningId)}/respond`,
    method: 'POST',
    body: {
      responseMessage: params.responseMessage,
      evidenceReferences: params.evidenceReferences || []
    },
    fetchImpl: params.fetchImpl
  });
}

export async function respondToSellerSuspension(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  responseMessage: string;
  evidenceReferences?: SafeEvidenceReference[];
  fetchImpl?: typeof fetch;
}): Promise<
  SellerApiCallResult<{
    success: true;
    storeId: string;
    status: string;
    respondedAt: string;
    notificationEventId: string | null;
  }>
> {
  const denied = guardStoreOwnerAccess<{
    success: true;
    storeId: string;
    status: string;
    respondedAt: string;
    notificationEventId: string | null;
  }>(params.token, params.activeStore);
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(
      params.activeStore!.id
    )}/compliance/suspension/respond`,
    method: 'POST',
    body: {
      responseMessage: params.responseMessage,
      evidenceReferences: params.evidenceReferences || []
    },
    fetchImpl: params.fetchImpl
  });
}

export async function fetchStoreOwnerNotifications(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  fetchImpl?: typeof fetch;
}): Promise<
  SellerApiCallResult<{
    success: true;
    storeId: string;
    totalCount: number;
    unreadCount: number;
    limit: number;
    offset: number;
    notifications: OwnerNotificationRecord[];
  }>
> {
  const denied = guardStoreOwnerAccess<{
    success: true;
    storeId: string;
    totalCount: number;
    unreadCount: number;
    limit: number;
    offset: number;
    notifications: OwnerNotificationRecord[];
  }>(params.token, params.activeStore);
  if (denied) return denied;

  const qs = new URLSearchParams();
  if (params.unreadOnly) qs.set('unreadOnly', 'true');
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : '';

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(params.activeStore!.id)}/notifications${query}`,
    fetchImpl: params.fetchImpl
  });
}

export async function markAllStoreNotificationsRead(params: {
  apiUrl?: string;
  token: string | null | undefined;
  activeStore: AuthorizedSellerStore | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<SellerApiCallResult<{ success: true; storeId: string; markedReadCount: number }>> {
  const denied = guardStoreOwnerAccess<{ success: true; storeId: string; markedReadCount: number }>(
    params.token,
    params.activeStore
  );
  if (denied) return denied;

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token!.trim(),
    path: `/api/v1/seller/stores/${encodeURIComponent(params.activeStore!.id)}/notifications/read-all`,
    method: 'POST',
    fetchImpl: params.fetchImpl
  });
}

export async function fetchAccountOwnerNotifications(params: {
  apiUrl?: string;
  token: string | null | undefined;
  storeId?: string;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  fetchImpl?: typeof fetch;
}): Promise<
  SellerApiCallResult<{
    success: true;
    totalCount: number;
    unreadCount: number;
    limit: number;
    offset: number;
    notifications: OwnerNotificationRecord[];
  }>
> {
  if (!isPlausibleJwtFormat(params.token)) {
    return buildMissingAuthResult('Seller authentication required.', 'AUTH_REQUIRED', 401);
  }

  const qs = new URLSearchParams();
  if (params.storeId) qs.set('storeId', params.storeId);
  if (params.unreadOnly) qs.set('unreadOnly', 'true');
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : '';

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token.trim(),
    path: `/api/v1/seller/notifications${query}`,
    fetchImpl: params.fetchImpl
  });
}

export async function fetchAccountUnreadSummary(params: {
  apiUrl?: string;
  token: string | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<
  SellerApiCallResult<{
    success: true;
    unreadCount: number;
    byStore: Array<{ storeId: string; storeBusinessName: string; unreadCount: number }>;
  }>
> {
  if (!isPlausibleJwtFormat(params.token)) {
    return buildMissingAuthResult('Seller authentication required.', 'AUTH_REQUIRED', 401);
  }

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token.trim(),
    path: '/api/v1/seller/notifications/unread-count',
    fetchImpl: params.fetchImpl
  });
}

export async function markOwnerNotificationRead(params: {
  apiUrl?: string;
  token: string | null | undefined;
  notificationId: string;
  activeStore?: AuthorizedSellerStore | null;
  fetchImpl?: typeof fetch;
}): Promise<SellerApiCallResult<{ success: true; notification: OwnerNotificationRecord }>> {
  if (!isPlausibleJwtFormat(params.token)) {
    return buildMissingAuthResult('Seller authentication required.', 'AUTH_REQUIRED', 401);
  }

  if (params.activeStore) {
    const denied = guardStoreOwnerAccess<{ success: true; notification: OwnerNotificationRecord }>(
      params.token,
      params.activeStore
    );
    if (denied) return denied;
    return requestSellerJson({
      apiUrl: params.apiUrl,
      token: params.token.trim(),
      path: `/api/v1/seller/stores/${encodeURIComponent(
        params.activeStore.id
      )}/notifications/${encodeURIComponent(params.notificationId)}/read`,
      method: 'POST',
      fetchImpl: params.fetchImpl
    });
  }

  return requestSellerJson({
    apiUrl: params.apiUrl,
    token: params.token.trim(),
    path: `/api/v1/seller/notifications/${encodeURIComponent(params.notificationId)}/read`,
    method: 'POST',
    fetchImpl: params.fetchImpl
  });
}
