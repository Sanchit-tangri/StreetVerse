import { Response, Router } from 'express';
import { StrictPgPool } from '../db/postgres';
import { ManagedRedisClient } from '../db/redis';
import { GatewayConfig } from '../config/env';
import { AdminPermission, AuthenticatedRequest, requireAdminJwt } from '../middleware/authJwt';
import { KycDocumentStorage } from '../storage/kycDocumentStorage';
import {
  authenticateAdminAccount,
  getAdminOnboardingQueue,
  getAdminStoreOnboardingDetails,
  resolveVerifiedAdminActor
} from '../services/adminAuth';
import {
  checkAdminLoginRateLimit,
  clearAdminLoginFailures,
  extractAdminLoginClientIp,
  recordAdminLoginFailure
} from '../services/adminLoginRateLimit';
import {
  approveSubmissionDecision,
  rejectSubmissionDecision,
  requestMoreInfoSubmissionDecision,
  retrieveAdminSubmissionDocumentContent,
  startSubmissionReview
} from '../services/adminReview';
import {
  escalateStoreComplianceWarning,
  getAdminStoreCompliance,
  issueStoreComplianceWarning,
  listAdminComplianceWarnings,
  reactivateMerchantStore,
  resolveStoreComplianceWarning,
  suspendMerchantStore
} from '../services/adminCompliance';
import {
  getAdminOutboxSummary,
  listAdminOutboxEvents,
  OutboxWorkerTelemetry,
  replayAdminOutboxEvent
} from '../services/notificationOutbox';
import {
  InfrastructureUnavailableError,
  isRedisUnavailableError,
  sanitizeErrorForLog
} from '../utils/infraErrors';

// =========================================================================
// MO-B1 / MO-B2: Protected Admin Identity, Review Queue, Document Viewing
//                & Application Decision Routes
//
// Mounted at: /api/v1/admin
//
// Security:
//   - Only POST /auth/login is public (credentials verified against admin_accounts
//     with Redis-backed `(clientIp, email)` and `clientIp` brute-force throttling).
//   - No public self-registration endpoint exists.
//   - All other endpoints require `requireAdminJwt` (distinct Admin JWT audience,
//     ADMIN_ACCOUNT principalType, ADMIN role, and live ACTIVE row in Merchant DB).
//   - Reviewer identity is always derived from `resolveVerifiedAdminActor(req)`.
//   - Document bytes stream exclusively through `KycDocumentStorage` after checksum
//     verification with safe MIME, `nosniff`, and `private, no-store` headers.
// =========================================================================

const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The Admin dashboard hides controls without the corresponding permission, but
 * authorization must be enforced at the API boundary as well.  Keep the live
 * DB-backed actor resolution here so a stale JWT can never grant access.
 */
function requireAdminPermission(
  req: AuthenticatedRequest,
  res: Response,
  permission: AdminPermission
) {
  const verified = resolveVerifiedAdminActor(req);
  if (!verified.ok) {
    res.status(verified.status).json({ error: verified.error, code: verified.code });
    return null;
  }
  if (!verified.actor.permissions.includes(permission)) {
    res.status(403).json({
      error: 'Administrative permission is required for this operation.',
      code: 'ADMIN_PERMISSION_REQUIRED'
    });
    return null;
  }
  return verified;
}

