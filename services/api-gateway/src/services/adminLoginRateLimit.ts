import crypto from 'crypto';
import { Request } from 'express';
import {
  convertRedisCommandError,
  ensureRedisReady,
  ManagedRedisClient
} from '../db/redis';
import { InfrastructureUnavailableError } from '../utils/infraErrors';

// =========================================================================
// MO-B1: Admin Login Abuse Protection (Redis-backed, No External Deps)
//
// Security design:
//   - Primary key tracks failures by `(clientIp, emailDigest)` (`maxFailuresPerPair = 5`).
//     Throttles brute force from an attacker IP against a target email WITHOUT
//     locking out the legitimate Admin logging in from another IP (no trivial DoS).
//   - Secondary key tracks total failures by `clientIp` (`maxFailuresPerIp = 15`)
//     across all emails to throttle distributed account/password spraying from a source IP.
//   - Uses SHA-256 digests in Redis keys so raw emails/IPs are not stored in keys or logs.
//   - Fails closed (`InfrastructureUnavailableError` -> 503) if Redis is unreachable.
// =========================================================================

export const ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL = 5;
export const ADMIN_LOGIN_MAX_FAILURES_PER_IP = 15;
export const ADMIN_LOGIN_WINDOW_SECONDS = 900; // 15 minutes

export interface AdminLoginRateLimitOptions {
  maxFailuresPerPair?: number;
  maxFailuresPerIp?: number;
  windowSeconds?: number;
}

export interface AdminLoginRateLimitCheck {
  allowed: boolean;
  retryAfterSeconds: number;
}

const CHECK_ADMIN_LOGIN_RATE_LIMIT_LUA = `
local pairKey = KEYS[1]
local ipKey = KEYS[2]
local maxPair = tonumber(ARGV[1])
local maxIp = tonumber(ARGV[2])
local fallbackTtl = tonumber(ARGV[3])

local pairCount = tonumber(redis.call('GET', pairKey) or '0')
if pairCount >= maxPair then
  local ttl = redis.call('TTL', pairKey)
  if ttl < 1 then ttl = fallbackTtl end
  return {0, ttl}
end

local ipCount = tonumber(redis.call('GET', ipKey) or '0')
if ipCount >= maxIp then
  local ttl = redis.call('TTL', ipKey)
  if ttl < 1 then ttl = fallbackTtl end
  return {0, ttl}
end

return {1, 0}
`;

const RECORD_ADMIN_LOGIN_FAILURE_LUA = `
local pairKey = KEYS[1]
local ipKey = KEYS[2]
local windowSec = tonumber(ARGV[1])

local pairCount = redis.call('INCR', pairKey)
if pairCount == 1 or redis.call('TTL', pairKey) < 1 then
  redis.call('EXPIRE', pairKey, windowSec)
end

local ipCount = redis.call('INCR', ipKey)
if ipCount == 1 or redis.call('TTL', ipKey) < 1 then
  redis.call('EXPIRE', ipKey, windowSec)
end

return {pairCount, ipCount}
`;

function sha256Short(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Extracts normalized client IP relying strictly on Express socket/proxy resolution
 * (never trusting unconfigured raw `X-Forwarded-For` headers).
 */
export function extractAdminLoginClientIp(req: Pick<Request, 'ip' | 'socket'>): string {
  const raw = req.ip || req.socket?.remoteAddress || 'unknown';
  const normalized = String(raw).trim();
  if (normalized.startsWith('::ffff:')) {
    return normalized.slice('::ffff:'.length);
  }
  return normalized || 'unknown';
}

export function buildAdminLoginThrottleKeys(clientIp: string, email: string): {
  pairKey: string;
  ipKey: string;
} {
  const ipDigest = sha256Short(clientIp.trim().toLowerCase());
  const emailDigest = sha256Short(email.trim().toLowerCase());
  return {
    pairKey: `sv:admin:login:fail:pair:${ipDigest}:${emailDigest}`,
    ipKey: `sv:admin:login:fail:ip:${ipDigest}`
  };
}

/**
 * Checks whether `(clientIp, email)` or `clientIp` has exceeded failed login thresholds.
 * Throws `InfrastructureUnavailableError` (503) if Redis is unavailable or replies unexpectedly.
 */
export async function checkAdminLoginRateLimit(
  redisClient: Partial<ManagedRedisClient> | null | undefined,
  params: { clientIp: string; email: string },
  options: AdminLoginRateLimitOptions = {}
): Promise<AdminLoginRateLimitCheck> {
  const client = await ensureRedisReady(redisClient);
  const { pairKey, ipKey } = buildAdminLoginThrottleKeys(params.clientIp, params.email);
  const maxPair = options.maxFailuresPerPair ?? ADMIN_LOGIN_MAX_FAILURES_PER_IP_EMAIL;
  const maxIp = options.maxFailuresPerIp ?? ADMIN_LOGIN_MAX_FAILURES_PER_IP;
  const windowSec = options.windowSeconds ?? ADMIN_LOGIN_WINDOW_SECONDS;

  try {
    const reply = await client.eval(
      CHECK_ADMIN_LOGIN_RATE_LIMIT_LUA,
      2,
      pairKey,
      ipKey,
      String(maxPair),
      String(maxIp),
      String(windowSec)
    );

    if (!Array.isArray(reply) || reply.length < 2) {
      throw new InfrastructureUnavailableError(
        'REDIS',
        'Unexpected Redis rate-limit response.',
        'REDIS_UNAVAILABLE'
      );
    }

    const allowed = Number(reply[0]) === 1;
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Number(reply[1]) || windowSec);
    return { allowed, retryAfterSeconds };
  } catch (err: unknown) {
    throw convertRedisCommandError(err, 'checkAdminLoginRateLimit');
  }
}

/**
 * Atomically increments both `(clientIp, email)` and `clientIp` failure counters with TTL.
 */
export async function recordAdminLoginFailure(
  redisClient: Partial<ManagedRedisClient> | null | undefined,
  params: { clientIp: string; email: string },
  options: AdminLoginRateLimitOptions = {}
): Promise<void> {
  const client = await ensureRedisReady(redisClient);
  const { pairKey, ipKey } = buildAdminLoginThrottleKeys(params.clientIp, params.email);
  const windowSec = options.windowSeconds ?? ADMIN_LOGIN_WINDOW_SECONDS;

  try {
    await client.eval(RECORD_ADMIN_LOGIN_FAILURE_LUA, 2, pairKey, ipKey, String(windowSec));
  } catch (err: unknown) {
    throw convertRedisCommandError(err, 'recordAdminLoginFailure');
  }
}

/**
 * Clears `(clientIp, email)` and `clientIp` failed-attempt counters upon verified login.
 */
export async function clearAdminLoginFailures(
  redisClient: Partial<ManagedRedisClient> | null | undefined,
  params: { clientIp: string; email: string }
): Promise<void> {
  const client = await ensureRedisReady(redisClient);
  const { pairKey, ipKey } = buildAdminLoginThrottleKeys(params.clientIp, params.email);

  try {
    await client.del(pairKey, ipKey);
  } catch (err: unknown) {
    throw convertRedisCommandError(err, 'clearAdminLoginFailures');
  }
}
