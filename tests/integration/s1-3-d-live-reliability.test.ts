/**
 * StreetVerse S1.3-D Live Reliability, Failure/Recovery, and Multi-Instance Verification Suite
 *
 * Executes strictly against ephemeral, dynamically ported Docker containers for:
 *   - PostgreSQL 16 Customer DB (`postgres:16-alpine`)
 *   - PostgreSQL 16 + PostGIS + pgvector Merchant DB (`pgvector/pgvector:pg16`)
 *   - Redis 7 (`redis:7-alpine`)
 *   - FastAPI AI Engine (`.venv` Uvicorn subprocess)
 *
 * Safety & Failure Policy:
 *   - Exits with code 2 (`BLOCKED / NOT RUN`) if Docker daemon is unavailable. Never fakes live results.
 *   - Never touches dev container names (`streetverse-customer-db`, `streetverse-merchant-db`, `streetverse-redis`),
 *     host DB ports (5432/5433/5434/6379/6380/8000), or existing Docker volumes.
 *   - Always shuts down gateway apps, stops Uvicorn, and removes only S1.3-D containers in `finally`.
 */

import { execFile, spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import { createRequire } from 'module';
import net, { AddressInfo } from 'net';
import path from 'path';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { createStrictPgPool, StrictPgPool, withPgTransaction } from '../../services/api-gateway/src/db/postgres';
import {
  closeManagedRedisClient,
  createManagedRedisClient,
  ensureRedisReady,
  ManagedRedisClient
} from '../../services/api-gateway/src/db/redis';
import {
  createEmailService,
  EmailTransporterLike,
  OTP_TTL_SECONDS
} from '../../services/api-gateway/src/services/email';
import { InfrastructureUnavailableError } from '../../services/api-gateway/src/utils/infraErrors';

const execFileAsync = promisify(execFile);

const gatewayRequire = createRequire(
  path.resolve(__dirname, '..', '..', 'services', 'api-gateway', 'package.json')
);
const RawRedis = gatewayRequire('ioredis') as new (...args: any[]) => any;

const RESERVED_DEV_CONTAINERS = new Set([
  'streetverse-customer-db',
  'streetverse-merchant-db',
  'streetverse-redis'
]);
const RESERVED_PORTS = new Set([5432, 5433, 5434, 6379, 6380, 8000]);

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

interface CapturedOtpEmail {
  to: string;
  subject: string;
  otp: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  failureMessage: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await delay(intervalMs);
  }
  const extra = lastError instanceof Error ? ` (${lastError.message})` : '';
  throw new Error(`${failureMessage}${extra}`);
}

async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', args, { timeout: 60000, encoding: 'utf8' });
}

async function listContainerNames(): Promise<string[]> {
  const { stdout } = await runDocker(['ps', '-a', '--format', '{{.Names}}']);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        server.close((err) => {
          if (err) reject(err);
          else resolve(addr.port);
        });
      });
    });
    if (!RESERVED_PORTS.has(port)) {
      return port;
    }
  }
  throw new Error('Failed to acquire an isolated non-reserved TCP port.');
}

