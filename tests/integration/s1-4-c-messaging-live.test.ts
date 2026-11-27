/**
 * StreetVerse S1.4-C Live PostgreSQL + Redis Multi-Instance Messaging Integration Suite
 *
 * Validates against disposable, dynamically ported Docker containers:
 *   1. Customer DB migration (`001_s1_4_c_conversations_messages.sql`), idempotency, DB constraints,
 *      Buyer-only creation, concurrent creation safety, and CLOSED-vs-OPEN reuse semantics.
 *   2. REST authorization, Seller Account / Store Membership inbox scoping, cursor pagination,
 *      client_message_id idempotency, and immediate access loss upon membership revocation.
 *   3. Two real API Gateway instances + real `@socket.io/redis-adapter` on dedicated Redis Pub/Sub
 *      connections (independent from OTP Redis), cross-instance Buyer <-> Staff fan-out, and
 *      real-time spoofed sender / room authorization blocking.
 *   4. Redis Pub/Sub outage resilience (PostgreSQL writes persist, realtimeDelivered=false honest ack,
 *      HTTP history intact), Redis restart fan-out recovery, and single-gateway graceful shutdown.
 */

import assert from 'assert';
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net, { AddressInfo } from 'net';
import path from 'path';
import { promisify } from 'util';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { createStrictPgPool, StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { SELLER_ACCOUNT_PRINCIPAL_TYPE } from '../../services/api-gateway/src/middleware/authJwt';
import { getConversationRoomName } from '../../services/api-gateway/src/services/conversations';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { io: ioClient } = require(
  require.resolve('socket.io-client', {
    paths: ['services/api-gateway/node_modules', 'apps/buyer-web/node_modules']
  })
);

const execFileAsync = promisify(execFile);
const RESERVED_PORTS = new Set([5432, 5433, 5434, 6379, 6380, 8000]);

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', args, { timeout: 60000, encoding: 'utf8' });
}

async function waitForUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`${message}${lastErr instanceof Error ? ` (${lastErr.message})` : ''}`);
}

async function getFreePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        server.close((err) => (err ? reject(err) : resolve(addr.port)));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('Could not allocate isolated port.');
}

