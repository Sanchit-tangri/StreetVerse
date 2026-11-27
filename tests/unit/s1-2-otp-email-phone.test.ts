/**
 * StreetVerse S1.2 Automated Tests: Phone Normalization, OTP Atomicity, Honest SMTP & Email-Change Security
 */

import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { createEmailService, generateOtp } from '../../services/api-gateway/src/services/email';
import { InfrastructureUnavailableError } from '../../services/api-gateway/src/utils/infraErrors';
import { normalizePhoneNumber } from '../../services/api-gateway/src/utils/phone';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function buildConfig(): GatewayConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    allowedOrigins: ['https://buyer.example.test'],
    jwtSecret: crypto.randomBytes(36).toString('base64url'),
    jwtIssuer: 'streetverse-api-test',
    jwtBuyerAudience: 'streetverse-buyer-test',
    jwtSellerAudience: 'streetverse-seller-test',
    jwtExpiresIn: '7d',
    redisUrl: 'redis://127.0.0.1:6399',
    customerDbUrl: 'postgresql://postgres:postgres@127.0.0.1:5433/test_cust',
    merchantDbUrl: 'postgresql://postgres:postgres@127.0.0.1:5434/test_merch',
    aiEngineUrl: 'http://127.0.0.1:8000'
  };
}

function signToken(
  cfg: GatewayConfig,
  sub: string,
  role: 'BUYER' | 'SELLER',
  aud?: string
): string {
  return jwt.sign(
    {
      sub,
      role,
      ...(role === 'SELLER' ? { principalType: 'SELLER_ACCOUNT' } : {}),
      email: `${sub}@example.test`
    },
    cfg.jwtSecret,
    {
      issuer: cfg.jwtIssuer,
      audience: aud || (role === 'BUYER' ? cfg.jwtBuyerAudience : cfg.jwtSellerAudience),
      expiresIn: '1h'
    }
  );
}

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
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
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Simulates atomic Redis Lua verification + NX cooldown execution cleanly offline
 */
