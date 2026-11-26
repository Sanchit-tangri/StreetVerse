import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { GatewayConfig } from '../config/env';

export type JwtAuthConfig = Pick<
  GatewayConfig,
  'jwtSecret' | 'jwtIssuer' | 'jwtBuyerAudience' | 'jwtSellerAudience' | 'jwtExpiresIn'
>;

export interface AuthenticatedPrincipal {
  sub: string;
  role: 'BUYER' | 'SELLER';
  audience: string;
  email?: string;
  phone?: string;
  fullName?: string;
  claims: jwt.JwtPayload;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthenticatedPrincipal;
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
    return {
      ok: true,
      principal: {
        sub: decoded.sub.trim(),
        role,
        audience: decoded.aud as string,
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
