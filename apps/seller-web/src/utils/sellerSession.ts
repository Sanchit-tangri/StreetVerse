import { KycUploadOutcome, resolveKycUploadOutcome } from './kycUpload';

/**
 * Centralized Seller session & store-selection utilities for `apps/seller-web`.
 *
 * Auth transport & persistence note:
 * The StreetVerse API Gateway issues cross-origin stateless Bearer JWT access tokens
 * (`Authorization: Bearer <token>`) whose `sub` identifies `SELLER_ACCOUNT` without
 * HttpOnly cookie sessions or refresh tokens. Only the signed Bearer access token and
 * a non-authoritative preferred Store ID (`streetverse_seller_selected_store_id`) are
 * saved in `localStorage`. Legacy `streetverse_seller_merchant` JSON blobs, unauthenticated
 * fallback store IDs (`m1`), and client-supplied roles/permissions/KYC flags are never
 * trusted. Seller identity, store memberships, roles, and permissions are hydrated
 * strictly from `GET /api/v1/auth/me` and `GET /api/v1/seller/stores`.
 */

export const SELLER_TOKEN_STORAGE_KEY = 'streetverse_seller_token';
export const SELLER_SELECTED_STORE_STORAGE_KEY = 'streetverse_seller_selected_store_id';
export const LEGACY_SELLER_MERCHANT_STORAGE_KEY = 'streetverse_seller_merchant';
const DEFAULT_API_URL = 'https://clatter-mousiness-smugness.ngrok-free.dev';
const DEFAULT_HYDRATION_TIMEOUT_MS = 8000;

export type SellerRole = 'OWNER' | 'STAFF';

export type SellerPermission =
  | 'STORE_SETTINGS_WRITE'
  | 'STAFF_MANAGE'
  | 'KYC_MANAGE'
  | 'INVENTORY_READ'
  | 'INVENTORY_WRITE'
  | 'PRICE_WRITE'
  | 'ORDER_MANAGE'
  | 'SLOT_MANAGE'
  | 'FINANCIAL_REPORTS_READ';

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SellerAccountProfile {
  id: string;
  phone: string;
  email: string;
  isEmailVerified: boolean;
  status: string;
  createdAt?: string;
}

export interface AuthorizedSellerStore {
  id: string;
  businessName: string;
  category: string;
  upiVpa: string;
  address: string;
  pincode: string;
  isOpen: boolean;
  membershipId: string;
  role: SellerRole;
  membershipStatus: string;
  permissions: SellerPermission[];
}

export type SellerHydrationStatus =
  | 'authenticated'
  | 'no_stores'
  | 'unauthenticated'
  | 'forbidden'
  | 'service_unavailable';

export interface SellerSessionHydrationResult {
  status: SellerHydrationStatus;
  sellerAccount: SellerAccountProfile | null;
  stores: AuthorizedSellerStore[];
  activeStore: AuthorizedSellerStore | null;
  token: string | null;
  errorMessage: string | null;
  errorCode: string | null;
}

