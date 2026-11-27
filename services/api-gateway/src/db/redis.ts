import Redis, { RedisOptions } from 'ioredis';
import {
  InfrastructureUnavailableError,
  isRedisUnavailableError,
  sanitizeErrorForLog
} from '../utils/infraErrors';

export const REDIS_CONNECT_TIMEOUT_MS = 1000;
export const REDIS_COMMAND_TIMEOUT_MS = 2000;
export const REDIS_MAX_RETRIES_PER_REQUEST = 1;
export const REDIS_RECONNECT_BASE_DELAY_MS = 200;
export const REDIS_MAX_RECONNECT_DELAY_MS = 3000;

export interface ManagedRedisMulti {
  set: (...args: any[]) => ManagedRedisMulti;
  del: (...args: string[]) => ManagedRedisMulti;
  exec: () => Promise<Array<[Error | null, any]> | null>;
}

export interface ManagedRedisClient {
  status: string;
  connect: () => Promise<void>;
  ping: () => Promise<string>;
  set: (...args: any[]) => Promise<any>;
  ttl: (key: string) => Promise<number>;
  del: (...keys: string[]) => Promise<number>;
  eval: (script: string, numKeys: number, ...args: (string | number)[]) => Promise<any>;
  multi: () => ManagedRedisMulti;
  on: (event: string, listener: (...args: any[]) => void) => any;
  quit: () => Promise<any>;
  disconnect: (reconnect?: boolean) => void;
}

const inFlightConnects = new WeakMap<object, Promise<void>>();

/**
 * Computes bounded background reconnection delay in milliseconds.
 * Keeps trying in background after transient Redis outages so recovery does not
 * require restarting the API gateway process.
 */
export function computeRedisReconnectDelay(times: number): number {
  const attempt = Math.max(1, Math.floor(times));
  return Math.min(attempt * REDIS_RECONNECT_BASE_DELAY_MS, REDIS_MAX_RECONNECT_DELAY_MS);
}

/**
 * Creates a fail-fast managed ioredis client shared between gateway subsystems.
 *
 * Retry policy:
 * - Request commands use `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`,
 *   and `commandTimeout: 2000` so commands issued while Redis is unreachable reject
 *   immediately rather than buffering indefinitely in memory and executing later.
 * - Background socket reconnection uses `retryStrategy` capped at 3000ms so transient
 *   Redis restarts heal automatically without crashing or restarting the Node process.
 */
export function createManagedRedisClient(
  redisUrl: string,
  overrides: RedisOptions = {}
): ManagedRedisClient {
  if (typeof redisUrl !== 'string' || !redisUrl.trim()) {
    throw new Error('Configuration error: Missing Redis connection URL.');
  }

  const client = new Redis(redisUrl.trim(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: (times: number) => computeRedisReconnectDelay(times),
    ...overrides
  });

  client.on('error', (err: unknown) => {
    const code =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    console.error(`[Redis] Connection/runtime error (code=${code}): ${sanitizeErrorForLog(err)}`);
  });

  return client as unknown as ManagedRedisClient;
}

/**
 * Returns true strictly when the Redis client reports ready status.
 */
export function isRedisClientUsable(client: Partial<ManagedRedisClient> | null | undefined): boolean {
  return Boolean(client && client.status === 'ready');
}

/**
 * Ensures the Redis client is connected and ready for immediate command execution.
 * Fails closed with InfrastructureUnavailableError whenever Redis is absent,
 * reconnecting, closed, or fails initial handshake.
 */
export async function ensureRedisReady(
  client: Partial<ManagedRedisClient> | null | undefined
): Promise<ManagedRedisClient> {
  if (!client) {
    throw new InfrastructureUnavailableError(
      'REDIS',
      'Redis service is unavailable.',
      'REDIS_UNAVAILABLE'
    );
  }

  if (client.status === 'ready') {
    return client as ManagedRedisClient;
  }

  const existingConnect = inFlightConnects.get(client);
  if (
    existingConnect &&
    (client.status === 'wait' || client.status === 'connecting' || client.status === 'connect')
  ) {
    try {
      await existingConnect;
    } catch (err) {
      const code =
        err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'UNKNOWN';
      console.error(`[Redis] Shared initial connection failed (code=${code}): ${sanitizeErrorForLog(err)}`);
      throw new InfrastructureUnavailableError(
        'REDIS',
        'Redis service is temporarily unavailable.',
        'REDIS_UNAVAILABLE'
      );
    }

    if ((client.status as string) === 'ready') {
      return client as ManagedRedisClient;
    }
    throw new InfrastructureUnavailableError(
      'REDIS',
      'Redis service is temporarily unavailable.',
      'REDIS_UNAVAILABLE'
    );
  }

  if (client.status === 'wait') {
    if (typeof client.connect !== 'function') {
      throw new InfrastructureUnavailableError(
        'REDIS',
        'Redis client cannot establish a connection.',
        'REDIS_UNAVAILABLE'
      );
    }

    let connectPromise: Promise<void>;
    try {
      connectPromise = Promise.resolve(client.connect!());
    } catch (syncErr) {
      connectPromise = Promise.reject(syncErr);
    }

    let settled = false;
    const pending = connectPromise.finally(() => {
      settled = true;
      inFlightConnects.delete(client);
    });

    if (!settled) {
      inFlightConnects.set(client, pending);
    }

    try {
      await pending;
    } catch (err) {
      const code =
        err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'UNKNOWN';
      console.error(`[Redis] Initial connection failed (code=${code}): ${sanitizeErrorForLog(err)}`);
      throw new InfrastructureUnavailableError(
        'REDIS',
        'Redis service is temporarily unavailable.',
        'REDIS_UNAVAILABLE'
      );
    }

    if ((client.status as string) === 'ready') {
      return client as ManagedRedisClient;
    }
  }

  throw new InfrastructureUnavailableError(
    'REDIS',
    'Redis service is temporarily unavailable.',
    'REDIS_UNAVAILABLE'
  );
}

