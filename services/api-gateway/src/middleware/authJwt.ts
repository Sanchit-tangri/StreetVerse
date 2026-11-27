import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { GatewayConfig } from '../config/env';
import { StrictPgPool } from '../db/postgres';
import {
  SellerPermission,
  StoreAccessContext,
  StoreMembershipRole,
  verifySellerStorePermission
} from '../services/sellerRbac';
import { classifyHttpError, sanitizeErrorForLog } from '../utils/infraErrors';

export const SELLER_ACCOUNT_PRINCIPAL_TYPE = 'SELLER_ACCOUNT' as const;
export type SellerPrincipalType = typeof SELLER_ACCOUNT_PRINCIPAL_TYPE;

export const ADMIN_ACCOUNT_PRINCIPAL_TYPE = 'ADMIN_ACCOUNT' as const;
export type AdminPrincipalType = typeof ADMIN_ACCOUNT_PRINCIPAL_TYPE;

export type AdminRole = 'ADMIN';

export type AdminPermission =
  | 'KYC_QUEUE_READ'
  | 'KYC_SUBMISSION_READ'
  | 'KYC_REVIEW_DECIDE'
  | 'STORE_COMPLIANCE_MANAGE';

export const ADMIN_ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  ADMIN: [
    'KYC_QUEUE_READ',
    'KYC_SUBMISSION_READ',
    'KYC_REVIEW_DECIDE',
    'STORE_COMPLIANCE_MANAGE',
  ],
};

export function getPermissionsForAdminRole(role: string): readonly AdminPermission[] {
  if (role === 'ADMIN') {
    return ADMIN_ROLE_PERMISSIONS.ADMIN;
  }
  return [];
}

export type JwtAuthConfig = Pick<
  GatewayConfig,
  'jwtSecret' | 'jwtIssuer' | 'jwtBuyerAudience' | 'jwtSellerAudience' | 'jwtExpiresIn'
> &
  Partial<Pick<GatewayConfig, 'jwtAdminAudience' | 'jwtAdminExpiresIn'>>;

export const DEFAULT_JWT_ADMIN_AUDIENCE = 'streetverse-admin';
export const DEFAULT_JWT_ADMIN_EXPIRES_IN = '8h';

export function resolveJwtAdminAudience(jwtConfig: Pick<JwtAuthConfig, 'jwtAdminAudience'>): string {
  const configured = jwtConfig.jwtAdminAudience?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_JWT_ADMIN_AUDIENCE;
}

export function resolveJwtAdminExpiresIn(jwtConfig: Pick<JwtAuthConfig, 'jwtAdminExpiresIn'>): string {
  const configured = jwtConfig.jwtAdminExpiresIn?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_JWT_ADMIN_EXPIRES_IN;
}

export interface AdminAccountContext {
  adminAccountId: string;
  email: string;
  fullName: string;
  role: AdminRole;
  permissions: readonly AdminPermission[];
  principalType: AdminPrincipalType;
  status: string;
}

export interface AuthenticatedPrincipal {
  sub: string;
  role: 'BUYER' | 'SELLER';
  audience: string;
  principalType?: SellerPrincipalType;
  email?: string;
  phone?: string;
  fullName?: string;
  claims: jwt.JwtPayload;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthenticatedPrincipal;
  storeAccess?: StoreAccessContext;
  adminAuth?: AdminAccountContext;
}

export function isRoleAudienceConsistent(
  role: unknown,
  aud: unknown,
  config: JwtAuthConfig
): boolean {
  if (typeof aud !== 'string') return false;
  if (role === 'BUYER') return aud === config.jwtBuyerAudience;
  if (role === 'SELLER') return aud === config.jwtSellerAudience;
  return false;
}

const ADMIN_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifiedAdminPrincipal {
  adminAccountId: string;
  role: AdminRole;
  principalType: AdminPrincipalType;
  email?: string;
}

/**
 * Verifies an Admin JWT using strictly the dedicated Admin audience (`jwtAdminAudience`),
 * configured issuer, explicit `ADMIN_ACCOUNT` principal type, and `ADMIN` role.
 * Buyer and Seller JWTs fail audience verification cleanly.
 */