function createMockRedis() {
  const kv = new Map<string, { val: string; expiresAt: number }>();

  const purgeExpired = (k: string) => {
    const rec = kv.get(k);
    if (rec && rec.expiresAt <= Date.now()) kv.delete(k);
  };

  const applySet = (k: string, val: string, _ex?: string, ttlSec?: number, nx?: string) => {
    purgeExpired(k);
    if (nx === 'NX' && kv.has(k)) return null;
    kv.set(k, { val, expiresAt: Date.now() + (ttlSec || 300) * 1000 });
    return 'OK';
  };

  const applyDel = (...keys: string[]) => {
    let count = 0;
    for (const k of keys) {
      if (kv.delete(k)) count++;
    }
    return count;
  };

  return {
    status: 'ready',
    on: () => {},
    connect: async () => {},
    ping: async () => 'PONG',
    quit: async () => 'OK',
    disconnect: () => {},
    set: async (k: string, val: string, ex?: string, ttlSec?: number, nx?: string) => applySet(k, val, ex, ttlSec, nx),
    ttl: async (k: string) => {
      purgeExpired(k);
      const rec = kv.get(k);
      return rec ? Math.max(1, Math.ceil((rec.expiresAt - Date.now()) / 1000)) : -2;
    },
    del: async (...keys: string[]) => applyDel(...keys),
    multi: () => {
      const ops: Array<() => any> = [];
      const chain: any = {
        set: (...args: any[]) => {
          ops.push(() => applySet(args[0], args[1], args[2], args[3], args[4]));
          return chain;
        },
        del: (...keys: string[]) => {
          ops.push(() => applyDel(...keys));
          return chain;
        },
        exec: async () => ops.map((op) => [null, op()] as [Error | null, any])
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
      if (numKeys === 1) {
        purgeExpired(key1);
        const rec = kv.get(key1);
        if (rec && rec.val === arg1OrKey2) {
          kv.delete(key1);
          return 1;
        }
        return 0;
      }
      if (numKeys === 3) {
        if (/OWNER_WRITE_FAILED/.test(script)) {
          const ownerKey = key1;
          const otpKey = arg1OrKey2;
          const attemptsKey = candidateOrKey3!;
          const opToken = maxOrToken!;
          const otp = maybeOtp!;
          const ttlSec = Number(maybeTtlSec || 300);
          applySet(ownerKey, opToken, 'EX', ttlSec);
          applySet(otpKey, otp, 'EX', ttlSec);
          applySet(attemptsKey, '0', 'EX', ttlSec);
          return [1, 'OK', '', 1];
        }
        const otpKey = key1;
        const attemptsKey = arg1OrKey2;
        const ownerKey = candidateOrKey3!;
        const expectedToken = maxOrToken!;
        purgeExpired(ownerKey);
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
      const maxAttemptsStr = maxOrToken!;
      purgeExpired(otpKey);
      purgeExpired(attemptsKey);
      const maxAttempts = Number(maxAttemptsStr);
      const stored = kv.get(otpKey)?.val;
      if (!stored) return [0, 'EXPIRED', 0];

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
}

export async function runS12Tests(): Promise<TestResult[]> {
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
  // 1. PHONE NORMALIZATION TESTS
  // -------------------------------------------------------------------------
  await runCase('Phone: normalizes all approved Indian formats to +919890123456 with legacy candidates', () => {
    const inputs = ['+91 98901 23456', '+919890123456', '919890123456', '09890123456', '9890123456'];
    for (const input of inputs) {
      const res = normalizePhoneNumber(input);
      assert(res.valid, `Expected ${input} to be valid: ${res.error}`);
      assert(res.e164 === '+919890123456', `Expected +919890123456 for ${input}, got ${res.e164}`);
      assert(res.isIndian === true, `Expected isIndian=true for ${input}`);
      assert(
        res.legacyCandidates?.includes('+919890123456') &&
          res.legacyCandidates?.includes('919890123456') &&
          res.legacyCandidates?.includes('09890123456') &&
          res.legacyCandidates?.includes('9890123456'),
        `Legacy candidates missing historical format for ${input}`
      );
    }
  });

  await runCase('Phone: enforces ^[6-9]\\d{9}$ and rejects malformed or ambiguous bare numbers', () => {
    for (const invalid of [
      '',
      '5890123456',
      '1234567890',
      '+91 58901 23456',
      '05890123456',
      '915890123456',
      '989012345',
      '98901234567',
      '447911123456', // missing '+' for non-Indian
      'abc9890123456'
    ]) {
      const res = normalizePhoneNumber(invalid);
      assert(!res.valid, `Expected invalid phone "${invalid}" to be rejected`);
    }
  });

  await runCase('Phone: normalizes explicit + international numbers and enforces VARCHAR(15) limit without truncation', () => {
    const uk = normalizePhoneNumber('+44 7911 123456');
    assert(uk.valid && uk.e164 === '+447911123456' && uk.isIndian === false, 'UK +44 format failed');

    const tooLong = normalizePhoneNumber('+123456789012345'); // 16 chars > VARCHAR(15)
    assert(!tooLong.valid, 'Phone exceeding 15 characters must be rejected rather than truncated');
  });

  // -------------------------------------------------------------------------
  // 2. OTP ATOMICITY, EXPIRY, COOLDOWN & SMTP TESTS
  // -------------------------------------------------------------------------
  await runCase('OTP: generateOtp covers 6 digits, valid succeeds once, reused & expired fail', async () => {
    const mockRedis = createMockRedis();
    const emailSvc = createEmailService({ nodeEnv: 'test', redisClient: mockRedis as any, transporter: null });

    for (let i = 0; i < 100; i++) {
      const code = generateOtp();
      assert(/^\d{6}$/.test(code) && Number(code) >= 100000 && Number(code) <= 999999, `Out of range OTP: ${code}`);
    }

    await emailSvc.storeOtp('buyer', 'otp1@example.test', '482910');
    const first = await emailSvc.verifyOtp('buyer', 'otp1@example.test', '482910');
    assert(first.valid, 'Valid OTP should succeed once');

    const reused = await emailSvc.verifyOtp('buyer', 'otp1@example.test', '482910');
    assert(!reused.valid, 'Reused OTP must fail');

    // Expired OTP fails (TTL expiry simulation)
    await mockRedis.set('otp:buyer:expired@example.test', '123456', 'EX', 0.02);
    await new Promise((r) => setTimeout(r, 35));
    const expiredTtl = await emailSvc.verifyOtp('buyer', 'expired@example.test', '123456');
    assert(!expiredTtl.valid, 'TTL-expired OTP must fail');

    // Missing/unrequested OTP
    const expired = await emailSvc.verifyOtp('buyer', 'nonexistent@example.test', '123456');
    assert(!expired.valid, 'Expired/missing OTP must fail');
  });

  await runCase('OTP: third incorrect attempt immediately invalidates challenge & prevents concurrent replay', async () => {
    const mockRedis = createMockRedis();
    const emailSvc = createEmailService({ nodeEnv: 'test', redisClient: mockRedis as any, transporter: null });

    await emailSvc.storeOtp('buyer', 'lock3@example.test', '777888');
    const a1 = await emailSvc.verifyOtp('buyer', 'lock3@example.test', '000001');
    assert(!a1.valid && a1.reason?.includes('2'), `Expected 2 remaining on attempt 1, got ${a1.reason}`);
    const a2 = await emailSvc.verifyOtp('buyer', 'lock3@example.test', '000002');
    assert(!a2.valid && a2.reason?.includes('1'), `Expected 1 remaining on attempt 2, got ${a2.reason}`);
    const a3 = await emailSvc.verifyOtp('buyer', 'lock3@example.test', '000003');
    assert(!a3.valid && a3.reason?.toLowerCase().includes('too many'), `Expected immediate lockout on attempt 3, got ${a3.reason}`);

    // Even valid OTP must now fail because challenge was immediately deleted on 3rd strike
    const afterLock = await emailSvc.verifyOtp('buyer', 'lock3@example.test', '777888');
    assert(!afterLock.valid, 'Valid OTP must fail after 3rd wrong attempt invalidation');

    // Concurrent verification race test via injected Redis
    await emailSvc.storeOtp('buyer', 'race@example.test', '991122');
    const [r1, r2, r3] = await Promise.all([
      emailSvc.verifyOtp('buyer', 'race@example.test', '991122'),
      emailSvc.verifyOtp('buyer', 'race@example.test', '991122'),
      emailSvc.verifyOtp('buyer', 'race@example.test', '991122')
    ]);
    const successCount = [r1, r2, r3].filter((r) => r.valid).length;
    assert(successCount === 1, `Concurrent verification must allow exactly 1 success, got ${successCount}`);

    // Fail-closed check: absent Redis must throw InfrastructureUnavailableError (no silent memory fallback)
    const noRedisSvc = createEmailService({ nodeEnv: 'test', redisClient: null, transporter: null });
    let failClosedErr: unknown = null;
    try {
      await noRedisSvc.storeOtp('buyer', 'mem@example.test', '334455');
    } catch (err) {
      failClosedErr = err;
    }
    assert(
      failClosedErr instanceof InfrastructureUnavailableError && failClosedErr.statusCode === 503,
      'Null Redis client must fail closed with InfrastructureUnavailableError'
    );
  });

  await runCase('OTP: resend cooldown enforces 45s limit and SMTP failure reports sent=false', async () => {
    const mockRedis = createMockRedis();
    const failingEmailSvc = createEmailService({
      nodeEnv: 'test',
      redisClient: mockRedis as any,
      transporter: {
        sendMail: async () => {
          throw new Error('Simulated SMTP outage');
        }
      }
    });

    const cd1 = await failingEmailSvc.acquireResendCooldown('resend:buyer', 'cool@example.test');
    assert(cd1.allowed && Boolean(cd1.token), 'First cooldown acquisition should succeed with token');
    const cd2 = await failingEmailSvc.acquireResendCooldown('resend:buyer', 'cool@example.test');
    assert(!cd2.allowed && (cd2.retryAfterSeconds || 0) > 0, 'Rapid resend must be blocked by cooldown');
    await failingEmailSvc.clearResendCooldown('resend:buyer', 'cool@example.test', cd1.token!);

    const failedDelivery = await failingEmailSvc.sendOtpEmail('cool@example.test', '112233', 'Test');
    assert(failedDelivery.sent === false, 'SMTP exception must return sent: false');

    // Staging/production without SMTP must return sent: false
    const prodEmailSvc = createEmailService({ nodeEnv: 'production', redisClient: mockRedis as any, transporter: null });
    const oldUser = process.env.SMTP_USER;
    const oldPass = process.env.SMTP_PASS;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    try {
      const prodUnconfigured = await prodEmailSvc.sendOtpEmail('cool@example.test', '112233', 'Prod');
      assert(prodUnconfigured.sent === false, 'Missing SMTP in production must return sent: false');
    } finally {
      if (oldUser !== undefined) process.env.SMTP_USER = oldUser;
      if (oldPass !== undefined) process.env.SMTP_PASS = oldPass;
    }
  });

  // -------------------------------------------------------------------------
  // 3. EMAIL-CHANGE AUTHORIZATION, BINDING & SCHEMA-STRICT SQL TESTS
  // -------------------------------------------------------------------------
  await runCase('Email-Change: enforces JWT auth, rejects IDOR & wrong OTP/binding, updates real columns only', async () => {
    const cfg = buildConfig();
    const mockRedis = createMockRedis();

    const users = [
      {
        id: 'user-a',
        full_name: 'Buyer A',
        email: 'buyera@example.test',
        phone: '+919890123456',
        home_address: 'Pune',
        is_verified: true
      },
      {
        id: 'user-b',
        full_name: 'Buyer B',
        email: 'buyerb@example.test',
        phone: '+919890123457',
        home_address: 'Pune',
        is_verified: true
      },
      {
        id: 'user-c',
        full_name: 'Existing Taken',
        email: 'taken@example.test',
        phone: '+919890123458',
        home_address: 'Pune',
        is_verified: true
      }
    ];

    const executedQueries: string[] = [];

    const mockCustomerPool = {
      query: async (sql: string, params: any[] = []) => {
        executedQueries.push(sql);
        // Enforce strict schema check: users table has NO role column
        if (/\brole\b/i.test(sql) && /\bFROM\s+users\b|\bUPDATE\s+users\b/i.test(sql)) {
          throw new Error(`SQL references nonexistent users.role column: ${sql}`);
        }

        if (/SELECT id, email FROM users WHERE id = \$1/i.test(sql)) {
          const u = users.find((r) => r.id === params[0]);
          return { rows: u ? [{ id: u.id, email: u.email }] : [], rowCount: u ? 1 : 0 };
        }
        if (/SELECT id FROM users WHERE LOWER\(email\) = \$1 AND id <> \$2/i.test(sql)) {
          const u = users.find((r) => r.email.toLowerCase() === params[0] && r.id !== params[1]);
          return { rows: u ? [{ id: u.id }] : [], rowCount: u ? 1 : 0 };
        }
        if (/UPDATE users SET email = \$1, updated_at = CURRENT_TIMESTAMP WHERE id = \$2/i.test(sql)) {
          const targetEmail = params[0];
          const targetId = params[1];
          const conflict = users.find((r) => r.email.toLowerCase() === targetEmail && r.id !== targetId);
          if (conflict) {
            const pgErr: any = new Error('duplicate key value violates unique constraint');
            pgErr.code = '23505';
            throw pgErr;
          }
          const u = users.find((r) => r.id === targetId);
          if (!u) return { rows: [], rowCount: 0 };
          u.email = targetEmail;
          return {
            rows: [
              {
                id: u.id,
                full_name: u.full_name,
                email: u.email,
                phone: u.phone,
                home_address: u.home_address,
                is_verified: u.is_verified
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      },
      on: () => {},
      end: async () => {}
    };

    let capturedEmailOtp = '';
    let shouldFailSmtp = false;
    const { server, io, emailService } = createGatewayApp(cfg, {
      customerPool: mockCustomerPool as any,
      merchantPool: { query: async () => ({ rows: [], rowCount: 0 }), on: () => {}, end: async () => {} },
      redis: mockRedis as any,
      emailTransporter: {
        sendMail: async (mail: any) => {
          if (shouldFailSmtp) throw new Error('SMTP down');
          const match = String(mail.text || '').match(/(\d{6})/);
          if (match) capturedEmailOtp = match[1];
          return {};
        }
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const tokenA = signToken(cfg, 'user-a', 'BUYER');
    const tokenB = signToken(cfg, 'user-b', 'BUYER');
    const sellerToken = signToken(cfg, 'merch-1', 'SELLER');

    try {
      // No token -> 401
      const noAuth = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        body: { newEmail: 'newa@example.test' }
      });
      assert(noAuth.statusCode === 401, `Expected 401 without token, got ${noAuth.statusCode}`);

      // Invalid token -> 401
      const badAuth = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: 'Bearer invalid.jwt.token' },
        body: { newEmail: 'newa@example.test' }
      });
      assert(badAuth.statusCode === 401, `Expected 401 for bad token, got ${badAuth.statusCode}`);

      // Seller token -> 403
      const sellerAttempt = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${sellerToken}` },
        body: { newEmail: 'newa@example.test' }
      });
      assert(sellerAttempt.statusCode === 403, `Expected 403 for seller token, got ${sellerAttempt.statusCode}`);

      // Duplicate email -> 409
      const dupReq = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: { newEmail: 'TAKEN@example.test' }
      });
      assert(dupReq.statusCode === 409, `Expected 409 for duplicate email, got ${dupReq.statusCode}`);

      // Valid request by User A even with spoofed body userId='user-b' -> binds ONLY to user-a
      const reqA = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: { newEmail: 'NewA@example.test', userId: 'user-b' }
      });
      assert(reqA.statusCode === 200, `Expected 200 on valid email change request, got ${reqA.statusCode}`);
      assert(/^\d{6}$/.test(capturedEmailOtp), 'OTP should be dispatched via transporter');

      // Cooldown blocks immediate second request with 429
      const rapidReq = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: { newEmail: 'another@example.test' }
      });
      assert(rapidReq.statusCode === 429, `Expected 429 cooldown response, got ${rapidReq.statusCode}`);

      // User B trying to use User A's OTP fails
      const userBReplay = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/verify-email-change',
        headers: { Authorization: `Bearer ${tokenB}` },
        body: { newEmail: 'NewA@example.test', otp: capturedEmailOtp }
      });
      assert(userBReplay.statusCode === 400, `User B must not consume User A OTP, got ${userBReplay.statusCode}`);

      // Wrong destination email fails
      const wrongTarget = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/verify-email-change',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: { newEmail: 'wrongtarget@example.test', otp: capturedEmailOtp }
      });
      assert(wrongTarget.statusCode === 400, `Wrong destination email must fail, got ${wrongTarget.statusCode}`);

      // Wrong OTP fails and leaves User A & User B unchanged
      const wrongOtp = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/verify-email-change',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: { newEmail: 'newa@example.test', otp: '000000' }
      });
      assert(wrongOtp.statusCode === 400, `Wrong OTP must fail, got ${wrongOtp.statusCode}`);
      assert(users[0].email === 'buyera@example.test', 'User A email must remain unchanged after failed OTP');

      // Valid confirm updates ONLY user-a (ignores spoofed userId='user-b')
      const confirmA = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/verify-email-change',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: { newEmail: 'newa@example.test', userId: 'user-b', otp: capturedEmailOtp }
      });
      assert(confirmA.statusCode === 200, `Valid verify-email-change failed: ${confirmA.statusCode} ${confirmA.body}`);
      const confirmBody = JSON.parse(confirmA.body);
      assert(confirmBody.user.id === 'user-a' && confirmBody.user.email === 'newa@example.test', 'Updated user A mismatch');
      assert(confirmBody.user.role === 'BUYER', 'Response role must come from JWT principal');
      assert(users[1].email === 'buyerb@example.test', 'User B email must never be touched');

      // Failed SMTP invalidates challenge and returns 502
      shouldFailSmtp = true;
      const smtpFailReq = await httpRequest({
        port,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${tokenB}` },
        body: { newEmail: 'newb@example.test' }
      });
      assert(smtpFailReq.statusCode === 502, `Expected 502 on SMTP delivery failure, got ${smtpFailReq.statusCode}`);
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------
  // 4. LOGIN AMBIGUOUS LEGACY PHONE CONFLICT CHECK
  // -------------------------------------------------------------------------
  await runCase('Auth: rejects login with 409 when multiple legacy phone representations match', async () => {
    const cfg = buildConfig();
    const mockRedis = createMockRedis();
    const mockCustomerPool = {
      query: async (sql: string) => {
        if (/WHERE phone = ANY\(\$1\)/i.test(sql)) {
          return {
            rows: [
              { id: 'u1', phone: '+919890123456', email: 'a@example.test', password_hash: 'h' },
              { id: 'u2', phone: '9890123456', email: 'b@example.test', password_hash: 'h' }
            ],
            rowCount: 2
          };
        }
        return { rows: [], rowCount: 0 };
      },
      on: () => {},
      end: async () => {}
    };

    const { server, io } = createGatewayApp(cfg, {
      customerPool: mockCustomerPool as any,
      merchantPool: { query: async () => ({ rows: [], rowCount: 0 }), on: () => {}, end: async () => {} },
      redis: mockRedis as any
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: '+91 98901 23456', password: 'Password123!' }
      });
      assert(res.statusCode === 409, `Expected 409 reconciliation conflict, got ${res.statusCode}`);
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------
  // 5. BUYER & SELLER LOGIN OTP COOLDOWN + ATTEMPT-COUNTER PRESERVATION
  // -------------------------------------------------------------------------
  await runCase('Auth: login OTP cooldown prevents resetting attempts, isolates buyer/seller, clears on SMTP failure', async () => {
    const cfg = buildConfig();
    const mockRedis = createMockRedis();
    const passwordHash = await bcrypt.hash('Password123!', 10);

    const sharedUuid = 'shared-account-uuid-001';
    const buyerEmail = 'cool.buyer@example.test';
    const sellerEmail = 'cool.seller@example.test';

    const mockCustomerPool = {
      query: async (sql: string) => {
        if (/FROM users/i.test(sql)) {
          return {
            rows: [
              {
                id: sharedUuid,
                phone: '+919890123456',
                full_name: 'Cool Buyer',
                email: buyerEmail,
                password_hash: passwordHash,
                is_verified: true,
                home_address: 'Pune'
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      },
      on: () => {},
      end: async () => {}
    };

    const mockMerchantPool = {
      query: async (sql: string) => {
        if (/FROM seller_accounts/i.test(sql)) {
          return {
            rows: [
              {
                id: sharedUuid,
                phone: '+919876543210',
                email: sellerEmail,
                password_hash: passwordHash,
                is_email_verified: true,
                status: 'ACTIVE'
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      },
      on: () => {},
      end: async () => {}
    };

    let lastOtp = '';
    let shouldFailLoginSmtp = false;
    const { server, io } = createGatewayApp(cfg, {
      customerPool: mockCustomerPool as any,
      merchantPool: mockMerchantPool as any,
      redis: mockRedis as any,
      emailTransporter: {
        sendMail: async (mail: any) => {
          if (shouldFailLoginSmtp) throw new Error('SMTP down');
          const m = String(mail.text || '').match(/(\d{6})/);
          if (m) lastOtp = m[1];
          return {};
        }
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      // Wrong password must NOT consume cooldown; valid password after wrong password succeeds on first OTP
      const badPw = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: buyerEmail, password: 'WrongPassword!' }
      });
      assert(badPw.statusCode === 401, `Expected 401 on wrong password, got ${badPw.statusCode}`);

      const login1 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: buyerEmail, password: 'Password123!' }
      });
      assert(login1.statusCode === 200, `First buyer login OTP must succeed, got ${login1.statusCode}`);
      const firstOtp = lastOtp;

      // Two wrong OTP attempts leave 1 attempt remaining
      const wrong1 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/verify-otp',
        body: { email: buyerEmail, otp: '000001' }
      });
      assert(wrong1.statusCode === 400, 'Wrong attempt 1 must return 400');

      const wrong2 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/verify-otp',
        body: { email: buyerEmail, otp: '000002' }
      });
      assert(wrong2.statusCode === 400, 'Wrong attempt 2 must return 400');

      // Repeated buyer/login within 45s must return 429 and MUST NOT reset OTP or attempt count
      const login2 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: '+91 98901 23456', password: 'Password123!' }
      });
      assert(login2.statusCode === 429, `Repeated buyer login within 45s must return 429, got ${login2.statusCode}`);
      const login2Body = JSON.parse(login2.body);
      assert(typeof login2Body.retryAfterSeconds === 'number' && login2Body.retryAfterSeconds > 0, 'retryAfterSeconds required');

      // 3rd wrong attempt still immediately invalidates the active OTP challenge (proving attempts weren't reset)
      const wrong3 = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/verify-otp',
        body: { email: buyerEmail, otp: '000003' }
      });
      assert(wrong3.statusCode === 400 && JSON.parse(wrong3.body).error.toLowerCase().includes('too many'), '3rd strike must lock immediately');

      // Even firstOtp now fails because 3rd strike invalidated it
      const validAfterLock = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/verify-otp',
        body: { email: buyerEmail, otp: firstOtp }
      });
      assert(validAfterLock.statusCode === 400, 'Active OTP must remain invalidated after 3rd failure');

      // Seller login with the SAME account UUID must NOT be blocked by Buyer cooldown
      // First simulate SMTP failure -> 502 + clears seller-login cooldown so retry immediately succeeds
      shouldFailLoginSmtp = true;
      const sellerFail = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/login',
        body: { identifier: sellerEmail, password: 'Password123!' }
      });
      assert(sellerFail.statusCode === 502, `Expected 502 on seller SMTP failure, got ${sellerFail.statusCode}`);

      shouldFailLoginSmtp = false;
      const sellerOk = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/login',
        body: { identifier: sellerEmail, password: 'Password123!' }
      });
      assert(sellerOk.statusCode === 200, `Seller login after failed SMTP cooldown cleanup & isolated from buyer must succeed, got ${sellerOk.statusCode}`);

      const sellerCooldown = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/login',
        body: { identifier: '+91 98765 43210', password: 'Password123!' }
      });
      assert(sellerCooldown.statusCode === 429, `Repeated seller login within 45s must return 429, got ${sellerCooldown.statusCode}`);
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runS12Tests()
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
      console.log(`\nS1.2 Unit/Route Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal S1.2 test error:', err);
      process.exit(1);
    });
}
