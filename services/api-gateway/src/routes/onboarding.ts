import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { StrictPgPool } from '../db/postgres';
import { AuthenticatedRequest, requireSellerJwt, requireStoreMembership } from '../middleware/authJwt';
import { GatewayConfig } from '../config/env';
import { KycDocumentStorage, KYC_MAX_FILE_SIZE_BYTES } from '../storage/kycDocumentStorage';
import {
  deleteDraftDocument,
  getOnboardingOverview,
  listStoreSubmissions,
  OnboardingDraftUpdate,
  retrieveStoreDocumentContent,
  submitOnboardingApplication,
  updateOnboardingDraft,
  uploadDraftDocument
} from '../services/onboarding';

// =========================================================================
// MO-A: Seller Onboarding & KYC Routes
//
// Mounted at: /api/v1/seller/stores/:storeId/onboarding
//
// Security:
//   - Requires valid Seller Account JWT (`requireSellerJwt`).
//   - Requires active `OWNER` membership on `storeId` via Merchant DB.
//   - Rejects STAFF members, Buyer JWTs, and cross-store Owners cleanly.
//   - Never trusts client-supplied roles, approval claims, or raw paths.
//   - Never returns `storage_key`, filesystem paths, SQL, or admin review notes.
// =========================================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: KYC_MAX_FILE_SIZE_BYTES,
    files: 1
  }
});

function handleDocumentMultipart(req: Request, res: Response, next: NextFunction): void {
  upload.single('document')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'File exceeds the 10 MB size limit.', code: 'FILE_TOO_LARGE' });
        return;
      }
      res.status(400).json({ error: 'Invalid multipart upload request.', code: err.code });
      return;
    }
    res.status(400).json({ error: 'Invalid file upload payload.', code: 'INVALID_UPLOAD' });
  });
}

