import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { GatewayConfig } from './config/env';
import { corsErrorHandler, createCorsOptions } from './config/cors';
import { createEmailService, EmailService, EmailTransporterLike } from './services/email';
import { createAuthRouter } from './routes/auth';
import { createSellerRouter } from './routes/seller';
import { createUserRouter } from './routes/user';
import { createSearchRouter, AiSearchFetcher } from './routes/search';
import { ConversationBroadcaster, createConversationsRouter } from './routes/conversations';
import { createOnboardingRouter } from './routes/onboarding';
import { createComplianceRouter } from './routes/compliance';
import { createStoreNotificationsRouter } from './routes/notifications';
import { createAdminRouter } from './routes/admin';
import { createCatalogueRouter } from './routes/catalogue';
import {
  createNotificationOutboxWorker,
  NotificationOutboxWorker,
  OutboxWorkerOptions
} from './services/notificationOutbox';
import { createKycDocumentStorage, KycDocumentStorage } from './storage/kycDocumentStorage';
import { createStrictPgPool, StrictPgPool } from './db/postgres';
import {
  closeManagedRedisClient,
  createManagedRedisClient,
  createRedisPubSubClient,
  ManagedRedisClient
} from './db/redis';
import { attachSecureChatSocketHandlers } from './realtime/chatSocket';
import { classifyHttpError, sanitizeErrorForLog } from './utils/infraErrors';
import { checkGatewayReadiness } from './utils/readiness';

export interface GatewayAppDeps {
  customerPool?: StrictPgPool;
  merchantPool?: StrictPgPool;
  redis?: ManagedRedisClient;
  redisPubClient?: ManagedRedisClient;
  redisSubClient?: ManagedRedisClient;
  enableRedisAdapter?: boolean;
  emailService?: EmailService;
  emailTransporter?: EmailTransporterLike | null;
  aiSearchFetcher?: AiSearchFetcher;
  /** Override KYC document storage (inject a mock in tests). */
  kycStorage?: KycDocumentStorage;
  /** Explicitly enable/disable or override background MO-B4 notification outbox worker. */
  startNotificationWorker?: boolean;
  notificationWorkerOptions?: OutboxWorkerOptions;
  notificationWorker?: NotificationOutboxWorker;
}

export interface GatewayShutdownOptions {
  timeoutMs?: number;
}

