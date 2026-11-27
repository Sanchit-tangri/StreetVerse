import { Response, Router } from 'express';
import { StrictPgPool } from '../db/postgres';
import {
  AuthenticatedRequest,
  JwtAuthConfig,
  requireSellerJwt,
  requireStoreMembership
} from '../middleware/authJwt';
import {
  getOwnerUnreadNotificationSummary,
  listOwnerNotifications,
  markAllOwnerStoreNotificationsRead,
  markOwnerNotificationRead
} from '../services/notificationOutbox';

// =========================================================================
// MO-B4: Authenticated Owner-Facing In-App Notification Routes
//
// Security invariants:
//   - Requires valid Seller Account JWT (`requireSellerJwt`).
//   - Store-scoped router enforces active `OWNER` membership via `requireStoreMembership`.
//   - Account-wide router enforces `recipient_seller_account_id = req.auth.sub` joined
//     with live ACTIVE `OWNER` membership on `store_memberships`.
//   - Never trusts recipientId/sellerAccountId/storeId from body or query as proof.
//   - Blocks STAFF members, Buyer/Admin JWTs, revoked Owners, and other Owners.
// =========================================================================

export function createStoreNotificationsRouter(
  merchantPool: StrictPgPool,
  jwtConfig: JwtAuthConfig
): Router {
  const router = Router({ mergeParams: true });

  router.use(requireSellerJwt(jwtConfig));
  router.use(
    requireStoreMembership(merchantPool, {
      allowedRoles: ['OWNER'],
      requiredPermission: 'KYC_MANAGE',
      getStoreId: (req) => req.params?.storeId
    })
  );

  // GET /api/v1/seller/stores/:storeId/notifications
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    const storeId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    if (!storeId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const unreadOnly = String(req.query.unreadOnly ?? '').trim().toLowerCase() === 'true';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;

    const result = await listOwnerNotifications(merchantPool, {
      sellerAccountId,
      storeId,
      unreadOnly,
      limit,
      offset
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      storeId,
      ...result.data
    });
  });

  // GET /api/v1/seller/stores/:storeId/notifications/unread-count
  router.get('/unread-count', async (req: AuthenticatedRequest, res: Response) => {
    const storeId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    if (!storeId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const result = await getOwnerUnreadNotificationSummary(merchantPool, {
      sellerAccountId,
      storeId
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      storeId,
      unreadCount: result.data.unreadCount
    });
  });

  // POST /api/v1/seller/stores/:storeId/notifications/read-all
  router.post('/read-all', async (req: AuthenticatedRequest, res: Response) => {
    const storeId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    if (!storeId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const result = await markAllOwnerStoreNotificationsRead(merchantPool, {
      sellerAccountId,
      storeId
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      ...result.data
    });
  });

  // POST /api/v1/seller/stores/:storeId/notifications/:notificationId/read
  router.post('/:notificationId/read', async (req: AuthenticatedRequest, res: Response) => {
    const storeId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    if (!storeId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const result = await markOwnerNotificationRead(merchantPool, {
      sellerAccountId,
      storeId,
      notificationId: String(req.params?.notificationId ?? '')
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      ...result.data
    });
  });

  return router;
}

export function createSellerAccountNotificationsRouter(
  merchantPool: StrictPgPool,
  jwtConfig: JwtAuthConfig
): Router {
  const router = Router();

  router.use(requireSellerJwt(jwtConfig));

  // GET /api/v1/seller/notifications
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    const sellerAccountId = req.auth?.sub;
    if (!sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId : undefined;
    const unreadOnly = String(req.query.unreadOnly ?? '').trim().toLowerCase() === 'true';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;

    const result = await listOwnerNotifications(merchantPool, {
      sellerAccountId,
      storeId,
      unreadOnly,
      limit,
      offset
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      ...result.data
    });
  });

  // GET /api/v1/seller/notifications/unread-count
  router.get('/unread-count', async (req: AuthenticatedRequest, res: Response) => {
    const sellerAccountId = req.auth?.sub;
    if (!sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const result = await getOwnerUnreadNotificationSummary(merchantPool, {
      sellerAccountId
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      ...result.data
    });
  });

  // POST /api/v1/seller/notifications/:notificationId/read
  router.post('/:notificationId/read', async (req: AuthenticatedRequest, res: Response) => {
    const sellerAccountId = req.auth?.sub;
    if (!sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const result = await markOwnerNotificationRead(merchantPool, {
      sellerAccountId,
      notificationId: String(req.params?.notificationId ?? '')
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      ...result.data
    });
  });

  return router;
}