export interface HydrateSellerSessionOptions {
  apiUrl?: string;
  token?: string | null;
  preferredStoreId?: string | null;
  storage?: SessionStorageLike | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProtectedKycSubmissionParams {
  apiUrl?: string;
  token: string | null;
  activeStore: AuthorizedSellerStore | null;
  documentType: string;
  documentNumber: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProtectedKycSubmissionResult {
  outcome: KycUploadOutcome;
  httpStatus: number;
  authExpired: boolean;
  forbidden: boolean;
  errorCode: string | null;
}

const JWT_FORMAT_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const VALID_SELLER_PERMISSIONS: ReadonlySet<string> = new Set([
  'STORE_SETTINGS_WRITE',
  'STAFF_MANAGE',
  'KYC_MANAGE',
  'INVENTORY_READ',
  'INVENTORY_WRITE',
  'PRICE_WRITE',
  'ORDER_MANAGE',
  'SLOT_MANAGE',
  'FINANCIAL_REPORTS_READ'
]);

/**
 * Structural pre-flight check (`header.payload.signature`). Cryptographic signature,
 * `principalType === 'SELLER_ACCOUNT'`, expiration, and membership authorization are
 * always verified on the backend.
 */
export function isPlausibleJwtFormat(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  return trimmed.length > 0 && JWT_FORMAT_REGEX.test(trimmed);
}

export function resolveSellerApiUrl(override?: string): string {
  const raw = override || process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

function getStorage(override?: SessionStorageLike | null): SessionStorageLike | null {
  if (override !== undefined) {
    return override;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeGet(storage: SessionStorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: SessionStorageLike | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage write errors cleanly
  }
}

function safeRemove(storage: SessionStorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage removal errors cleanly
  }
}

export function clearLegacySellerMerchantCache(
  storageOverride?: SessionStorageLike | null
): void {
  const storage = getStorage(storageOverride);
  safeRemove(storage, LEGACY_SELLER_MERCHANT_STORAGE_KEY);
}

export function readSellerAccessToken(storageOverride?: SessionStorageLike | null): string | null {
  const storage = getStorage(storageOverride);
  clearLegacySellerMerchantCache(storage);

  const raw = safeGet(storage, SELLER_TOKEN_STORAGE_KEY);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!isPlausibleJwtFormat(trimmed)) {
    safeRemove(storage, SELLER_TOKEN_STORAGE_KEY);
    return null;
  }
  return trimmed;
}

export function saveSellerAccessToken(
  token: string,
  storageOverride?: SessionStorageLike | null
): boolean {
  const storage = getStorage(storageOverride);
  clearLegacySellerMerchantCache(storage);

  if (!isPlausibleJwtFormat(token)) {
    safeRemove(storage, SELLER_TOKEN_STORAGE_KEY);
    return false;
  }
  safeSet(storage, SELLER_TOKEN_STORAGE_KEY, token.trim());
  return true;
}

export function readPreferredStoreId(storageOverride?: SessionStorageLike | null): string | null {
  const storage = getStorage(storageOverride);
  const raw = safeGet(storage, SELLER_SELECTED_STORE_STORAGE_KEY);
  if (!raw || raw.trim().length === 0) return null;
  return raw.trim();
}

export function savePreferredStoreId(
  storeId: string | null,
  storageOverride?: SessionStorageLike | null
): void {
  const storage = getStorage(storageOverride);
  if (!storeId || storeId.trim().length === 0) {
    safeRemove(storage, SELLER_SELECTED_STORE_STORAGE_KEY);
    return;
  }
  safeSet(storage, SELLER_SELECTED_STORE_STORAGE_KEY, storeId.trim());
}

export function clearSellerSession(storageOverride?: SessionStorageLike | null): void {
  const storage = getStorage(storageOverride);
  safeRemove(storage, SELLER_TOKEN_STORAGE_KEY);
  safeRemove(storage, SELLER_SELECTED_STORE_STORAGE_KEY);
  safeRemove(storage, LEGACY_SELLER_MERCHANT_STORAGE_KEY);
}

export function buildSellerAuthHeaders(
  token: string | null | undefined,
  extraHeaders?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    'ngrok-skip-browser-warning': 'true',
    ...(extraHeaders || {})
  };
  if (isPlausibleJwtFormat(token)) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function extractApiError(data: any, fallback: string): string {
  if (data && typeof data.error === 'string' && data.error.trim().length > 0) {
    return data.error.trim();
  }
  if (data && typeof data.message === 'string' && data.message.trim().length > 0) {
    return data.message.trim();
  }
  return fallback;
}

function normalizeSellerAccount(raw: any): SellerAccountProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null;

  return {
    id: raw.id.trim(),
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    email: typeof raw.email === 'string' ? raw.email : '',
    isEmailVerified: Boolean(raw.isEmailVerified),
    status: typeof raw.status === 'string' ? raw.status : 'ACTIVE',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined
  };
}

/**
 * Strips any unrecognized/untrusted properties (such as legacy `isVerified` or
 * `kycApproval`) and accepts only ACTIVE server-returned store memberships.
 */
export function normalizeAuthorizedStores(rawList: unknown): AuthorizedSellerStore[] {
  if (!Array.isArray(rawList)) return [];

  const seenStoreIds = new Set<string>();
  const normalized: AuthorizedSellerStore[] = [];

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const membershipId = typeof raw.membershipId === 'string' ? raw.membershipId.trim() : '';
    const role = raw.role === 'OWNER' || raw.role === 'STAFF' ? raw.role : null;
    const membershipStatus =
      typeof raw.membershipStatus === 'string' ? raw.membershipStatus.toUpperCase() : 'ACTIVE';

    if (!id || !membershipId || !role || membershipStatus !== 'ACTIVE' || seenStoreIds.has(id)) {
      continue;
    }

    const rawPermissions = Array.isArray(raw.permissions) ? raw.permissions : [];
    const permissions: SellerPermission[] = [];
    for (const perm of rawPermissions) {
      if (typeof perm === 'string' && VALID_SELLER_PERMISSIONS.has(perm)) {
        permissions.push(perm as SellerPermission);
      }
    }

    seenStoreIds.add(id);
    normalized.push({
      id,
      businessName: typeof raw.businessName === 'string' ? raw.businessName : '',
      category: typeof raw.category === 'string' ? raw.category : 'Merchant Store',
      upiVpa: typeof raw.upiVpa === 'string' ? raw.upiVpa : '',
      address: typeof raw.address === 'string' ? raw.address : '',
      pincode: typeof raw.pincode === 'string' ? raw.pincode : '',
      isOpen: typeof raw.isOpen === 'boolean' ? raw.isOpen : true,
      membershipId,
      role,
      membershipStatus,
      permissions
    });
  }

