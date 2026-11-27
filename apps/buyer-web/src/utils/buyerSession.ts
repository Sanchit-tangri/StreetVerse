/**
 * Centralized Buyer session management for `apps/buyer-web`.
 *
 * Auth transport & persistence note:
 * The StreetVerse API Gateway issues cross-origin stateless Bearer JWT access tokens
 * (`Authorization: Bearer <token>`) without HttpOnly cookie sessions or refresh tokens.
 * To work across separate web/gateway origins cleanly, only the signed Bearer access
 * token is stored in `localStorage`. Untrusted local profile blobs (`streetverse_buyer_user`)
 * are cleared and never relied on for authentication; identity and session validity are
 * hydrated strictly from `GET /api/v1/auth/me`. Because `localStorage` is readable by
 * same-origin JavaScript, XSS mitigation relies on React escaping, avoiding unsafe DOM
 * HTML sinks, and rejecting non-JWT / unsigned strings before transport.
 */

export const BUYER_TOKEN_STORAGE_KEY = 'streetverse_buyer_token';
export const LEGACY_BUYER_USER_STORAGE_KEY = 'streetverse_buyer_user';
const DEFAULT_API_URL = 'https://clatter-mousiness-smugness.ngrok-free.dev';
const DEFAULT_HYDRATION_TIMEOUT_MS = 8000;

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthenticatedBuyerUser {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  address?: string | null;
  preferredLanguage?: string | null;
  isEmailVerified?: boolean;
  createdAt?: string;
}

export type BuyerHydrationStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'forbidden'
  | 'service_unavailable';

export interface BuyerSessionHydrationResult {
  status: BuyerHydrationStatus;
  user: AuthenticatedBuyerUser | null;
  token: string | null;
  errorMessage: string | null;
  errorCode: string | null;
}

export interface HydrateBuyerSessionOptions {
  apiUrl?: string;
  token?: string | null;
  storage?: SessionStorageLike | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const JWT_FORMAT_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Checks only structural compact-JWS shape (`header.payload.signature`).
 * Real cryptographic signature, expiration, audience, and account status
 * verification always happens on the backend (`/api/v1/auth/me`).
 */
export function isPlausibleJwtFormat(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  return trimmed.length > 0 && JWT_FORMAT_REGEX.test(trimmed);
}

export function resolveBuyerApiUrl(override?: string): string {
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

function safeRemove(storage: SessionStorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore browser storage quota/privacy mode errors cleanly
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
    // Ignore storage write errors when storage is restricted
  }
}

export function clearLegacyBuyerUserCache(storageOverride?: SessionStorageLike | null): void {
  const storage = getStorage(storageOverride);
  safeRemove(storage, LEGACY_BUYER_USER_STORAGE_KEY);
}

export function readBuyerAccessToken(storageOverride?: SessionStorageLike | null): string | null {
  const storage = getStorage(storageOverride);
  clearLegacyBuyerUserCache(storage);

  const raw = safeGet(storage, BUYER_TOKEN_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!isPlausibleJwtFormat(trimmed)) {
    safeRemove(storage, BUYER_TOKEN_STORAGE_KEY);
    return null;
  }
  return trimmed;
}

export function saveBuyerAccessToken(
  token: string,
  storageOverride?: SessionStorageLike | null
): boolean {
  const storage = getStorage(storageOverride);
  clearLegacyBuyerUserCache(storage);

  if (!isPlausibleJwtFormat(token)) {
    safeRemove(storage, BUYER_TOKEN_STORAGE_KEY);
    return false;
  }
  safeSet(storage, BUYER_TOKEN_STORAGE_KEY, token.trim());
  return true;
}

export function clearBuyerSession(storageOverride?: SessionStorageLike | null): void {
  const storage = getStorage(storageOverride);
  safeRemove(storage, BUYER_TOKEN_STORAGE_KEY);
  safeRemove(storage, LEGACY_BUYER_USER_STORAGE_KEY);
}

export function buildBuyerAuthHeaders(
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

function normalizeBuyerProfile(raw: any): AuthenticatedBuyerUser | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null;

  return {
    id: raw.id.trim(),
    fullName: typeof raw.fullName === 'string' ? raw.fullName : '',
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    email: typeof raw.email === 'string' ? raw.email : '',
    address: typeof raw.address === 'string' ? raw.address : null,
    preferredLanguage: typeof raw.preferredLanguage === 'string' ? raw.preferredLanguage : null,
    isEmailVerified: typeof raw.isEmailVerified === 'boolean' ? raw.isEmailVerified : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined
  };
}

/**
 * Hydrates the Buyer session strictly from `GET /api/v1/auth/me`.
 * - Never trusts cached `streetverse_buyer_user` JSON or unsigned demo tokens.
 * - Clears persisted token on `401` / `403` / `404` or wrong role.
 * - Preserves persisted valid token cleanly on `503` or transient network outages
 *   without granting unauthenticated dashboard access.
 */
export async function hydrateBuyerSession(
  options: HydrateBuyerSessionOptions = {}
): Promise<BuyerSessionHydrationResult> {
  const storage = getStorage(options.storage);
  clearLegacyBuyerUserCache(storage);

  const candidateToken =
    options.token !== undefined
      ? typeof options.token === 'string'
        ? options.token.trim()
        : null
      : readBuyerAccessToken(storage);

  if (!isPlausibleJwtFormat(candidateToken)) {
    clearBuyerSession(storage);
    return {
      status: 'unauthenticated',
      user: null,
      token: null,
      errorMessage: null,
      errorCode: null
    };
  }

  const fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    return {
      status: 'service_unavailable',
      user: null,
      token: candidateToken,
      errorMessage: 'Network client is unavailable in this environment.',
      errorCode: 'FETCH_UNAVAILABLE'
    };
  }