export function verifyAdminToken(
  token: string,
  jwtConfig: JwtAuthConfig
): { ok: true; principal: VerifiedAdminPrincipal } | { ok: false; status: 401 | 403; error: string } {
  const adminAudience = resolveJwtAdminAudience(jwtConfig);
  if (
    adminAudience === jwtConfig.jwtBuyerAudience ||
    adminAudience === jwtConfig.jwtSellerAudience
  ) {
    return {
      ok: false,
      status: 401,
      error: 'Admin JWT audience configuration must remain isolated from Buyer and Seller audiences.'
    };
  }

  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, jwtConfig.jwtSecret, {
      issuer: jwtConfig.jwtIssuer,
      audience: adminAudience
    }) as jwt.JwtPayload;
  } catch {
    return { ok: false, status: 401, error: 'Invalid or expired admin access token.' };
  }

  if (!decoded || typeof decoded !== 'object') {
    return { ok: false, status: 401, error: 'Malformed admin access token.' };
  }

  if (decoded.principalType !== ADMIN_ACCOUNT_PRINCIPAL_TYPE) {
    return { ok: false, status: 403, error: 'Admin account principal required.' };
  }

  if (typeof decoded.sub !== 'string' || !ADMIN_UUID_REGEX.test(decoded.sub.trim())) {
    return { ok: false, status: 401, error: 'Invalid admin token subject.' };
  }

  if (decoded.role !== 'ADMIN') {
    return { ok: false, status: 403, error: 'Admin role required.' };
  }

  return {
    ok: true,
    principal: {
      adminAccountId: decoded.sub.trim(),
      role: 'ADMIN',
      principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE,
      ...(typeof decoded.email === 'string' && decoded.email.trim().length > 0
        ? { email: decoded.email.trim().toLowerCase() }
        : {})
    }
  };
}

/**
 * Middleware protecting `/api/v1/admin/*` endpoints.
 * Verifies the Admin JWT (distinct audience + ADMIN_ACCOUNT principal + ADMIN role)
 * AND verifies live `ACTIVE` status against `admin_accounts` in Merchant DB.
 * Fails closed with 503 if Merchant PostgreSQL is unreachable.
 */
export function requireAdminJwt(
  merchantPool: Pick<StrictPgPool, 'query'>,
  jwtConfig: JwtAuthConfig
) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void | Response> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Admin authorization token required.',
        code: 'ADMIN_AUTH_REQUIRED'
      });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      return res.status(401).json({
        error: 'Admin authorization token required.',
        code: 'ADMIN_AUTH_REQUIRED'
      });
    }

    const verified = verifyAdminToken(token, jwtConfig);
    if (!verified.ok) {
      return res.status(verified.status).json({
        error: verified.error,
        code: verified.status === 403 ? 'ADMIN_FORBIDDEN' : 'ADMIN_AUTH_INVALID'
      });
    }

    try {
      const accountRes = await merchantPool.query(
        `SELECT id, email, full_name, role, status
         FROM admin_accounts
         WHERE id = $1
         LIMIT 1`,
        [verified.principal.adminAccountId]
      );

      if (accountRes.rows.length === 0) {
        return res.status(401).json({
          error: 'Admin account not found or revoked.',
          code: 'ADMIN_AUTH_INVALID'
        });
      }

      const row = accountRes.rows[0] as {
        id: string;
        email: string;
        full_name: string;
        role: string;
        status: string;
      };

      if (row.status !== 'ACTIVE') {
        return res.status(403).json({
          error: 'Admin account is suspended or disabled.',
          code: 'ADMIN_ACCOUNT_INACTIVE'
        });
      }

      if (row.role !== 'ADMIN') {
        return res.status(403).json({
          error: 'Insufficient administrative privileges.',
          code: 'ADMIN_FORBIDDEN'
        });
      }

      req.adminAuth = {
        adminAccountId: String(row.id),
        email: String(row.email),
        fullName: String(row.full_name),
        role: 'ADMIN',
        permissions: getPermissionsForAdminRole(String(row.role)),
        principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE,
        status: String(row.status)
      };

      next();
    } catch (err: unknown) {
      const mapped = classifyHttpError(err);
      if (mapped.status === 503) {
        return res.status(503).json({ error: mapped.message, code: mapped.code });
      }
      console.error(`[Admin Auth DB Error]: ${sanitizeErrorForLog(err)}`);
      return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
    }
  };
}