/**
 * Converts low-level ioredis failures into InfrastructureUnavailableError when
 * connectivity/readiness/timeout exhaustion caused the error.
 */
export function convertRedisCommandError(err: unknown, context: string): Error {
  if (err instanceof InfrastructureUnavailableError) {
    return err;
  }
  if (isRedisUnavailableError(err)) {
    const code =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    console.error(`[Redis] Command failed during ${context} (code=${code}): ${sanitizeErrorForLog(err)}`);
    return new InfrastructureUnavailableError(
      'REDIS',
      'Redis service is temporarily unavailable.',
      'REDIS_UNAVAILABLE'
    );
  }
  return err instanceof Error ? err : new Error(sanitizeErrorForLog(err));
}

/**
 * Closes an application-owned Redis client cleanly and safely without closing injected clients.
 */
export async function closeManagedRedisClient(
  client: Partial<ManagedRedisClient> | null | undefined,
  owned: boolean
): Promise<string | null> {
  if (!owned || !client) {
    return null;
  }

  if (client.status === 'end') {
    return null;
  }

  // Never dial a new connection just to quit an unused/disconnected client
  if (client.status === 'wait' || client.status === 'reconnecting' || client.status === 'close') {
    try {
      client.disconnect?.(false);
    } catch (err) {
      const safeLog = `[Redis] Shutdown disconnect failed: ${sanitizeErrorForLog(err)}`;
      console.error(safeLog);
      return safeLog;
    }
    return null;
  }

  try {
    if (typeof client.quit === 'function') {
      await client.quit();
    } else {
      client.disconnect?.(false);
    }
    return null;
  } catch (err) {
    const code =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    const safeLog = `[Redis] Shutdown quit() failed (code=${code}): ${sanitizeErrorForLog(err)}`;
    console.error(safeLog);
    try {
      client.disconnect?.(false);
    } catch {
      // Ignore secondary disconnect error
    }
    return safeLog;
  }
}

export type RedisPubSubRole = 'pub' | 'sub';

/**
 * Creates a dedicated Redis connection for Socket.IO Pub/Sub fan-out, completely separate
 * from the strict OTP/cooldown Redis command client (`enableOfflineQueue: false`).
 *
 * - Publisher (`pub`): keeps `enableOfflineQueue: false` and bounded `commandTimeout` so
 *   publish attempts fail fast when disconnected without unbounded offline buffering.
 * - Subscriber (`sub`): uses `autoResubscribe: true`, `maxRetriesPerRequest: null`, and no
 *   short `commandTimeout` (blocked pub/sub listeners stay open indefinitely while connected)
 *   so background `retryStrategy` recovery automatically restores subscriptions.
 */
export function createRedisPubSubClient(
  redisUrl: string,
  role: RedisPubSubRole,
  overrides: RedisOptions = {}
): ManagedRedisClient {
  if (typeof redisUrl !== 'string' || !redisUrl.trim()) {
    throw new Error(`Configuration error: Missing Redis connection URL for Pub/Sub "${role}" client.`);
  }

  const options: RedisOptions = {
    lazyConnect: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    autoResubscribe: true,
    retryStrategy: (times: number) => computeRedisReconnectDelay(times),
    ...(role === 'pub'
      ? {
          enableOfflineQueue: false,
          maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
          commandTimeout: REDIS_COMMAND_TIMEOUT_MS
        }
      : {
          enableOfflineQueue: true,
          maxRetriesPerRequest: null
        }),
    ...overrides
  };

  const client = new Redis(redisUrl.trim(), options);

  client.on('error', (err: unknown) => {
    const code =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    console.error(`[Redis:pubsub-${role}] Connection/runtime error (code=${code}): ${sanitizeErrorForLog(err)}`);
  });

  return client as unknown as ManagedRedisClient;
}
