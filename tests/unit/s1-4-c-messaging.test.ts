import assert from 'assert';
import http from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { createGatewayApp } from '../../services/api-gateway/src/app';
import { GatewayConfig, parseGatewayConfig } from '../../services/api-gateway/src/config/env';
import { StrictPgClient, StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import {
  createRedisPubSubClient,
  ManagedRedisClient,
  REDIS_MAX_RECONNECT_DELAY_MS
} from '../../services/api-gateway/src/db/redis';
import { SELLER_ACCOUNT_PRINCIPAL_TYPE } from '../../services/api-gateway/src/middleware/authJwt';
import {
  getConversationRoomName,
  MAX_CHAT_MESSAGE_LENGTH
} from '../../services/api-gateway/src/services/conversations';

// Resolve socket.io-client cleanly without adding duplicate dependencies to gateway
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { io: ioClient } = require(
  require.resolve('socket.io-client', {
    paths: ['services/api-gateway/node_modules', 'apps/buyer-web/node_modules']
  })
);

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const BUYER_1_ID = '11111111-1111-4111-8111-111111111111';
const BUYER_2_ID = '22222222-2222-4222-8222-222222222222';
const STORE_1_ID = '33333333-3333-4333-8333-333333333333';
const STORE_2_ID = '44444444-4444-4444-8444-444444444444';
const OWNER_1_ID = '55555555-5555-4555-8555-555555555555';
const STAFF_1_ID = '66666666-6666-4666-8666-666666666666';
const OUTSIDER_SELLER_ID = '77777777-7777-4777-8777-777777777777';
const CONV_1_ID = '88888888-8888-4888-8888-888888888888';
const CONV_CLOSED_ID = '99999999-9999-4999-8999-999999999999';
const MISSING_CONV_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG_UUID_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeConfig(): GatewayConfig {
  return parseGatewayConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 's14c-unit-test-jwt-secret-key-minimum-length-32-chars!!',
    ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:3001',
    REDIS_URL: 'redis://127.0.0.1:16399',
    CUSTOMER_DB_URL: 'postgresql://user:pass@127.0.0.1:15433/cust',
    MERCHANT_DB_URL: 'postgresql://user:pass@127.0.0.1:15434/merch'
  });
}

function signToken(
  cfg: GatewayConfig,
  payload: Record<string, unknown>,
  expiresIn: string | number = '1h'
): string {
  return jwt.sign(payload, cfg.jwtSecret, {
    issuer: cfg.jwtIssuer,
    expiresIn: expiresIn as any
  });
}

function makeBuyerJwt(cfg: GatewayConfig, buyerId = BUYER_1_ID, expiresIn: string | number = '1h'): string {
  return signToken(
    cfg,
    { sub: buyerId, role: 'BUYER', aud: cfg.jwtBuyerAudience, email: 'buyer@test.local' },
    expiresIn
  );
}

function makeSellerJwt(
  cfg: GatewayConfig,
  sellerAccountId = OWNER_1_ID,
  extra: Record<string, unknown> = {},
  expiresIn: string | number = '1h'
): string {
  return signToken(
    cfg,
    {
      sub: sellerAccountId,
      role: 'SELLER',
      principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE,
      aud: cfg.jwtSellerAudience,
      email: 'seller@test.local',
      ...extra
    },
    expiresIn
  );
}

function createMockRedis(initialStatus = 'ready'): ManagedRedisClient & {
  quitCalls: number;
  disconnectCalls: number;
} {
  const client: any = {
    status: initialStatus,
    quitCalls: 0,
    disconnectCalls: 0,
    connect: async () => {
      client.status = 'ready';
    },
    ping: async () => 'PONG',
    set: async () => 'OK',
    ttl: async () => -1,
    del: async () => 0,
    eval: async () => 1,
    multi: () => ({ set: () => client, del: () => client, exec: async () => [] }),
    on: () => client,
    removeListener: () => client,
    quit: async () => {
      client.quitCalls++;
      client.status = 'end';
      return 'OK';
    },
    disconnect: () => {
      client.disconnectCalls++;
      client.status = 'end';
    }
  };
  return client;
}