  return normalized;
}

/**
 * Selects a store exclusively from the server-authorized `stores` list.
 * Any forged/stale `preferredStoreId` not present in `stores` is discarded and falls
 * back to `stores[0]`.
 */
export function resolveAuthorizedStoreSelection(
  stores: AuthorizedSellerStore[],
  preferredStoreId?: string | null
): AuthorizedSellerStore | null {
  if (!Array.isArray(stores) || stores.length === 0) {
    return null;
  }
  if (typeof preferredStoreId === 'string' && preferredStoreId.trim().length > 0) {
    const matched = stores.find((store) => store.id === preferredStoreId.trim());
    if (matched) return matched;
  }
  return stores[0];
}

export function switchSelectedSellerStore(
  stores: AuthorizedSellerStore[],
  nextStoreId: string,
  storageOverride?: SessionStorageLike | null
): AuthorizedSellerStore | null {
  const matched = stores.find((store) => store.id === nextStoreId);
  if (!matched) {
    return null;
  }
  savePreferredStoreId(matched.id, storageOverride);
  return matched;
}

export function hasSellerPermission(
  store: AuthorizedSellerStore | null | undefined,
  permission: SellerPermission
): boolean {
  if (!store || store.membershipStatus !== 'ACTIVE') return false;
  return Array.isArray(store.permissions) && store.permissions.includes(permission);
}

export function canManageStoreKyc(store: AuthorizedSellerStore | null | undefined): boolean {
  if (!store) return false;
  return store.role === 'OWNER' && hasSellerPermission(store, 'KYC_MANAGE');
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; ok: boolean; data: any }> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId =
    controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetchImpl(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {})
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Hydrates Seller session strictly from `GET /api/v1/auth/me` and
 * `GET /api/v1/seller/stores`.
 * - Rejects legacy pre-S1.4-A merchant tokens and cached `streetverse_seller_merchant` JSON.
 * - Clears persisted token on `401` / `403` / `404` or wrong role.
 * - Preserves persisted valid token on `503` / transient network failure.
 * - Never fabricates a fallback `'m1'` store when authorized stores are empty.
 */