export interface GatewayShutdownResult {
  timedOut: boolean;
  poolErrors: string[];
  redisErrors: string[];
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

export function createGatewayApp(config: GatewayConfig, deps: GatewayAppDeps = {}) {
  const app = express();
  const corsOptions = createCorsOptions(config.allowedOrigins);

  app.use(cors(corsOptions));
  app.use(corsErrorHandler);
  app.use(express.json());

  const hasInjectedPubSub = Boolean(deps.redisPubClient || deps.redisSubClient);
  if (Boolean(deps.redisPubClient) !== Boolean(deps.redisSubClient)) {
    throw new Error('Configuration error: Both redisPubClient and redisSubClient must be provided together.');
  }

  const ownsRedis = !deps.redis;
  const redis = deps.redis || createManagedRedisClient(config.redisUrl);
  const enableRedisAdapter =
    deps.enableRedisAdapter ?? (hasInjectedPubSub || !deps.redis);
  const ownsPubSub = enableRedisAdapter && !hasInjectedPubSub;
  const redisPubClient = enableRedisAdapter
    ? deps.redisPubClient || createRedisPubSubClient(config.redisUrl, 'pub')
    : null;
  const redisSubClient = enableRedisAdapter
    ? deps.redisSubClient || createRedisPubSubClient(config.redisUrl, 'sub')
    : null;

  const emailService =
    deps.emailService ||
    createEmailService({
      redisClient: redis,
      nodeEnv: config.nodeEnv,
      transporter: deps.emailTransporter
    });

  const ownsCustomerPool = !deps.customerPool;
  const ownsMerchantPool = !deps.merchantPool;
  const customerPool = deps.customerPool || createStrictPgPool(config.customerDbUrl, 'customer');
  const merchantPool = deps.merchantPool || createStrictPgPool(config.merchantDbUrl, 'merchant');

  const kycStorage =
    deps.kycStorage ||
    createKycDocumentStorage(
      config.kycStorageDir || path.resolve(__dirname, '..', 'data', 'kyc-documents')
    );

  let conversationBroadcaster: ConversationBroadcaster | null = null;
  const lazyBroadcaster: ConversationBroadcaster = {
    emitNewMessage: (roomName, message) =>
      conversationBroadcaster
        ? conversationBroadcaster.emitNewMessage(roomName, message)
        : { realtimeDelivered: false }
  };

  // Mount StreetVerse Authentication Router (Buyer & Seller)
  app.use('/api/v1/auth', createAuthRouter(customerPool, merchantPool, config, emailService));

  // Mount Authenticated Seller Store & RBAC Router
  app.use('/api/v1/seller', createSellerRouter(merchantPool, config));

  // Mount MO-A: Seller Onboarding & KYC Routes (OWNER-only)
  app.use(
    '/api/v1/seller/stores/:storeId/onboarding',
    createOnboardingRouter(merchantPool, config, kycStorage)
  );

  const notificationWorkerEnabled =
    deps.startNotificationWorker ?? Boolean(config.notificationWorkerEnabled);
  const notificationWorker: NotificationOutboxWorker =
    deps.notificationWorker ||
    createNotificationOutboxWorker(merchantPool, emailService, {
      enabled: notificationWorkerEnabled,
      pollIntervalMs: config.notificationWorkerPollMs,
      batchSize: config.notificationWorkerBatchSize,
      leaseDurationMs: config.notificationWorkerLeaseMs,
      maxAttempts: config.notificationWorkerMaxAttempts,
      baseRetryDelayMs: config.notificationWorkerBaseRetryMs,
      maxRetryDelayMs: config.notificationWorkerMaxRetryMs,
      ...(deps.notificationWorkerOptions || {})
    });

  // Mount MO-B3: Owner-Only Store Compliance & Corrective Response Routes
  app.use(
    '/api/v1/seller/stores/:storeId/compliance',
    createComplianceRouter(merchantPool, config)
  );

  // Mount MO-B4: Owner-Only Store Notification Routes
  app.use(
    '/api/v1/seller/stores/:storeId/notifications',
    createStoreNotificationsRouter(merchantPool, config)
  );

  // Mount MO-B1 / MO-B2 / MO-B3 / MO-B4: Protected Admin Identity, Review, Compliance & Outbox Routes
  app.use(
    '/api/v1/admin',
    createAdminRouter(merchantPool, config, redis, kycStorage, () => notificationWorker.getTelemetry())
  );

  app.use('/api/v1', createCatalogueRouter(merchantPool, config));

  // Mount PostgreSQL-Backed Authenticated Conversations & Messaging Router
  app.use(
    '/api/v1/conversations',
    createConversationsRouter(customerPool, merchantPool, config, lazyBroadcaster)
  );

  // Mount User Settings Router (JWT protected)
  app.use('/api/user', createUserRouter(customerPool, config, emailService));

  // Mount AI Search Proxy Router
  app.use('/api/v1/search', createSearchRouter(merchantPool, config.aiEngineUrl, deps.aiSearchFetcher));

  // =========================================================================
  // 1. BOOKING OPERATIONS TEMPORARILY DISABLED (PENDING STAGE 2 DB CONSOLIDATION)
  // =========================================================================
  const BOOKING_UNAVAILABLE_RESPONSE = {
    success: false,
    code: 'BOOKING_TEMPORARILY_UNAVAILABLE',
    error: 'Booking is temporarily unavailable while booking storage is being consolidated. Please try again later.'
  };

  /**
   * Temporarily disabled: locking and confirming slots requires coordinated writes across
   * Merchant DB (service_slots) and Customer DB (booking_receipts). Returns 503 without
   * mutating slots, storing receipts, touching Redis locks, or fabricating tokens.
   */
  app.post('/api/v1/bookings/lock-slot', (_req: Request, res: Response) => {
    return res.status(503).json(BOOKING_UNAVAILABLE_RESPONSE);
  });

  app.post('/api/v1/bookings/confirm-payment', (_req: Request, res: Response) => {
    return res.status(503).json(BOOKING_UNAVAILABLE_RESPONSE);
  });

  // Process liveness endpoint: reports healthy whenever the Express gateway process is alive.
  // Never queries PostgreSQL or Redis so transient dependency outages do not mark the process dead.
  app.get('/api/health', (_req, res) => {
    res.status(200).json({
      status: 'healthy',
      service: 'StreetVerse API Gateway & Realtime Hub',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  // Dependency readiness endpoint: checks Customer DB, Merchant DB, and shared Redis
  // using existing managed instances within bounded timeouts. Returns 503 if any is down.
  app.get('/api/ready', async (_req: Request, res: Response) => {
    const readiness = await checkGatewayReadiness({
      customerPool,
      merchantPool,
      redis
    });

    if (!readiness.ready) {
      return res.status(503).json({
        status: readiness.status,
        ready: false,
        code: 'SERVICE_UNAVAILABLE',
        error: 'One or more required infrastructure dependencies are unavailable.',
        checks: readiness.checks,
        timestamp: readiness.timestamp
      });
    }

    return res.status(200).json({
      status: readiness.status,
      ready: true,
      checks: readiness.checks,
      timestamp: readiness.timestamp
    });
  });

  // Live server telemetry: consistent with dependency readiness (never fakes HTTP 200 or stats on outage)
  app.get('/api/v1/server/node-status', async (_req: Request, res: Response) => {
    const readiness = await checkGatewayReadiness({
      customerPool,
      merchantPool,
      redis
    });

    if (!readiness.ready) {
      return res.status(503).json({
        success: false,
        status: readiness.status,
        ready: false,
        code: 'SERVICE_UNAVAILABLE',
        error: 'Required infrastructure dependencies are unavailable.',
        checks: readiness.checks,
        timestamp: readiness.timestamp
      });
    }

    try {
      const [custCount, merchCount, itemsCount] = await Promise.all([
        customerPool.query('SELECT count(*)::int as count FROM users'),
        merchantPool.query('SELECT count(*)::int as count FROM merchants'),
        merchantPool.query('SELECT count(*)::int as count FROM inventory_items')
      ]);

      return res.status(200).json({
        success: true,
        status: 'ready',
        ready: true,
        checks: readiness.checks,
        node: {
          service: 'StreetVerse API Gateway & Realtime Hub',
          stats: {
            users: Number(custCount.rows[0]?.count ?? 0),
            merchants: Number(merchCount.rows[0]?.count ?? 0),
            inventoryItems: Number(itemsCount.rows[0]?.count ?? 0)
          },
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString()
        }
      });
    } catch (err: unknown) {
      const mapped = classifyHttpError(err);
      if (mapped.status === 503) {
        return res.status(503).json({
          success: false,
          status: 'not_ready',
          ready: false,
          code: mapped.code,
          error: mapped.message,
          timestamp: new Date().toISOString()
        });
      }
      console.error(`[Node Status Error]: ${sanitizeErrorForLog(err)}`);
      return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        error: 'Internal server error.'
      });
    }
  });

  // =========================================================================
  // 2. SECURE AUTHENTICATED SOCKET.IO CHAT DISPATCHER (Customer PG + Redis Pub/Sub)
  // =========================================================================
  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: corsOptions
  });

  const chatHub = attachSecureChatSocketHandlers({
    io,
    config,
    customerPool,
    merchantPool,
    redisPubClient,
    redisSubClient,
    enableRedisAdapter
  });
  conversationBroadcaster = chatHub.broadcaster;

  server.once('listening', () => {
    void chatHub.ensurePubSubReady();
    notificationWorker.start();
  });

  let shutdownPromise: Promise<GatewayShutdownResult> | null = null;

  /**
   * Gracefully stops accepting new HTTP connections, drains active requests within a bounded
   * timeout, and closes application-owned PostgreSQL pools and owned Redis clients (OTP + Pub/Sub)
   * without closing caller-injected test resources.
   */
  const shutdown = async (options: GatewayShutdownOptions = {}): Promise<GatewayShutdownResult> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    const timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_SHUTDOWN_TIMEOUT_MS;

    shutdownPromise = (async () => {
      let timedOut = false;
      const ioClosePromise = io.close().catch(() => {});

      if (server.listening) {
        timedOut = await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (didTimeout: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(didTimeout);
          };

          const timer = setTimeout(() => {
            server.closeAllConnections?.();
            finish(true);
          }, timeoutMs);
          timer.unref?.();

          // Stop accepting new connections immediately and drain active requests; drop idle keep-alives
          server.close(() => finish(false));
          server.closeIdleConnections?.();
          void ioClosePromise;
        });
      }

      // Allow RedisAdapter.close() unsubscribe calls to finish before quitting Pub/Sub sockets
      await Promise.race([
        ioClosePromise,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          t.unref?.();
        })
      ]);

      // Drain active outbox notification batch cleanly before closing PostgreSQL pools
      const workerStopRes = await notificationWorker
        .stop(Math.min(timeoutMs, 4000))
        .catch(() => ({ timedOut: true }));
      if (workerStopRes.timedOut) {
        timedOut = true;
      }

      const poolErrors: string[] = [];
      const redisErrors: string[] = [];
      const closeOwnedPool = async (pool: StrictPgPool, label: string, owned: boolean) => {
        if (!owned) return;
        try {
          await pool.end();
        } catch (err) {
          const code =
            err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
              ? (err as { code: string }).code
              : 'UNKNOWN';
          const safeLog = `[PostgreSQL:${label}] Pool shutdown failed (code=${code}): ${sanitizeErrorForLog(err)}`;
          console.error(safeLog);
          poolErrors.push(safeLog);
        }
      };

      const settled = await Promise.allSettled([
        closeOwnedPool(customerPool, 'customer', ownsCustomerPool),
        closeOwnedPool(merchantPool, 'merchant', ownsMerchantPool),
        closeManagedRedisClient(redis, ownsRedis),
        closeManagedRedisClient(redisPubClient, ownsPubSub),
        closeManagedRedisClient(redisSubClient, ownsPubSub)
      ]);
      for (const redisOutcome of settled.slice(2)) {
        if (redisOutcome.status === 'fulfilled' && redisOutcome.value) {
          redisErrors.push(redisOutcome.value);
        } else if (redisOutcome.status === 'rejected') {
          redisErrors.push(`[Redis] Shutdown failed unexpectedly: ${sanitizeErrorForLog(redisOutcome.reason)}`);
        }
      }

      return { timedOut, poolErrors, redisErrors };
    })();

    return shutdownPromise;
  };

  return {
    app,
    server,
    io,
    redis,
    redisPubClient,
    redisSubClient,
    customerPool,
    merchantPool,
    emailService,
    notificationWorker,
    ensurePubSubReady: chatHub.ensurePubSubReady,
    shutdown
  };
}