async function httpRequest(options: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        timeout: 8000,
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
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode || 0, json, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function connectSocket(port: number, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 5000,
      auth: { token }
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Timed out connecting socket on port ${port}`));
    }, 5500);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(err);
    });
  });
}

const PRE_S14C_CUSTOMER_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE,
    preferred_language VARCHAR(10) DEFAULT 'en',
    home_address TEXT,
    password_hash VARCHAR(255),
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL,
    total_amount NUMERIC(10, 2) NOT NULL,
    payment_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    upi_transaction_ref VARCHAR(100),
    delivery_type VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS booking_receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL,
    service_slot_id UUID NOT NULL,
    service_name VARCHAR(150) NOT NULL,
    appointment_time TIMESTAMP WITH TIME ZONE NOT NULL,
    token_number INT NOT NULL,
    qr_verification_code VARCHAR(255) NOT NULL,
    booking_status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
`;

async function runSuite() {
  try {
    await runDocker(['info']);
  } catch (err: any) {
    console.error(`BLOCKED: Docker daemon unavailable (${err?.message || 'error'}). Live S1.4-C tests NOT RUN.`);
    process.exit(2);
  }

  const runId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const custContainer = `streetverse-s14c-cust-${runId}`;
  const merchContainer = `streetverse-s14c-merch-${runId}`;
  const redisContainer = `streetverse-s14c-redis-${runId}`;
  const createdContainers: string[] = [];

  const custPort = await getFreePort();
  const merchPort = await getFreePort();
  const redisPort = await getFreePort();
  const aiEnginePort = await getFreePort();

  const pgPass = crypto.randomBytes(12).toString('hex');
  const redisPass = crypto.randomBytes(12).toString('hex');
  const jwtSecret = crypto.randomBytes(36).toString('base64url');

  const custDb = 'sv_s14c_customer';
  const merchDb = 'sv_s14c_merchant';
  const customerDbUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${custPort}/${custDb}`;
  const merchantDbUrl = `postgresql://postgres:${pgPass}@127.0.0.1:${merchPort}/${merchDb}`;
  const redisUrl = `redis://:${redisPass}@127.0.0.1:${redisPort}`;

  const pools: StrictPgPool[] = [];
  const gateways: Array<ReturnType<typeof createGatewayApp>> = [];
  const sockets: any[] = [];
  const results: TestResult[] = [];

  async function runCase(name: string, fn: () => Promise<void>) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, durationMs: Date.now() - start });
    } catch (err: any) {
      results.push({
        name,
        passed: false,
        durationMs: Date.now() - start,
        error: err?.stack || err?.message || String(err)
      });
    }
  }

  try {
    console.log(`[S1.4-C] Starting isolated containers (${runId}) on ports ${custPort}, ${merchPort}, ${redisPort}...`);

    await runDocker([
      'run', '-d', '--name', custContainer, '-p', `127.0.0.1:${custPort}:5432`,
      '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', `POSTGRES_DB=${custDb}`,
      'postgres:16-alpine'
    ]);
    createdContainers.push(custContainer);

    await runDocker([
      'run', '-d', '--name', merchContainer, '-p', `127.0.0.1:${merchPort}:5432`,
      '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', `POSTGRES_DB=${merchDb}`,
      'pgvector/pgvector:pg16'
    ]);
    createdContainers.push(merchContainer);

    await runDocker([
      'run', '-d', '--name', redisContainer, '-p', `127.0.0.1:${redisPort}:6379`,
      'redis:7-alpine', 'redis-server', '--requirepass', redisPass
    ]);
    createdContainers.push(redisContainer);

    await Promise.all([
      waitForUntil(async () => {
        await runDocker(['exec', custContainer, 'pg_isready', '-U', 'postgres', '-d', custDb]);
        return true;
      }, 30000, 300, 'Customer PG ready timeout'),
      waitForUntil(async () => {
        await runDocker(['exec', merchContainer, 'pg_isready', '-U', 'postgres', '-d', merchDb]);
        return true;
      }, 30000, 300, 'Merchant PG ready timeout'),
      waitForUntil(async () => {
        const res = await runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'ping']);
        return res.stdout.trim() === 'PONG';
      }, 20000, 250, 'Redis ready timeout')
    ]);

    const customerPool = createStrictPgPool(customerDbUrl, 'customer');
    const merchantPool = createStrictPgPool(merchantDbUrl, 'merchant');
    pools.push(customerPool, merchantPool);

    await Promise.all([
      waitForUntil(async () => (await customerPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'customerPool connect'),
      waitForUntil(async () => (await merchantPool.query('SELECT 1')).rows.length === 1, 20000, 300, 'merchantPool connect')
    ]);

    // Apply pre-S1.4-C Customer schema + S1.4-C migration SQL (twice for idempotency)
    await customerPool.query(PRE_S14C_CUSTOMER_SCHEMA_SQL);
    const s14cMigrationSql = fs.readFileSync(
      path.resolve(process.cwd(), 'packages', 'database-schemas', 'customer-db', 'migrations', '001_s1_4_c_conversations_messages.sql'),
      'utf8'
    );
    await customerPool.query(s14cMigrationSql);
    await customerPool.query(s14cMigrationSql);

    // Apply Merchant schema + S1.4-A migration
    const merchantSchemaSql = fs.readFileSync(
      path.resolve(process.cwd(), 'packages', 'database-schemas', 'merchant-db', 'schema.sql'),
      'utf8'
    );
    const s14aMerchantMigrationSql = fs.readFileSync(
      path.resolve(process.cwd(), 'packages', 'database-schemas', 'merchant-db', 'migrations', '001_s1_4_a_seller_accounts_and_memberships.sql'),
      'utf8'
    );
    await merchantPool.query(merchantSchemaSql);
    await merchantPool.query(s14aMerchantMigrationSql);

    // Seed Buyers, Stores, Seller Accounts & Store Memberships
    const pwHash = await bcrypt.hash('TestPass123!', 10);
    const b1Res = await customerPool.query(
      `INSERT INTO users (phone, full_name, email, password_hash, is_verified)
       VALUES ('+919800010001', 'Buyer One', 'buyer1@s14c.test', $1, true) RETURNING id`,
      [pwHash]
    );
    const b2Res = await customerPool.query(
      `INSERT INTO users (phone, full_name, email, password_hash, is_verified)
       VALUES ('+919800010002', 'Buyer Two', 'buyer2@s14c.test', $1, true) RETURNING id`,
      [pwHash]
    );
    const buyer1Id = String(b1Res.rows[0].id);
    const buyer2Id = String(b2Res.rows[0].id);

    const store1Res = await merchantPool.query(
      `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude)
       VALUES ('Store One Grocer', 'GROCERY', '+919811100001', 'owner1@s14c.test', $1, true, 's1@upi', 'Pune 1', '411038', 18.5074, 73.8077) RETURNING id`,
      [pwHash]
    );
    const store2Res = await merchantPool.query(
      `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude)
       VALUES ('Store Two Salon', 'SALON', '+919811100002', 'owner2@s14c.test', $1, true, 's2@upi', 'Pune 2', '411038', 18.5080, 73.8080) RETURNING id`,
      [pwHash]
    );
    const store1Id = String(store1Res.rows[0].id);
    const store2Id = String(store2Res.rows[0].id);

    const owner1AcctRes = await merchantPool.query(
      `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
       VALUES ('+919811100001', 'owner1@s14c.test', $1, true, 'ACTIVE') RETURNING id`,
      [pwHash]
    );
    const staff1AcctRes = await merchantPool.query(
      `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
       VALUES ('+919811100011', 'staff1@s14c.test', $1, true, 'ACTIVE') RETURNING id`,
      [pwHash]
    );
    const owner2AcctRes = await merchantPool.query(
      `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
       VALUES ('+919811100002', 'owner2@s14c.test', $1, true, 'ACTIVE') RETURNING id`,
      [pwHash]
    );
    const owner1Id = String(owner1AcctRes.rows[0].id);
    const staff1Id = String(staff1AcctRes.rows[0].id);
    const owner2Id = String(owner2AcctRes.rows[0].id);

    await merchantPool.query(
      `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status)
       VALUES ($1, $2, 'OWNER', 'ACTIVE'),
              ($3, $2, 'STAFF', 'ACTIVE'),
              ($4, $5, 'OWNER', 'ACTIVE')`,
      [owner1Id, store1Id, staff1Id, owner2Id, store2Id]
    );

    const gwCfgA: GatewayConfig = {
      nodeEnv: 'test',
      port: 0,
      allowedOrigins: ['http://localhost:3000', 'http://localhost:3001'],
      jwtSecret,
      jwtIssuer: 'streetverse-api-gateway',
      jwtBuyerAudience: 'streetverse-buyer',
      jwtSellerAudience: 'streetverse-seller',
      jwtExpiresIn: '7d',
      redisUrl,
      customerDbUrl,
      merchantDbUrl,
      aiEngineUrl: `http://127.0.0.1:${aiEnginePort}`
    };
    const gwCfgB: GatewayConfig = { ...gwCfgA };

    const gwA = createGatewayApp(gwCfgA);
    const gwB = createGatewayApp(gwCfgB);
    gateways.push(gwA, gwB);

    await Promise.all([
      new Promise<void>((resolve) => gwA.server.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => gwB.server.listen(0, '127.0.0.1', resolve))
    ]);
    const portA = (gwA.server.address() as AddressInfo).port;
    const portB = (gwB.server.address() as AddressInfo).port;

    await Promise.all([gwA.ensurePubSubReady(), gwB.ensurePubSubReady()]);
    assert(gwA.redisPubClient && gwA.redisSubClient, 'Gateway A must provision dedicated Pub/Sub clients');
    assert(gwA.redisPubClient !== gwA.redis && gwA.redisSubClient !== gwA.redis, 'Pub/Sub clients must not reuse OTP Redis');
    assert(gwA.redisPubClient !== gwA.redisSubClient, 'Publisher and Subscriber connections must be separate');

    const signBuyerJwt = (userId: string) =>
      jwt.sign({ sub: userId, role: 'BUYER', aud: gwCfgA.jwtBuyerAudience }, jwtSecret, {
        issuer: gwCfgA.jwtIssuer,
        expiresIn: '1h'
      });
    const signSellerJwt = (sellerAccountId: string) =>
      jwt.sign(
        {
          sub: sellerAccountId,
          role: 'SELLER',
          principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE,
          aud: gwCfgA.jwtSellerAudience
        },
        jwtSecret,
        { issuer: gwCfgA.jwtIssuer, expiresIn: '1h' }
      );

    const buyer1Jwt = signBuyerJwt(buyer1Id);
    const buyer2Jwt = signBuyerJwt(buyer2Id);
    const owner1Jwt = signSellerJwt(owner1Id);
    const staff1Jwt = signSellerJwt(staff1Id);
    const owner2Jwt = signSellerJwt(owner2Id);

    let convB1S1Id = '';

    // =========================================================================
    // CASE 1: Migration, FK enforcement, Concurrent Conversation Creation & CLOSED reuse
    // =========================================================================
    await runCase('Customer DB schema enforces FKs/limits, concurrent creation deduplicates cleanly, and CLOSED preserves history', async () => {
      // Direct insert without participant must fail composite FK
      let fkRejected = false;
      const tmpConv = await customerPool.query(
        `INSERT INTO conversations (buyer_user_id, merchant_id, status) VALUES ($1, $2, 'CLOSED') RETURNING id`,
        [buyer2Id, store1Id]
      );
      try {
        await customerPool.query(
          `INSERT INTO messages (conversation_id, sender_type, sender_id, body) VALUES ($1, 'BUYER', $2, 'Should fail FK')`,
          [tmpConv.rows[0].id, buyer2Id]
        );
      } catch (err: any) {
        fkRejected = err?.code === '23503';
      } finally {
        await customerPool.query('DELETE FROM conversations WHERE id = $1', [tmpConv.rows[0].id]);
      }
      assert(fkRejected, 'messages composite FK must reject sender not registered in conversation_participants');

      // Concurrent Buyer conversation creation for same Store produces single OPEN row
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () =>
          httpRequest({
            port: portA,
            method: 'POST',
            path: '/api/v1/conversations',
            headers: { Authorization: `Bearer ${buyer1Jwt}` },
            body: { merchantId: store1Id }
          })
        )
      );

      for (const r of concurrent) {
        assert(r.statusCode === 200 || r.statusCode === 201, `Unexpected concurrent create status ${r.statusCode}: ${r.raw}`);
      }
      const uniqueIds = new Set(concurrent.map((r) => r.json.conversation.id));
      assert.strictEqual(uniqueIds.size, 1, 'Concurrent creation must resolve to one single OPEN conversation UUID');
      convB1S1Id = Array.from(uniqueIds)[0];

      const countRes = await customerPool.query(
        `SELECT count(*)::int AS cnt FROM conversations WHERE buyer_user_id = $1 AND merchant_id = $2 AND status = 'OPEN'`,
        [buyer1Id, store1Id]
      );
      assert.strictEqual(countRes.rows[0].cnt, 1);

      const partRes = await customerPool.query(
        `SELECT participant_type, participant_id FROM conversation_participants WHERE conversation_id = $1`,
        [convB1S1Id]
      );
      assert.strictEqual(partRes.rows.length, 1);
      assert.strictEqual(partRes.rows[0].participant_type, 'BUYER');
      assert.strictEqual(partRes.rows[0].participant_id, buyer1Id);

      // Seller cannot create conversation; nonexistent store fails 404
      const sellerCreate = await httpRequest({
        port: portA,
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${owner1Jwt}` },
        body: { merchantId: store1Id }
      });
      assert.strictEqual(sellerCreate.statusCode, 403);

      const badStoreCreate = await httpRequest({
        port: portA,
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${buyer1Jwt}` },
        body: { merchantId: crypto.randomUUID() }
      });
      assert.strictEqual(badStoreCreate.statusCode, 404);

      // Buyer 2 <-> Store 2 conversation: close it -> Buyer 2 opens new OPEN conversation cleanly
      const closedPrep = await httpRequest({
        port: portA,
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${buyer2Jwt}` },
        body: { merchantId: store2Id }
      });
      const oldClosedId = closedPrep.json.conversation.id;
      await customerPool.query(`UPDATE conversations SET status = 'CLOSED' WHERE id = $1`, [oldClosedId]);

      const newOpenAfterClosed = await httpRequest({
        port: portA,
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${buyer2Jwt}` },
        body: { merchantId: store2Id }
      });
      assert.strictEqual(newOpenAfterClosed.statusCode, 201);
      assert.notStrictEqual(newOpenAfterClosed.json.conversation.id, oldClosedId);
    });

    // =========================================================================
    // CASE 2: Live REST Authorization, Inbox Scoping, Idempotency & Keyset Pagination
    // =========================================================================
    await runCase('REST inbox scoping, idempotent sends, and tie-safe cursor pagination work live against PostgreSQL', async () => {
      const buyerInbox = await httpRequest({
        port: portA,
        method: 'GET',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${buyer1Jwt}` }
      });
      assert.strictEqual(buyerInbox.statusCode, 200);
      assert.strictEqual(buyerInbox.json.conversations.length, 1);
      assert.strictEqual(buyerInbox.json.conversations[0].id, convB1S1Id);

      const staffInbox = await httpRequest({
        port: portB,
        method: 'GET',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${staff1Jwt}` }
      });
      assert.strictEqual(staffInbox.statusCode, 200);
      assert.strictEqual(staffInbox.json.conversations.length, 1);
      assert.strictEqual(staffInbox.json.conversations[0].id, convB1S1Id);
      assert.strictEqual(staffInbox.json.conversations[0].membership.role, 'STAFF');

      const owner2Inbox = await httpRequest({
        port: portB,
        method: 'GET',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${owner2Jwt}` }
      });
      assert(owner2Inbox.json.conversations.every((c: any) => c.merchantId === store2Id));

      // Idempotent REST send with clientMessageId
      const clientMsgId = crypto.randomUUID();
      const firstSend = await httpRequest({
        port: portA,
        method: 'POST',
        path: `/api/v1/conversations/${convB1S1Id}/messages`,
        headers: { Authorization: `Bearer ${buyer1Jwt}` },
        body: { text: 'Idempotent first message', clientMessageId: clientMsgId }
      });
      assert.strictEqual(firstSend.statusCode, 201);
      const retrySend = await httpRequest({
        port: portB,
        method: 'POST',
        path: `/api/v1/conversations/${convB1S1Id}/messages`,
        headers: { Authorization: `Bearer ${buyer1Jwt}` },
        body: { text: 'Idempotent first message', clientMessageId: clientMsgId }
      });
      assert.strictEqual(retrySend.statusCode, 200);
      assert.strictEqual(retrySend.json.deduplicated, true);
      assert.strictEqual(retrySend.json.message.id, firstSend.json.message.id);

      // Insert 4 more messages (including two with identical created_at timestamp to test tie-breaker pagination)
      await httpRequest({
        port: portA,
        method: 'POST',
        path: `/api/v1/conversations/${convB1S1Id}/messages`,
        headers: { Authorization: `Bearer ${staff1Jwt}` },
        body: { text: 'Staff REST reply' }
      });

      const tiedTs = '2026-11-26T15:00:00.000Z';
      await customerPool.query(
        `INSERT INTO messages (conversation_id, sender_type, sender_id, body, created_at)
         VALUES ($1, 'BUYER', $2, 'Tied msg A', $3),
                ($1, 'BUYER', $2, 'Tied msg B', $3),
                ($1, 'BUYER', $2, 'Tied msg C', $3)`,
        [convB1S1Id, buyer1Id, tiedTs]
      );

      // Paginate limit=2 across all 5 messages
      const seenIds: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page++) {
        const q = cursor ? `?limit=2&before=${encodeURIComponent(cursor)}` : '?limit=2';
        const pageRes = await httpRequest({
          port: portB,
          method: 'GET',
          path: `/api/v1/conversations/${convB1S1Id}/messages${q}`,
          headers: { Authorization: `Bearer ${staff1Jwt}` }
        });
        assert.strictEqual(pageRes.statusCode, 200);
        for (const m of pageRes.json.messages) {
          assert(!seenIds.includes(m.id), 'Pagination returned duplicate message ID across pages');
          seenIds.push(m.id);
        }
        cursor = pageRes.json.pageInfo.nextCursor;
        if (!pageRes.json.pageInfo.hasMore) break;
      }
      assert.strictEqual(seenIds.length, 5, `Expected 5 distinct paginated messages, got ${seenIds.length}`);
    });

    // =========================================================================
    // CASE 3: Two Real Gateways + Redis Pub/Sub Fan-Out + Live Revocation
    // =========================================================================
    await runCase('Two real Gateways share live messages via Redis Pub/Sub and revoke access immediately on membership change', async () => {
      const buyerSockA = await connectSocket(portA, buyer1Jwt);
      const staffSockB = await connectSocket(portB, staff1Jwt);
      const outsiderSockB = await connectSocket(portB, owner2Jwt);
      sockets.push(buyerSockA, staffSockB, outsiderSockB);

      const outsiderJoin: any = await new Promise((resolve) =>
        outsiderSockB.emit('join_conversation', convB1S1Id, resolve)
      );
      assert.strictEqual(outsiderJoin.success, false);
      assert.strictEqual(outsiderJoin.code, 'FORBIDDEN');

      const buyerJoin: any = await new Promise((resolve) =>
        buyerSockA.emit('join_conversation', convB1S1Id, resolve)
      );
      const staffJoin: any = await new Promise((resolve) =>
        staffSockB.emit('join_conversation', convB1S1Id, resolve)
      );
      assert.strictEqual(buyerJoin.success, true);
      assert.strictEqual(staffJoin.success, true);
      assert.strictEqual(buyerJoin.room, getConversationRoomName(convB1S1Id));

      // Buyer on Gateway A -> Staff on Gateway B via Redis Pub/Sub
      const staffReceivePromise = new Promise<any>((resolve) =>
        staffSockB.once('new_message', resolve)
      );
      const buyerSendAck: any = await new Promise((resolve) =>
        buyerSockA.emit(
          'send_message',
          { conversationId: convB1S1Id, text: 'Cross-instance hello A->B' },
          resolve
        )
      );
      assert.strictEqual(buyerSendAck.success, true);
      assert.strictEqual(buyerSendAck.persisted, true);
      assert.strictEqual(buyerSendAck.realtimeDelivered, true);

      const staffReceived = await staffReceivePromise;
      assert.strictEqual(staffReceived.id, buyerSendAck.message.id);
      assert.strictEqual(staffReceived.senderType, 'BUYER');
      assert.strictEqual(staffReceived.senderId, buyer1Id);

      // Staff on Gateway B -> Buyer on Gateway A via Redis Pub/Sub
      const buyerReceivePromise = new Promise<any>((resolve) =>
        buyerSockA.once('new_message', resolve)
      );
      const staffSendAck: any = await new Promise((resolve) =>
        staffSockB.emit(
          'send_message',
          { conversationId: convB1S1Id, text: 'Cross-instance reply B->A', sender: 'spoofed' },
          resolve
        )
      );
      assert.strictEqual(staffSendAck.success, true);
      assert.strictEqual(staffSendAck.realtimeDelivered, true);
      assert.strictEqual(staffSendAck.message.senderType, 'SELLER_ACCOUNT');
      assert.strictEqual(staffSendAck.message.senderId, staff1Id);

      const buyerReceived = await buyerReceivePromise;
      assert.strictEqual(buyerReceived.id, staffSendAck.message.id);
      assert.strictEqual(buyerReceived.senderId, staff1Id);

      // Confirm outsider never received broadcast & DB holds both messages
      const dbCount = await customerPool.query(
        `SELECT count(*)::int AS cnt FROM messages WHERE id = ANY($1::uuid[])`,
        [[buyerSendAck.message.id, staffSendAck.message.id]]
      );
      assert.strictEqual(dbCount.rows[0].cnt, 2);

      // Revoke Staff 1 membership in Merchant PostgreSQL -> Staff 1 loses chat immediately
      await merchantPool.query(
        `UPDATE store_memberships SET status = 'REVOKED' WHERE seller_account_id = $1 AND merchant_id = $2`,
        [staff1Id, store1Id]
      );

      const revokedSockAck: any = await new Promise((resolve) =>
        staffSockB.emit('send_message', { conversationId: convB1S1Id, text: 'Post-revoke' }, resolve)
      );
      assert.strictEqual(revokedSockAck.success, false);
      assert.strictEqual(revokedSockAck.code, 'FORBIDDEN');

      const revokedHttp = await httpRequest({
        port: portA,
        method: 'GET',
        path: `/api/v1/conversations/${convB1S1Id}/messages`,
        headers: { Authorization: `Bearer ${staff1Jwt}` }
      });
      assert.strictEqual(revokedHttp.statusCode, 404);
    });

    // =========================================================================
    // CASE 4: Redis Pub/Sub Outage, Auto-Recovery & Single-Gateway Shutdown
    // =========================================================================
    await runCase('Redis Pub/Sub outage preserves committed PG messages honestly, recovers fan-out on restart, and isolates gateway shutdown', async () => {
      const buyerSockA = await connectSocket(portA, buyer1Jwt);
      const ownerSockB = await connectSocket(portB, owner1Jwt);
      sockets.push(buyerSockA, ownerSockB);

      const bJoin: any = await new Promise((r) => buyerSockA.emit('join_conversation', convB1S1Id, r));
      const oJoin: any = await new Promise((r) => ownerSockB.emit('join_conversation', convB1S1Id, r));
      assert(bJoin.success && oJoin.success, 'Buyer and Owner must join room prior to Redis outage test');

      // Stop Redis container while both Gateways stay up
      await runDocker(['stop', '-t', '1', redisContainer]);
      await waitForUntil(
        async () => gwA.redisPubClient?.status !== 'ready' && gwB.redisPubClient?.status !== 'ready',
        10000,
        150,
        'Pub/Sub clients did not observe Redis stop'
      );

      const outageText = `Message during Redis outage ${runId}`;
      const outageAck: any = await new Promise((resolve) =>
        buyerSockA.emit('send_message', { conversationId: convB1S1Id, text: outageText }, resolve)
      );
      assert.strictEqual(outageAck.success, true);
      assert.strictEqual(outageAck.persisted, true);
      assert.strictEqual(
        outageAck.realtimeDelivered,
        false,
        'Outage ack must never report realtimeDelivered=true'
      );
      assert.strictEqual(outageAck.code, 'REALTIME_FANOUT_UNAVAILABLE');

      // Message IS readable over HTTP on Gateway B directly from PostgreSQL
      const histDuringOutage = await httpRequest({
        port: portB,
        method: 'GET',
        path: `/api/v1/conversations/${convB1S1Id}/messages?limit=5`,
        headers: { Authorization: `Bearer ${owner1Jwt}` }
      });
      assert.strictEqual(histDuringOutage.statusCode, 200);
      assert(
        histDuringOutage.json.messages.some((m: any) => m.id === outageAck.message.id && m.body === outageText),
        'Committed outage message must remain accessible via HTTP history'
      );

      // Restart Redis container and wait for automatic Pub/Sub recovery
      await runDocker(['start', redisContainer]);
      await waitForUntil(async () => {
        try {
          const ping = await runDocker(['exec', redisContainer, 'redis-cli', '--no-auth-warning', '-a', redisPass, 'ping']);
          return ping.stdout.trim() === 'PONG';
        } catch {
          return false;
        }
      }, 20000, 300, 'Redis restart ping timeout');

      await waitForUntil(
        async () =>
          gwA.redisPubClient?.status === 'ready' &&
          gwA.redisSubClient?.status === 'ready' &&
          gwB.redisPubClient?.status === 'ready' &&
          gwB.redisSubClient?.status === 'ready',
        20000,
        250,
        'Gateway Pub/Sub clients did not reconnect cleanly after Redis restart'
      );
      // Allow ioredis autoResubscribe pipeline to settle on reopened subscriber sockets
      await delay(150);

      const recoveryText = `Recovered cross-instance message ${runId}`;
      const ownerRecvAfterRecovery = new Promise<any>((resolve) =>
        ownerSockB.once('new_message', resolve)
      );
      const recoveredAck: any = await new Promise((resolve) =>
        buyerSockA.emit('send_message', { conversationId: convB1S1Id, text: recoveryText }, resolve)
      );
      assert.strictEqual(recoveredAck.success, true);
      assert.strictEqual(recoveredAck.persisted, true);
      assert.strictEqual(recoveredAck.realtimeDelivered, true);

      const deliveredAfterRecovery = await ownerRecvAfterRecovery;
      assert.strictEqual(deliveredAfterRecovery.id, recoveredAck.message.id);
      assert.strictEqual(deliveredAfterRecovery.body, recoveryText);

      // Shut down Gateway B cleanly; Gateway A remains operational
      const gwBShutdown = await gwB.shutdown({ timeoutMs: 3000 });
      assert.strictEqual(gwBShutdown.poolErrors.length, 0);
      assert.strictEqual(gwBShutdown.redisErrors.length, 0);

      const postGwBShutdownHttp = await httpRequest({
        port: portA,
        method: 'POST',
        path: `/api/v1/conversations/${convB1S1Id}/messages`,
        headers: { Authorization: `Bearer ${buyer1Jwt}` },
        body: { text: 'Still persisting on Gateway A after Gateway B stopped' }
      });
      assert.strictEqual(postGwBShutdownHttp.statusCode, 201);
      assert.strictEqual(postGwBShutdownHttp.json.persisted, true);
    });
  } finally {
    for (const s of sockets) {
      try {
        s.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    }
    for (const gw of gateways) {
      try {
        await gw.shutdown({ timeoutMs: 3000 });
      } catch {
        // Ignore shutdown errors
      }
    }
    for (const pool of pools) {
      try {
        await pool.end();
      } catch {
        // Ignore pool close errors
      }
    }
    for (const c of createdContainers) {
      try {
        await runDocker(['rm', '-f', c]);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  console.log('\n=== StreetVerse S1.4-C Live Multi-Instance Messaging Results ===');
  let failed = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`PASS | ${r.name} (${r.durationMs}ms)`);
    } else {
      failed++;
      console.error(`FAIL | ${r.name} (${r.durationMs}ms)\n  ${r.error}`);
    }
  }
  console.log(`\nSummary: ${results.length - failed}/${results.length} S1.4-C live scenarios passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error('Fatal S1.4-C live suite error:', err);
  process.exit(1);
});
