import { StrictPgPool } from '../db/postgres';
import { ensureRedisReady, ManagedRedisClient } from '../db/redis';
import { sanitizeErrorForLog } from './infraErrors';

export const DEFAULT_READINESS_TIMEOUT_MS = 1500;

export type DependencyState = 'up' | 'down';

export interface DependencyCheckSummary {
  status: DependencyState;
  latencyMs: number;
}

export interface GatewayReadinessSummary {
  ready: boolean;
  status: 'ready' | 'not_ready';
  checks: {
    customerDb: DependencyCheckSummary;
    merchantDb: DependencyCheckSummary;
    redis: DependencyCheckSummary;
  };
  timestamp: string;
}

export interface GatewayReadinessDeps {
  customerPool: Pick<StrictPgPool, 'query'> | null | undefined;
  merchantPool: Pick<StrictPgPool, 'query'> | null | undefined;
  redis: Partial<ManagedRedisClient> | null | undefined;
  timeoutMs?: number;
}

async function runBoundedCheck(
  label: string,
  fn: () => Promise<void>,
  timeoutMs: number
): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const checkPromise = (async () => {
    await fn();
  })();
  // Prevent delayed post-timeout rejections from surfacing as unhandledRejections
  checkPromise.catch(() => {});

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Readiness check for ${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([checkPromise, timeoutPromise]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    console.error(`[Readiness:${label}] Dependency check failed (${timedOut ? 'timeout' : 'error'}): ${sanitizeErrorForLog(err)}`);
    return { ok: false, latencyMs: Date.now() - startedAt };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Checks required backend dependencies (Customer PostgreSQL, Merchant PostgreSQL, shared Redis)
 * using only the existing injected/managed clients within a bounded timeout.
 * Never returns connection strings, credentials, or raw error messages.
 */
export async function checkGatewayReadiness(deps: GatewayReadinessDeps): Promise<GatewayReadinessSummary> {
  const timeoutMs =
    typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0
      ? deps.timeoutMs
      : DEFAULT_READINESS_TIMEOUT_MS;

  const [customerResult, merchantResult, redisResult] = await Promise.all([
    runBoundedCheck(
      'customerDb',
      async () => {
        if (!deps.customerPool) {
          throw new Error('Customer database pool is not initialized');
        }
        await deps.customerPool.query('SELECT 1');
      },
      timeoutMs
    ),
    runBoundedCheck(
      'merchantDb',
      async () => {
        if (!deps.merchantPool) {
          throw new Error('Merchant database pool is not initialized');
        }
        await deps.merchantPool.query('SELECT 1');
      },
      timeoutMs
    ),
    runBoundedCheck(
      'redis',
      async () => {
        const readyClient = await ensureRedisReady(deps.redis);
        if (typeof readyClient.ping !== 'function') {
          throw new Error('Redis client does not support PING');
        }
        const pong = await readyClient.ping();
        if (pong !== 'PONG') {
          throw new Error('Unexpected Redis PING response');
        }
      },
      timeoutMs
    )
  ]);

  const ready = customerResult.ok && merchantResult.ok && redisResult.ok;

  return {
    ready,
    status: ready ? 'ready' : 'not_ready',
    checks: {
      customerDb: {
        status: customerResult.ok ? 'up' : 'down',
        latencyMs: customerResult.latencyMs
      },
      merchantDb: {
        status: merchantResult.ok ? 'up' : 'down',
        latencyMs: merchantResult.latencyMs
      },
      redis: {
        status: redisResult.ok ? 'up' : 'down',
        latencyMs: redisResult.latencyMs
      }
    },
    timestamp: new Date().toISOString()
  };
}