export async function hydrateSellerSession(
  options: HydrateSellerSessionOptions = {}
): Promise<SellerSessionHydrationResult> {
  const storage = getStorage(options.storage);
  clearLegacySellerMerchantCache(storage);

  const candidateToken =
    options.token !== undefined
      ? typeof options.token === 'string'
        ? options.token.trim()
        : null
      : readSellerAccessToken(storage);

  if (!isPlausibleJwtFormat(candidateToken)) {
    clearSellerSession(storage);
    return {
      status: 'unauthenticated',
      sellerAccount: null,
      stores: [],
      activeStore: null,
      token: null,
      errorMessage: null,
      errorCode: null
    };
  }

  const fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    return {
      status: 'service_unavailable',
      sellerAccount: null,
      stores: [],
      activeStore: null,
      token: candidateToken,
      errorMessage: 'Network client is unavailable in this environment.',
      errorCode: 'FETCH_UNAVAILABLE'
    };
  }

  const apiUrl = resolveSellerApiUrl(options.apiUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS;
  const authHeaders = buildSellerAuthHeaders(candidateToken);

  try {
    const meRes = await fetchJsonWithTimeout(
      fetchImpl,
      `${apiUrl}/api/v1/auth/me`,
      { method: 'GET', headers: authHeaders, credentials: 'include' },
      timeoutMs
    );

    if (meRes.status === 401) {
      clearSellerSession(storage);
      return {
        status: 'unauthenticated',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: null,
        errorMessage: extractApiError(meRes.data, 'Your seller session has expired. Please sign in again.'),
        errorCode: typeof meRes.data?.code === 'string' ? meRes.data.code : 'UNAUTHORIZED'
      };
    }

    if (meRes.status === 403 || meRes.status === 404) {
      clearSellerSession(storage);
      return {
        status: 'forbidden',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: null,
        errorMessage: extractApiError(meRes.data, 'Access denied for this seller account.'),
        errorCode: typeof meRes.data?.code === 'string' ? meRes.data.code : 'FORBIDDEN'
      };
    }

    if (meRes.status >= 500 || meRes.status === 429) {
      return {
        status: 'service_unavailable',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: candidateToken,
        errorMessage: extractApiError(
          meRes.data,
          'Authentication service is temporarily unavailable. Please retry.'
        ),
        errorCode: typeof meRes.data?.code === 'string' ? meRes.data.code : 'SERVICE_UNAVAILABLE'
      };
    }

    if (!meRes.ok) {
      clearSellerSession(storage);
      return {
        status: 'unauthenticated',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: null,
        errorMessage: extractApiError(meRes.data, 'Unable to validate seller session.'),
        errorCode: typeof meRes.data?.code === 'string' ? meRes.data.code : 'SESSION_INVALID'
      };
    }

    if (
      (meRes.data?.role && meRes.data.role !== 'SELLER') ||
      meRes.data?.principalType !== 'SELLER_ACCOUNT'
    ) {
      clearSellerSession(storage);
      return {
        status: 'forbidden',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: null,
        errorMessage: 'Signed-in credentials are not a valid Seller Account session.',
        errorCode: 'ROLE_FORBIDDEN'
      };
    }

    const sellerAccount =
      meRes.data?.authenticated === true ? normalizeSellerAccount(meRes.data?.sellerAccount) : null;
    if (!sellerAccount) {
      return {
        status: 'service_unavailable',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: candidateToken,
        errorMessage: 'Received an incomplete seller account response.',
        errorCode: 'INVALID_ME_PAYLOAD'
      };
    }

    const storesRes = await fetchJsonWithTimeout(
      fetchImpl,
      `${apiUrl}/api/v1/seller/stores`,
      { method: 'GET', headers: authHeaders, credentials: 'include' },
      timeoutMs
    );

    if (storesRes.status === 401) {
      clearSellerSession(storage);
      return {
        status: 'unauthenticated',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: null,
        errorMessage: extractApiError(storesRes.data, 'Seller session expired. Please sign in again.'),
        errorCode: typeof storesRes.data?.code === 'string' ? storesRes.data.code : 'UNAUTHORIZED'
      };
    }

    if (storesRes.status === 403 || storesRes.status === 404) {
      clearSellerSession(storage);
      return {
        status: 'forbidden',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: null,
        errorMessage: extractApiError(storesRes.data, 'Seller store access denied.'),
        errorCode: typeof storesRes.data?.code === 'string' ? storesRes.data.code : 'FORBIDDEN'
      };
    }

    if (storesRes.status >= 500 || storesRes.status === 429 || !storesRes.ok) {
      return {
        status: 'service_unavailable',
        sellerAccount: null,
        stores: [],
        activeStore: null,
        token: candidateToken,
        errorMessage: extractApiError(
          storesRes.data,
          'Store membership service is temporarily unavailable. Please retry.'
        ),
        errorCode: typeof storesRes.data?.code === 'string' ? storesRes.data.code : 'SERVICE_UNAVAILABLE'
      };
    }

    const stores = normalizeAuthorizedStores(storesRes.data?.stores);
    saveSellerAccessToken(candidateToken, storage);

    if (stores.length === 0) {
      savePreferredStoreId(null, storage);
      return {
        status: 'no_stores',
        sellerAccount,
        stores: [],
        activeStore: null,
        token: candidateToken,
        errorMessage: 'No active store memberships are assigned to this seller account.',
        errorCode: 'NO_AUTHORIZED_STORES'
      };
    }

    const preferredId =
      options.preferredStoreId !== undefined
        ? options.preferredStoreId
        : readPreferredStoreId(storage);
    const activeStore = resolveAuthorizedStoreSelection(stores, preferredId);
    savePreferredStoreId(activeStore ? activeStore.id : null, storage);

    return {
      status: 'authenticated',
      sellerAccount,
      stores,
      activeStore,
      token: candidateToken,
      errorMessage: null,
      errorCode: null
    };
  } catch {
    return {
      status: 'service_unavailable',
      sellerAccount: null,
      stores: [],
      activeStore: null,
      token: candidateToken,
      errorMessage:
        'Unable to reach the Seller authentication service. Your session token is preserved—please retry.',
      errorCode: 'NETWORK_ERROR'
    };
  }
}

