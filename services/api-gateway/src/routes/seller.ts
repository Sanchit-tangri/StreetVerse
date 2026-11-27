import { Router, Response } from 'express';
import { StrictPgPool } from '../db/postgres';
import { AuthenticatedRequest, JwtAuthConfig, requireSellerJwt } from '../middleware/authJwt';
import { listSellerAccountWithMemberships } from '../services/sellerRbac';
import { createSellerAccountNotificationsRouter } from './notifications';
import { classifyHttpError, sanitizeErrorForLog } from '../utils/infraErrors';

/**
 * Shared handler returning active authorized stores and database-backed OWNER/STAFF
 * roles for the authenticated Seller Account (`GET /api/v1/seller/stores` and
 * `GET /api/v1/auth/seller/stores`).
 */
export async function handleListSellerStores(
  req: AuthenticatedRequest,
  res: Response,
  merchantPool: Pick<StrictPgPool, 'query'>
): Promise<Response> {
  try {
    const sellerAccountId = req.auth?.sub;
    if (!sellerAccountId) {
      return res.status(401).json({ error: 'Seller authentication required.', code: 'SELLER_AUTH_REQUIRED' });
    }

    const profile = await listSellerAccountWithMemberships(merchantPool, sellerAccountId);
    if (!profile.ok) {
      return res.status(profile.status).json({ error: profile.error, code: profile.code });
    }

    return res.status(200).json({
      success: true,
      sellerAccountId: profile.sellerAccount.id,
      stores: profile.memberships.map((m) => ({
        ...m.store,
        membershipId: m.membershipId,
        role: m.role,
        membershipStatus: m.status,
        permissions: m.permissions
      }))
    });
  } catch (err: unknown) {
    const mapped = classifyHttpError(err);
    if (mapped.status === 503) {
      return res.status(503).json({ error: mapped.message, code: mapped.code });
    }
    console.error(`[Seller Stores Error]: ${sanitizeErrorForLog(err)}`);
    return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
  }
}

export function createSellerRouter(
  merchantPool: StrictPgPool,
  jwtConfig: JwtAuthConfig
): Router {
  const router = Router();

  router.use(requireSellerJwt(jwtConfig));

  router.get('/stores', async (req: AuthenticatedRequest, res: Response) => {
    return handleListSellerStores(req, res, merchantPool);
  });

  router.use('/notifications', createSellerAccountNotificationsRouter(merchantPool, jwtConfig));

  return router;
}
