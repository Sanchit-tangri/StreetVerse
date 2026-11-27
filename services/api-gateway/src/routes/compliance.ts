import { Response, Router } from 'express';
import { StrictPgPool } from '../db/postgres';
import { GatewayConfig } from '../config/env';
import {
  AuthenticatedRequest,
  requireSellerJwt,
  requireStoreMembership
} from '../middleware/authJwt';
import {
  getOwnerStoreCompliance,
  submitOwnerSuspensionResponse,
  submitOwnerWarningResponse
} from '../services/adminCompliance';

// =========================================================================
// MO-B3: Owner-Only Store Compliance & Corrective Response Routes
//
// Mounted at: /api/v1/seller/stores/:storeId/compliance
//
// Security:
//   - Requires valid Seller Account JWT (`requireSellerJwt`).
//   - Requires active `OWNER` membership on `storeId` via Merchant DB.
//   - Rejects STAFF members, Buyer JWTs, Admin JWTs, and cross-store Owners.
//   - Never lets an Owner resolve warnings, override suspension, or open store.
//   - Actor identity derived exclusively from `req.auth.sub`.
// =========================================================================

export function createComplianceRouter(
  merchantPool: StrictPgPool,
  config: GatewayConfig
): Router {
  const router = Router({ mergeParams: true });

  router.use(requireSellerJwt(config));
  router.use(
    requireStoreMembership(merchantPool, {
      allowedRoles: ['OWNER'],
      requiredPermission: 'KYC_MANAGE',
      getStoreId: (req) => req.params?.storeId
    })
  );

  // GET /api/v1/seller/stores/:storeId/compliance
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    const storeId = req.storeAccess?.storeId;
    if (!storeId) {
      return res.status(401).json({ error: 'Store access context missing.', code: 'AUTH_REQUIRED' });
    }

    const result = await getOwnerStoreCompliance(merchantPool, storeId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      ...result.data
    });
  });

  // GET /api/v1/seller/stores/:storeId/compliance/warnings
  router.get('/warnings', async (req: AuthenticatedRequest, res: Response) => {
    const storeId = req.storeAccess?.storeId;
    if (!storeId) {
      return res.status(401).json({ error: 'Store access context missing.', code: 'AUTH_REQUIRED' });
    }

    const result = await getOwnerStoreCompliance(merchantPool, storeId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      warningCounts: result.data.warningCounts,
      warnings: result.data.warnings
    });
  });

  // POST /api/v1/seller/stores/:storeId/compliance/warnings/:warningId/respond
  router.post('/warnings/:warningId/respond', async (req: AuthenticatedRequest, res: Response) => {
    const storeId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    if (!storeId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await submitOwnerWarningResponse(merchantPool, {
      storeId,
      warningId: String(req.params?.warningId ?? ''),
      sellerAccountId,
      responseMessage: body.responseMessage,
      evidenceReferences: body.evidenceReferences
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(201).json({
      success: true,
      ...result.data
    });
  });

  // POST /api/v1/seller/stores/:storeId/compliance/suspension/respond
  router.post('/suspension/respond', async (req: AuthenticatedRequest, res: Response) => {
    const storeId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    if (!storeId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await submitOwnerSuspensionResponse(merchantPool, {
      storeId,
      sellerAccountId,
      responseMessage: body.responseMessage,
      evidenceReferences: body.evidenceReferences
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(201).json({
      success: true,
      ...result.data
    });
  });

  return router;
}