async function httpRequest(options: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}): Promise<{ statusCode: number; body: string; json: any; elapsedMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        timeout: options.timeoutMs ?? 8000,
        headers: {
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload).toString()
              }
            : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({
            statusCode: res.statusCode || 0,
            body,
            json,
            elapsedMs: Date.now() - startedAt
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP request timed out (${options.method} ${options.path})`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeGatewayTestConfig(params: {
  customerDbUrl: string;
  merchantDbUrl: string;
  redisUrl: string;
  aiEngineUrl: string;
  jwtSecret: string;
}): GatewayConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    allowedOrigins: ['http://127.0.0.1:3000'],
    jwtSecret: params.jwtSecret,
    jwtIssuer: 'streetverse-api-s13d',
    jwtBuyerAudience: 'streetverse-buyer-s13d',
    jwtSellerAudience: 'streetverse-seller-s13d',
    jwtExpiresIn: '1h',
    redisUrl: params.redisUrl,
    customerDbUrl: params.customerDbUrl,
    merchantDbUrl: params.merchantDbUrl,
    aiEngineUrl: params.aiEngineUrl
  };
}

function createCapturingTransporter(): {
  transporter: EmailTransporterLike;
  emails: CapturedOtpEmail[];
} {
  const emails: CapturedOtpEmail[] = [];
  const transporter: EmailTransporterLike = {
    sendMail: async (mailOptions: any) => {
      const text = String(mailOptions?.text || '');
      const match = text.match(/\b(\d{6})\b/);
      emails.push({
        to: String(mailOptions?.to || ''),
        subject: String(mailOptions?.subject || ''),
        otp: match ? match[1] : ''
      });
      return { messageId: `s13d-${emails.length}` };
    }
  };
  return { transporter, emails };
}

async function connectRawRedis(redisUrl: string): Promise<any> {
  const client = new RawRedis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000
  });
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function startHttpServer(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  return (server.address() as AddressInfo).port;
}

async function waitForPostgresReady(containerName: string, user: string, dbName: string): Promise<void> {
  await waitForUntil(
    async () => {
      await runDocker(['exec', containerName, 'pg_isready', '-U', user, '-d', dbName]);
      return true;
    },
    30000,
    300,
    `PostgreSQL container "${containerName}" failed to become ready within 30s`
  );
}

async function waitForRedisContainerReady(containerName: string, redisPass: string): Promise<void> {
  await waitForUntil(
    async () => {
      const { stdout } = await runDocker([
        'exec',
        containerName,
        'redis-cli',
        '--no-auth-warning',
        '-a',
        redisPass,
        'ping'
      ]);
      return stdout.trim() === 'PONG';
    },
    20000,
    250,
    `Redis container "${containerName}" failed to become ready within 20s`
  );
}

async function waitForPoolQueryRecovery(pool: StrictPgPool): Promise<void> {
  await waitForUntil(
    async () => {
      const res = await pool.query('SELECT 1 AS ok');
      return res.rows[0]?.ok === 1;
    },
    20000,
    300,
    'PostgreSQL pool did not recover within 20s'
  );
}

async function waitForGatewayReady(port: number): Promise<void> {
  await waitForUntil(
    async () => {
      const res = await httpRequest({ port, method: 'GET', path: '/api/ready', timeoutMs: 4000 });
      return res.statusCode === 200 && res.json?.ready === true;
    },
    25000,
    300,
    `Gateway on port ${port} did not become ready within 25s`
  );
}

async function stopChildProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.killed) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Ignore already-exited child
      }
      resolve();
    }, 5000);
    timer.unref?.();
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function startUvicornAiEngine(port: number, merchantDbUrl: string): Promise<{
  proc: ChildProcess;
  logs: string[];
}> {
  const pythonExe = path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe');
  assert(fs.existsSync(pythonExe), `Expected Python venv executable at ${pythonExe}`);

  const logs: string[] = [];
  const proc = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'services.ai-agent-engine.main:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MERCHANT_DATABASE_URL: merchantDbUrl,
        GEMINI_API_KEY: '',
        GOOGLE_API_KEY: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  proc.stdout?.on('data', (chunk) => logs.push(chunk.toString('utf8')));
  proc.stderr?.on('data', (chunk) => logs.push(chunk.toString('utf8')));

  await waitForUntil(
    async () => {
      if (proc.exitCode !== null) {
        throw new Error(`Uvicorn exited early with code ${proc.exitCode}: ${logs.join('').slice(-600)}`);
      }
      const res = await httpRequest({ port, method: 'GET', path: '/health', timeoutMs: 2000 });
      return res.statusCode === 200;
    },
    20000,
    250,
    `FastAPI AI Engine did not respond healthy on port ${port}`
  );

  return { proc, logs };
}

async function runSuite(): Promise<void> {
  try {
    await runDocker(['info']);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message.split(/\r?\n/)[0] : 'Docker daemon unavailable';
    console.error(
      `BLOCKED: Docker daemon is unavailable (${detail}). S1.3-D live PostgreSQL, Redis, multi-instance, and AI engine reliability tests were NOT RUN.`
    );
    process.exit(2);
  }

  const runId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const custContainer = `streetverse-s13d-cust-${runId}`;
  const merchContainer = `streetverse-s13d-merch-${runId}`;
  const redisContainer = `streetverse-s13d-redis-${runId}`;

  assert(
    !RESERVED_DEV_CONTAINERS.has(custContainer) &&
      !RESERVED_DEV_CONTAINERS.has(merchContainer) &&
      !RESERVED_DEV_CONTAINERS.has(redisContainer),
    'Refusing to run against reserved dev container names.'
  );

  const preExistingContainers = await listContainerNames();
  const createdContainers: string[] = [];

  const custPort = await getFreePort();
  const merchPort = await getFreePort();
  const redisPort = await getFreePort();
  const aiPort = await getFreePort();

  const custDbName = 'sv_s13d_customer';
  const merchDbName = 'sv_s13d_merchant';
  const pgUser = 'postgres';
  const pgPass = crypto.randomBytes(12).toString('hex');
  const redisPass = crypto.randomBytes(12).toString('hex');
  const jwtSecret = crypto.randomBytes(36).toString('base64url');

  const customerDbUrl = `postgresql://${pgUser}:${pgPass}@127.0.0.1:${custPort}/${custDbName}`;
  const merchantDbUrl = `postgresql://${pgUser}:${pgPass}@127.0.0.1:${merchPort}/${merchDbName}`;
  const redisUrl = `redis://:${redisPass}@127.0.0.1:${redisPort}`;
  const aiEngineUrl = `http://127.0.0.1:${aiPort}`;

  const activeShutdowns: Array<() => Promise<unknown>> = [];
  const activePools: StrictPgPool[] = [];
  const activeRedisClients: ManagedRedisClient[] = [];
  const activeRawRedisClients: any[] = [];
  let aiProc: ChildProcess | null = null;

  const results: TestResult[] = [];
  async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
    const startedAt = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, durationMs: Date.now() - startedAt });
    } catch (err: unknown) {
      results.push({
        name,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.stack || err.message : String(err)
      });
    }
  }

  try {
    console.log(`[S1.3-D] Starting isolated ephemeral containers (${runId}) on ports cust=${custPort}, merch=${merchPort}, redis=${redisPort}...`);

    await runDocker([
      'run',
      '-d',
      '--name',
      custContainer,
      '-p',
      `127.0.0.1:${custPort}:5432`,
      '-e',
      `POSTGRES_USER=${pgUser}`,
      '-e',
      `POSTGRES_PASSWORD=${pgPass}`,
      '-e',
      `POSTGRES_DB=${custDbName}`,
      'postgres:16-alpine'
    ]);
    createdContainers.push(custContainer);

    await runDocker([
      'run',
      '-d',
      '--name',
      merchContainer,
      '-p',
      `127.0.0.1:${merchPort}:5432`,
      '-e',
      `POSTGRES_USER=${pgUser}`,
      '-e',
      `POSTGRES_PASSWORD=${pgPass}`,
      '-e',
      `POSTGRES_DB=${merchDbName}`,
      'pgvector/pgvector:pg16'
    ]);
    createdContainers.push(merchContainer);

    await runDocker([
      'run',
      '-d',
      '--name',
      redisContainer,
      '-p',
      `127.0.0.1:${redisPort}:6379`,
      'redis:7-alpine',
      'redis-server',
      '--requirepass',
      redisPass
    ]);
    createdContainers.push(redisContainer);

    await Promise.all([
      waitForPostgresReady(custContainer, pgUser, custDbName),
      waitForPostgresReady(merchContainer, pgUser, merchDbName),
      waitForRedisContainerReady(redisContainer, redisPass)
    ]);

    const probeCustomerPool = createStrictPgPool(customerDbUrl, 'customer');
    const probeMerchantPool = createStrictPgPool(merchantDbUrl, 'merchant');
    activePools.push(probeCustomerPool, probeMerchantPool);

    await Promise.all([
      waitForPoolQueryRecovery(probeCustomerPool),
      waitForPoolQueryRecovery(probeMerchantPool)
    ]);

    const customerSchemaSql = fs.readFileSync(
      path.resolve(process.cwd(), 'packages', 'database-schemas', 'customer-db', 'schema.sql'),
      'utf8'
    );
    const merchantSchemaSql = fs.readFileSync(
      path.resolve(process.cwd(), 'packages', 'database-schemas', 'merchant-db', 'schema.sql'),
      'utf8'
    );

    await probeCustomerPool.query(customerSchemaSql);
    await probeMerchantPool.query(merchantSchemaSql);

    // Seed real merchant inventory + service slot + unverified merchant fixture
    const seededMerchantRes = await probeMerchantPool.query(
      `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, upi_vpa, address, pincode, latitude, longitude, is_open, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, false)
       RETURNING id`,
      [
        'S13D Roast House',
        'RESTAURANT',
        '+919800001001',
        'roast-s13d@example.test',
        'hashed_unused_for_seed',
        's13droast@upi',
        '101 Test Lane',
        '411038',
        18.5074,
        73.8077
      ]
    );
    const seededMerchantId: string = seededMerchantRes.rows[0].id;

    const seededSellerAcctRes = await probeMerchantPool.query(
      `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
       VALUES ($1, $2, $3, true, 'ACTIVE')
       RETURNING id`,
      ['+919800001001', 'roast-s13d@example.test', 'hashed_unused_for_seed']
    );
    const seededSellerAccountId: string = seededSellerAcctRes.rows[0].id;

    await probeMerchantPool.query(
      `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status)
       VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
      [seededSellerAccountId, seededMerchantId]
    );

    const seededSellerOwnerJwt = jwt.sign(
      { sub: seededSellerAccountId, role: 'SELLER', principalType: 'SELLER_ACCOUNT' },
      jwtSecret,
      { issuer: 'streetverse-api-s13d', audience: 'streetverse-seller-s13d', expiresIn: '1h' }
    );

    const seededItemRes = await probeMerchantPool.query(
      `INSERT INTO inventory_items (merchant_id, item_name, category, description, price, stock_quantity, is_available)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id`,
      [seededMerchantId, 'Artisan Filter Coffee', 'RESTAURANT', 'Fresh roasted single origin', 149.0, 25]
    );
    const seededItemId: string = seededItemRes.rows[0].id;

    const seededSlotRes = await probeMerchantPool.query(
      `INSERT INTO service_slots (merchant_id, service_name, slot_start, slot_end, capacity, booked_count, price, status)
       VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '2 hours', CURRENT_TIMESTAMP + INTERVAL '3 hours', 1, 0, 499.0, 'AVAILABLE')
       RETURNING id`,
      [seededMerchantId, 'Coffee Tasting Session']
    );
    const seededSlotId: string = seededSlotRes.rows[0].id;

    // -----------------------------------------------------------------------
    // Case 1: Real PostgreSQL dual-DB separation, constraints, and withPgTransaction
    // -----------------------------------------------------------------------
    await runCase('Real PostgreSQL dual-DB separation and withPgTransaction behavior', async () => {
      const custInfo = await probeCustomerPool.query('SELECT current_database() AS db');
      const merchInfo = await probeMerchantPool.query('SELECT current_database() AS db');
      assert(custInfo.rows[0].db === custDbName, `Expected customer DB ${custDbName}, got ${custInfo.rows[0].db}`);
      assert(merchInfo.rows[0].db === merchDbName, `Expected merchant DB ${merchDbName}, got ${merchInfo.rows[0].db}`);

      const extRes = await probeMerchantPool.query(
        "SELECT extname FROM pg_extension WHERE extname IN ('cube', 'earthdistance', 'vector')"
      );
      assert(extRes.rows.length === 3, `Expected PostGIS/pgvector extensions installed, found ${extRes.rows.length}`);

      await probeCustomerPool.query('CREATE TABLE IF NOT EXISTS s13d_tx_probe (id SERIAL PRIMARY KEY, val TEXT NOT NULL)');
      try {
        // 1. Commit persists
        await withPgTransaction(probeCustomerPool, async (client) => {
          await client.query('INSERT INTO s13d_tx_probe (val) VALUES ($1)', ['committed-row']);
        });
        const committedCount = await probeCustomerPool.query(
          "SELECT count(*)::int AS c FROM s13d_tx_probe WHERE val = 'committed-row'"
        );
        assert(committedCount.rows[0].c === 1, 'Expected committed transaction row to persist.');

        // 2. Thrown error rolls back cleanly
        let rolledBackErr = false;
        try {
          await withPgTransaction(probeCustomerPool, async (client) => {
            await client.query('INSERT INTO s13d_tx_probe (val) VALUES ($1)', ['rolled-back-row']);
            throw new Error('Intentional S13D rollback trigger');
          });
        } catch (err: any) {
          rolledBackErr = /Intentional S13D rollback trigger/.test(String(err?.message || ''));
        }
        assert(rolledBackErr, 'Expected withPgTransaction to rethrow callback error.');
        const rolledBackCount = await probeCustomerPool.query(
          "SELECT count(*)::int AS c FROM s13d_tx_probe WHERE val = 'rolled-back-row'"
        );
        assert(rolledBackCount.rows[0].c === 0, 'Expected rolled-back row not to persist.');

        // 3. client.release() under constrained max: 2 pool across 12 sequential/concurrent transactions
        const smallPool = createStrictPgPool(customerDbUrl, 'customer', { max: 2, connectionTimeoutMillis: 2500 });
        activePools.push(smallPool);
        await Promise.all(
          Array.from({ length: 12 }, (_, idx) =>
            withPgTransaction(smallPool, async (client) => {
              await client.query('INSERT INTO s13d_tx_probe (val) VALUES ($1)', [`pool-tx-${idx}`]);
            })
          )
        );
        const batchCount = await smallPool.query("SELECT count(*)::int AS c FROM s13d_tx_probe WHERE val LIKE 'pool-tx-%'");
        assert(batchCount.rows[0].c === 12, `Expected 12 committed pooled rows, got ${batchCount.rows[0].c}`);
        await smallPool.end();

        // 4. Mid-transaction backend termination at COMMIT propagates without blind retry
        let txAttempts = 0;
        let commitDropCaught = false;
        try {
          await withPgTransaction(probeCustomerPool, async (client) => {
            txAttempts += 1;
            await client.query('INSERT INTO s13d_tx_probe (val) VALUES ($1)', ['commit-drop-probe']);
            await client.query('SELECT pg_terminate_backend(pg_backend_pid())').catch(() => {});
          });
        } catch {
          commitDropCaught = true;
        }
        assert(commitDropCaught, 'Expected terminated transaction backend to surface an error rather than faking success.');
        assert(txAttempts === 1, `Expected zero automatic retries on dropped COMMIT, saw ${txAttempts}`);

        const recoveryRes = await probeCustomerPool.query('SELECT 1 AS ok');
        assert(recoveryRes.rows[0]?.ok === 1, 'Pool should stay usable after terminated transaction cleanup.');
      } finally {
        await probeCustomerPool.query('DROP TABLE IF EXISTS s13d_tx_probe').catch(() => {});
      }
    });

    // -----------------------------------------------------------------------
    // Case 2: Real Redis 7 Lua OTP atomic scripts, ACL/READONLY failure, & offline queue disabled
    // -----------------------------------------------------------------------
    await runCase('Real Redis 7 Lua OTP atomicity, ownership, ACL/READONLY fail-closed, and reconnect', async () => {
      const adminRedis = await connectRawRedis(redisUrl);
      activeRawRedisClients.push(adminRedis);
      assert((await adminRedis.ping()) === 'PONG', 'Admin Redis ping failed');

      const managedRedis = createManagedRedisClient(redisUrl);
      activeRedisClients.push(managedRedis);
      const getManagedStatus = (): string => String(managedRedis.status);
      assert(getManagedStatus() === 'wait', `Expected initial lazyConnect status=wait, got ${managedRedis.status}`);

      // Concurrent initial ensureRedisReady deduplication
      const readies = await Promise.all([
        ensureRedisReady(managedRedis),
        ensureRedisReady(managedRedis),
        ensureRedisReady(managedRedis)
      ]);
      assert(readies.every((c) => c === managedRedis) && getManagedStatus() === 'ready', 'Expected deduplicated initial ready state.');

      const { transporter } = createCapturingTransporter();
      const emailService = createEmailService({
        redisClient: managedRedis,
        nodeEnv: 'test',
        transporter
      });

      // STORE_OTP_LUA & TTL checks + single-use VERIFY_OTP_LUA
      const tokenA = await emailService.storeOtp('buyer', 'lua-live@example.test', '111222');
      assert(typeof tokenA === 'string' && tokenA.length === 32, 'Expected 32-char hex owner token.');
      const otpTtl = await adminRedis.ttl('otp:buyer:lua-live@example.test');
      assert(otpTtl > 0 && otpTtl <= OTP_TTL_SECONDS, `Expected TTL in (0, ${OTP_TTL_SECONDS}], got ${otpTtl}`);

      const okVerify = await emailService.verifyOtp('buyer', 'lua-live@example.test', '111222');
      assert(okVerify.valid === true, `Expected valid OTP match, got ${okVerify.reason}`);
      const replayVerify = await emailService.verifyOtp('buyer', 'lua-live@example.test', '111222');
      assert(replayVerify.valid === false, 'Expected single-use OTP replay rejection.');

      // 3-strike lockout test
      await emailService.storeOtp('buyer', 'lockout-live@example.test', '333444');
      const miss1 = await emailService.verifyOtp('buyer', 'lockout-live@example.test', '000001');
      const miss2 = await emailService.verifyOtp('buyer', 'lockout-live@example.test', '000002');
      const miss3 = await emailService.verifyOtp('buyer', 'lockout-live@example.test', '000003');
      assert(!miss1.valid && miss1.reason?.includes('2 attempts remaining'), `Expected 2 remaining, got ${miss1.reason}`);
      assert(!miss2.valid && miss2.reason?.includes('1 attempts remaining'), `Expected 1 remaining, got ${miss2.reason}`);
      assert(!miss3.valid && miss3.reason?.includes('Too many incorrect attempts'), `Expected LOCKED, got ${miss3.reason}`);
      assert((await adminRedis.get('otp:buyer:lockout-live@example.test')) === null, 'Locked OTP key should be deleted.');
      assert((await emailService.verifyOtp('buyer', 'lockout-live@example.test', '333444')).valid === false, 'Original OTP must not verify after lockout.');

      // Ownership-checked RELEASE_OTP_LUA: stale token cannot delete newer OTP
      const oldToken = await emailService.storeOtp('buyer', 'owner-live@example.test', '555666');
      const newToken = await emailService.storeOtp('buyer', 'owner-live@example.test', '777888');
      await emailService.invalidateOtpIfOwned('buyer', 'owner-live@example.test', oldToken);
      assert((await adminRedis.get('otp:buyer:owner-live@example.test')) === '777888', 'Stale token must NOT delete newer OTP.');
      await emailService.invalidateOtpIfOwned('buyer', 'owner-live@example.test', newToken);
      assert((await adminRedis.get('otp:buyer:owner-live@example.test')) === null, 'Matching owner token must delete OTP.');

      // Real Redis TTL expiry on VERIFY_OTP_LUA
      await emailService.storeOtp('buyer', 'expire-live@example.test', '888999');
      await adminRedis.expire('otp:buyer:expire-live@example.test', 1);
      await delay(1200);
      const expiredVerify = await emailService.verifyOtp('buyer', 'expire-live@example.test', '888999');
      assert(
        expiredVerify.valid === false && expiredVerify.reason?.includes('expired'),
        `Expected expired OTP reason, got ${expiredVerify.reason}`
      );

      // Cooldown RELEASE_COOLDOWN_LUA ownership + real Redis TTL expiry
      const cdFirst = await emailService.acquireResendCooldown('resend:buyer', 'cd-live@example.test', 2);
      assert(cdFirst.allowed && typeof cdFirst.token === 'string', 'First cooldown acquisition should succeed.');
      const cdBlocked = await emailService.acquireResendCooldown('resend:buyer', 'cd-live@example.test', 2);
      assert(!cdBlocked.allowed && (cdBlocked.retryAfterSeconds ?? 0) > 0, 'Active cooldown must block immediate second request.');
      await emailService.clearResendCooldown('resend:buyer', 'cd-live@example.test', 'wrong-token-000');
      assert((await emailService.acquireResendCooldown('resend:buyer', 'cd-live@example.test', 2)).allowed === false, 'Wrong token must not clear active cooldown.');
      await delay(2200);
      const cdExpired = await emailService.acquireResendCooldown('resend:buyer', 'cd-live@example.test', 45);
      assert(cdExpired.allowed && typeof cdExpired.token === 'string', 'Expired cooldown must allow new acquisition.');
      await emailService.clearResendCooldown('resend:buyer', 'cd-live@example.test', cdExpired.token!);

      // Real Redis READONLY failure via REPLICAOF
      await adminRedis.call('REPLICAOF', '127.0.0.1', '1');
      let readonlyFailed = false;
      try {
        await emailService.storeOtp('buyer', 'readonly-live@example.test', '999000');
      } catch (err) {
        readonlyFailed = err instanceof InfrastructureUnavailableError && err.errorCode === 'REDIS_UNAVAILABLE';
      } finally {
        await adminRedis.call('REPLICAOF', 'NO', 'ONE');
      }
      assert(readonlyFailed, 'Expected READONLY Redis failure to throw REDIS_UNAVAILABLE cleanly.');
      assert((await adminRedis.get('otp:buyer:readonly-live@example.test')) === null, 'Zero OTP state on READONLY failure.');

      // Real Redis 7 ACL denial on otp:* pattern fails closed with zero OTP state stored
      const aclUser = `s13d_partial_${crypto.randomBytes(4).toString('hex')}`;
      const aclPass = crypto.randomBytes(8).toString('hex');
      await adminRedis.call(
        'ACL',
        'SETUSER',
        aclUser,
        'on',
        `>${aclPass}`,
        '+ping',
        '+info',
        '+eval',
        '+get',
        '+del',
        '+set',
        '~otp_owner:*',
        '~otp_attempts:*',
        '%R~otp:*'
      );
      const aclUrl = `redis://${aclUser}:${aclPass}@127.0.0.1:${redisPort}`;
      const aclClient = createManagedRedisClient(aclUrl);
      activeRedisClients.push(aclClient);
      const aclEmailService = createEmailService({ redisClient: aclClient, nodeEnv: 'test', transporter });
      let aclFailed = false;
      try {
        await aclEmailService.storeOtp('buyer', 'acl-live@example.test', '444555');
      } catch (err) {
        aclFailed =
          err instanceof InfrastructureUnavailableError ||
          (err instanceof Error && /NOPERM/i.test(err.message));
      } finally {
        await closeManagedRedisClient(aclClient, true).catch(() => {});
        await adminRedis.del('otp_owner:buyer:acl-live@example.test').catch(() => {});
        await adminRedis.call('ACL', 'DELUSER', aclUser).catch(() => {});
      }
      assert(aclFailed, 'Expected partial ACL write denial to fail closed without storing OTP state.');
      assert((await adminRedis.get('otp:buyer:acl-live@example.test')) === null, 'Zero valid OTP key on ACL failure.');
      assert((await adminRedis.get('otp_attempts:buyer:acl-live@example.test')) === null, 'Zero attempts key on ACL failure.');
      assert((await adminRedis.get('otp_owner:buyer:acl-live@example.test')) === null, 'Zero owner key left on ACL failure.');

      // Command fail-closed while stopped + zero offline queue replay after docker start
      adminRedis.disconnect();
      await runDocker(['stop', redisContainer]);
      let offlineRejected = false;
      try {
        await emailService.storeOtp('buyer', 'offline-noreplay@example.test', '123321');
      } catch (err) {
        offlineRejected = err instanceof InfrastructureUnavailableError;
      }
      assert(offlineRejected, 'Expected immediate rejection while Redis is stopped.');

      await runDocker(['start', redisContainer]);
      await waitForRedisContainerReady(redisContainer, redisPass);
      const adminPostRestart = await connectRawRedis(redisUrl);
      activeRawRedisClients.push(adminPostRestart);
      assert((await adminPostRestart.ping()) === 'PONG', 'Post-restart admin Redis ping failed');
      assert(
        (await adminPostRestart.get('otp:buyer:offline-noreplay@example.test')) === null,
        'Rejected offline command must NOT replay after Redis restarts.'
      );
      adminPostRestart.disconnect();
      await waitForUntil(
        async () => {
          try {
            await emailService.storeOtp('buyer', 'post-recovery@example.test', '654456');
            return true;
          } catch {
            return false;
          }
        },
        20000,
        300,
        'Managed Redis client did not recover for subsequent OTP write after Redis container restart'
      );
      await closeManagedRedisClient(managedRedis, true);
    });

    // -----------------------------------------------------------------------
    // Case 3: Single-instance live outage and recovery (Redis, Customer PG, Merchant PG, Combined)
    // -----------------------------------------------------------------------
    await runCase('Single-instance outage & recovery against real Redis, Customer PG, Merchant PG', async () => {
      const { transporter, emails } = createCapturingTransporter();
      const gw = createGatewayApp(
        makeGatewayTestConfig({ customerDbUrl, merchantDbUrl, redisUrl, aiEngineUrl, jwtSecret }),
        { emailTransporter: transporter }
      );
      activeShutdowns.push(gw.shutdown);
      const port = await startHttpServer(gw.server);

      await waitForGatewayReady(port);
      const liveness = await httpRequest({ port, method: 'GET', path: '/api/health' });
      assert(liveness.statusCode === 200 && liveness.json?.status === 'healthy', 'Expected /api/health 200');
      const nodeStatus = await httpRequest({ port, method: 'GET', path: '/api/v1/server/node-status' });
      assert(nodeStatus.statusCode === 200 && nodeStatus.json?.success === true, 'Expected node-status 200');

      const buyerEmail = `single-buyer-${runId}@example.test`;
      const regRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/register',
        body: {
          phone: '+919800002001',
          full_name: 'S13D Single Buyer',
          email: buyerEmail,
          password: 'Password123',
          home_address: 'Pune'
        }
      });
      assert(regRes.statusCode === 201, `Expected buyer register 201, got ${regRes.statusCode}: ${regRes.body}`);
      const regOtp = emails[emails.length - 1]?.otp;
      assert(/^\d{6}$/.test(regOtp), 'Expected 6-digit registration OTP captured');

      const verRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/verify-otp',
        body: { email: buyerEmail, otp: regOtp }
      });
      assert(verRes.statusCode === 200 && typeof verRes.json?.token === 'string', 'Expected buyer OTP verification JWT');

      // 3a. Redis outage -> /api/health 200, /api/ready 503, OTP routes 503 + zero SMTP, then recover
      await runDocker(['stop', redisContainer]);
      const smtpBeforeRedisDown = emails.length;
      const readyRedisDown = await httpRequest({ port, method: 'GET', path: '/api/ready' });
      assert(readyRedisDown.statusCode === 503 && readyRedisDown.json?.checks?.redis?.status === 'down', 'Expected redis=down 503');
      assert(readyRedisDown.json?.checks?.customerDb?.status === 'up', 'Expected customerDb=up during Redis outage');
      assert(readyRedisDown.json?.checks?.merchantDb?.status === 'up', 'Expected merchantDb=up during Redis outage');
      const healthRedisDown = await httpRequest({ port, method: 'GET', path: '/api/health' });
      assert(healthRedisDown.statusCode === 200, '/api/health must remain 200 during Redis outage');
      const otpDuringRedisDown = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/resend-otp',
        body: { scope: 'buyer', email: buyerEmail }
      });
      assert(otpDuringRedisDown.statusCode === 503, `Expected resend-otp 503 during Redis outage, got ${otpDuringRedisDown.statusCode}`);
      assert(emails.length === smtpBeforeRedisDown, 'Must dispatch zero SMTP emails during Redis outage.');

      await runDocker(['start', redisContainer]);
      await waitForRedisContainerReady(redisContainer, redisPass);
      await waitForGatewayReady(port);

      // 3b. Customer PG outage -> /api/health 200, /api/ready 503, buyer auth 503, search 200, recover
      await runDocker(['stop', custContainer]);
      const smtpBeforeCustDown = emails.length;
      const readyCustDown = await httpRequest({ port, method: 'GET', path: '/api/ready' });
      assert(readyCustDown.statusCode === 503 && readyCustDown.json?.checks?.customerDb?.status === 'down', 'Expected customerDb=down 503');
      assert(readyCustDown.json?.checks?.merchantDb?.status === 'up', 'Expected merchantDb=up');
      const buyerLoginCustDown = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: buyerEmail, password: 'Password123' }
      });
      assert(buyerLoginCustDown.statusCode === 503, `Expected buyer login 503 when Customer PG stopped, got ${buyerLoginCustDown.statusCode}`);
      assert(emails.length === smtpBeforeCustDown, 'Must send zero SMTP emails during Customer PG outage.');

      const searchDuringCustDown = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/search/hyperlocal?q=Coffee&lat=18.5074&lon=73.8077&radius=10'
      });
      assert(searchDuringCustDown.statusCode === 200 && searchDuringCustDown.json?.total_found >= 1, 'Merchant search must stay 200 while Customer PG is down');

      await runDocker(['start', custContainer]);
      await waitForPostgresReady(custContainer, pgUser, custDbName);
      await waitForGatewayReady(port);

      // 3c. Merchant PG outage -> /api/health 200, /api/ready 503, search & KYC 503, recover
      await runDocker(['stop', merchContainer]);
      const readyMerchDown = await httpRequest({ port, method: 'GET', path: '/api/ready' });
      assert(readyMerchDown.statusCode === 503 && readyMerchDown.json?.checks?.merchantDb?.status === 'down', 'Expected merchantDb=down 503');
      const searchMerchDown = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/search/hyperlocal?q=Coffee&lat=18.5074&lon=73.8077&radius=10'
      });
      assert(searchMerchDown.statusCode === 503, `Expected hyperlocal search 503 when Merchant PG down, got ${searchMerchDown.statusCode}`);
      const kycMerchDown = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${seededSellerOwnerJwt}` },
        body: { merchantId: seededMerchantId, documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert(kycMerchDown.statusCode === 503, `Expected KYC 503 when Merchant PG down, got ${kycMerchDown.statusCode}`);

      await runDocker(['start', merchContainer]);
      await waitForPostgresReady(merchContainer, pgUser, merchDbName);
      await waitForGatewayReady(port);

      // 3d. Combined Redis + Customer PG outage -> both reported down in /api/ready -> full recovery
      await Promise.all([runDocker(['stop', redisContainer]), runDocker(['stop', custContainer])]);
      const readyCombinedDown = await httpRequest({ port, method: 'GET', path: '/api/ready' });
      assert(readyCombinedDown.statusCode === 503, 'Expected combined outage /api/ready 503');
      assert(readyCombinedDown.json?.checks?.redis?.status === 'down', 'Expected redis=down in combined outage');
      assert(readyCombinedDown.json?.checks?.customerDb?.status === 'down', 'Expected customerDb=down in combined outage');
      assert(readyCombinedDown.json?.checks?.merchantDb?.status === 'up', 'Expected merchantDb=up in combined outage');
      assert((await httpRequest({ port, method: 'GET', path: '/api/health' })).statusCode === 200, '/api/health must stay 200 in combined outage');

      await Promise.all([runDocker(['start', redisContainer]), runDocker(['start', custContainer])]);
      await Promise.all([
        waitForRedisContainerReady(redisContainer, redisPass),
        waitForPostgresReady(custContainer, pgUser, custDbName)
      ]);
      await waitForGatewayReady(port);

      const postRecoverySearch = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/search/hyperlocal?q=Coffee&lat=18.5074&lon=73.8077&radius=10'
      });
      assert(postRecoverySearch.statusCode === 200 && postRecoverySearch.json?.total_found >= 1, 'Expected post-recovery search 200 with seeded item');

      await gw.shutdown();
    });

    // -----------------------------------------------------------------------
    // Case 4: Multi-instance shared OTP/cooldown/DB state, outage, and shutdown isolation
    // -----------------------------------------------------------------------
    await runCase('Multi-instance OTP, cooldown, Redis outage, and shutdown isolation', async () => {
      const capA = createCapturingTransporter();
      const capB = createCapturingTransporter();
      const gwA = createGatewayApp(
        makeGatewayTestConfig({ customerDbUrl, merchantDbUrl, redisUrl, aiEngineUrl, jwtSecret }),
        { emailTransporter: capA.transporter }
      );
      const gwB = createGatewayApp(
        makeGatewayTestConfig({ customerDbUrl, merchantDbUrl, redisUrl, aiEngineUrl, jwtSecret }),
        { emailTransporter: capB.transporter }
      );
      activeShutdowns.push(gwA.shutdown, gwB.shutdown);

      const portA = await startHttpServer(gwA.server);
      const portB = await startHttpServer(gwB.server);
      await Promise.all([waitForGatewayReady(portA), waitForGatewayReady(portB)]);

      const sharedBuyerEmail = `multi-buyer-${runId}@example.test`;
      const regA = await httpRequest({
        port: portA,
        method: 'POST',
        path: '/api/v1/auth/buyer/register',
        body: {
          phone: '+919800003001',
          full_name: 'S13D Multi Buyer',
          email: sharedBuyerEmail,
          password: 'Password123',
          home_address: 'Pune'
        }
      });
      assert(regA.statusCode === 201, `Expected Instance A register 201, got ${regA.statusCode}`);
      const otpFromA = capA.emails[capA.emails.length - 1]?.otp;
      assert(/^\d{6}$/.test(otpFromA), 'Expected OTP email captured on Instance A');

      // Cross-instance verification on Instance B
      const verifyB = await httpRequest({
        port: portB,
        method: 'POST',
        path: '/api/v1/auth/buyer/verify-otp',
        body: { email: sharedBuyerEmail, otp: otpFromA }
      });
      assert(verifyB.statusCode === 200 && typeof verifyB.json?.token === 'string', 'Instance B must verify OTP stored by Instance A.');

      // Replay back on Instance A must fail
      const replayA = await httpRequest({
        port: portA,
        method: 'POST',
        path: '/api/v1/auth/buyer/verify-otp',
        body: { email: sharedBuyerEmail, otp: otpFromA }
      });
      assert(replayA.statusCode === 400, `Expected replay on Instance A to fail 400, got ${replayA.statusCode}`);

      // Cross-instance JWT + email-change OTP interoperability (request on B -> verify on A)
      const meOnA = await httpRequest({
        port: portA,
        method: 'GET',
        path: '/api/v1/auth/me',
        headers: { Authorization: `Bearer ${verifyB.json.token}` }
      });
      assert(meOnA.statusCode === 200 && meOnA.json?.authenticated === true, 'JWT from Instance B must authenticate on Instance A.');

      const changedEmail = `multi-buyer-new-${runId}@example.test`;
      const reqEmailChangeB = await httpRequest({
        port: portB,
        method: 'POST',
        path: '/api/user/request-email-change',
        headers: { Authorization: `Bearer ${verifyB.json.token}` },
        body: { newEmail: changedEmail }
      });
      assert(reqEmailChangeB.statusCode === 200, `Expected Instance B email-change request 200, got ${reqEmailChangeB.statusCode}`);
      const changeOtp = capB.emails[capB.emails.length - 1]?.otp;
      assert(/^\d{6}$/.test(changeOtp), 'Expected email-change OTP on Instance B');
      const verifyEmailChangeA = await httpRequest({
        port: portA,
        method: 'POST',
        path: '/api/user/verify-email-change',
        headers: { Authorization: `Bearer ${verifyB.json.token}` },
        body: { newEmail: changedEmail, otp: changeOtp }
      });
      assert(
        verifyEmailChangeA.statusCode === 200 && verifyEmailChangeA.json?.user?.email === changedEmail,
        'Instance A must verify email-change OTP issued by Instance B.'
      );
      const updatedBuyerEmail = changedEmail;

      // Cross-instance resend cooldown (A sends, B enforces 429 with zero SMTP)
      const resendA = await httpRequest({
        port: portA,
        method: 'POST',
        path: '/api/v1/auth/resend-otp',
        body: { scope: 'buyer', email: updatedBuyerEmail }
      });
      assert(resendA.statusCode === 200, `Expected Instance A resend 200, got ${resendA.statusCode}`);
      const smtpBCountBefore = capB.emails.length;
      const resendB = await httpRequest({
        port: portB,
        method: 'POST',
        path: '/api/v1/auth/resend-otp',
        body: { scope: 'buyer', email: updatedBuyerEmail }
      });
      assert(resendB.statusCode === 429 && (resendB.json?.retryAfterSeconds ?? 0) > 0, `Expected Instance B cooldown 429, got ${resendB.statusCode}`);
      assert(capB.emails.length === smtpBCountBefore, 'Instance B must not dispatch SMTP email while cooldown is active.');

      // Shared Redis outage fails closed on both A and B (zero process-local fallback)
      await runDocker(['stop', redisContainer]);
      const [readyADown, readyBDown] = await Promise.all([
        httpRequest({ port: portA, method: 'GET', path: '/api/ready' }),
        httpRequest({ port: portB, method: 'GET', path: '/api/ready' })
      ]);
      assert(readyADown.statusCode === 503 && readyBDown.statusCode === 503, 'Both instances must fail /api/ready 503 during Redis outage.');
      const loginBDown = await httpRequest({
        port: portB,
        method: 'POST',
        path: '/api/v1/auth/buyer/login',
        body: { identifier: updatedBuyerEmail, password: 'Password123' }
      });
      assert(loginBDown.statusCode === 503, `Expected Instance B login 503 during Redis outage, got ${loginBDown.statusCode}`);

      await runDocker(['start', redisContainer]);
      await waitForRedisContainerReady(redisContainer, redisPass);
      await Promise.all([waitForGatewayReady(portA), waitForGatewayReady(portB)]);

      // Shutdown Instance A cleanly -> Instance B remains healthy and operational
      const shutResA = await gwA.shutdown();
      assert(shutResA.poolErrors.length === 0 && shutResA.redisErrors.length === 0, 'Expected clean Instance A shutdown');
      const readyBAfterA = await httpRequest({ port: portB, method: 'GET', path: '/api/ready' });
      assert(readyBAfterA.statusCode === 200 && readyBAfterA.json?.ready === true, 'Instance B must stay ready after Instance A shutdown.');

      // Injected caller-owned dependencies must NOT be closed on gateway shutdown
      const injectedCustPool = createStrictPgPool(customerDbUrl, 'customer');
      const injectedMerchPool = createStrictPgPool(merchantDbUrl, 'merchant');
      const injectedRedis = createManagedRedisClient(redisUrl);
      activePools.push(injectedCustPool, injectedMerchPool);
      activeRedisClients.push(injectedRedis);
      await ensureRedisReady(injectedRedis);

      const gwInjected = createGatewayApp(
        makeGatewayTestConfig({ customerDbUrl, merchantDbUrl, redisUrl, aiEngineUrl, jwtSecret }),
        {
          customerPool: injectedCustPool,
          merchantPool: injectedMerchPool,
          redis: injectedRedis,
          emailTransporter: capA.transporter
        }
      );
      activeShutdowns.push(gwInjected.shutdown);
      await gwInjected.shutdown();
      assert((await injectedCustPool.query('SELECT 1 AS ok')).rows[0]?.ok === 1, 'Injected customer pool must survive gateway shutdown.');
      assert((await injectedMerchPool.query('SELECT 1 AS ok')).rows[0]?.ok === 1, 'Injected merchant pool must survive gateway shutdown.');
      assert((await injectedRedis.ping()) === 'PONG', 'Injected Redis client must survive gateway shutdown.');

      await Promise.all([
        gwB.shutdown(),
        injectedCustPool.end(),
        injectedMerchPool.end(),
        closeManagedRedisClient(injectedRedis, true)
      ]);
    });

    // -----------------------------------------------------------------------
    // Case 5: Live S1.3-C API safety contracts against real DBs & Redis
    // -----------------------------------------------------------------------
    await runCase('Live S1.3-C booking 503, KYC trust boundary, search fallback, and /api/ready latency', async () => {
      const { transporter } = createCapturingTransporter();
      const gw = createGatewayApp(
        makeGatewayTestConfig({ customerDbUrl, merchantDbUrl, redisUrl, aiEngineUrl: 'http://127.0.0.1:1', jwtSecret }),
        { emailTransporter: transporter }
      );
      activeShutdowns.push(gw.shutdown);
      const port = await startHttpServer(gw.server);
      await waitForGatewayReady(port);

      const adminRedis = await connectRawRedis(redisUrl);
      activeRawRedisClients.push(adminRedis);

      // Snapshot before disabled booking routes
      const slotsBefore = await probeMerchantPool.query('SELECT id, status, booked_count FROM service_slots WHERE id = $1', [seededSlotId]);
      const receiptsBefore = await probeCustomerPool.query('SELECT count(*)::int AS c FROM booking_receipts');
      const dbSizeBefore = await adminRedis.dbsize();

      const lockRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/bookings/lock-slot',
        body: { slotId: seededSlotId, serviceName: 'Coffee Tasting Session' }
      });
      const confirmRes = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/bookings/confirm-payment',
        body: { slotId: seededSlotId, upiTransactionRef: 'UPI123' }
      });
      assert(lockRes.statusCode === 503 && lockRes.json?.code === 'BOOKING_TEMPORARILY_UNAVAILABLE', `Unexpected lock-slot response: ${lockRes.statusCode}`);
      assert(confirmRes.statusCode === 503 && confirmRes.json?.code === 'BOOKING_TEMPORARILY_UNAVAILABLE', `Unexpected confirm response: ${confirmRes.statusCode}`);

      const slotsAfter = await probeMerchantPool.query('SELECT id, status, booked_count FROM service_slots WHERE id = $1', [seededSlotId]);
      const receiptsAfter = await probeCustomerPool.query('SELECT count(*)::int AS c FROM booking_receipts');
      const dbSizeAfter = await adminRedis.dbsize();
      assert(slotsAfter.rows[0].status === slotsBefore.rows[0].status && slotsAfter.rows[0].booked_count === slotsBefore.rows[0].booked_count, 'Disabled booking mutated service_slots!');
      assert(receiptsAfter.rows[0].c === receiptsBefore.rows[0].c, 'Disabled booking inserted booking_receipts!');
      assert(dbSizeAfter === dbSizeBefore, 'Disabled booking mutated Redis keyspace!');

      // Seller KYC boundary against real DB (authenticated OWNER + fail-closed checks)
      const unauthKyc = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        body: { merchantId: seededMerchantId, documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert(unauthKyc.statusCode === 401, `Expected 401 on unauthenticated KYC upload, got ${unauthKyc.statusCode}`);

      const badKyc = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${seededSellerOwnerJwt}` },
        body: { merchantId: 'not-a-uuid', documentType: 'GSTIN_CERTIFICATE', documentNumber: '12345' }
      });
      assert(badKyc.statusCode === 400 && badKyc.json?.code === 'INVALID_MERCHANT_ID', `Expected 400 INVALID_MERCHANT_ID, got ${badKyc.statusCode}`);

      const missingKyc = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${seededSellerOwnerJwt}` },
        body: { merchantId: '00000000-0000-4000-8000-000000000099', documentType: 'GSTIN_CERTIFICATE', documentNumber: '12345' }
      });
      assert(missingKyc.statusCode === 404 && missingKyc.json?.code === 'MERCHANT_NOT_FOUND', `Expected 404 MERCHANT_NOT_FOUND, got ${missingKyc.statusCode}`);

      const realKyc = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/seller/kyc/upload',
        headers: { Authorization: `Bearer ${seededSellerOwnerJwt}` },
        body: { merchantId: seededMerchantId, documentType: 'GSTIN_CERTIFICATE', documentNumber: '27AAAPL1234C1ZV' }
      });
      assert(realKyc.statusCode === 503 && realKyc.json?.code === 'KYC_SUBMISSION_UNAVAILABLE', `Expected 503 KYC_SUBMISSION_UNAVAILABLE, got ${realKyc.statusCode}`);
      const verifyFlag = await probeMerchantPool.query('SELECT is_verified FROM merchants WHERE id = $1', [seededMerchantId]);
      assert(verifyFlag.rows[0]?.is_verified === false, 'KYC upload must leave merchants.is_verified as false!');

      // Search hit vs empty miss vs live-catalog against real DB
      const searchHit = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/search/hyperlocal?q=Coffee&lat=18.5074&lon=73.8077&radius=10'
      });
      assert(
        searchHit.statusCode === 200 &&
          searchHit.json?.results?.some((item: any) => item.item_id === seededItemId),
        'Expected seeded inventory item in real PG search fallback results'
      );

      const searchMiss = await httpRequest({
        port,
        method: 'GET',
        path: '/api/v1/search/hyperlocal?q=zxy_nonexistent_streetverse_999&lat=18.5074&lon=73.8077&radius=10'
      });
      assert(
        searchMiss.statusCode === 200 && searchMiss.json?.total_found === 0 && Array.isArray(searchMiss.json?.results) && searchMiss.json.results.length === 0,
        'Expected honest empty array [] on miss without fabricated items.'
      );

      const liveCatalog = await httpRequest({ port, method: 'GET', path: '/api/v1/search/live-catalog' });
      assert(
        liveCatalog.statusCode === 200 && liveCatalog.json?.items?.some((item: any) => item.id === seededItemId),
        'Expected live-catalog to return real seeded DB inventory item.'
      );

      // Bounded latency on /api/ready during outage (< 4000ms)
      adminRedis.disconnect();
      await runDocker(['stop', redisContainer]);
      const downReady = await httpRequest({ port, method: 'GET', path: '/api/ready', timeoutMs: 5000 });
      assert(downReady.statusCode === 503 && downReady.elapsedMs < 4000, `/api/ready must fail bounded (<4s), took ${downReady.elapsedMs}ms`);
      await runDocker(['start', redisContainer]);
      await waitForRedisContainerReady(redisContainer, redisPass);
      await waitForGatewayReady(port);

      await gw.shutdown();
    });

    // -----------------------------------------------------------------------
    // Case 6: Live FastAPI AI Engine smoke test + Gateway <-> AI + Merchant DB outage
    // -----------------------------------------------------------------------
    await runCase('Live FastAPI AI engine smoke test against real Merchant DB + outage/recovery', async () => {
      const started = await startUvicornAiEngine(aiPort, merchantDbUrl);
      aiProc = started.proc;

      const { transporter } = createCapturingTransporter();
      const gw = createGatewayApp(
        makeGatewayTestConfig({ customerDbUrl, merchantDbUrl, redisUrl, aiEngineUrl, jwtSecret }),
        { emailTransporter: transporter }
      );
      activeShutdowns.push(gw.shutdown);
      const port = await startHttpServer(gw.server);
      await waitForGatewayReady(port);

      const aiHealth = await httpRequest({ port: aiPort, method: 'GET', path: '/health' });
      assert(aiHealth.statusCode === 200, `Expected AI /health 200, got ${aiHealth.statusCode}`);

      const aiSearch = await httpRequest({
        port: aiPort,
        method: 'POST',
        path: '/api/v1/search/hyperlocal',
        body: { query: 'Coffee', latitude: 18.5074, longitude: 73.8077, max_radius_km: 10.0, limit: 10 }
      });
      assert(aiSearch.statusCode === 200 && Array.isArray(aiSearch.json?.results), `Expected AI search 200 array, got ${aiSearch.statusCode}`);

      const gwViaAi = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/search/hyperlocal',
        body: { query: 'Coffee', latitude: 18.5074, longitude: 73.8077, max_radius_km: 10.0, limit: 10 }
      });
      assert(
        gwViaAi.statusCode === 200 && gwViaAi.json?.results?.some((r: any) => r.item_id === seededItemId),
        'Expected gateway search to return seeded real record alongside live AI service.'
      );

      // Merchant PG stopped -> FastAPI AI engine & Gateway both fail closed 503
      await runDocker(['stop', merchContainer]);
      const aiMerchDown = await httpRequest({
        port: aiPort,
        method: 'POST',
        path: '/api/v1/search/hyperlocal',
        body: { query: 'Coffee', latitude: 18.5074, longitude: 73.8077, max_radius_km: 10.0, limit: 10 }
      });
      assert(aiMerchDown.statusCode === 503, `Expected FastAPI 503 when Merchant PG down, got ${aiMerchDown.statusCode}: ${aiMerchDown.body}`);
      const gwMerchDown = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/search/hyperlocal',
        body: { query: 'Coffee', latitude: 18.5074, longitude: 73.8077, max_radius_km: 10.0, limit: 10 }
      });
      assert(gwMerchDown.statusCode === 503, `Expected Gateway 503 when Merchant PG down, got ${gwMerchDown.statusCode}`);

      // Merchant PG restarted -> both FastAPI AI Engine and Gateway recover
      await runDocker(['start', merchContainer]);
      await waitForPostgresReady(merchContainer, pgUser, merchDbName);
      await waitForUntil(
        async () => {
          const probe = await httpRequest({
            port: aiPort,
            method: 'POST',
            path: '/api/v1/search/hyperlocal',
            body: { query: 'Coffee', latitude: 18.5074, longitude: 73.8077, max_radius_km: 10.0, limit: 10 }
          });
          return probe.statusCode === 200;
        },
        20000,
        300,
        'FastAPI AI Engine did not recover after Merchant PG restart'
      );
      await waitForGatewayReady(port);

      // Stop Uvicorn AI Engine -> Gateway cleanly falls back to real Merchant DB
      await stopChildProcess(aiProc);
      aiProc = null;
      const gwFallback = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/search/hyperlocal',
        body: { query: 'Coffee', latitude: 18.5074, longitude: 73.8077, max_radius_km: 10.0, limit: 10 }
      });
      assert(
        gwFallback.statusCode === 200 && gwFallback.json?.results?.some((r: any) => r.item_id === seededItemId),
        'Expected gateway PG fallback to succeed cleanly when Uvicorn AI Engine is stopped.'
      );

      await gw.shutdown();
    });
  } finally {
    await stopChildProcess(aiProc).catch(() => {});
    await Promise.allSettled(activeShutdowns.map((fn) => fn()));
    await Promise.allSettled(activePools.map((p) => p.end()));
    await Promise.allSettled(activeRedisClients.map((c) => closeManagedRedisClient(c, true)));
    await Promise.allSettled(
      activeRawRedisClients.map(async (c) => {
        try {
          c.disconnect?.();
        } catch {
          // Ignore disconnect cleanup error
        }
      })
    );

    if (createdContainers.length > 0) {
      await runDocker(['rm', '-f', ...createdContainers]).catch((err) => {
        console.error(`[S1.3-D Cleanup Error]: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    const remainingContainers: string[] = await listContainerNames().catch(() => [] as string[]);
    for (const c of createdContainers) {
      if (remainingContainers.includes(c)) {
        console.error(`[S1.3-D Cleanup Warning] Container still exists: ${c}`);
      }
    }
    const unexpectedExtra = remainingContainers.filter(
      (c) => !preExistingContainers.includes(c) && c.startsWith('streetverse-s13d-')
    );
    if (unexpectedExtra.length > 0) {
      console.error(`[S1.3-D Cleanup Warning] Leftover ephemeral containers: ${unexpectedExtra.join(', ')}`);
    }
  }

  console.log('\n=== StreetVerse S1.3-D Live Infrastructure Verification Results ===');
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.name} (${r.durationMs}ms)`);
    if (r.error) console.log(`  -> ${r.error}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nSummary: ${passed}/${results.length} live integration scenarios passed.`);
  if (passed !== results.length) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('[S1.3-D Fatal Error]', err);
  process.exit(1);
});
