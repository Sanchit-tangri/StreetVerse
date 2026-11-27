/**
 * StreetVerse S1.1 Automated Tests: Configuration, JWT Claims & CORS Hardening
 * Runs completely isolated using generated in-memory secrets and ephemeral ports.
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import {
  GatewayConfig,
  loadGatewayEnvFiles,
  parseAllowedOrigins,
  parseGatewayConfig,
  resolveGatewayEnvPaths,
  validateJwtSecret,
  validateNodeEnv
} from '../../services/api-gateway/src/config/env';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { createEmailService, generateOtp } from '../../services/api-gateway/src/services/email';

function createMockOtpRedis() {
  const kv = new Map<string, { val: string; expiresAt: number }>();
  const purge = (k: string) => {
    const rec = kv.get(k);
    if (rec && rec.expiresAt <= Date.now()) kv.delete(k);
  };
  const applySet = (k: string, val: string, _ex?: string, ttlSec?: number, nx?: string) => {
    purge(k);
    if (nx === 'NX' && kv.has(k)) return null;
    kv.set(k, { val, expiresAt: Date.now() + (ttlSec || 300) * 1000 });
    return 'OK';
  };
  return {
    status: 'ready',
    on: () => {},
    connect: async () => {},
    ping: async () => 'PONG',
    quit: async () => 'OK',
    disconnect: () => {},
    set: async (...args: any[]) => applySet(args[0], args[1], args[2], args[3], args[4]),
    ttl: async (k: string) => {
      purge(k);
      const rec = kv.get(k);
      return rec ? Math.max(1, Math.ceil((rec.expiresAt - Date.now()) / 1000)) : -2;
    },
    del: async (...keys: string[]) => keys.reduce((n, k) => n + (kv.delete(k) ? 1 : 0), 0),
    multi: () => {
      const ops: Array<() => any> = [];
      const chain: any = {
        set: (...args: any[]) => {
          ops.push(() => applySet(args[0], args[1], args[2], args[3], args[4]));
          return chain;
        },
        del: (...keys: string[]) => {
          ops.push(() => keys.reduce((n, k) => n + (kv.delete(k) ? 1 : 0), 0));
          return chain;
        },
        exec: async () => ops.map((fn) => [null, fn()] as [Error | null, any])
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
        kv.set(attemptsKey, { val: String(nextAttempts), expiresAt: kv.get(otpKey)!.expiresAt });
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

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrowsWithoutLeaking(fn: () => unknown, secretToProtect?: string, label = 'Expected error'): Error {
  try {
    fn();
  } catch (err: any) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (secretToProtect && error.message.includes(secretToProtect)) {
      throw new Error(`${label}: error message leaked secret material`);
    }
    return error;
  }
  throw new Error(`${label}: expected function to throw`);
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
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
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

function buildValidTestSecret(): string {
  return crypto.randomBytes(36).toString('base64url');
}

function createIsolatedConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    allowedOrigins: ['https://buyer.example.test', 'https://seller.example.test'],
    jwtSecret: buildValidTestSecret(),
    jwtIssuer: 'streetverse-api-test',
    jwtBuyerAudience: 'streetverse-buyer-test',
    jwtSellerAudience: 'streetverse-seller-test',
    jwtExpiresIn: '7d',
    redisUrl: 'redis://127.0.0.1:6399',
    customerDbUrl: 'postgresql://postgres:postgres@127.0.0.1:5433/test_customer',
    merchantDbUrl: 'postgresql://postgres:postgres@127.0.0.1:5434/test_merchant',
    aiEngineUrl: 'http://127.0.0.1:8000',
    ...overrides
  };
}

export async function runS11ConfigSecurityTests(): Promise<TestResult[]> {
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
  // 1. CONFIGURATION VALIDATION TESTS
  // -------------------------------------------------------------------------
  await runCase('Config: rejects missing and empty JWT_SECRET', () => {
    assertThrowsWithoutLeaking(() => validateJwtSecret(undefined), undefined, 'missing JWT_SECRET');
    assertThrowsWithoutLeaking(() => validateJwtSecret('   '), undefined, 'empty JWT_SECRET');
  });

  await runCase('Config: rejects JWT_SECRET shorter than 32 bytes without leaking value', () => {
    const shortSecret = 'short-secret-under-32-bytes';
    assertThrowsWithoutLeaking(() => validateJwtSecret(shortSecret), shortSecret, 'short JWT_SECRET');
  });

  await runCase('Config: rejects exposed legacy secret and placeholder values without leaking value', () => {
    const exposed = 'streetverse-secure-jwt-capstone-token-secret-2026';
    assertThrowsWithoutLeaking(() => validateJwtSecret(exposed), exposed, 'exposed legacy secret');

    for (const placeholder of [
      'YOUR_JWT_SECRET_VALUE_MUST_BE_LONG_ENOUGH',
      'CHANGE_ME_GENERATE_AT_LEAST_32_CHAR_RANDOM_SECRET',
      'REPLACE_WITH_MIN_32_BYTE_RANDOM_SECRET'
    ]) {
      assertThrowsWithoutLeaking(() => validateJwtSecret(placeholder), placeholder, 'placeholder secret');
    }
  });

  await runCase('Config: accepts valid randomly generated JWT_SECRET and preserves 7d default', () => {
    const secret = buildValidTestSecret();
    const cfg = parseGatewayConfig({
      NODE_ENV: 'test',
      JWT_SECRET: secret,
      ALLOWED_ORIGINS: 'http://localhost:3000'
    });
    assert(cfg.jwtSecret === secret, 'Parsed secret must match provided test secret');
    assert(cfg.jwtExpiresIn === '7d', 'Default JWT expiry must stay 7d');
    assert(cfg.jwtBuyerAudience !== cfg.jwtSellerAudience, 'Buyer and seller audiences must be distinct');
  });

  await runCase('Config: enforces development defaults vs explicit test and production ALLOWED_ORIGINS', () => {
    const secret = buildValidTestSecret();

    const devDefaults = parseGatewayConfig({ NODE_ENV: 'development', JWT_SECRET: secret });
    assert(
      devDefaults.allowedOrigins.length === 2 &&
        devDefaults.allowedOrigins.includes('http://localhost:3000') &&
        devDefaults.allowedOrigins.includes('http://localhost:3001'),
      'Development default origins must be localhost:3000 and localhost:3001'
    );

    assertThrowsWithoutLeaking(
      () => parseGatewayConfig({ NODE_ENV: 'test', JWT_SECRET: secret }),
      undefined,
      'missing test ALLOWED_ORIGINS'
    );

    assertThrowsWithoutLeaking(
      () => parseGatewayConfig({ NODE_ENV: 'production', JWT_SECRET: secret }),
      undefined,
      'missing production ALLOWED_ORIGINS'
    );

    assertThrowsWithoutLeaking(
      () => parseGatewayConfig({ NODE_ENV: 'staging', JWT_SECRET: secret, ALLOWED_ORIGINS: 'http://app.staging.local' }),
      undefined,
      'non-HTTPS staging origin'
    );

    const prodCfg = parseGatewayConfig({
      NODE_ENV: 'production',
      JWT_SECRET: secret,
      ALLOWED_ORIGINS: ' https://buyer.streetverse.in/ , https://seller.streetverse.in '
    });
    assert(
      prodCfg.allowedOrigins[0] === 'https://buyer.streetverse.in' &&
        prodCfg.allowedOrigins[1] === 'https://seller.streetverse.in',
      'Valid HTTPS production origins must be normalized cleanly'
    );
  });

  await runCase('Config: rejects wildcard, malformed URLs, non-HTTP(S), paths, credentials, queries, fragments', () => {
    for (const invalid of [
      '*',
      'https://*.streetverse.in',
      'not-a-valid-url',
      'ftp://files.streetverse.in',
      'https://buyer.streetverse.in/subpath',
      'https://user:pass@buyer.streetverse.in',
      'https://buyer.streetverse.in?token=1',
      'https://buyer.streetverse.in#section',
      'https://buyer.streetverse.in?'
    ]) {
      assertThrowsWithoutLeaking(
        () => parseAllowedOrigins(invalid, 'development'),
        undefined,
        `invalid origin: ${invalid}`
      );
    }
  });

  await runCase('Config: validates strict NODE_ENV values and rejects invalid names', () => {
    assert(validateNodeEnv(undefined) === 'development', 'Omitted NODE_ENV must default to development');
    for (const valid of ['development', 'test', 'staging', 'production', 'PRODUCTION', ' Development ']) {
      const parsed = validateNodeEnv(valid);
      assert(
        ['development', 'test', 'staging', 'production'].includes(parsed),
        `Expected valid NODE_ENV for ${valid}`
      );
    }

    const secret = buildValidTestSecret();
    for (const invalid of ['', '   ', 'dev', 'prod', 'local', 'producton', 'stage']) {
      assertThrowsWithoutLeaking(() => validateNodeEnv(invalid), undefined, `invalid NODE_ENV: "${invalid}"`);
      assertThrowsWithoutLeaking(
        () => parseGatewayConfig({ NODE_ENV: invalid, JWT_SECRET: secret }),
        secret,
        `parseGatewayConfig invalid NODE_ENV: "${invalid}"`
      );
      assertThrowsWithoutLeaking(
        () => parseAllowedOrigins(undefined, invalid),
        undefined,
        `parseAllowedOrigins invalid NODE_ENV: "${invalid}"`
      );
    }
  });

  await runCase('Config: loads temp .env files with OS > gateway > root precedence independent of cwd', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'streetverse-env-test-'));
    const unrelatedCwd = path.join(tmpBase, 'unrelated-cwd');
    const rootEnvPath = path.join(tmpBase, 'root.env');
    const gatewayEnvPath = path.join(tmpBase, 'gateway.env');
    const originalCwd = process.cwd();

    try {
      fs.mkdirSync(unrelatedCwd, { recursive: true });
      fs.writeFileSync(
        rootEnvPath,
        [
          'OS_OVERRIDE_VAR=from-root',
          'GATEWAY_OVERRIDE_VAR=from-root',
          'ROOT_ONLY_VAR=from-root-only'
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(
        gatewayEnvPath,
        [
          'OS_OVERRIDE_VAR=from-gateway',
          'GATEWAY_OVERRIDE_VAR=from-gateway'
        ].join('\n'),
        'utf8'
      );

      process.chdir(unrelatedCwd);

      const injectedEnv: NodeJS.ProcessEnv = {
        OS_OVERRIDE_VAR: 'from-os'
      };
      loadGatewayEnvFiles({
        gatewayEnvPath,
        rootEnvPath,
        targetEnv: injectedEnv,
        forceReload: true
      });

      assert(injectedEnv.OS_OVERRIDE_VAR === 'from-os', 'OS-injected value must never be overwritten');
      assert(injectedEnv.GATEWAY_OVERRIDE_VAR === 'from-gateway', 'Gateway .env must override root .env');
      assert(injectedEnv.ROOT_ONLY_VAR === 'from-root-only', 'Root .env must fill values absent from gateway .env');

      // Also verify default path resolution stays anchored to config directory regardless of cwd
      const resolved = resolveGatewayEnvPaths();
      assert(
        resolved.gatewayEnvPath.endsWith(path.join('services', 'api-gateway', '.env')),
        'Default gateway .env path must resolve independently of cwd'
      );
      assert(
        resolved.rootEnvPath.endsWith(path.join('StreetVerse', '.env')),
        'Default root .env path must resolve independently of cwd'
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. JWT ISSUER / AUDIENCE / ROLE CONSISTENCY TESTS (LIVE EXPRESS ROUTE)
  // -------------------------------------------------------------------------
  await runCase('JWT: issues distinct buyer/seller audiences and enforces iss, aud, role, secret & expiry on /me', async () => {
    const cfg = createIsolatedConfig();
    const buyerEmail = 'buyer.s11@example.test';
    const sellerEmail = 'seller.s11@example.test';

    const mockCustomerPool = {
      query: async (sql: string) => {
        if (/FROM users/i.test(sql)) {
          return {
            rows: [
              {
                id: 'buyer-uuid-001',
                phone: '+919900000001',
                full_name: 'Test Buyer',
                email: buyerEmail,
                home_address: 'Pune',
                preferred_language: 'en',
                is_verified: true,
                created_at: '2026-11-26T00:00:00.000Z'
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    };

    const mockMerchantPool = {
      query: async (sql: string) => {
        if (/FROM seller_accounts/i.test(sql)) {
          return {
            rows: [
              {
                id: 'seller-uuid-001',
                phone: '+919900000002',
                email: sellerEmail,
                is_email_verified: true,
                status: 'ACTIVE',
                created_at: '2026-11-26T00:00:00.000Z'
              }
            ],
            rowCount: 1
          };
        }
        if (/FROM store_memberships/i.test(sql)) {
          return {
            rows: [
              {
                store_id: 'store-uuid-001',
                business_name: 'Test Kirana',
                category: 'GROCERY',
                upi_vpa: 'test@okaxis',
                address: 'Pune',
                pincode: '411038',
                is_open: true,
                membership_id: 'mem-uuid-001',
                membership_role: 'OWNER',
                membership_status: 'ACTIVE'
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    };

    const mockRedis = createMockOtpRedis();
    const { server, io, emailService } = createGatewayApp(cfg, {
      customerPool: mockCustomerPool as any,
      merchantPool: mockMerchantPool as any,
      redis: mockRedis as any
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      await emailService.storeOtp('buyer', buyerEmail, '123456');
      const buyerRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/verify-otp',
        body: { email: buyerEmail, otp: '123456' }
      });
      assert(buyerRes.statusCode === 200, `Buyer OTP verify failed: ${buyerRes.statusCode}`);
      const buyerBody = JSON.parse(buyerRes.body);
      const buyerDecoded = jwt.verify(buyerBody.token, cfg.jwtSecret) as jwt.JwtPayload;
      assert(buyerDecoded.sub === 'buyer-uuid-001', 'Buyer sub mismatch');
      assert(buyerDecoded.role === 'BUYER', 'Buyer role mismatch');
      assert(buyerDecoded.iss === cfg.jwtIssuer, 'Buyer iss mismatch');
      assert(buyerDecoded.aud === cfg.jwtBuyerAudience, 'Buyer aud mismatch');

      await emailService.storeOtp('seller', sellerEmail, '654321');
      const sellerRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/verify-otp',
        body: { email: sellerEmail, otp: '654321' }
      });
      assert(sellerRes.statusCode === 200, `Seller OTP verify failed: ${sellerRes.statusCode}`);
      const sellerBody = JSON.parse(sellerRes.body);
      const sellerDecoded = jwt.verify(sellerBody.token, cfg.jwtSecret) as jwt.JwtPayload;
      assert(sellerDecoded.sub === 'seller-uuid-001', 'Seller sub mismatch');
      assert(sellerDecoded.role === 'SELLER', 'Seller role mismatch');
      assert(sellerDecoded.principalType === 'SELLER_ACCOUNT', 'Seller principalType mismatch');
      assert(sellerDecoded.iss === cfg.jwtIssuer, 'Seller iss mismatch');
      assert(sellerDecoded.aud === cfg.jwtSellerAudience, 'Seller aud mismatch');

      // Legacy Merchant-ID Seller token without principalType=SELLER_ACCOUNT must be rejected (401)
      const legacySellerToken = jwt.sign(
        { sub: 'store-uuid-001', role: 'SELLER', businessName: 'Test Kirana' },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtSellerAudience, expiresIn: '1h' }
      );
      const resLegacySeller = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${legacySellerToken}` }
      });
      assert(resLegacySeller.statusCode === 401, 'Legacy Merchant-ID seller token must be rejected');

      // Valid buyer & seller tokens accepted on /me with audience returned
      const meBuyer = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${buyerBody.token}` }
      });
      assert(meBuyer.statusCode === 200, 'Valid buyer token must pass /me');
      assert(JSON.parse(meBuyer.body).audience === cfg.jwtBuyerAudience, '/me must return buyer audience');

      const meSeller = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${sellerBody.token}` }
      });
      assert(meSeller.statusCode === 200, 'Valid seller token must pass /me');
      assert(JSON.parse(meSeller.body).audience === cfg.jwtSellerAudience, '/me must return seller audience');

      // Wrong secret
      const wrongSecretToken = jwt.sign(
        { sub: 'u1', role: 'BUYER' },
        buildValidTestSecret(),
        { issuer: cfg.jwtIssuer, audience: cfg.jwtBuyerAudience, expiresIn: '1h' }
      );
      const resWrongSecret = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${wrongSecretToken}` }
      });
      assert(resWrongSecret.statusCode === 401, 'Wrong secret token must be rejected');

      // Wrong issuer
      const wrongIssuerToken = jwt.sign(
        { sub: 'u1', role: 'BUYER' },
        cfg.jwtSecret,
        { issuer: 'other-issuer', audience: cfg.jwtBuyerAudience, expiresIn: '1h' }
      );
      const resWrongIssuer = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${wrongIssuerToken}` }
      });
      assert(resWrongIssuer.statusCode === 401, 'Wrong issuer token must be rejected');

      // Wrong audience
      const wrongAudToken = jwt.sign(
        { sub: 'u1', role: 'BUYER' },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: 'unknown-app', expiresIn: '1h' }
      );
      const resWrongAud = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${wrongAudToken}` }
      });
      assert(resWrongAud.statusCode === 401, 'Wrong audience token must be rejected');

      // Role/audience mismatch (BUYER role claiming SELLER audience)
      const mismatchToken = jwt.sign(
        { sub: 'u1', role: 'BUYER' },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtSellerAudience, expiresIn: '1h' }
      );
      const resMismatch = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${mismatchToken}` }
      });
      assert(resMismatch.statusCode === 401, 'Role/audience mismatch must be rejected');

      // Expired token
      const expiredToken = jwt.sign(
        { sub: 'u1', role: 'BUYER' },
        cfg.jwtSecret,
        { issuer: cfg.jwtIssuer, audience: cfg.jwtBuyerAudience, expiresIn: -10 }
      );
      const resExpired = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${expiredToken}` }
      });
      assert(resExpired.statusCode === 401, 'Expired token must be rejected');
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------
  // 3. EXPRESS & SOCKET.IO CORS TESTS
  // -------------------------------------------------------------------------
  await runCase('CORS: allows dev buyer/seller origins, blocks untrusted origins on Express and Socket.IO', async () => {
    const devCfg = parseGatewayConfig({ NODE_ENV: 'development', JWT_SECRET: buildValidTestSecret() });
    const { server, io } = createGatewayApp({ ...devCfg, port: 0 }, {
      customerPool: { query: async () => ({ rows: [], rowCount: 0 }), on: () => {}, end: async () => {} },
      merchantPool: { query: async () => ({ rows: [], rowCount: 0 }), on: () => {}, end: async () => {} },
      redis: { on: () => {} } as any
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      for (const trustedOrigin of ['http://localhost:3000', 'http://localhost:3001']) {
        const res = await httpRequest({
          port,
          method: 'GET',
          path: '/api/health',
          headers: { Origin: trustedOrigin }
        });
        assert(res.statusCode === 200, `Expected 200 for ${trustedOrigin}`);
        assert(
          res.headers['access-control-allow-origin'] === trustedOrigin,
          `Expected ACAO header ${trustedOrigin}, got ${res.headers['access-control-allow-origin']}`
        );
      }

      const untrustedRes = await httpRequest({
        port,
        method: 'GET',
        path: '/api/health',
        headers: { Origin: 'https://untrusted.attacker.test' }
      });
      assert(untrustedRes.statusCode === 403, `Expected 403 for untrusted origin, got ${untrustedRes.statusCode}`);
      assert(
        untrustedRes.headers['access-control-allow-origin'] === undefined,
        'Untrusted origin must never receive Access-Control-Allow-Origin header'
      );

      // Socket.IO polling handshake test using shared policy
      const sioAllowed = await httpRequest({
        port,
        method: 'GET',
        path: '/socket.io/?EIO=4&transport=polling',
        headers: { Origin: 'http://localhost:3000' }
      });
      assert(sioAllowed.statusCode === 200, `Expected 200 on Socket.IO polling for trusted origin, got ${sioAllowed.statusCode}`);
      assert(
        sioAllowed.headers['access-control-allow-origin'] === 'http://localhost:3000',
        'Socket.IO must allow configured origin'
      );

      const sioBlocked = await httpRequest({
        port,
        method: 'GET',
        path: '/socket.io/?EIO=4&transport=polling',
        headers: { Origin: 'https://untrusted.attacker.test' }
      });
      assert(
        sioBlocked.headers['access-control-allow-origin'] === undefined,
        'Socket.IO must never reflect untrusted origin in Access-Control-Allow-Origin'
      );
      assert(sioBlocked.statusCode !== 200, `Socket.IO must reject untrusted origin, got ${sioBlocked.statusCode}`);
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  await runCase('CORS: applies explicit HTTPS production allowlist consistently to Express and Socket.IO', async () => {
    const prodCfg = parseGatewayConfig({
      NODE_ENV: 'production',
      JWT_SECRET: buildValidTestSecret(),
      ALLOWED_ORIGINS: 'https://buyer.streetverse.in,https://seller.streetverse.in'
    });
    const { server, io } = createGatewayApp({ ...prodCfg, port: 0 }, {
      customerPool: { query: async () => ({ rows: [], rowCount: 0 }), on: () => {}, end: async () => {} },
      merchantPool: { query: async () => ({ rows: [], rowCount: 0 }), on: () => {}, end: async () => {} },
      redis: { on: () => {} } as any
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const allowedHttp = await httpRequest({
        port,
        method: 'GET',
        path: '/api/health',
        headers: { Origin: 'https://seller.streetverse.in' }
      });
      assert(allowedHttp.statusCode === 200, 'Configured production origin must succeed');
      assert(
        allowedHttp.headers['access-control-allow-origin'] === 'https://seller.streetverse.in',
        'Configured production origin must be returned'
      );

      const localhostInProd = await httpRequest({
        port,
        method: 'GET',
        path: '/api/health',
        headers: { Origin: 'http://localhost:3000' }
      });
      assert(localhostInProd.statusCode === 403, 'Localhost must be rejected in production unless explicitly listed');
      assert(localhostInProd.headers['access-control-allow-origin'] === undefined, 'Rejected origin must not get ACAO');

      const sioProdBlocked = await httpRequest({
        port,
        method: 'GET',
        path: '/socket.io/?EIO=4&transport=polling',
        headers: { Origin: 'http://localhost:3000' }
      });
      assert(sioProdBlocked.headers['access-control-allow-origin'] === undefined, 'Socket.IO must block unlisted origin in prod');
    } finally {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------
  // 4. STANDALONE EMAIL/OTP IMPORT CHECK (EXPLICIT REDIS INJECTION, NO SERVER NEEDED)
  // -------------------------------------------------------------------------
  await runCase('Email/OTP: works standalone with injected Redis without starting HTTP server or dotenv race', async () => {
    const emailService = createEmailService({
      redisClient: createMockOtpRedis() as any,
      nodeEnv: 'test'
    });
    const otp = generateOtp();
    assert(/^\d{6}$/.test(otp), 'Generated OTP must be 6 digits');
    await emailService.storeOtp('buyer', 'standalone.test@example.test', otp);
    const badAttempt = await emailService.verifyOtp('buyer', 'standalone.test@example.test', '000000');
    assert(!badAttempt.valid, 'Wrong OTP must fail verification');
    const goodAttempt = await emailService.verifyOtp('buyer', 'standalone.test@example.test', otp);
    assert(goodAttempt.valid, 'Valid OTP must pass standalone verification');
  });

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runS11ConfigSecurityTests()
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
      console.log(`\nS1.1 Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal S1.1 test error:', err);
      process.exit(1);
    });
}