export function createOnboardingRouter(
  merchantPool: StrictPgPool,
  config: GatewayConfig,
  kycStorage: KycDocumentStorage
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

  // GET /api/v1/seller/stores/:storeId/onboarding
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    const merchantId = req.storeAccess?.storeId;
    if (!merchantId) {
      return res.status(401).json({ error: 'Store access context missing.', code: 'AUTH_REQUIRED' });
    }

    const result = await getOnboardingOverview(merchantPool, merchantId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      ...result.data
    });
  });

  // PUT /api/v1/seller/stores/:storeId/onboarding
  router.put('/', async (req: AuthenticatedRequest, res: Response) => {
    const merchantId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    if (!merchantId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const parseFiniteNumber = (val: unknown): number | undefined => {
      if (val === undefined) return undefined;
      if (typeof val === 'number') return val;
      if (typeof val === 'string' && val.trim() !== '') return Number(val);
      return NaN;
    };

    const update: OnboardingDraftUpdate = {};
    if (body.businessName !== undefined) update.businessName = String(body.businessName);
    if (body.category !== undefined) update.category = String(body.category);
    if (body.businessType !== undefined) update.businessType = String(body.businessType);
    if (body.premisesType !== undefined) update.premisesType = String(body.premisesType);
    if (body.operatingModel !== undefined) update.operatingModel = String(body.operatingModel);
    if (body.businessTypeConfirmed !== undefined) {
      if (typeof body.businessTypeConfirmed !== 'boolean') {
        return res.status(400).json({ error: 'businessTypeConfirmed must be a boolean.', code: 'INVALID_INPUT' });
      }
      update.businessTypeConfirmed = body.businessTypeConfirmed;
    }
    if (body.fixedPremisesConfirmed !== undefined) {
      if (typeof body.fixedPremisesConfirmed !== 'boolean') {
        return res.status(400).json({ error: 'fixedPremisesConfirmed must be a boolean.', code: 'INVALID_INPUT' });
      }
      update.fixedPremisesConfirmed = body.fixedPremisesConfirmed;
    }
    if (body.premisesOwnershipType !== undefined) update.premisesOwnershipType = String(body.premisesOwnershipType);
    if (body.address !== undefined) update.address = typeof body.address === 'string' ? body.address : String(body.address);
    if (body.pincode !== undefined) update.pincode = typeof body.pincode === 'string' ? body.pincode : String(body.pincode);
    if (body.latitude !== undefined) update.latitude = parseFiniteNumber(body.latitude);
    if (body.longitude !== undefined) update.longitude = parseFiniteNumber(body.longitude);
    if (body.gpsAccuracyMeters !== undefined) update.gpsAccuracyMeters = parseFiniteNumber(body.gpsAccuracyMeters);

    const result = await updateOnboardingDraft(merchantPool, merchantId, sellerAccountId, update);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      profile: result.data.profile,
      locationChangeDetected: result.data.locationChangeDetected,
      ...(result.data.locationChangeDetected
        ? {
            message:
              'Address or GPS location change detected. Store re-verification is required with fresh GPS, storefront photos, and premises proof.'
          }
        : {})
    });
  });

  // POST /api/v1/seller/stores/:storeId/onboarding/documents
  router.post(
    '/documents',
    handleDocumentMultipart,
    async (req: AuthenticatedRequest & { file?: Express.Multer.File }, res: Response) => {
      const merchantId = req.storeAccess?.storeId;
      const sellerAccountId = req.auth?.sub;
      if (!merchantId || !sellerAccountId) {
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({
          error: 'No file uploaded. Provide a file in the "document" field.',
          code: 'FILE_REQUIRED'
        });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const requirementKey = typeof body.requirementKey === 'string' ? body.requirementKey.trim() : '';
      if (!requirementKey) {
        return res.status(400).json({ error: 'requirementKey is required.', code: 'REQUIREMENT_KEY_REQUIRED' });
      }

      const result = await uploadDraftDocument(merchantPool, kycStorage, {
        merchantId,
        sellerAccountId,
        requirementKey,
        fileBuffer: file.buffer,
        declaredMimeType: file.mimetype || '',
        originalFilename: file.originalname || 'document'
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, code: result.code });
      }

      return res.status(201).json({
        success: true,
        document: result.data
      });
    }
  );

  // GET /api/v1/seller/stores/:storeId/onboarding/documents/:documentId
  router.get('/documents/:documentId', async (req: AuthenticatedRequest, res: Response) => {
    const merchantId = req.storeAccess?.storeId;
    const { documentId } = req.params;
    if (!merchantId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }
    if (!documentId) {
      return res.status(400).json({ error: 'Missing documentId.', code: 'MISSING_DOCUMENT_ID' });
    }

    const result = await retrieveStoreDocumentContent(merchantPool, kycStorage, merchantId, documentId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    res.setHeader('Content-Type', result.data.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.data.originalFilenameSanitized.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(result.data.buffer);
  });

  // DELETE /api/v1/seller/stores/:storeId/onboarding/documents/:documentId
  router.delete('/documents/:documentId', async (req: AuthenticatedRequest, res: Response) => {
    const merchantId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    const { documentId } = req.params;
    if (!merchantId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }
    if (!documentId) {
      return res.status(400).json({ error: 'Missing documentId.', code: 'MISSING_DOCUMENT_ID' });
    }

    const result = await deleteDraftDocument(merchantPool, kycStorage, merchantId, documentId, sellerAccountId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({ success: true, deleted: result.data.deleted });
  });

  // POST /api/v1/seller/stores/:storeId/onboarding/submit
  router.post('/submit', async (req: AuthenticatedRequest, res: Response) => {
    const merchantId = req.storeAccess?.storeId;
    const sellerAccountId = req.auth?.sub;
    if (!merchantId || !sellerAccountId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const result = await submitOnboardingApplication(merchantPool, merchantId, sellerAccountId);
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        code: result.code,
        ...(result.details ? { details: result.details } : {})
      });
    }

    return res.status(201).json({
      success: true,
      submission: result.data.submission,
      submissionId: result.data.submission.id,
      submissionVersion: result.data.submission.submissionVersion,
      status: result.data.status,
      message: 'KYC submission created and awaiting administrative review.'
    });
  });

  // GET /api/v1/seller/stores/:storeId/onboarding/submissions
  router.get('/submissions', async (req: AuthenticatedRequest, res: Response) => {
    const merchantId = req.storeAccess?.storeId;
    if (!merchantId) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    const result = await listStoreSubmissions(merchantPool, merchantId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      submissions: result.data
    });
  });

  return router;
}