export function createAdminRouter(
  merchantPool: StrictPgPool,
  config: GatewayConfig,
  redisClient: Partial<ManagedRedisClient> | null,
  kycStorage: KycDocumentStorage,
  getOutboxWorkerTelemetry?: () => OutboxWorkerTelemetry | null
): Router {
  const router = Router();

  // POST /api/v1/admin/auth/login
  router.post('/auth/login', async (req: AuthenticatedRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const normalizedEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const clientIp = extractAdminLoginClientIp(req);
    const rateKeyEmail =
      normalizedEmail && EMAIL_FORMAT_REGEX.test(normalizedEmail) ? normalizedEmail : '__malformed__';

    try {
      const rateCheck = await checkAdminLoginRateLimit(redisClient, {
        clientIp,
        email: rateKeyEmail
      });

      if (!rateCheck.allowed) {
        res.setHeader('Retry-After', String(rateCheck.retryAfterSeconds));
        return res.status(429).json({
          error: 'Too many failed admin login attempts. Please try again later.',
          code: 'ADMIN_LOGIN_RATE_LIMITED',
          retryAfterSeconds: rateCheck.retryAfterSeconds
        });
      }

      if (!normalizedEmail || !EMAIL_FORMAT_REGEX.test(normalizedEmail) || !password) {
        await recordAdminLoginFailure(redisClient, {
          clientIp,
          email: rateKeyEmail
        });
        return res.status(400).json({
          error: 'Valid email and password are required.',
          code: 'ADMIN_INVALID_INPUT'
        });
      }

      const result = await authenticateAdminAccount(merchantPool, config, {
        email: normalizedEmail,
        password
      });

      if (!result.ok) {
        if (result.status === 401 || result.status === 403 || result.status === 400) {
          await recordAdminLoginFailure(redisClient, {
            clientIp,
            email: normalizedEmail
          });
        }
        return res.status(result.status).json({ error: result.error, code: result.code });
      }

      try {
        await clearAdminLoginFailures(redisClient, {
          clientIp,
          email: normalizedEmail
        });
      } catch (clearErr: unknown) {
        console.warn(`[Admin Login Throttle Cleanup]: ${sanitizeErrorForLog(clearErr)}`);
      }

      return res.status(200).json({
        success: true,
        token: result.data.token,
        expiresIn: result.data.expiresIn,
        admin: result.data.admin
      });
    } catch (err: unknown) {
      if (err instanceof InfrastructureUnavailableError || isRedisUnavailableError(err)) {
        return res.status(503).json({
          error: 'Authentication protection service is temporarily unavailable.',
          code: 'REDIS_UNAVAILABLE'
        });
      }
      console.error(`[Admin Login Route Error]: ${sanitizeErrorForLog(err)}`);
      return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
    }
  });

  // Protect every non-login Admin endpoint with strict Admin JWT + DB status check
  router.use(requireAdminJwt(merchantPool, config));

  // GET /api/v1/admin/me
  router.get('/me', async (req: AuthenticatedRequest, res: Response) => {
    const verified = resolveVerifiedAdminActor(req);
    if (!verified.ok) {
      return res.status(verified.status).json({ error: verified.error, code: verified.code });
    }

    return res.status(200).json({
      success: true,
      admin: {
        id: verified.actor.actorId,
        email: verified.actor.email,
        fullName: verified.actor.fullName,
        role: verified.actor.role,
        permissions: verified.actor.permissions,
        principalType: req.adminAuth!.principalType,
        status: req.adminAuth!.status
      }
    });
  });

  // GET /api/v1/admin/onboarding/queue
  router.get('/onboarding/queue', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'KYC_QUEUE_READ');
    if (!verified) return;

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const search =
      typeof req.query.search === 'string'
        ? req.query.search
        : typeof req.query.q === 'string'
          ? req.query.q
          : undefined;
    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId : undefined;
    const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;

    const result = await getAdminOnboardingQueue(merchantPool, {
      status,
      category,
      search,
      storeId,
      sort,
      limit,
      offset
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      reviewedByActor: {
        actorType: verified.actor.actorType,
        actorId: verified.actor.actorId
      },
      ...result.data
    });
  });

  // GET /api/v1/admin/onboarding/stores/:storeId
  router.get('/onboarding/stores/:storeId', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'KYC_SUBMISSION_READ');
    if (!verified) return;

    const storeId = String(req.params?.storeId ?? '');
    const result = await getAdminStoreOnboardingDetails(merchantPool, storeId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      reviewedByActor: {
        actorType: verified.actor.actorType,
        actorId: verified.actor.actorId
      },
      ...result.data
    });
  });

  // GET /api/v1/admin/onboarding/submissions/:submissionId/documents/:documentId/content
  router.get(
    '/onboarding/submissions/:submissionId/documents/:documentId/content',
    async (req: AuthenticatedRequest, res: Response) => {
      const verified = requireAdminPermission(req, res, 'KYC_SUBMISSION_READ');
      if (!verified) return;

      const submissionId = String(req.params?.submissionId ?? '');
      const documentId = String(req.params?.documentId ?? '');
      const result = await retrieveAdminSubmissionDocumentContent(merchantPool, kycStorage, {
        submissionId,
        documentId,
        adminId: verified.actor.actorId
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, code: result.code });
      }

      res.setHeader('Content-Type', result.data.mimeType);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${result.data.originalFilenameSanitized.replace(/"/g, '')}"`
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      return res.status(200).send(result.data.buffer);
    }
  );

  // POST /api/v1/admin/onboarding/submissions/:submissionId/start-review
  router.post('/onboarding/submissions/:submissionId/start-review', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'KYC_REVIEW_DECIDE');
    if (!verified) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await startSubmissionReview(merchantPool, {
      submissionId: String(req.params?.submissionId ?? ''),
      adminId: verified.actor.actorId,
      reviewNotes: body.reviewNotes
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({ success: true, decision: result.data });
  });

  // POST /api/v1/admin/onboarding/submissions/:submissionId/approve
  router.post('/onboarding/submissions/:submissionId/approve', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'KYC_REVIEW_DECIDE');
    if (!verified) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await approveSubmissionDecision(merchantPool, {
      submissionId: String(req.params?.submissionId ?? ''),
      adminId: verified.actor.actorId,
      checklist: body.checklist,
      reviewNotes: body.reviewNotes
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({ success: true, decision: result.data });
  });

  // POST /api/v1/admin/onboarding/submissions/:submissionId/request-information
  router.post(
    '/onboarding/submissions/:submissionId/request-information',
    async (req: AuthenticatedRequest, res: Response) => {
      const verified = requireAdminPermission(req, res, 'KYC_REVIEW_DECIDE');
      if (!verified) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await requestMoreInfoSubmissionDecision(merchantPool, {
        submissionId: String(req.params?.submissionId ?? ''),
        adminId: verified.actor.actorId,
        reason: body.reason,
        requestedCorrections: body.requestedCorrections,
        requestedRequirements: body.requestedRequirements,
        reviewNotes: body.reviewNotes
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, code: result.code });
      }

      return res.status(200).json({ success: true, decision: result.data });
    }
  );

  // POST /api/v1/admin/onboarding/submissions/:submissionId/reject
  router.post('/onboarding/submissions/:submissionId/reject', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'KYC_REVIEW_DECIDE');
    if (!verified) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await rejectSubmissionDecision(merchantPool, {
      submissionId: String(req.params?.submissionId ?? ''),
      adminId: verified.actor.actorId,
      reason: body.reason,
      rejectionCategory: body.rejectionCategory,
      reviewNotes: body.reviewNotes
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({ success: true, decision: result.data });
  });

  // =========================================================================
  // MO-B3: Store Compliance Warnings, Escalations, Suspension & Reactivation
  // =========================================================================

  // GET /api/v1/admin/compliance/warnings
  router.get('/compliance/warnings', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'STORE_COMPLIANCE_MANAGE');
    if (!verified) return;

    const result = await listAdminComplianceWarnings(merchantPool, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      overdueOnly: req.query.overdueOnly === 'true',
      escalatedOnly: req.query.escalatedOnly === 'true',
      storeId: typeof req.query.storeId === 'string' ? req.query.storeId : undefined,
      severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      offset: typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({ success: true, ...result.data });
  });

  // GET /api/v1/admin/stores/:storeId/compliance
  router.get('/stores/:storeId/compliance', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'STORE_COMPLIANCE_MANAGE');
    if (!verified) return;

    const result = await getAdminStoreCompliance(merchantPool, String(req.params?.storeId ?? ''));
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      reviewedByActor: {
        actorType: verified.actor.actorType,
        actorId: verified.actor.actorId
      },
      ...result.data
    });
  });

  // POST /api/v1/admin/stores/:storeId/compliance/warnings
  router.post('/stores/:storeId/compliance/warnings', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'STORE_COMPLIANCE_MANAGE');
    if (!verified) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await issueStoreComplianceWarning(merchantPool, {
      storeId: String(req.params?.storeId ?? ''),
      adminId: verified.actor.actorId,
      violationCategory: body.violationCategory,
      severity: body.severity,
      reason: body.reason,
      requiredCorrectiveAction: body.requiredCorrectiveAction,
      correctiveDeadline: body.correctiveDeadline,
      evidenceReferences: body.evidenceReferences
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(201).json({ success: true, ...result.data });
  });

  // POST /api/v1/admin/stores/:storeId/compliance/warnings/:warningId/escalate
  router.post(
    '/stores/:storeId/compliance/warnings/:warningId/escalate',
    async (req: AuthenticatedRequest, res: Response) => {
      const verified = requireAdminPermission(req, res, 'STORE_COMPLIANCE_MANAGE');
      if (!verified) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await escalateStoreComplianceWarning(merchantPool, {
        storeId: String(req.params?.storeId ?? ''),
        warningId: String(req.params?.warningId ?? ''),
        adminId: verified.actor.actorId,
        notes: body.notes,
        evidenceReferences: body.evidenceReferences
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, code: result.code });
      }

      return res.status(200).json({ success: true, ...result.data });
    }
  );

  // POST /api/v1/admin/stores/:storeId/compliance/warnings/:warningId/resolve
  router.post(
    '/stores/:storeId/compliance/warnings/:warningId/resolve',
    async (req: AuthenticatedRequest, res: Response) => {
      const verified = requireAdminPermission(req, res, 'STORE_COMPLIANCE_MANAGE');
      if (!verified) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await resolveStoreComplianceWarning(merchantPool, {
        storeId: String(req.params?.storeId ?? ''),
        warningId: String(req.params?.warningId ?? ''),
        adminId: verified.actor.actorId,
        reason: body.reason,
        correctiveEvidenceChecked: body.correctiveEvidenceChecked,
        allowResolutionWithoutOwnerResponse: body.allowResolutionWithoutOwnerResponse,
        evidenceReferences: body.evidenceReferences
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, code: result.code });
      }

      return res.status(200).json({ success: true, ...result.data });
    }
  );

  // POST /api/v1/admin/stores/:storeId/compliance/suspend
  router.post('/stores/:storeId/compliance/suspend', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'STORE_COMPLIANCE_MANAGE');
    if (!verified) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await suspendMerchantStore(merchantPool, {
      storeId: String(req.params?.storeId ?? ''),
      adminId: verified.actor.actorId,
      suspensionType: body.suspensionType,
      violationCategory: body.violationCategory,
      reason: body.reason,
      evidenceReferences: body.evidenceReferences
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({ success: true, suspension: result.data });
  });

  // POST /api/v1/admin/stores/:storeId/compliance/reactivate
  router.post('/stores/:storeId/compliance/reactivate', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'STORE_COMPLIANCE_MANAGE');
    if (!verified) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await reactivateMerchantStore(merchantPool, {
      storeId: String(req.params?.storeId ?? ''),
      adminId: verified.actor.actorId,
      reason: body.reason,
      correctiveEvidenceReviewed: body.correctiveEvidenceReviewed,
      evidenceReferences: body.evidenceReferences,
      warningResolutions: body.warningResolutions
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({ success: true, reactivation: result.data });
  });

  // -----------------------------------------------------------------------
  // MO-B4: Notification Outbox Operational Visibility & Terminal Replay
  // -----------------------------------------------------------------------

  // GET /api/v1/admin/notifications/outbox/summary
  router.get('/notifications/outbox/summary', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'KYC_QUEUE_READ');
    if (!verified) return;

    const telemetry = getOutboxWorkerTelemetry ? getOutboxWorkerTelemetry() : null;
    const result = await getAdminOutboxSummary(merchantPool, telemetry);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      ...result.data
    });
  });

  // GET /api/v1/admin/notifications/outbox
  router.get('/notifications/outbox', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'KYC_QUEUE_READ');
    if (!verified) return;

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const storeId = typeof req.query.storeId === 'string' ? req.query.storeId : undefined;
    const eventType = typeof req.query.eventType === 'string' ? req.query.eventType : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;

    const result = await listAdminOutboxEvents(merchantPool, {
      status,
      storeId,
      eventType,
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

  // POST /api/v1/admin/notifications/outbox/:eventId/replay
  router.post('/notifications/outbox/:eventId/replay', async (req: AuthenticatedRequest, res: Response) => {
    const verified = requireAdminPermission(req, res, 'KYC_QUEUE_READ');
    if (!verified) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await replayAdminOutboxEvent(merchantPool, {
      eventId: String(req.params?.eventId ?? ''),
      adminId: verified.actor.actorId,
      reason: body.reason
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      replay: result.data
    });
  });

  return router;
}