/**
 * Submits Seller KYC document payload with Bearer Seller JWT and selected authorized `merchantId`.
 * Preserves honest `503 KYC_SUBMISSION_UNAVAILABLE` handling from `resolveKycUploadOutcome`.
 */
export async function submitProtectedSellerKyc(
  params: ProtectedKycSubmissionParams
): Promise<ProtectedKycSubmissionResult> {
  if (!isPlausibleJwtFormat(params.token)) {
    return {
      outcome: {
        ok: false,
        submission: null,
        successMessage: null,
        errorMessage: 'Your seller session has expired. Please sign in again.'
      },
      httpStatus: 401,
      authExpired: true,
      forbidden: false,
      errorCode: 'SESSION_MISSING'
    };
  }

  if (!params.activeStore?.id) {
    return {
      outcome: {
        ok: false,
        submission: null,
        successMessage: null,
        errorMessage: 'Select an authorized store before submitting KYC documents.'
      },
      httpStatus: 400,
      authExpired: false,
      forbidden: false,
      errorCode: 'STORE_REQUIRED'
    };
  }

  if (!canManageStoreKyc(params.activeStore)) {
    return {
      outcome: {
        ok: false,
        submission: null,
        successMessage: null,
        errorMessage:
          'Only a store OWNER with KYC_MANAGE permission can submit regulatory KYC documents.'
      },
      httpStatus: 403,
      authExpired: false,
      forbidden: true,
      errorCode: 'KYC_MANAGE_REQUIRED'
    };
  }

  const fetchImpl = params.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    return {
      outcome: {
        ok: false,
        submission: null,
        successMessage: null,
        errorMessage: 'Unable to reach KYC submission service. Please try again later.'
      },
      httpStatus: 0,
      authExpired: false,
      forbidden: false,
      errorCode: 'FETCH_UNAVAILABLE'
    };
  }

  const apiUrl = resolveSellerApiUrl(params.apiUrl);
  const timeoutMs = params.timeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS;

  try {
    const res = await fetchJsonWithTimeout(
      fetchImpl,
      `${apiUrl}/api/v1/auth/seller/kyc/upload`,
      {
        method: 'POST',
        headers: buildSellerAuthHeaders(params.token, {
          'Content-Type': 'application/json'
        }),
        credentials: 'include',
        body: JSON.stringify({
          merchantId: params.activeStore.id,
          documentType: params.documentType,
          documentNumber: params.documentNumber.trim()
        })
      },
      timeoutMs
    );

    if (res.status === 401) {
      return {
        outcome: resolveKycUploadOutcome(false, res.status, res.data),
        httpStatus: res.status,
        authExpired: true,
        forbidden: false,
        errorCode: typeof res.data?.code === 'string' ? res.data.code : 'UNAUTHORIZED'
      };
    }

    if (res.status === 403) {
      return {
        outcome: resolveKycUploadOutcome(false, res.status, res.data),
        httpStatus: res.status,
        authExpired: false,
        forbidden: true,
        errorCode: typeof res.data?.code === 'string' ? res.data.code : 'FORBIDDEN'
      };
    }

    return {
      outcome: resolveKycUploadOutcome(res.ok, res.status, res.data),
      httpStatus: res.status,
      authExpired: false,
      forbidden: false,
      errorCode: typeof res.data?.code === 'string' ? res.data.code : null
    };
  } catch {
    return {
      outcome: {
        ok: false,
        submission: null,
        successMessage: null,
        errorMessage: 'Unable to reach KYC submission service. Please try again later.'
      },
      httpStatus: 0,
      authExpired: false,
      forbidden: false,
      errorCode: 'NETWORK_ERROR'
    };
  }
}