export function registerShutdownSignals(
  shutdown: (options?: GatewayShutdownOptions) => Promise<GatewayShutdownResult>,
  options: {
    targetProcess?: Pick<NodeJS.Process, 'once' | 'removeListener'>;
    onExit?: (exitCode: number) => void;
    timeoutMs?: number;
  } = {}
): () => void {
  const proc = options.targetProcess || process;
  const exit = options.onExit || ((code: number) => process.exit(code));
  let handlingSignal = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (handlingSignal) return;
    handlingSignal = true;
    console.log(`[StreetVerse Gateway] Received ${signal}. Initiating graceful shutdown...`);
    shutdown({ timeoutMs: options.timeoutMs })
      .then((res) => {
        if (res.timedOut) {
          console.warn(
            '[StreetVerse Gateway] Graceful shutdown timeout reached; remaining HTTP connections were closed.'
          );
        }
        exit(res.poolErrors.length > 0 || res.redisErrors.length > 0 ? 1 : 0);
      })
      .catch((err) => {
        console.error(`[StreetVerse Gateway] Graceful shutdown error: ${sanitizeErrorForLog(err)}`);
        exit(1);
      });
  };

  const onSigTerm = () => handleSignal('SIGTERM');
  const onSigInt = () => handleSignal('SIGINT');

  proc.once('SIGTERM', onSigTerm);
  proc.once('SIGINT', onSigInt);

  return () => {
    proc.removeListener('SIGTERM', onSigTerm);
    proc.removeListener('SIGINT', onSigInt);
  };
}

export function startGatewayServer(config: GatewayConfig) {
  const { server, shutdown } = createGatewayApp(config);
  const cleanupSignals = registerShutdownSignals(shutdown);
  server.once('close', cleanupSignals);

  server.listen(config.port, () => {
    console.log(
      `[StreetVerse Gateway] Listening on http://localhost:${config.port} (env=${config.nodeEnv}, allowedOrigins=${config.allowedOrigins.length})`
    );
  });
  return server;
}