export function verifyAccessToken(
  token: string,
  jwtConfig: JwtAuthConfig
): { ok: true; principal: AuthenticatedPrincipal } | { ok: false; status: 401; error: string } {
  try {
    const decoded = jwt.verify(token, jwtConfig.jwtSecret, {
      issuer: jwtConfig.jwtIssuer,
      audience: [jwtConfig.jwtBuyerAudience, jwtConfig.jwtSellerAudience]
    }) as jwt.JwtPayload;

    if (!isRoleAudienceConsistent(decoded.role, decoded.aud, jwtConfig)) {
      return { ok: false, status: 401, error: 'Authentication token role and audience mismatch.' };
    }

    if (typeof decoded.sub !== 'string' || !decoded.sub.trim()) {
      return { ok: false, status: 401, error: 'Authentication token subject is missing.' };
    }

    const role = decoded.role as 'BUYER' | 'SELLER';
    if (role === 'SELLER' && decoded.principalType !== SELLER_ACCOUNT_PRINCIPAL_TYPE) {
      return {
        ok: false,
        status: 401,
        error: 'Legacy or invalid seller session token. Please sign in again.'
      };
    }

    return {
      ok: true,
      principal: {
        sub: decoded.sub.trim(),
        role,
        audience: decoded.aud as string,
        ...(role === 'SELLER' ? { principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE } : {}),
        email: typeof decoded.email === 'string' ? decoded.email : undefined,
        phone: typeof decoded.phone === 'string' ? decoded.phone : undefined,
        fullName: typeof decoded.fullName === 'string' ? decoded.fullName : undefined,
        claims: decoded
      }
    };
  } catch {
    return { ok: false, status: 401, error: 'Authentication token is invalid or expired.' };
  }
}

/**
 * Minimal reusable Buyer JWT middleware compatible with S1.4 full RBAC expansion.
 * Derives principal identity strictly from the verified JWT without touching request body IDs.
 */
export function requireBuyerJwt(jwtConfig: JwtAuthConfig) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authentication token provided.' });
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided.' });
    }

    const verification = verifyAccessToken(token, jwtConfig);
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error });
    }

    if (verification.principal.role !== 'BUYER' || verification.principal.audience !== jwtConfig.jwtBuyerAudience) {
      return res.status(403).json({ error: 'Forbidden: Buyer portal access required.' });
    }

    req.auth = verification.principal;
    return next();
  };
}

/**
 * Requires a valid Seller Account Bearer JWT (`role=SELLER`, strict Seller audience,
 * and explicit `principalType=SELLER_ACCOUNT`). Rejects legacy Merchant-ID Seller tokens
 * and rejects Buyer tokens with HTTP 403.
 */
export function requireSellerJwt(jwtConfig: JwtAuthConfig) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authentication token provided.' });
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided.' });
    }

    const verification = verifyAccessToken(token, jwtConfig);
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error });
    }

    if (verification.principal.role !== 'SELLER' || verification.principal.audience !== jwtConfig.jwtSellerAudience) {
      return res.status(403).json({ error: 'Forbidden: Seller portal access required.' });
    }

    if (verification.principal.principalType !== SELLER_ACCOUNT_PRINCIPAL_TYPE) {
      return res.status(401).json({ error: 'Legacy or invalid seller session token. Please sign in again.' });
    }

    req.auth = verification.principal;
    return next();
  };
}

export interface StoreMembershipMiddlewareOptions {
  requiredPermission?: SellerPermission;
  allowedRoles?: readonly StoreMembershipRole[];
  getStoreId?: (req: AuthenticatedRequest) => unknown;
}

/**
 * Enforces `Seller Account -> Store Membership -> Requested Store` against Merchant PostgreSQL.
 * Must follow `requireSellerJwt`. Never trusts client-provided role claims.
 */
export function requireStoreMembership(
  merchantPool: StrictPgPool,
  options: StoreMembershipMiddlewareOptions = {}
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.auth || req.auth.role !== 'SELLER' || req.auth.principalType !== SELLER_ACCOUNT_PRINCIPAL_TYPE) {
        return res.status(401).json({ error: 'Seller authentication required.', code: 'SELLER_AUTH_REQUIRED' });
      }

      const rawStoreId = options.getStoreId
        ? options.getStoreId(req)
        : req.params?.storeId ?? req.params?.merchantId ?? req.body?.storeId ?? req.body?.merchantId;

      if (typeof rawStoreId !== 'string' || !rawStoreId.trim()) {
        return res.status(400).json({ error: 'Missing storeId / merchantId.', code: 'MISSING_STORE_ID' });
      }

      const accessCheck = await verifySellerStorePermission({
        merchantPool,
        sellerAccountId: req.auth.sub,
        storeId: rawStoreId,
        requiredPermission: options.requiredPermission,
        allowedRoles: options.allowedRoles
      });

      if (!accessCheck.ok) {
        return res.status(accessCheck.status).json({ error: accessCheck.error, code: accessCheck.code });
      }

      req.storeAccess = accessCheck.access;
      return next();
    } catch (err: unknown) {
      const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
      if (mapped.status === 503 || mapped.status === 400) {
        return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      }
      console.error(`[Store RBAC Middleware Error]: ${sanitizeErrorForLog(err)}`);
      return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
    }
  };
}