function createMemoryChatPools(options: {
  failDbWith503?: boolean;
  failConvUpdateInTx?: boolean;
  failNextInsertUnique?: boolean;
} = {}) {
  const users = new Set([BUYER_1_ID, BUYER_2_ID]);
  const stores = new Map([
    [
      STORE_1_ID,
      { id: STORE_1_ID, business_name: 'Store One', category: 'GROCERY', upi_vpa: 's1@ok', address: 'Pune', pincode: '411004', is_open: true }
    ],
    [
      STORE_2_ID,
      { id: STORE_2_ID, business_name: 'Store Two', category: 'SALON', upi_vpa: 's2@ok', address: 'Pune', pincode: '411004', is_open: true }
    ]
  ]);
  const sellerAccounts = new Map([
    [OWNER_1_ID, { id: OWNER_1_ID, phone: '+919800000001', email: 'owner1@test', status: 'ACTIVE', is_email_verified: true }],
    [STAFF_1_ID, { id: STAFF_1_ID, phone: '+919800000002', email: 'staff1@test', status: 'ACTIVE', is_email_verified: true }],
    [OUTSIDER_SELLER_ID, { id: OUTSIDER_SELLER_ID, phone: '+919800000003', email: 'outsider@test', status: 'ACTIVE', is_email_verified: true }]
  ]);
  const memberships = new Map<string, { id: string; seller_account_id: string; merchant_id: string; role: string; status: string }>([
    [`${OWNER_1_ID}:${STORE_1_ID}`, { id: 'm-1', seller_account_id: OWNER_1_ID, merchant_id: STORE_1_ID, role: 'OWNER', status: 'ACTIVE' }],
    [`${STAFF_1_ID}:${STORE_1_ID}`, { id: 'm-2', seller_account_id: STAFF_1_ID, merchant_id: STORE_1_ID, role: 'STAFF', status: 'ACTIVE' }],
    [`${OUTSIDER_SELLER_ID}:${STORE_2_ID}`, { id: 'm-3', seller_account_id: OUTSIDER_SELLER_ID, merchant_id: STORE_2_ID, role: 'OWNER', status: 'ACTIVE' }]
  ]);

  const conversations = new Map<string, any>([
    [
      CONV_1_ID,
      {
        id: CONV_1_ID,
        buyer_user_id: BUYER_1_ID,
        merchant_id: STORE_1_ID,
        status: 'OPEN',
        created_at: new Date('2026-11-26T10:00:00.000Z'),
        updated_at: new Date('2026-11-26T10:00:00.000Z')
      }
    ],
    [
      CONV_CLOSED_ID,
      {
        id: CONV_CLOSED_ID,
        buyer_user_id: BUYER_1_ID,
        merchant_id: STORE_2_ID,
        status: 'CLOSED',
        created_at: new Date('2026-11-25T10:00:00.000Z'),
        updated_at: new Date('2026-11-25T10:00:00.000Z')
      }
    ]
  ]);

  const participants = new Map<string, any>([
    [`${CONV_1_ID}:BUYER:${BUYER_1_ID}`, { conversation_id: CONV_1_ID, participant_type: 'BUYER', participant_id: BUYER_1_ID, can_read: true, can_send: true }],
    [`${CONV_CLOSED_ID}:BUYER:${BUYER_1_ID}`, { conversation_id: CONV_CLOSED_ID, participant_type: 'BUYER', participant_id: BUYER_1_ID, can_read: true, can_send: true }]
  ]);

  const messages: any[] = [
    {
      id: MSG_UUID_1,
      conversation_id: CONV_CLOSED_ID,
      sender_type: 'BUYER',
      sender_id: BUYER_1_ID,
      client_message_id: null,
      body: 'Archived question',
      created_at: new Date('2026-11-25T10:05:00.000Z')
    }
  ];

  const txLog: string[] = [];
  let convCounter = 1;
  let msgCounter = 1;

  const checkOutage = () => {
    if (options.failDbWith503) {
      const err: any = new Error('connect ECONNREFUSED 127.0.0.1:5433');
      err.code = 'ECONNREFUSED';
      throw err;
    }
  };

  const runCustomerQuery = async (sql: string, params: any[] = [], stateSnapshot?: any) => {
    checkOutage();
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK' || s.startsWith('SAVEPOINT') || s.startsWith('RELEASE SAVEPOINT') || s.startsWith('ROLLBACK TO SAVEPOINT')) {
      txLog.push(s);
      return { rows: [], rowCount: 0 };
    }

    if (s.startsWith('SELECT id FROM users WHERE id = $1')) {
      return { rows: users.has(params[0]) ? [{ id: params[0] }] : [], rowCount: users.has(params[0]) ? 1 : 0 };
    }

    if (s.startsWith('SELECT id, buyer_user_id, merchant_id, status, created_at, updated_at FROM conversations WHERE buyer_user_id = $1 AND merchant_id = $2 AND status = \'OPEN\'')) {
      const found = Array.from(conversations.values()).find(
        (c) => c.buyer_user_id === params[0] && c.merchant_id === params[1] && c.status === 'OPEN'
      );
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (s.startsWith('INSERT INTO conversations')) {
      const existing = Array.from(conversations.values()).find(
        (c) => c.buyer_user_id === params[0] && c.merchant_id === params[1] && c.status === 'OPEN'
      );
      if (existing || options.failNextInsertUnique) {
        options.failNextInsertUnique = false;
        const err: any = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      const id = `c0000000-0000-4000-8000-${String(convCounter++).padStart(12, '0')}`;
      const row = {
        id,
        buyer_user_id: params[0],
        merchant_id: params[1],
        status: 'OPEN',
        created_at: new Date(),
        updated_at: new Date()
      };
      conversations.set(id, row);
      return { rows: [row], rowCount: 1 };
    }

    if (s.startsWith('INSERT INTO conversation_participants')) {
      const type = s.includes("'BUYER'") ? 'BUYER' : 'SELLER_ACCOUNT';
      const key = `${params[0]}:${type}:${params[1]}`;
      if (!participants.has(key)) {
        participants.set(key, {
          conversation_id: params[0],
          participant_type: type,
          participant_id: params[1],
          can_read: true,
          can_send: true
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (s.startsWith('SELECT id, buyer_user_id, merchant_id, status, created_at, updated_at FROM conversations WHERE id = $1')) {
      const found = conversations.get(params[0]);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (s.startsWith('SELECT id, status FROM conversations WHERE id = $1 FOR SHARE')) {
      const found = conversations.get(params[0]);
      return { rows: found ? [{ id: found.id, status: found.status }] : [], rowCount: found ? 1 : 0 };
    }

    if (s.startsWith('SELECT can_read, can_send FROM conversation_participants')) {
      const type = s.includes("'BUYER'")
        ? 'BUYER'
        : s.includes("'SELLER_ACCOUNT'")
          ? 'SELLER_ACCOUNT'
          : params[1];
      const participantId = s.includes("'BUYER'") || s.includes("'SELLER_ACCOUNT'") ? params[1] : params[2];
      const found = participants.get(`${params[0]}:${type}:${participantId}`);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (s.includes('FROM conversations c') && s.includes("cp.participant_type = 'BUYER'")) {
      const rows = Array.from(conversations.values())
        .filter((c) => c.buyer_user_id === params[0] && participants.get(`${c.id}:BUYER:${params[0]}`)?.can_read)
        .map((c) => ({ ...c, last_message_id: null }));
      return { rows, rowCount: rows.length };
    }

    if (s.includes('FROM conversations c') && s.includes("cp.participant_type = 'SELLER_ACCOUNT'")) {
      const allowedStores = new Set<string>(params[0] || []);
      const sellerId = params[1];
      const rows = Array.from(conversations.values())
        .filter((c) => {
          if (!allowedStores.has(c.merchant_id)) return false;
          const p = participants.get(`${c.id}:SELLER_ACCOUNT:${sellerId}`);
          return !p || p.can_read === true;
        })
        .map((c) => ({ ...c, last_message_id: null }));
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('SELECT id, conversation_id, sender_type, sender_id, client_message_id, body, created_at FROM messages WHERE conversation_id = $1 AND sender_type = $2')) {
      const found = messages.find(
        (m) =>
          m.conversation_id === params[0] &&
          m.sender_type === params[1] &&
          m.sender_id === params[2] &&
          m.client_message_id === params[3]
      );
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (s.startsWith('SELECT id, conversation_id, sender_type, sender_id, client_message_id, body, created_at FROM messages WHERE conversation_id = $1')) {
      const filtered = messages
        .filter((m) => m.conversation_id === params[0])
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
      return { rows: filtered.slice(0, params[3] || 51), rowCount: filtered.length };
    }

    if (s.startsWith('INSERT INTO messages')) {
      const cidIdx = params[3] ?? null;
      if (cidIdx) {
        const dup = messages.find(
          (m) =>
            m.conversation_id === params[0] &&
            m.sender_type === params[1] &&
            m.sender_id === params[2] &&
            m.client_message_id === cidIdx
        );
        if (dup) {
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
      }
      const id = `d0000000-0000-4000-8000-${String(msgCounter++).padStart(12, '0')}`;
      const row = {
        id,
        conversation_id: params[0],
        sender_type: params[1],
        sender_id: params[2],
        client_message_id: cidIdx,
        body: params[4] ?? params[3],
        created_at: new Date()
      };
      messages.push(row);
      if (stateSnapshot) stateSnapshot.insertedMsgIds.push(id);
      return { rows: [row], rowCount: 1 };
    }

    if (s.startsWith('UPDATE conversations SET updated_at')) {
      if (options.failConvUpdateInTx) {
        throw new Error('forced conversation update failure');
      }
      const conv = conversations.get(params[0]);
      if (conv) {
        conv.updated_at = new Date(params[1]);
      }
      return { rows: [], rowCount: conv ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  const customerPool: StrictPgPool = {
    query: (sql, params) => runCustomerQuery(sql, params),
    connect: async () => {
      checkOutage();
      const snapshot = { insertedMsgIds: [] as string[] };
      const client: StrictPgClient = {
        query: async (sql: string, params?: any[]) => {
          const s = sql.trim().toUpperCase();
          if (s === 'ROLLBACK' && snapshot.insertedMsgIds.length > 0) {
            for (const msgId of snapshot.insertedMsgIds) {
              const idx = messages.findIndex((m) => m.id === msgId);
              if (idx >= 0) messages.splice(idx, 1);
            }
          }
          return runCustomerQuery(sql, params, snapshot);
        },
        release: () => {}
      };
      return client;
    },
    on: () => customerPool,
    end: async () => {}
  };

  const merchantPool: StrictPgPool = {
    query: async (sql: string, params: any[] = []) => {
      checkOutage();
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id, business_name, category, is_open FROM merchants WHERE id = $1')) {
        const st = stores.get(params[0]);
        return { rows: st ? [st] : [], rowCount: st ? 1 : 0 };
      }
      if (s.startsWith('SELECT id, business_name, category, is_open FROM merchants WHERE id = ANY($1::uuid[])')) {
        const rows = (params[0] || []).map((id: string) => stores.get(id)).filter(Boolean);
        return { rows, rowCount: rows.length };
      }
      if (s.startsWith('SELECT id, phone, email, is_email_verified, status, created_at FROM seller_accounts WHERE id = $1') ||
          s.startsWith('SELECT id, status FROM seller_accounts WHERE id = $1')) {
        const acct = sellerAccounts.get(params[0]);
        return { rows: acct ? [acct] : [], rowCount: acct ? 1 : 0 };
      }
      if (s.includes('FROM store_memberships sm JOIN merchants m ON m.id = sm.merchant_id')) {
        const rows = Array.from(memberships.values())
          .filter((m) => m.seller_account_id === params[0] && m.status === 'ACTIVE')
          .map((m) => {
            const st = stores.get(m.merchant_id)!;
            return {
              store_id: st.id,
              business_name: st.business_name,
              category: st.category,
              upi_vpa: st.upi_vpa,
              address: st.address,
              pincode: st.pincode,
              is_open: st.is_open,
              membership_id: m.id,
              membership_role: m.role,
              membership_status: m.status
            };
          });
        return { rows, rowCount: rows.length };
      }
      if (s.includes('FROM merchants m LEFT JOIN store_memberships sm')) {
        const st = stores.get(params[1]);
        if (!st) return { rows: [], rowCount: 0 };
        const mem = memberships.get(`${params[0]}:${params[1]}`);
        return {
          rows: [
            {
              store_id: st.id,
              business_name: st.business_name,
              membership_role: mem?.role ?? null,
              membership_status: mem?.status ?? null
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      throw new Error('merchantPool.connect not used here');
    },
    on: () => merchantPool,
    end: async () => {}
  };

  return {
    customerPool,
    merchantPool,
    conversations,
    participants,
    messages,
    memberships,
    sellerAccounts,
    txLog
  };
}

function httpRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ statusCode: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...(opts.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(raw);
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

function connectSocket(
  port: number,
  options: { token?: string; queryToken?: string } = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 3000,
      ...(options.token !== undefined ? { auth: { token: options.token } } : {}),
      ...(options.queryToken !== undefined ? { query: { token: options.queryToken } } : {})
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connect timeout'));
    }, 3500);
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

export async function runS14CMessagingUnitTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  async function runCase(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err: any) {
      results.push({ name, passed: false, error: err?.message || String(err) });
    }
  }

  // 1. Conversation creation & REST authorization
  await runCase('REST conversation creation is Buyer-only, validates store, ignores spoofed buyer IDs, and prevents enumeration', async () => {
    const cfg = makeConfig();
    const state = createMemoryChatPools();
    const redis = createMockRedis();
    const gw = createGatewayApp(cfg, { customerPool: state.customerPool, merchantPool: state.merchantPool, redis });
    await new Promise<void>((r) => gw.server.listen(0, '127.0.0.1', r));
    const port = (gw.server.address() as AddressInfo).port;

    try {
      const buyer1Token = makeBuyerJwt(cfg, BUYER_1_ID);
      const buyer2Token = makeBuyerJwt(cfg, BUYER_2_ID);
      const ownerToken = makeSellerJwt(cfg, OWNER_1_ID);
      const outsiderToken = makeSellerJwt(cfg, OUTSIDER_SELLER_ID);

      // Seller cannot initiate conversation
      const sellerCreate = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${ownerToken}` },
        body: { merchantId: STORE_1_ID }
      });
      assert.strictEqual(sellerCreate.statusCode, 403);

      // Missing store rejected 404
      const missingStore = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${buyer1Token}` },
        body: { merchantId: MISSING_CONV_ID }
      });
      assert.strictEqual(missingStore.statusCode, 404);

      // Repeated creation returns existing OPEN conversation; ignores client-supplied userId
      const createExisting = await httpRequest({
        port,
        method: 'POST',
        path: '/api/v1/conversations',
        headers: { Authorization: `Bearer ${buyer1Token}` },
        body: { merchantId: STORE_1_ID, buyerUserId: BUYER_2_ID, userId: BUYER_2_ID }
      });
      assert.strictEqual(createExisting.statusCode, 200);
      assert.strictEqual(createExisting.json.created, false);
      assert.strictEqual(createExisting.json.conversation.id, CONV_1_ID);
      assert.strictEqual(createExisting.json.conversation.buyerUserId, BUYER_1_ID);

      // Buyer 2 cannot distinguish unauthorized vs nonexistent conversation ID (uniform 404)
      const b2Read = await httpRequest({
        port,
        method: 'GET',
        path: `/api/v1/conversations/${CONV_1_ID}/messages`,
        headers: { Authorization: `Bearer ${buyer2Token}` }
      });
      const b2Missing = await httpRequest({
        port,
        method: 'GET',
        path: `/api/v1/conversations/${MISSING_CONV_ID}/messages`,
        headers: { Authorization: `Bearer ${buyer2Token}` }
      });
      assert.strictEqual(b2Read.statusCode, 404);
      assert.strictEqual(b2Missing.statusCode, 404);
      assert.deepStrictEqual(b2Read.json, b2Missing.json);

      // Unassigned seller gets identical 404 response
      const outsiderRead = await httpRequest({
        port,
        method: 'GET',
        path: `/api/v1/conversations/${CONV_1_ID}/messages`,
        headers: { Authorization: `Bearer ${outsiderToken}` }
      });
      assert.deepStrictEqual(outsiderRead.json, b2Missing.json);

      // Authorized buyer CAN still read history of CLOSED conversation, but cannot send new messages (409)
      const closedHist = await httpRequest({
        port,
        method: 'GET',
        path: `/api/v1/conversations/${CONV_CLOSED_ID}/messages`,
        headers: { Authorization: `Bearer ${buyer1Token}` }
      });
      assert.strictEqual(closedHist.statusCode, 200);
      assert.strictEqual(closedHist.json.messages.length, 1);

      const closedSend = await httpRequest({
        port,
        method: 'POST',
        path: `/api/v1/conversations/${CONV_CLOSED_ID}/messages`,
        headers: { Authorization: `Bearer ${buyer1Token}` },
        body: { text: 'Should fail on closed' }
      });
      assert.strictEqual(closedSend.statusCode, 409);
      assert.strictEqual(closedSend.json.code, 'CONVERSATION_CLOSED');
    } finally {
      await gw.shutdown();
    }
  });

  // 2. REST message validation, rollback atomicity, and seller revocation
  await runCase('REST message send validates length, rolls back on tx error with 0 broadcast, and enforces live membership', async () => {
    const cfg = makeConfig();
    const state = createMemoryChatPools();
    const redis = createMockRedis();
    const gw = createGatewayApp(cfg, { customerPool: state.customerPool, merchantPool: state.merchantPool, redis });
    await new Promise<void>((r) => gw.server.listen(0, '127.0.0.1', r));
    const port = (gw.server.address() as AddressInfo).port;

    try {
      const buyer1Token = makeBuyerJwt(cfg, BUYER_1_ID);
      const staffToken = makeSellerJwt(cfg, STAFF_1_ID);

      // Empty & oversized bodies rejected
      const emptyRes = await httpRequest({
        port,
        method: 'POST',
        path: `/api/v1/conversations/${CONV_1_ID}/messages`,
        headers: { Authorization: `Bearer ${buyer1Token}` },
        body: { text: '   ' }
      });
      assert.strictEqual(emptyRes.statusCode, 400);

      const longRes = await httpRequest({
        port,
        method: 'POST',
        path: `/api/v1/conversations/${CONV_1_ID}/messages`,
        headers: { Authorization: `Bearer ${buyer1Token}` },
        body: { text: 'a'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1) }
      });
      assert.strictEqual(longRes.statusCode, 400);

      // Transaction rollback leaves zero partial message and broadcasts nothing
      let broadcastCount = 0;
      gw.io.on('connection', () => {});
      const origTo = gw.io.to.bind(gw.io);
      (gw.io as any).to = (room: string | string[]) => {
        broadcastCount++;
        return origTo(room);
      };

      const prevCount = state.messages.length;
      const mutableOpts = state;
      const failPools = createMemoryChatPools({ failConvUpdateInTx: true });
      const gwFail = createGatewayApp(cfg, {
        customerPool: failPools.customerPool,
        merchantPool: failPools.merchantPool,
        redis: createMockRedis()
      });
      await new Promise<void>((r) => gwFail.server.listen(0, '127.0.0.1', r));
      const failPort = (gwFail.server.address() as AddressInfo).port;
      let failBroadcasts = 0;
      const origFailEmit = gwFail.io.emit.bind(gwFail.io);
      (gwFail.io as any).to = () => ({ emit: () => { failBroadcasts++; }, local: { emit: () => { failBroadcasts++; } } });

      try {
        const rollbackRes = await httpRequest({
          port: failPort,
          method: 'POST',
          path: `/api/v1/conversations/${CONV_1_ID}/messages`,
          headers: { Authorization: `Bearer ${buyer1Token}` },
          body: { text: 'Must rollback cleanly' }
        });
        assert.strictEqual(rollbackRes.statusCode, 500);
        assert.strictEqual(failPools.messages.length, 1, 'Rolled back tx must not keep inserted message');
        assert(failPools.txLog.includes('ROLLBACK'), 'Transaction failure must execute ROLLBACK');
        assert.strictEqual(failBroadcasts, 0, 'Failed transaction must broadcast nothing');
      } finally {
        void origFailEmit;
        void mutableOpts;
        void prevCount;
        await gwFail.shutdown();
      }

      // Active Staff sends message (ignores forged sender fields, stores SELLER_ACCOUNT + STAFF_1_ID)
      const staffSend = await httpRequest({
        port,
        method: 'POST',
        path: `/api/v1/conversations/${CONV_1_ID}/messages`,
        headers: { Authorization: `Bearer ${staffToken}` },
        body: {
          text: 'Hello from verified staff',
          sender: 'fake-buyer',
          senderType: 'BUYER',
          senderId: BUYER_1_ID
        }
      });
      assert.strictEqual(staffSend.statusCode, 201);
      assert.strictEqual(staffSend.json.message.senderType, 'SELLER_ACCOUNT');
      assert.strictEqual(staffSend.json.message.senderId, STAFF_1_ID);
      assert.strictEqual(broadcastCount, 1);

      // Revoke Staff membership -> next operation immediately denied even though participant exists
      state.memberships.get(`${STAFF_1_ID}:${STORE_1_ID}`)!.status = 'REVOKED';
      const revokedSend = await httpRequest({
        port,
        method: 'POST',
        path: `/api/v1/conversations/${CONV_1_ID}/messages`,
        headers: { Authorization: `Bearer ${staffToken}` },
        body: { text: 'Should fail after revoke' }
      });
      assert.strictEqual(revokedSend.statusCode, 404);
    } finally {
      await gw.shutdown();
    }
  });

  // 3. Socket.IO handshake auth, room authorization, and send security
  await runCase('Socket.IO enforces auth.token handshake, rejects query tokens/legacy tokens, and authorizes room joins & sends', async () => {
    const cfg = makeConfig();
    const state = createMemoryChatPools();
    const redis = createMockRedis();
    const gw = createGatewayApp(cfg, { customerPool: state.customerPool, merchantPool: state.merchantPool, redis });
    await new Promise<void>((r) => gw.server.listen(0, '127.0.0.1', r));
    const port = (gw.server.address() as AddressInfo).port;

    const socketsToClose: any[] = [];
    try {
      const buyer1Token = makeBuyerJwt(cfg, BUYER_1_ID);
      const buyer2Token = makeBuyerJwt(cfg, BUYER_2_ID);
      const staffToken = makeSellerJwt(cfg, STAFF_1_ID);
      const outsiderToken = makeSellerJwt(cfg, OUTSIDER_SELLER_ID);
      const expiredToken = makeBuyerJwt(cfg, BUYER_1_ID, -10);
      const legacySellerToken = signToken(cfg, { sub: STORE_1_ID, role: 'SELLER', aud: cfg.jwtSellerAudience });
      const wrongAudToken = signToken(cfg, { sub: BUYER_1_ID, role: 'BUYER', aud: cfg.jwtSellerAudience });
      const nonUuidSubToken = makeBuyerJwt(cfg, 'm1');

      // Rejected handshakes
      for (const badAttempt of [
        {},
        { queryToken: buyer1Token },
        { token: buyer1Token, queryToken: buyer1Token },
        { token: 'not.a.valid.jwt' },
        { token: expiredToken },
        { token: legacySellerToken },
        { token: wrongAudToken },
        { token: nonUuidSubToken }
      ]) {
        let rejected = false;
        try {
          const s = await connectSocket(port, badAttempt);
          s.disconnect();
        } catch {
          rejected = true;
        }
        assert(rejected, `Expected Socket.IO handshake rejection for ${JSON.stringify(Object.keys(badAttempt))}`);
      }

      // Authorized Buyer + Active Staff connect via auth.token
      const buyerSocket = await connectSocket(port, { token: buyer1Token });
      const buyer2Socket = await connectSocket(port, { token: buyer2Token });
      const staffSocket = await connectSocket(port, { token: staffToken });
      const outsiderSocket = await connectSocket(port, { token: outsiderToken });
      socketsToClose.push(buyerSocket, buyer2Socket, staffSocket, outsiderSocket);

      // Unjoined send rejected
      const unjoinedAck: any = await new Promise((resolve) =>
        buyerSocket.emit('send_message', { conversationId: CONV_1_ID, text: 'Not joined' }, resolve)
      );
      assert.strictEqual(unjoinedAck.success, false);
      assert.strictEqual(unjoinedAck.code, 'ROOM_NOT_JOINED');

      // Arbitrary room / unrelated Buyer / unassigned Seller rejected cleanly
      const arbitraryAck: any = await new Promise((resolve) =>
        buyerSocket.emit('join_conversation', 'arbitrary-room-name', resolve)
      );
      assert.strictEqual(arbitraryAck.success, false);

      const b2JoinAck: any = await new Promise((resolve) =>
        buyer2Socket.emit('join_conversation', CONV_1_ID, resolve)
      );
      assert.strictEqual(b2JoinAck.success, false);
      assert.strictEqual(b2JoinAck.code, 'FORBIDDEN');

      const outJoinAck: any = await new Promise((resolve) =>
        outsiderSocket.emit('join_conversation', CONV_1_ID, resolve)
      );
      assert.strictEqual(outJoinAck.success, false);
      assert.strictEqual(outJoinAck.code, 'FORBIDDEN');

      // Authorized Buyer & Staff join namespaced room conversation:<uuid>
      const bJoinAck: any = await new Promise((resolve) =>
        buyerSocket.emit('join_conversation', CONV_1_ID, resolve)
      );
      assert.strictEqual(bJoinAck.success, true);
      assert.strictEqual(bJoinAck.room, getConversationRoomName(CONV_1_ID));

      const sJoinAck: any = await new Promise((resolve) =>
        staffSocket.emit('join_conversation', CONV_1_ID, resolve)
      );
      assert.strictEqual(sJoinAck.success, true);
      assert.strictEqual(sJoinAck.room, getConversationRoomName(CONV_1_ID));

      // Forged sender payload on Staff socket must still broadcast Staff's actual SELLER_ACCOUNT ID
      const receivedByBuyerPromise = new Promise<any>((resolve) =>
        buyerSocket.once('new_message', resolve)
      );
      const staffSendAck: any = await new Promise((resolve) =>
        staffSocket.emit(
          'send_message',
          {
            conversationId: CONV_1_ID,
            sender: 'spoofed-owner',
            senderType: 'BUYER',
            senderId: BUYER_1_ID,
            text: 'Realtime verified staff reply'
          },
          resolve
        )
      );
      assert.strictEqual(staffSendAck.success, true);
      assert.strictEqual(staffSendAck.persisted, true);
      assert.strictEqual(staffSendAck.message.senderType, 'SELLER_ACCOUNT');
      assert.strictEqual(staffSendAck.message.senderId, STAFF_1_ID);

      const delivered = await receivedByBuyerPromise;
      assert.strictEqual(delivered.id, staffSendAck.message.id);
      assert.strictEqual(delivered.senderType, 'SELLER_ACCOUNT');
      assert.strictEqual(delivered.senderId, STAFF_1_ID);

      // Revoke Staff membership -> next send rejected even while still in Socket.IO room
      state.memberships.get(`${STAFF_1_ID}:${STORE_1_ID}`)!.status = 'REVOKED';
      let rogueBroadcast = false;
      buyerSocket.once('new_message', () => {
        rogueBroadcast = true;
      });
      const revokedSendAck: any = await new Promise((resolve) =>
        staffSocket.emit('send_message', { conversationId: CONV_1_ID, text: 'After revoke' }, resolve)
      );
      assert.strictEqual(revokedSendAck.success, false);
      assert.strictEqual(revokedSendAck.code, 'FORBIDDEN');
      assert.strictEqual(rogueBroadcast, false);
    } finally {
      for (const s of socketsToClose) {
        s.disconnect();
      }
      await gw.shutdown();
    }
  });

  // 4. Socket handshake fails closed on PG DB outage + Redis Pub/Sub client config & ownership
  await runCase('Socket handshake fails closed on DB outage and Redis Pub/Sub clients preserve independent ownership & policies', async () => {
    const cfg = makeConfig();
    const outagePools = createMemoryChatPools({ failDbWith503: true });
    const gwOutage = createGatewayApp(cfg, {
      customerPool: outagePools.customerPool,
      merchantPool: outagePools.merchantPool,
      redis: createMockRedis()
    });
    await new Promise<void>((r) => gwOutage.server.listen(0, '127.0.0.1', r));
    const port = (gwOutage.server.address() as AddressInfo).port;

    try {
      let errMsg = '';
      try {
        await connectSocket(port, { token: makeBuyerJwt(cfg, BUYER_1_ID) });
      } catch (err: any) {
        errMsg = err?.message || '';
      }
      assert(errMsg.includes('SERVICE_UNAVAILABLE'), `Expected SERVICE_UNAVAILABLE handshake rejection, got: ${errMsg}`);
    } finally {
      await gwOutage.shutdown();
    }

    // Verify dedicated Pub/Sub client config and ownership isolation
    const pubClient = createRedisPubSubClient('redis://default:PubSecret@127.0.0.1:16399', 'pub');
    const subClient = createRedisPubSubClient('redis://default:SubSecret@127.0.0.1:16399', 'sub');
    assert.strictEqual((pubClient as any).options.enableOfflineQueue, false, 'Pub client must fail-fast without offline queue');
    assert.strictEqual((subClient as any).options.autoResubscribe, true, 'Sub client must autoResubscribe');
    assert.strictEqual((subClient as any).options.maxRetriesPerRequest, null, 'Sub client must not cap blocked listener requests');
    assert.strictEqual((subClient as any).options.retryStrategy(50), REDIS_MAX_RECONNECT_DELAY_MS);
    pubClient.disconnect(false);
    subClient.disconnect(false);

    const injectedOtpRedis = createMockRedis('ready');
    const injectedPub = createMockRedis('wait');
    const injectedSub = createMockRedis('wait');
    const gwInjected = createGatewayApp(cfg, {
      customerPool: outagePools.customerPool,
      merchantPool: outagePools.merchantPool,
      redis: injectedOtpRedis,
      redisPubClient: injectedPub,
      redisSubClient: injectedSub
    });
    await gwInjected.shutdown();
    assert.strictEqual(injectedOtpRedis.quitCalls, 0);
    assert.strictEqual(injectedPub.quitCalls + injectedPub.disconnectCalls, 0);
    assert.strictEqual(injectedSub.quitCalls + injectedSub.disconnectCalls, 0);
  });

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runS14CMessagingUnitTests()
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
      console.log(`\nS1.4-C Unit Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal S1.4-C unit test error:', err);
      process.exit(1);
    });
}
