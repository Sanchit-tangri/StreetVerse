/**
 * StreetVerse S1.3-B Automated Unit Tests: Strict Redis Infrastructure & Fail-Closed OTP Reliability
 * Deterministic unit and HTTP route verification using explicit injected Redis/SMTP mocks.
 * Zero sleeps, zero implicit memory fallbacks, and zero live container dependencies.
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import http from 'http';
import { AddressInfo } from 'net';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { createGatewayApp, registerShutdownSignals } from '../../services/api-gateway/src/app';
import {
  closeManagedRedisClient,
  computeRedisReconnectDelay,
  createManagedRedisClient,
  ensureRedisReady,
  isRedisClientUsable,
  ManagedRedisClient,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_MAX_RECONNECT_DELAY_MS,
  REDIS_MAX_RETRIES_PER_REQUEST
} from '../../services/api-gateway/src/db/redis';
import { StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { createEmailService, generateOtp } from '../../services/api-gateway/src/services/email';
import { InfrastructureUnavailableError } from '../../services/api-gateway/src/utils/infraErrors';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeTestConfig(): GatewayConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    allowedOrigins: ['https://buyer.example.test'],
    jwtSecret: crypto.randomBytes(36).toString('base64url'),
    jwtIssuer: 'streetverse-api-test',
    jwtBuyerAudience: 'streetverse-buyer-test',
    jwtSellerAudience: 'streetverse-seller-test',
    jwtExpiresIn: '7d',
    redisUrl: 'redis://default:UnitTestRedisSecret@127.0.0.1:16399',
    customerDbUrl: 'postgresql://postgres:UnitTestPgSecret@127.0.0.1:15991/test_cust',
    merchantDbUrl: 'postgresql://postgres:UnitTestPgSecret@127.0.0.1:15992/test_merch',
    aiEngineUrl: 'http://127.0.0.1:8000'
  };
}

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() }
            : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createNoopPool(): StrictPgPool {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    on: () => {},
    end: async () => {}
  };
}

interface DeterministicRedisOptions {
  initialStatus?: string;
  failConnectWith?: Error;
  failSetWith?: Error;
  failEvalWith?: Error;
  failDelWith?: Error;
  failStoreOtpOn?: 'owner' | 'otp' | 'attempts';
  failStoreOtpWith?: string;
  failStoreOtpResult?: [number, string, string, number?];
  abortStoreOtpScript?: boolean;
  failQuitWith?: Error;
}

function createDeterministicMockRedis(opts: DeterministicRedisOptions = {}) {
  const kv = new Map<string, { val: string; expiresAt: number }>();
  let nowMs = 1_700_000_000_000;
  let quitCalls = 0;
  let disconnectCalls = 0;
  let delCalls = 0;

  const purge = (k: string) => {
    const rec = kv.get(k);
    if (rec && rec.expiresAt <= nowMs) kv.delete(k);
  };

  const applySet = (k: string, val: string, _ex?: string, ttlSec?: number, nx?: string) => {
    purge(k);
    if (nx === 'NX' && kv.has(k)) return null;
    kv.set(k, { val, expiresAt: nowMs + (ttlSec || 300) * 1000 });
    return 'OK';
  };

  const applyDel = (...keys: string[]) => keys.reduce((n, k) => n + (kv.delete(k) ? 1 : 0), 0);

  const client: ManagedRedisClient & {
    advanceMs: (deltaMs: number) => void;
    clearAllKeys: () => void;
    hasKey: (key: string) => boolean;
    getKey: (key: string) => string | undefined;
    getQuitCount: () => number;
    getDisconnectCount: () => number;
    getDelCount: () => number;
  } = {
    status: opts.initialStatus ?? 'ready',
    advanceMs: (deltaMs: number) => {
      nowMs += deltaMs;
    },
    clearAllKeys: () => kv.clear(),
    hasKey: (key: string) => {
      purge(key);
      return kv.has(key);
    },
    getKey: (key: string) => {
      purge(key);
      return kv.get(key)?.val;
    },
    getQuitCount: () => quitCalls,
    getDisconnectCount: () => disconnectCalls,
    getDelCount: () => delCalls,
    on: () => client,
    connect: async () => {
      if (opts.failConnectWith) {
        client.status = 'reconnecting';
        throw opts.failConnectWith;
      }
      client.status = 'ready';
    },
    ping: async () => {
      if (client.status !== 'ready') throw new Error('Connection is closed.');
      return 'PONG';
    },
    quit: async () => {
      quitCalls++;
      if (opts.failQuitWith) throw opts.failQuitWith;
      client.status = 'end';
      return 'OK';
    },
    disconnect: () => {
      disconnectCalls++;
      client.status = 'end';
    },
    set: async (...args: any[]) => {
      if (opts.failSetWith) throw opts.failSetWith;
      if (client.status !== 'ready') throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
      return applySet(args[0], args[1], args[2], args[3], args[4]);
    },
    ttl: async (k: string) => {
      purge(k);
      const rec = kv.get(k);
      return rec ? Math.max(1, Math.ceil((rec.expiresAt - nowMs) / 1000)) : -2;
    },
    del: async (...keys: string[]) => {
      delCalls++;
      if (opts.failDelWith) throw opts.failDelWith;
      if (client.status !== 'ready') throw new Error('Connection is closed.');
      return applyDel(...keys);
    },
    multi: () => {
      const queued: Array<() => any> = [];
      const chain: any = {
        set: (...args: any[]) => {
          queued.push(() => applySet(args[0], args[1], args[2], args[3], args[4]));
          return chain;
        },
        del: (...keys: string[]) => {
          queued.push(() => applyDel(...keys));
          return chain;
        },
        exec: async () => {
          if (client.status !== 'ready') throw new Error('Connection is closed.');
          return queued.map((op) => [null, op()] as [Error | null, any]);
        }
      };
      return chain;
    },
    eval: async (
      script: string,
      numKeys: number,
      key1: string,
      arg1OrKey2: string,
      candidateOrKey3?: string,
      maxOrToken?: string,
      maybeOtp?: string,
      maybeTtlSec?: string
    ) => {
      if (opts.failEvalWith) throw opts.failEvalWith;
      if (client.status !== 'ready') throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
      if (numKeys === 1) {
        purge(key1);
        const rec = kv.get(key1);
        if (rec && rec.val === arg1OrKey2) {
          kv.delete(key1);
          return 1;
        }
        return 0;
      }
      if (numKeys === 3) {
        if (/OWNER_WRITE_FAILED/.test(script)) {
          if (opts.abortStoreOtpScript) return null;
          if (opts.failStoreOtpResult) return opts.failStoreOtpResult;

          const ownerKey = key1;
          const otpKey = arg1OrKey2;
          const attemptsKey = candidateOrKey3!;
          const opToken = maxOrToken!;
          const otp = maybeOtp!;
          const ttlSec = Number(maybeTtlSec || 300);

          const cleanupOwned = () => {
            purge(ownerKey);
            if (kv.get(ownerKey)?.val === opToken) {
              kv.delete(otpKey);
              kv.delete(attemptsKey);
              kv.delete(ownerKey);
            }
          };

          if (opts.failStoreOtpOn === 'owner') {
            return [0, 'OWNER_WRITE_FAILED', opts.failStoreOtpWith || 'READONLY cannot write owner key', 1];
          }
          applySet(ownerKey, opToken, 'EX', ttlSec);

          if (opts.failStoreOtpOn === 'otp') {
            cleanupOwned();
            return [0, 'OTP_WRITE_FAILED', opts.failStoreOtpWith || 'READONLY cannot write otp key', 1];
          }
          applySet(otpKey, otp, 'EX', ttlSec);

          if (opts.failStoreOtpOn === 'attempts') {
            cleanupOwned();
            return [0, 'ATTEMPTS_WRITE_FAILED', opts.failStoreOtpWith || 'OOM command not allowed', 1];
          }
          applySet(attemptsKey, '0', 'EX', ttlSec);
          return [1, 'OK', '', 1];
        }

        const otpKey = key1;
        const attemptsKey = arg1OrKey2;
        const ownerKey = candidateOrKey3!;
        const expectedToken = maxOrToken!;
        purge(ownerKey);
        if (kv.get(ownerKey)?.val === expectedToken) {
          let n = 0;
          if (kv.delete(otpKey)) n++;
          if (kv.delete(attemptsKey)) n++;
          if (kv.delete(ownerKey)) n++;
          return n;
        }
        return 0;
      }

      const otpKey = key1;
      const attemptsKey = arg1OrKey2;
      const candidate = candidateOrKey3!;
      const maxStr = maxOrToken!;
      purge(otpKey);
      purge(attemptsKey);
      const stored = kv.get(otpKey)?.val;
      if (!stored) return [0, 'EXPIRED', 0];

      const maxAttempts = Number(maxStr);
      const attempts = Number(kv.get(attemptsKey)?.val || '0');
      if (attempts >= maxAttempts) {
        kv.delete(otpKey);
        kv.delete(attemptsKey);
        return [0, 'LOCKED', 0];
      }

      if (stored !== candidate) {
        const nextAttempts = attempts + 1;
        const otpExp = kv.get(otpKey)!.expiresAt;
        kv.set(attemptsKey, { val: String(nextAttempts), expiresAt: otpExp });
        if (nextAttempts >= maxAttempts) {
          kv.delete(otpKey);
          kv.delete(attemptsKey);
          return [0, 'LOCKED', 0];
        }
        return [0, 'MISMATCH', maxAttempts - nextAttempts];
      }

      kv.delete(otpKey);
      kv.delete(attemptsKey);
      return [1, 'OK', 0];
    }
  };

  return client;
}

async function assertThrowsInfraUnavailable(fn: () => Promise<unknown>, label: string): Promise<InfrastructureUnavailableError> {
  try {
    await fn();
  } catch (err) {
    assert(
      err instanceof InfrastructureUnavailableError && err.dependency === 'REDIS' && err.statusCode === 503,
      `${label}: expected InfrastructureUnavailableError(REDIS, 503), got ${String(err)}`
    );
    return err;
  }
  throw new Error(`${label}: expected operation to fail closed with InfrastructureUnavailableError`);
}

export async function runS13RedisOtpUnitTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const runCase = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err: any) {
      results.push({ name, passed: false, error: err?.message || String(err) });
    }
  };

  // -------------------------------------------------------------------------
  // 1-3, 6, 15: FAIL-CLOSED OTP STORAGE, VERIFICATION, COOLDOWN & MULTI/EXEC
  // -------------------------------------------------------------------------
  await runCase('OTP creation, verification & cooldown fail closed when Redis is null, reconnecting, or closed', async () => {
    const nullSvc = createEmailService({ redisClient: null, nodeEnv: 'production' });
    await assertThrowsInfraUnavailable(() => nullSvc.storeOtp('buyer', 'a@example.test', '123456'), 'null storeOtp');
    await assertThrowsInfraUnavailable(() => nullSvc.verifyOtp('buyer', 'a@example.test', '123456'), 'null verifyOtp');
    await assertThrowsInfraUnavailable(() => nullSvc.acquireResendCooldown('buyer-login', 'u1'), 'null cooldown acquire');
    await assertThrowsInfraUnavailable(() => nullSvc.clearResendCooldown('buyer-login', 'u1', 'tok-1'), 'null cooldown clear');

    const reconnectingClient = createDeterministicMockRedis({ initialStatus: 'reconnecting' });
    const reconnectingSvc = createEmailService({ redisClient: reconnectingClient, nodeEnv: 'development' });
    await assertThrowsInfraUnavailable(() => reconnectingSvc.storeOtp('buyer', 'a@example.test', '123456'), 'reconnecting storeOtp');
    await assertThrowsInfraUnavailable(() => reconnectingSvc.verifyOtp('buyer', 'a@example.test', '123456'), 'reconnecting verifyOtp');
    await assertThrowsInfraUnavailable(() => reconnectingSvc.acquireResendCooldown('buyer-login', 'u1'), 'reconnecting cooldown');

    const failedConnectClient = createDeterministicMockRedis({
      initialStatus: 'wait',
      failConnectWith: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6380'), { code: 'ECONNREFUSED' })
    });
    const origError = console.error;
    console.error = () => {};
    try {
      await assertThrowsInfraUnavailable(() => ensureRedisReady(failedConnectClient), 'wait failed connect');
    } finally {
      console.error = origError;
    }

    const commandTimeoutClient = createDeterministicMockRedis({
      failEvalWith: new Error('Command timed out')
    });
    const timeoutSvc = createEmailService({ redisClient: commandTimeoutClient, nodeEnv: 'staging' });
    await assertThrowsInfraUnavailable(() => timeoutSvc.verifyOtp('buyer', 'a@example.test', '123456'), 'command timeout verifyOtp');
  });

  await runCase('STORE_OTP_LUA errors and malformed script replies fail closed without ghost memory fallback', async () => {
    const cmdErrRedis = createDeterministicMockRedis({
      failStoreOtpOn: 'otp',
      failStoreOtpWith: "READONLY You can't write against a read only replica."
    });
    let emailsSent = 0;
    const svc1 = createEmailService({
      redisClient: cmdErrRedis,
      nodeEnv: 'test',
      transporter: {
        sendMail: async () => {
          emailsSent++;
          return {};
        }
      }
    });

    await assertThrowsInfraUnavailable(() => svc1.storeOtp('buyer', 'txerr@example.test', '654321'), 'STORE_OTP_LUA write error');
    assert(!cmdErrRedis.hasKey('otp_owner:buyer:txerr@example.test'), 'Owner key must be rolled back on OTP write error');
    assert(!cmdErrRedis.hasKey('otp:buyer:txerr@example.test'), 'OTP key must remain absent on OTP write error');
    assert(!cmdErrRedis.hasKey('otp_attempts:buyer:txerr@example.test'), 'Attempts key must remain absent on OTP write error');

    const abortedRedis = createDeterministicMockRedis({ abortStoreOtpScript: true });
    const svc2 = createEmailService({
      redisClient: abortedRedis,
      nodeEnv: 'test',
      transporter: {
        sendMail: async () => {
          emailsSent++;
          return {};
        }
      }
    });
    await assertThrowsInfraUnavailable(() => svc2.storeOtp('buyer', 'txabort@example.test', '654321'), 'malformed STORE_OTP_LUA reply');

    // Outage followed by clean recovery NEVER resurrects an in-memory OTP
    cmdErrRedis.status = 'reconnecting';
    await assertThrowsInfraUnavailable(() => svc1.storeOtp('buyer', 'ghost@example.test', '111222'), 'store during outage');
    cmdErrRedis.status = 'ready';
    cmdErrRedis.clearAllKeys();
    const afterRecovery = await svc1.verifyOtp('buyer', 'ghost@example.test', '111222');
    assert(!afterRecovery.valid, 'Recovery with empty Redis must not match any phantom in-memory OTP');
    assert(emailsSent === 0, 'SMTP transporter must never run when storage fails');
  });

  // -------------------------------------------------------------------------
  // 4-5: HTTP ROUTES RETURN 503 AND NEVER SEND SMTP ON REDIS/COOLDOWN OUTAGE
  // -------------------------------------------------------------------------
  await runCase('HTTP routes return safe 503 and never dispatch SMTP when OTP storage or cooldown fails', async () => {
    const cfg = makeTestConfig();
    const pwHash = await bcrypt.hash('Password123!', 10);

    const custPool: StrictPgPool = {
      query: async (sql: string) => {
        if (/SELECT id, phone, email FROM users/i.test(sql)) return { rows: [], rowCount: 0 };
        if (/INSERT INTO users/i.test(sql)) {
          return { rows: [{ id: 'u-1', phone: '+919890123456', full_name: 'Buyer', email: 'b@example.test', home_address: '' }], rowCount: 1 };
        }
        if (/SELECT id, phone, full_name, email, password_hash/i.test(sql)) {
          return { rows: [{ id: 'u-1', phone: '+919890123456', full_name: 'Buyer', email: 'b@example.test', password_hash: pwHash, is_verified: true }], rowCount: 1 };
        }
        if (/SELECT id, email FROM users WHERE id = \$1/i.test(sql)) {
          return { rows: [{ id: 'u-1', email: 'b@example.test' }], rowCount: 1 };
        }
        if (/SELECT id FROM users WHERE LOWER\(email\)/i.test(sql)) {
          return { rows: /AND id <>/i.test(sql) ? [] : [{ id: 'u-1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
      on: () => {},
      end: async () => {}
    };

    const merchQuery = async (sql: string) => {
      if (/SELECT id, phone, email FROM seller_accounts/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id, owner_phone, owner_email FROM merchants/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO seller_accounts/i.test(sql)) {
        return {
          rows: [{ id: 'sa-1', phone: '+919876543210', email: 's@example.test', is_email_verified: false, status: 'ACTIVE' }],
          rowCount: 1
        };
      }
      if (/INSERT INTO merchants/i.test(sql)) {
        return { rows: [{ id: 'm-1', business_name: 'Shop', category: 'GROCERY', owner_phone: '+919876543210', owner_email: 's@example.test', upi_vpa: 's@okaxis', address: 'Pune' }], rowCount: 1 };
      }
      if (/INSERT INTO store_memberships/i.test(sql)) {
        return { rows: [{ id: 'sm-1' }], rowCount: 1 };
      }
      if (/FROM seller_accounts/i.test(sql)) {
        return {
          rows: [{ id: 'sa-1', phone: '+919876543210', email: 's@example.test', password_hash: pwHash, is_email_verified: true, status: 'ACTIVE' }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    };
    const merchPool: StrictPgPool = {
      query: merchQuery,
      connect: async () => ({ query: merchQuery, release: () => {} }),
      on: () => {},
      end: async () => {}
    };

    let smtpSendCount = 0;
    // A: Disconnect Redis completely -> BOTH cooldown check and storeOtp fail closed
    const downRedis = createDeterministicMockRedis({ initialStatus: 'reconnecting' });
    const appA = createGatewayApp(cfg, {
      customerPool: custPool,
      merchantPool: merchPool,
      redis: downRedis,
      emailTransporter: {
        sendMail: async () => {
          smtpSendCount++;
          return {};
        }
      }
    });

    // B: Redis cooldown SET NX succeeds, but STORE_OTP_LUA storeOtp fails -> clears cooldown & never calls SMTP
    const storeFailRedis = createDeterministicMockRedis({
      failStoreOtpOn: 'owner',
      failStoreOtpWith: 'READONLY'
    });
    const appB = createGatewayApp(cfg, {
      customerPool: custPool,
      merchantPool: merchPool,
      redis: storeFailRedis,
      emailTransporter: {
        sendMail: async () => {
          smtpSendCount++;
          return {};
        }
      }
    });

    await new Promise<void>((resolve) => appA.server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => appB.server.listen(0, '127.0.0.1', resolve));
    const portA = (appA.server.address() as AddressInfo).port;
    const portB = (appB.server.address() as AddressInfo).port;

    const buyerJwt = jwt.sign(
      { sub: 'u-1', role: 'BUYER', email: 'b@example.test' },
      cfg.jwtSecret,
      { issuer: cfg.jwtIssuer, audience: cfg.jwtBuyerAudience, expiresIn: '1h' }
    );

    try {
      const checks = [
        // Outage during cooldown & store paths
        { port: portA, path: '/api/v1/auth/buyer/register', body: { phone: '9890123456', full_name: 'Buyer', email: 'b@example.test', password: 'Password123!' } },
        { port: portA, path: '/api/v1/auth/buyer/login', body: { identifier: 'b@example.test', password: 'Password123!' } },
        { port: portA, path: '/api/v1/auth/buyer/verify-otp', body: { email: 'b@example.test', otp: '123456' } },
        { port: portA, path: '/api/v1/auth/seller/register', body: { business_name: 'Shop', category: 'GROCERY', owner_phone: '9876543210', owner_email: 's@example.test', password: 'Password123!', upi_vpa: 's@okaxis', address: 'Pune', pincode: '411038' } },
        { port: portA, path: '/api/v1/auth/seller/login', body: { identifier: 's@example.test', password: 'Password123!' } },
        { port: portA, path: '/api/v1/auth/resend-otp', body: { scope: 'buyer', email: 'b@example.test' } },
        { port: portA, path: '/api/user/request-email-change', headers: { Authorization: `Bearer ${buyerJwt}` }, body: { newEmail: 'newb@example.test' } },
        { port: portA, path: '/api/user/verify-email-change', headers: { Authorization: `Bearer ${buyerJwt}` }, body: { newEmail: 'newb@example.test', otp: '123456' } },
        // Cooldown succeeded, MULTI/EXEC failed paths
        { port: portB, path: '/api/v1/auth/buyer/login', body: { identifier: 'b@example.test', password: 'Password123!' } },
        { port: portB, path: '/api/v1/auth/seller/login', body: { identifier: 's@example.test', password: 'Password123!' } },
        { port: portB, path: '/api/v1/auth/resend-otp', body: { scope: 'buyer', email: 'b@example.test' } },
        { port: portB, path: '/api/user/request-email-change', headers: { Authorization: `Bearer ${buyerJwt}` }, body: { newEmail: 'newb@example.test' } }
      ];

      for (const reqSpec of checks) {
        const res = await httpRequest({
          port: reqSpec.port,
          method: 'POST',
          path: reqSpec.path,
          headers: reqSpec.headers,
          body: reqSpec.body
        });
        assert(res.statusCode === 503, `Expected 503 on ${reqSpec.path}, got ${res.statusCode}: ${res.body}`);
        assert(!res.body.includes('UnitTestRedisSecret') && !res.body.includes('16399'), `Response leaked Redis config: ${res.body}`);
      }

      assert(smtpSendCount === 0, `SMTP sendMail must NEVER be invoked when Redis fails (called ${smtpSendCount} times)`);
      // Verify cooldown keys rolled back cleanly after STORE_OTP_LUA failure on portB
      assert((await storeFailRedis.ttl('otp_cooldown:buyer-login:u-1')) === -2, 'Buyer login cooldown must roll back when storeOtp fails');
      assert((await storeFailRedis.ttl('otp_cooldown:email-change:u-1')) === -2, 'Email-change cooldown must roll back when storeOtp fails');
    } finally {
      await new Promise<void>((resolve) => appA.io.close(() => resolve()));
      await new Promise<void>((resolve) => appB.io.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------
  // 7-11: DETERMINISTIC EXPIRY, SINGLE-USE, CONCURRENCY, LOCKOUT, COOLDOWN
  // -------------------------------------------------------------------------
  await runCase('Deterministic OTP lifecycle: expiry, single-use, concurrency, 3-strike lockout & 45s cooldown', async () => {
    const mockRedis = createDeterministicMockRedis();
    const emailSvc = createEmailService({ redisClient: mockRedis, nodeEnv: 'test' });

    const otp = generateOtp();
    assert(/^\d{6}$/.test(otp), 'OTP must be 6 digits');

    // Expiry check using deterministic clock (zero sleep)
    await emailSvc.storeOtp('buyer', 'exp@example.test', otp);
    mockRedis.advanceMs(301_000);
    const expired = await emailSvc.verifyOtp('buyer', 'exp@example.test', otp);
    assert(!expired.valid && expired.reason?.includes('expired'), 'Expired OTP must fail');

    // Concurrent single-use
    await emailSvc.storeOtp('buyer', 'once@example.test', '555666');
    const race = await Promise.all([
      emailSvc.verifyOtp('buyer', 'once@example.test', '555666'),
      emailSvc.verifyOtp('buyer', 'once@example.test', '555666'),
      emailSvc.verifyOtp('buyer', 'once@example.test', '555666')
    ]);
    assert(race.filter((r) => r.valid).length === 1, 'Exactly one concurrent verify may succeed');

    // 3-strike immediate lockout
    await emailSvc.storeOtp('buyer', 'brute@example.test', '999888');
    assert(!(await emailSvc.verifyOtp('buyer', 'brute@example.test', '000001')).valid, 'Strike 1 fail');
    assert(!(await emailSvc.verifyOtp('buyer', 'brute@example.test', '000002')).valid, 'Strike 2 fail');
    const s3 = await emailSvc.verifyOtp('buyer', 'brute@example.test', '000003');
    assert(!s3.valid && s3.reason?.toLowerCase().includes('too many'), 'Strike 3 must lock out');
    assert(!(await emailSvc.verifyOtp('buyer', 'brute@example.test', '999888')).valid, 'Locked OTP stays invalidated');

    // Deterministic 45s cooldown + expire recovery
    const cd1 = await emailSvc.acquireResendCooldown('email-change', 'u-cd');
    assert(cd1.allowed, 'First cooldown allowed');
    const cd2 = await emailSvc.acquireResendCooldown('email-change', 'u-cd');
    assert(!cd2.allowed && (cd2.retryAfterSeconds || 0) === 45, 'Immediate repeat blocked with 45s');
    mockRedis.advanceMs(46_000);
    const cd3 = await emailSvc.acquireResendCooldown('email-change', 'u-cd');
    assert(cd3.allowed, 'Cooldown after 45s passes cleanly');
  });

  // -------------------------------------------------------------------------
  // 12: TWO GATEWAY INSTANCES DO NOT OVERWRITE EACH OTHER
  // -------------------------------------------------------------------------
  await runCase('Multi-instance isolation: creating App 2 does not mutate App 1 Redis or email dependencies', async () => {
    const cfg = makeTestConfig();
    const redis1 = createDeterministicMockRedis();
    const redis2 = createDeterministicMockRedis();
    let app1Emails = 0;
    let app2Emails = 0;
    let lastOtp1 = '';

    const pool1 = createNoopPool();
    const pool2 = createNoopPool();

    const app1 = createGatewayApp(cfg, {
      customerPool: pool1,
      merchantPool: pool1,
      redis: redis1,
      emailTransporter: {
        sendMail: async (m: any) => {
          app1Emails++;
          const match = String(m.text || '').match(/(\d{6})/);
          if (match) lastOtp1 = match[1];
          return {};
        }
      }
    });

    const app2 = createGatewayApp(cfg, {
      customerPool: pool2,
      merchantPool: pool2,
      redis: redis2,
      emailTransporter: {
        sendMail: async () => {
          app2Emails++;
          throw new Error('App 2 transporter down');
        }
      }
    });

    // App 1 stores OTP into redis1 and dispatches via transporter1 even after App 2 mounted failing transporter
    await app1.emailService.storeOtp('buyer', 'isolated@example.test', '774411');
    const sent1 = await app1.emailService.sendOtpEmail('isolated@example.test', '774411', 'App1');
    assert(sent1.sent && app1Emails === 1 && lastOtp1 === '774411', 'App 1 transporter must stay isolated from App 2');

    // App 2 cannot verify App 1's key because redis2 is isolated from redis1
    const verifyOnApp2 = await app2.emailService.verifyOtp('buyer', 'isolated@example.test', '774411');
    assert(!verifyOnApp2.valid, 'App 2 must read its own redis2 store, not App 1 redis1');

    // App 1 verifies successfully against redis1, while App 2 uses failing transporter2
    const verifyOnApp1 = await app1.emailService.verifyOtp('buyer', 'isolated@example.test', '774411');
    assert(verifyOnApp1.valid, 'App 1 must remain intact');

    const sent2 = await app2.emailService.sendOtpEmail('isolated@example.test', '112233', 'App2');
    assert(!sent2.sent && app2Emails === 1 && app1Emails === 1, 'App 2 dispatch must remain isolated');

    await app1.shutdown();
    await app2.shutdown();
  });

  // -------------------------------------------------------------------------
  // 13-14: REDIS OWNERSHIP, SHUTDOWN, CLIENT CONFIG & ERROR LOG SANITIZATION
  // -------------------------------------------------------------------------
  await runCase('Shutdown closes owned Redis client safely once and leaves injected Redis untouched', async () => {
    const cfg = makeTestConfig();

    // Owned client (`!deps.redis`) closed on shutdown
    const ownedApp = createGatewayApp(cfg, {
      customerPool: createNoopPool(),
      merchantPool: createNoopPool()
    });
    assert(ownedApp.redis.status === 'wait', 'Owned lazy client starts in wait state');
    const shutdownRes1 = await ownedApp.shutdown();
    const shutdownRes2 = await ownedApp.shutdown();
    assert(ownedApp.redis.status === 'end', 'Owned Redis must transition to end on shutdown');
    assert(shutdownRes1.redisErrors.length === 0 && shutdownRes2.redisErrors.length === 0, 'Idempotent shutdown must succeed');

    // Owned ready client calls quit() & logs sanitized error on quit() failure
    const secretUrl = 'redis://default:OwnedRedisSecret88@cache.internal:6380';
    const readyOwnedMock = createDeterministicMockRedis({
      initialStatus: 'ready',
      failQuitWith: new Error(`quit failed on ${secretUrl}`)
    });
    const origConsoleError = console.error;
    const logs: string[] = [];
    console.error = (...args: any[]) => logs.push(args.map(String).join(' '));
    try {
      const errLog = await closeManagedRedisClient(readyOwnedMock, true);
      assert(errLog !== null && !errLog.includes('OwnedRedisSecret88'), 'Redis shutdown error must redact credentials');
      assert(readyOwnedMock.getQuitCount() === 1 && readyOwnedMock.getDisconnectCount() === 1, 'Failed quit must fall back to disconnect');
      assert(logs.every((l) => !l.includes('OwnedRedisSecret88')), 'Console error must redact Redis URI credentials');
    } finally {
      console.error = origConsoleError;
    }

    // Injected Redis (`deps.redis`) must NEVER be closed by gateway shutdown
    const injectedRedis = createDeterministicMockRedis({ initialStatus: 'ready' });
    const injectedApp = createGatewayApp(cfg, {
      customerPool: createNoopPool(),
      merchantPool: createNoopPool(),
      redis: injectedRedis
    });
    await injectedApp.shutdown();
    assert(injectedRedis.getQuitCount() === 0 && injectedRedis.getDisconnectCount() === 0, 'Injected Redis client must NOT be closed');
    assert(injectedRedis.status === 'ready', 'Injected Redis status must remain untouched');
  });

  await runCase('Managed Redis config: fail-fast offlineQueue disabled, bounded backoff & sanitized error logging', async () => {
    assert(computeRedisReconnectDelay(1) === 200, 'Attempt 1 reconnect delay mismatch');
    assert(computeRedisReconnectDelay(10) === 2000, 'Attempt 10 reconnect delay mismatch');
    assert(computeRedisReconnectDelay(50) === REDIS_MAX_RECONNECT_DELAY_MS, 'Reconnect delay must cap at 3000ms');

    const secretPass = 'TopSecretManagedRedisPass';
    const managed = createManagedRedisClient(`redis://default:${secretPass}@127.0.0.1:16398`);
    const opts = (managed as any).options;

    assert(opts.lazyConnect === true, 'Managed client must use lazyConnect');
    assert(opts.enableOfflineQueue === false, 'Managed client must disable offline queue');
    assert(opts.maxRetriesPerRequest === REDIS_MAX_RETRIES_PER_REQUEST, 'Bounded maxRetriesPerRequest mismatch');
    assert(opts.connectTimeout === REDIS_CONNECT_TIMEOUT_MS, 'connectTimeout mismatch');
    assert(opts.commandTimeout === REDIS_COMMAND_TIMEOUT_MS, 'commandTimeout mismatch');
    assert(!isRedisClientUsable(managed), 'Unconnected wait client must not report usable');

    const origErr = console.error;
    const errLogs: string[] = [];
    console.error = (...args: any[]) => errLogs.push(args.map(String).join(' '));
    try {
      managed.on('error', () => {});
      (managed as any).emit('error', new Error(`ECONNREFUSED redis://default:${secretPass}@127.0.0.1:16398`));
      assert(errLogs.length >= 1 && errLogs.every((l) => !l.includes(secretPass)), 'Runtime Redis error log must redact credentials');
    } finally {
      console.error = origErr;
      await closeManagedRedisClient(managed, true);
    }
  });

  // -------------------------------------------------------------------------
  // CLOSEOUT AUDIT TESTS (RECOVERY, PARTIAL CLEANUP, COOLDOWN TOKEN, SHUTDOWN)
  // -------------------------------------------------------------------------
  await runCase('Closeout Audit 1: ensureRedisReady deduplicates concurrent connects across states & recovers cleanly', async () => {
    let connectCalls = 0;
    let shouldFailConnect = false;
    let releaseConnect!: () => void;
    let rejectConnect!: (err: Error) => void;

    const controlledClient: any = {
      status: 'wait',
      connect: () => {
        connectCalls++;
        controlledClient.status = 'connecting';
        return new Promise<void>((resolve, reject) => {
          releaseConnect = () => {
            controlledClient.status = 'ready';
            resolve();
          };
          rejectConnect = (err: Error) => {
            controlledClient.status = 'reconnecting';
            reject(err);
          };
          if (shouldFailConnect) {
            // Defer failure only until caller explicitly rejects or immediate fail
          }
        });
      }
    };

    // Concurrent calls during wait -> connecting -> connect states must invoke connect() ONCE
    const p1 = ensureRedisReady(controlledClient);
    assert(controlledClient.status === 'connecting' && connectCalls === 1, 'First caller must enter connecting state');
    const p2 = ensureRedisReady(controlledClient);
    controlledClient.status = 'connect'; // TCP handshake phase before ready
    const p3 = ensureRedisReady(controlledClient);
    releaseConnect();

    const [c1, c2, c3] = await Promise.all([p1, p2, p3]);
    assert(c1 === controlledClient && c2 === controlledClient && c3 === controlledClient, 'All concurrent callers receive same client');
    assert(connectCalls === 1, `Concurrent calls must share one connect(), got ${connectCalls}`);

    // Non-start external states (connecting/connect/reconnecting/close/end) must NEVER invoke connect()
    for (const nonStartStatus of ['connecting', 'connect', 'reconnecting', 'close', 'end']) {
      const externalClient: any = {
        status: nonStartStatus,
        connect: async () => {
          throw new Error(`connect() must never be invoked in ${nonStartStatus}`);
        }
      };
      await assertThrowsInfraUnavailable(() => ensureRedisReady(externalClient), `state=${nonStartStatus}`);
    }

    // Rejected initial connect clears WeakMap & recovers cleanly once Redis comes back
    const recoverableClient: any = {
      status: 'wait',
      connect: () => {
        connectCalls++;
        recoverableClient.status = 'connecting';
        return Promise.reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })).catch((e) => {
          recoverableClient.status = 'reconnecting';
          throw e;
        });
      }
    };

    const origErr = console.error;
    console.error = () => {};
    try {
      await assertThrowsInfraUnavailable(() => ensureRedisReady(recoverableClient), 'initial failure');
      // While reconnecting, subsequent calls must fail closed WITHOUT invoking connect() again
      const callsBeforeReconnectingCheck = connectCalls;
      await assertThrowsInfraUnavailable(() => ensureRedisReady(recoverableClient), 'while reconnecting');
      assert(connectCalls === callsBeforeReconnectingCheck, 'Must not call connect() again while reconnecting');

      // Simulate ioredis background reconnect succeeding -> status returns to 'ready'
      recoverableClient.status = 'ready';
      const recoveredViaBg = await ensureRedisReady(recoverableClient);
      assert(recoveredViaBg === recoverableClient, 'Must recover automatically once ioredis becomes ready');

      // Also simulate retry starting from fresh wait state (proving WeakMap did not retain rejected promise)
      let attempt2Count = 0;
      const retryWaitClient: any = {
        status: 'wait',
        connect: async () => {
          attempt2Count++;
          if (attempt2Count === 1) {
            retryWaitClient.status = 'wait';
            throw new Error('ECONNREFUSED');
          }
          retryWaitClient.status = 'ready';
        }
      };
      await assertThrowsInfraUnavailable(() => ensureRedisReady(retryWaitClient), 'first wait attempt fails');
      const recoveredWait = await ensureRedisReady(retryWaitClient);
      assert(attempt2Count === 2 && recoveredWait === retryWaitClient, 'WeakMap must clear rejected promise for recovery');
    } finally {
      console.error = origErr;
    }
    void rejectConnect;
  });

  await runCase('Closeout Audit 2a: STORE_OTP_LUA handles owner/otp/attempts failures, cleans up owned state, and never masks causal error', async () => {
    const partialKv = new Map<string, string>();
    type FailStep = 'none' | 'owner' | 'otp' | 'attempts' | 'transport';
    let failStep: FailStep = 'owner';
    let failLuaCleanup = false;
    let failFallbackCleanup = false;
    let fallbackErrorSecret = 'SecretInCleanup';
    let lastFailReason = 'READONLY cannot write';
    let otpWriteAttempted = false;
    let attemptsWriteAttempted = false;
    let observedLuaPcallScript = false;
    let smtpCalls = 0;

    const scriptClient: any = {
      status: 'ready',
      eval: async (
        script: string,
        numKeys: number,
        k1: string,
        k2: string,
        k3: string,
        arg4: string,
        arg5?: string
      ) => {
        if (numKeys === 3 && /OWNER_WRITE_FAILED/.test(script)) {
          observedLuaPcallScript =
            script.includes('redis.pcall') &&
            script.includes('OTP_WRITE_FAILED') &&
            script.includes('ATTEMPTS_WRITE_FAILED') &&
            script.includes('cleanup_owned');
          const ownerKey = k1;
          const otpKey = k2;
          const attemptsKey = k3;
          const opToken = arg4;
          const otp = arg5!;

          if (failStep === 'transport') {
            partialKv.set(ownerKey, opToken);
            partialKv.set(otpKey, otp);
            throw Object.assign(new Error('ETIMEDOUT storeOtp script timeout'), { code: 'ETIMEDOUT' });
          }

          if (failStep === 'owner') {
            return [0, 'OWNER_WRITE_FAILED', lastFailReason, 1];
          }
          partialKv.set(ownerKey, opToken);

          otpWriteAttempted = true;
          if (failStep === 'otp') {
            if (failLuaCleanup) {
              return [0, 'OTP_WRITE_FAILED', lastFailReason, 0];
            }
            if (partialKv.get(ownerKey) === opToken) {
              partialKv.delete(otpKey);
              partialKv.delete(attemptsKey);
              partialKv.delete(ownerKey);
            }
            return [0, 'OTP_WRITE_FAILED', lastFailReason, 1];
          }
          partialKv.set(otpKey, otp);

          attemptsWriteAttempted = true;
          if (failStep === 'attempts') {
            if (failLuaCleanup) {
              return [0, 'ATTEMPTS_WRITE_FAILED', lastFailReason, 0];
            }
            if (partialKv.get(ownerKey) === opToken) {
              partialKv.delete(otpKey);
              partialKv.delete(attemptsKey);
              partialKv.delete(ownerKey);
            }
            return [0, 'ATTEMPTS_WRITE_FAILED', lastFailReason, 1];
          }
          partialKv.set(attemptsKey, '0');
          return [1, 'OK', '', 1];
        }

        // RELEASE_OTP_LUA path
        if (failFallbackCleanup) {
          throw new Error(`secondary cleanup failure redis://default:${fallbackErrorSecret}@127.0.0.1:6380`);
        }
        if (numKeys === 3 && partialKv.get(k3) === arg4) {
          let n = 0;
          if (partialKv.delete(k1)) n++;
          if (partialKv.delete(k2)) n++;
          if (partialKv.delete(k3)) n++;
          return n;
        }
        return 0;
      }
    };

    const emailSvc = createEmailService({
      redisClient: scriptClient,
      nodeEnv: 'test',
      transporter: {
        sendMail: async () => {
          smtpCalls++;
          return {};
        }
      }
    });

    // 1a. Owner-key write failure writes zero OTP or attempts keys
    failStep = 'owner';
    lastFailReason = 'READONLY cannot write owner';
    const ownerErr = await assertThrowsInfraUnavailable(
      () => emailSvc.storeOtp('buyer', 'ownerfail@example.test', '123456'),
      'owner write fail'
    );
    assert(ownerErr.errorCode === 'REDIS_UNAVAILABLE', `Expected REDIS_UNAVAILABLE, got ${ownerErr.errorCode}`);
    assert(observedLuaPcallScript, 'storeOtp must invoke redis.pcall-guarded STORE_OTP_LUA script');
    assert(!otpWriteAttempted && !attemptsWriteAttempted, 'Owner write failure must abort before OTP or attempts writes');
    assert(partialKv.size === 0, 'Owner write failure must leave zero keys in Redis');

    // 1b. Owner-key write failure must also preserve any pre-existing valid OTP state
    partialKv.set('otp_owner:buyer:ownerfail@example.test', 'existing-owner');
    partialKv.set('otp:buyer:ownerfail@example.test', '999999');
    partialKv.set('otp_attempts:buyer:ownerfail@example.test', '1');
    await assertThrowsInfraUnavailable(
      () => emailSvc.storeOtp('buyer', 'ownerfail@example.test', '123456'),
      'owner write fail with existing otp'
    );
    assert(
      partialKv.get('otp:buyer:ownerfail@example.test') === '999999' &&
        partialKv.get('otp_attempts:buyer:ownerfail@example.test') === '1' &&
        partialKv.get('otp_owner:buyer:ownerfail@example.test') === 'existing-owner',
      'Owner write failure must preserve prior valid OTP state'
    );
    partialKv.clear();

    // 2. OTP-key write failure rolls back owned ownerKey cleanly
    failStep = 'otp';
    otpWriteAttempted = false;
    attemptsWriteAttempted = false;
    lastFailReason = 'READONLY cannot write otp';
    const otpErr = await assertThrowsInfraUnavailable(
      () => emailSvc.storeOtp('buyer', 'otpfail@example.test', '123456'),
      'otp write fail'
    );
    assert(otpErr.errorCode === 'REDIS_UNAVAILABLE', `Expected REDIS_UNAVAILABLE, got ${otpErr.errorCode}`);
    assert(!attemptsWriteAttempted, 'OTP write failure must abort before attempts write');
    assert(!partialKv.has('otp_owner:buyer:otpfail@example.test'), 'Owned ownerKey must be cleaned up on OTP write failure');
    assert(!partialKv.has('otp:buyer:otpfail@example.test'), 'OTP key must remain absent on OTP write failure');
    assert(!partialKv.has('otp_attempts:buyer:otpfail@example.test'), 'Attempts key must remain absent on OTP write failure');

    // 3. Attempts-key write failure rolls back both owned ownerKey and otpKey cleanly
    failStep = 'attempts';
    lastFailReason = 'OOM command not allowed when used memory > maxmemory';
    const attemptsErr = await assertThrowsInfraUnavailable(
      () => emailSvc.storeOtp('buyer', 'attemptsfail@example.test', '123456'),
      'attempts write fail'
    );
    assert(attemptsErr.errorCode === 'REDIS_COMMAND_FAILED', `Expected REDIS_COMMAND_FAILED, got ${attemptsErr.errorCode}`);
    assert(!partialKv.has('otp_owner:buyer:attemptsfail@example.test'), 'Owned ownerKey must be cleaned up on attempts write failure');
    assert(!partialKv.has('otp:buyer:attemptsfail@example.test'), 'Owned OTP key must be cleaned up on attempts write failure');
    assert(!partialKv.has('otp_attempts:buyer:attemptsfail@example.test'), 'Attempts key must remain absent on attempts write failure');

    // 4. Cleanup failure (in-Lua and fallback RELEASE_OTP_LUA) never masks causal storage error
    failStep = 'otp';
    failLuaCleanup = true;
    failFallbackCleanup = true;
    fallbackErrorSecret = 'SecretInCleanup';
    lastFailReason = 'READONLY cannot write';
    const origWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...a: any[]) => warns.push(a.map(String).join(' '));
    try {
      const causalLuaErr = await assertThrowsInfraUnavailable(
        () => emailSvc.storeOtp('buyer', 'partial2@example.test', '654321'),
        'cleanup failure must not mask script error'
      );
      assert(causalLuaErr.errorCode === 'REDIS_UNAVAILABLE', `Causal script error masked: ${causalLuaErr.errorCode}`);
      assert(!causalLuaErr.message.includes('SecretInCleanup'), 'Causal error must not be replaced by cleanup error');

      failStep = 'transport';
      fallbackErrorSecret = 'SecretTransportCleanup';
      const causalTransportErr = await assertThrowsInfraUnavailable(
        () => emailSvc.storeOtp('buyer', 'partial3@example.test', '654321'),
        'cleanup failure must not mask transport error'
      );
      assert(causalTransportErr.errorCode === 'REDIS_UNAVAILABLE', `Causal transport error masked: ${causalTransportErr.errorCode}`);
      assert(
        warns.every((w) => !w.includes('SecretInCleanup') && !w.includes('SecretTransportCleanup')),
        'Cleanup warnings must sanitize Redis credentials'
      );
    } finally {
      console.warn = origWarn;
    }

    assert(smtpCalls === 0, 'SMTP must never run after STORE_OTP_LUA or transport failure');
  });

  await runCase('Closeout Audit 2c: stale OTP failure cleanup and delayed SMTP invalidation never delete newer OTP or attempts', async () => {
    const mockKv = new Map<string, string>();
    let failReqAScript = true;
    let enterReqACleanup!: () => void;
    let releaseReqACleanup!: () => void;
    const reqACleanupEntered = new Promise<void>((r) => {
      enterReqACleanup = r;
    });
    const reqACleanupGate = new Promise<void>((r) => {
      releaseReqACleanup = r;
    });
    let pausedOnce = false;
    let reqASmtpCalls = 0;

    // Shared Redis backing store pausing Request A right before fallback RELEASE_OTP_LUA cleanup runs
    const sharedMock: any = {
      status: 'ready',
      eval: async (script: string, numKeys: number, k1: string, k2: string, k3: string, arg4: string, arg5?: string) => {
        if (numKeys === 3 && /OWNER_WRITE_FAILED/.test(script)) {
          const ownerKey = k1;
          const otpKey = k2;
          const attemptsKey = k3;
          const opToken = arg4;
          const otp = arg5!;

          if (failReqAScript) {
            // Request A partially persisted ownerA + otpA before attempts write + internal cleanup reported uncleaned failure
            mockKv.set(ownerKey, opToken);
            mockKv.set(otpKey, otp);
            return [0, 'ATTEMPTS_WRITE_FAILED', 'READONLY transient replica switch', 0];
          }

          // Request B cleanly persists all 3 keys (ownerB, otpB, attempts='0')
          mockKv.set(ownerKey, opToken);
          mockKv.set(otpKey, otp);
          mockKv.set(attemptsKey, '0');
          return [1, 'OK', '', 1];
        }

        if (numKeys === 3) {
          if (!pausedOnce) {
            pausedOnce = true;
            enterReqACleanup();
            await reqACleanupGate; // Pause Request A BEFORE atomic check-and-delete runs
          }
          if (mockKv.get(k3) === arg4) {
            let n = 0;
            if (mockKv.delete(k1)) n++;
            if (mockKv.delete(k2)) n++;
            if (mockKv.delete(k3)) n++;
            return n;
          }
          return 0;
        }
        if (numKeys === 2) {
          const otpKey = k1;
          const attemptsKey = k2;
          const candidate = k3;
          const maxAttempts = Number(arg4);
          const stored = mockKv.get(otpKey);
          if (!stored) return [0, 'EXPIRED', 0];
          const attempts = Number(mockKv.get(attemptsKey) || '0');
          if (stored !== candidate) {
            const nextAttempts = attempts + 1;
            mockKv.set(attemptsKey, String(nextAttempts));
            if (nextAttempts >= maxAttempts) {
              mockKv.delete(otpKey);
              mockKv.delete(attemptsKey);
              return [0, 'LOCKED', 0];
            }
            return [0, 'MISMATCH', maxAttempts - nextAttempts];
          }
          mockKv.delete(otpKey);
          mockKv.delete(attemptsKey);
          return [1, 'OK', 0];
        }
        return 0;
      }
    };

    const svcA = createEmailService({
      redisClient: sharedMock,
      nodeEnv: 'test',
      transporter: {
        sendMail: async () => {
          reqASmtpCalls++;
          return {};
        }
      }
    });
    const svcB = createEmailService({ redisClient: sharedMock, nodeEnv: 'test' });

    const otpKey = 'otp:buyer:race-otp@example.test';
    const attemptsKey = 'otp_attempts:buyer:race-otp@example.test';
    const ownerKey = 'otp_owner:buyer:race-otp@example.test';

    // 1. Start Request A -> fails STORE_OTP_LUA with uncleaned partial state, pauses right before RELEASE_OTP_LUA
    const reqAPromise = assertThrowsInfraUnavailable(
      () => svcA.storeOtp('buyer', 'race-otp@example.test', '111111'),
      'reqA partial store failure'
    );
    await reqACleanupEntered;
    assert(reqASmtpCalls === 0, 'SMTP must never be invoked for failed Request A');

    // 2. Request B succeeds cleanly BEFORE Request A cleanup executes
    failReqAScript = false;
    const tokenB = await svcB.storeOtp('buyer', 'race-otp@example.test', '222222');
    assert(typeof tokenB === 'string' && tokenB.length >= 16, 'Request B must receive ownership token');

    // Wrong OTP attempt increments Request B's attempts counter to '1'
    const badCheck = await svcB.verifyOtp('buyer', 'race-otp@example.test', '000000');
    assert(!badCheck.valid && mockKv.get(attemptsKey) === '1', 'Attempts counter for Request B must be 1');

    // 3. Release Request A delayed cleanup -> must NOT delete Request B's OTP or attempts counter!
    releaseReqACleanup();
    await reqAPromise;

    assert(mockKv.get(otpKey) === '222222', 'Newer OTP B MUST survive stale Request A cleanup');
    assert(mockKv.get(attemptsKey) === '1', 'Newer attempts counter MUST NOT be deleted by stale Request A cleanup');
    assert(mockKv.get(ownerKey) === tokenB, 'Owner key must still belong to Request B');

    // Also verify delayed SMTP-failure invalidateOtpIfOwned with stale token never deletes Request B
    await svcA.invalidateOtpIfOwned('buyer', 'race-otp@example.test', 'stale-token-from-earlier-smtp');
    assert(mockKv.get(otpKey) === '222222' && mockKv.get(attemptsKey) === '1', 'Stale SMTP invalidation must leave Request B intact');

    // Valid OTP B still verifies cleanly once
    const validB = await svcB.verifyOtp('buyer', 'race-otp@example.test', '222222');
    assert(validB.valid, 'Request B OTP must verify cleanly after surviving stale cleanup');
    const replayB = await svcB.verifyOtp('buyer', 'race-otp@example.test', '222222');
    assert(!replayB.valid, 'Single-use check must still reject replay');
  });

  await runCase('Closeout Audit 2b: token-bound cooldown cleanup cannot delete a newer cooldown from another request', async () => {
    const mockRedis = createDeterministicMockRedis();
    const emailSvc = createEmailService({ redisClient: mockRedis, nodeEnv: 'test' });

    const req1 = await emailSvc.acquireResendCooldown('buyer-login', 'u-token-race');
    assert(req1.allowed && typeof req1.token === 'string' && req1.token.length >= 16, 'Req 1 must get unique token');

    // Advance past req1 expiry so req2 legally acquires a fresh cooldown
    mockRedis.advanceMs(46_000);
    const req2 = await emailSvc.acquireResendCooldown('buyer-login', 'u-token-race');
    assert(req2.allowed && req2.token && req2.token !== req1.token, 'Req 2 must get distinct token');

    // Delayed error handler from req1 attempts cleanup with req1.token -> must NOT delete req2's cooldown
    await emailSvc.clearResendCooldown('buyer-login', 'u-token-race', req1.token!);
    const req3DuringReq2 = await emailSvc.acquireResendCooldown('buyer-login', 'u-token-race');
    assert(!req3DuringReq2.allowed, 'Req 1 stale cleanup must NEVER delete Req 2 newer cooldown');

    // Req 2 cleaning up with its OWN matching token succeeds cleanly
    await emailSvc.clearResendCooldown('buyer-login', 'u-token-race', req2.token!);
    const req4AfterOwnerClear = await emailSvc.acquireResendCooldown('buyer-login', 'u-token-race');
    assert(req4AfterOwnerClear.allowed, 'Owner cleanup with matching token must release cooldown');
  });

  await runCase('Closeout Audit 3: Redis shutdown failure still closes both owned PG pools once & exits 1', async () => {
    const cfg = makeTestConfig();
    const ownedApp = createGatewayApp(cfg);

    let custEndCount = 0;
    let merchEndCount = 0;
    let redisQuitCount = 0;
    let redisDisconnectCount = 0;

    const origCustEnd = ownedApp.customerPool.end.bind(ownedApp.customerPool);
    const origMerchEnd = ownedApp.merchantPool.end.bind(ownedApp.merchantPool);
    ownedApp.customerPool.end = async () => {
      custEndCount++;
      return origCustEnd();
    };
    ownedApp.merchantPool.end = async () => {
      merchEndCount++;
      return origMerchEnd();
    };

    ownedApp.redis.status = 'ready';
    ownedApp.redis.quit = async () => {
      redisQuitCount++;
      throw new Error('quit boom on redis://default:ShutdownSecret77@cache:6380');
    };
    ownedApp.redis.disconnect = () => {
      redisDisconnectCount++;
      ownedApp.redis.status = 'end';
    };

    const fakeProc = new EventEmitter();
    const origErr = console.error;
    const origLog = console.log;
    const errLogs: string[] = [];
    console.error = (...args: any[]) => errLogs.push(args.map(String).join(' '));
    console.log = () => {};

    try {
      const exitPromise = new Promise<number>((resolveExit) => {
        registerShutdownSignals(ownedApp.shutdown, {
          targetProcess: fakeProc as any,
          onExit: (code) => resolveExit(code),
          timeoutMs: 1000
        });
      });

      fakeProc.emit('SIGTERM');
      const exitCode = await exitPromise;
      const secondCallRes = await ownedApp.shutdown();

      assert(exitCode === 1, `Redis shutdown error must exit with code 1, got ${exitCode}`);
      assert(redisQuitCount === 1 && redisDisconnectCount === 1, 'Owned Redis must close cleanly at most once');
      assert(custEndCount === 1, `Customer pool must still be closed once on Redis quit error, got ${custEndCount}`);
      assert(merchEndCount === 1, `Merchant pool must still be closed once on Redis quit error, got ${merchEndCount}`);
      assert(secondCallRes.redisErrors.length === 1 && secondCallRes.poolErrors.length === 0, 'Shutdown result must preserve sanitized redisErrors');
      assert(
        secondCallRes.redisErrors.every((e) => !e.includes('ShutdownSecret77')) &&
          errLogs.every((l) => !l.includes('ShutdownSecret77')),
        'Shutdown error logs & result must sanitize Redis credentials'
      );
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
  });

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runS13RedisOtpUnitTests()
    .then((results) => {
      let failed = 0;
      for (const r of results) {
        if (r.passed) {
          console.log(`  PASS: ${r.name}`);
        } else {
          failed++;
          console.error(`  FAIL: ${r.name} -> ${r.error}`);
        }
      }
      console.log(`\nS1.3-B Redis & OTP Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal S1.3-B unit test error:', err);
      process.exit(1);
    });
}