  const apiUrl = resolveBuyerApiUrl(options.apiUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId =
    controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetchImpl(`${apiUrl}/api/v1/auth/me`, {
      method: 'GET',
      headers: buildBuyerAuthHeaders(candidateToken),
      credentials: 'include',
      ...(controller ? { signal: controller.signal } : {})
    });

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status === 401) {
      clearBuyerSession(storage);
      return {
        status: 'unauthenticated',
        user: null,
        token: null,
        errorMessage: extractApiError(data, 'Your session has expired. Please sign in again.'),
        errorCode: typeof data?.code === 'string' ? data.code : 'UNAUTHORIZED'
      };
    }

    if (res.status === 403 || res.status === 404) {
      clearBuyerSession(storage);
      return {
        status: 'forbidden',
        user: null,
        token: null,
        errorMessage: extractApiError(data, 'Access denied for this buyer account.'),
        errorCode: typeof data?.code === 'string' ? data.code : 'FORBIDDEN'
      };
    }

    if (res.status >= 500 || res.status === 429) {
      return {
        status: 'service_unavailable',
        user: null,
        token: candidateToken,
        errorMessage: extractApiError(
          data,
          'Authentication service is temporarily unavailable. Please retry.'
        ),
        errorCode: typeof data?.code === 'string' ? data.code : 'SERVICE_UNAVAILABLE'
      };
    }

    if (!res.ok) {
      clearBuyerSession(storage);
      return {
        status: 'unauthenticated',
        user: null,
        token: null,
        errorMessage: extractApiError(data, 'Unable to verify session. Please sign in again.'),
        errorCode: typeof data?.code === 'string' ? data.code : 'SESSION_INVALID'
      };
    }

    if (data?.role && data.role !== 'BUYER') {
      clearBuyerSession(storage);
      return {
        status: 'forbidden',
        user: null,
        token: null,
        errorMessage: 'Signed-in credentials do not belong to a Buyer account.',
        errorCode: 'ROLE_FORBIDDEN'
      };
    }

    const normalizedUser = data?.authenticated === true ? normalizeBuyerProfile(data?.user) : null;
    if (!normalizedUser) {
      return {
        status: 'service_unavailable',
        user: null,
        token: candidateToken,
        errorMessage: 'Received an incomplete profile response from authentication service.',
        errorCode: 'INVALID_ME_PAYLOAD'
      };
    }

    saveBuyerAccessToken(candidateToken, storage);

    return {
      status: 'authenticated',
      user: normalizedUser,
      token: candidateToken,
      errorMessage: null,
      errorCode: null
    };
  } catch {
    return {
      status: 'service_unavailable',
      user: null,
      token: candidateToken,
      errorMessage:
        'Unable to reach the authentication service. Your session token is preserved—please retry.',
      errorCode: 'NETWORK_ERROR'
    };
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}
