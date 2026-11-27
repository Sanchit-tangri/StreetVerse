/**
 * StreetVerse S1.3-A Automated Unit Tests: Strict PostgreSQL Infrastructure & Error Classification
 * Exercises withPgTransaction, createStrictPgPool error logging/fail-closed behaviour,
 * and PostgreSQL vs application/SQL error classification strictly without live infra dependencies.
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import http from 'http';
import net, { AddressInfo } from 'net';
import { GatewayConfig } from '../../services/api-gateway/src/config/env';
import { createGatewayApp, registerShutdownSignals } from '../../services/api-gateway/src/app';
import { createStrictPgPool, StrictPgClient, StrictPgPool, withPgTransaction } from '../../services/api-gateway/src/db/postgres';
import {
  classifyDbError,
  classifyHttpError,
  InfrastructureUnavailableError,
  isPgUnavailableError,
  isRedisUnavailableError,
  sanitizeErrorForLog,
  toInfrastructureUnavailableError
} from '../../services/api-gateway/src/utils/infraErrors';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runS13PgInfraUnitTests(): Promise<TestResult[]> {
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
  // 1. TRANSACTION HELPER (COMMIT, ROLLBACK, RELEASE, ERROR PRESERVATION)
  // -------------------------------------------------------------------------
  await runCase('withPgTransaction: commits on success and always releases client', async () => {
    const queries: string[] = [];
    let releasedCount = 0;

    const fakeClient: StrictPgClient = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ id: 'row-1' }], rowCount: 1 };
      },
      release: () => {
        releasedCount++;
      }
    };

    const fakePool: Pick<StrictPgPool, 'connect'> = {
      connect: async () => fakeClient
    };

    const val = await withPgTransaction(fakePool, async (client) => {
      const res = await client.query('INSERT INTO demo VALUES ($1)', ['ok']);
      return res.rows[0].id;
    });

    assert(val === 'row-1', `Expected return value row-1, got ${val}`);
    assert(queries.length === 3, `Expected 3 SQL calls, got ${queries.length}`);
    assert(queries[0] === 'BEGIN' && queries[2] === 'COMMIT', `Unexpected query sequence: ${queries.join(', ')}`);
    assert(releasedCount === 1, `Client must be released exactly once, got ${releasedCount}`);
  });

  await runCase('withPgTransaction: rolls back on callback failure and releases client', async () => {
    const queries: string[] = [];
    let releasedCount = 0;

    const fakeClient: StrictPgClient = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        releasedCount++;
      }
    };

    const fakePool: Pick<StrictPgPool, 'connect'> = {
      connect: async () => fakeClient
    };

    let caught: Error | null = null;
    try {
      await withPgTransaction(fakePool, async (client) => {
        await client.query('UPDATE accounts SET balance = balance - 10');
        throw new Error('Causal domain failure');
      });
    } catch (err: any) {
      caught = err;
    }

    assert(caught !== null && caught.message === 'Causal domain failure', 'Causal exception must propagate');
    assert(queries.includes('ROLLBACK') && !queries.includes('COMMIT'), `Expected ROLLBACK without COMMIT: ${queries.join(', ')}`);
    assert(releasedCount === 1, `Client must be released once on failure, got ${releasedCount}`);
  });

  await runCase('withPgTransaction: rollback failure does not mask original error and still releases client', async () => {
    const queries: string[] = [];
    let releasedCount = 0;
    const origConsoleError = console.error;
    const capturedLogs: string[] = [];
    console.error = (...args: any[]) => {
      capturedLogs.push(args.map(String).join(' '));
    };

    try {
      const fakeClient: StrictPgClient = {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql === 'ROLLBACK') {
            throw new Error('Rollback connection dropped postgres://admin:supersecret@db:5432/app');
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {
          releasedCount++;
        }
      };

      const fakePool: Pick<StrictPgPool, 'connect'> = {
        connect: async () => fakeClient
      };

      let caught: Error | null = null;
      try {
        await withPgTransaction(fakePool, async () => {
          throw new Error('Primary constraint violation error');
        });
      } catch (err: any) {
        caught = err;
      }

      assert(
        caught !== null && caught.message === 'Primary constraint violation error',
        `Original error was masked: ${caught?.message}`
      );
      assert(releasedCount === 1, `Client must still be released once, got ${releasedCount}`);
      assert(
        capturedLogs.every((l) => !l.includes('supersecret')),
        'Rollback log must redact database credentials'
      );
    } finally {
      console.error = origConsoleError;
    }
  });

  await runCase('withPgTransaction: BEGIN error skips ROLLBACK and releases client cleanly', async () => {
    const queries: string[] = [];
    let releasedCount = 0;

    const fakePool: Pick<StrictPgPool, 'connect'> = {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
        },
        release: () => {
          releasedCount++;
        }
      })
    };

    let caught: any = null;
    try {
      await withPgTransaction(fakePool, async () => 'unreachable');
    } catch (err) {
      caught = err;
    }

    assert(caught !== null && isPgUnavailableError(caught), 'BEGIN connection failure must propagate');
    assert(!queries.includes('ROLLBACK'), 'ROLLBACK must not execute if BEGIN failed');
    assert(releasedCount === 1, 'Client must be released when BEGIN fails');
  });

  await runCase('withPgTransaction: COMMIT drop propagates without blind retry or post-COMMIT ROLLBACK', async () => {
    const queries: string[] = [];
    let releasedCount = 0;
    let callbackRuns = 0;

    const fakePool: Pick<StrictPgPool, 'connect'> = {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          if (sql === 'COMMIT') {
            throw Object.assign(new Error('connection failure during COMMIT'), { code: '08006' });
          }
          return { rows: [{ id: 'inserted-once' }], rowCount: 1 };
        },
        release: () => {
          releasedCount++;
        }
      })
    };

    let caught: any = null;
    try {
      await withPgTransaction(fakePool, async (client) => {
        callbackRuns++;
        return client.query('INSERT INTO orders (amount) VALUES ($1)', [500]);
      });
    } catch (err) {
      caught = err;
    }

    assert(callbackRuns === 1, `Non-idempotent transaction must NEVER blindly retry (ran ${callbackRuns} times)`);
    assert(caught !== null && caught.code === '08006', 'COMMIT connection failure must propagate to caller');
    assert(!queries.includes('ROLLBACK'), 'ROLLBACK must not be issued after COMMIT started');
    assert(releasedCount === 1, 'Client must still be released when COMMIT fails');
  });

  // -------------------------------------------------------------------------
  // 2. STRICT PG POOL VALIDATION, REDACTION & FAIL-CLOSED CLOSED-PORT CHECK
  // -------------------------------------------------------------------------
  await runCase('createStrictPgPool: validates config, redacts credentials on error, fails closed when PG down', async () => {
    let missingThrew = false;
    try {
      createStrictPgPool('   ', 'customer');
    } catch {
      missingThrew = true;
    }
    assert(missingThrew, 'Blank connection string must throw configuration error');

    // Reserve and close an ephemeral TCP port to guarantee immediate ECONNREFUSED without touching dev ports
    const closedPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      });
    });

    const secretPass = 'VerySecretPgPass999';
    const pool = createStrictPgPool(
      `postgresql://pguser:${secretPass}@127.0.0.1:${closedPort}/nonexistent_db`,
      'customer',
      { connectionTimeoutMillis: 600 }
    );

    const origConsoleError = console.error;
    const logs: string[] = [];
    console.error = (...args: any[]) => logs.push(args.map(String).join(' '));

    try {
      // Trigger pool error event and assert secret redaction
      (pool as any).emit('error', new Error(`connect failed postgresql://pguser:${secretPass}@127.0.0.1:${closedPort}/nonexistent_db`));
      assert(logs.length >= 1, 'Pool error listener must log sanitized error');
      assert(logs.every((l) => !l.includes(secretPass)), 'Pool error logs must never expose DB credentials');

      // Querying unreachable PostgreSQL MUST reject (no fake rahul.d@example.com fallback)
      let queryErr: unknown = null;
      try {
        await pool.query('SELECT id, email FROM users WHERE email = $1', ['rahul.d@example.com']);
      } catch (err) {
        queryErr = err;
      }
      assert(queryErr !== null, 'Unreachable PostgreSQL must throw rather than returning fake fallback rows');
      assert(isPgUnavailableError(queryErr), `Expected PG unavailable classification, got: ${String(queryErr)}`);
    } finally {
      console.error = origConsoleError;
      await pool.end().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // 3. ERROR CLASSIFICATION & SAFE HTTP MAPPING
  // -------------------------------------------------------------------------
  await runCase('Error classifier: distinguishes PG outages (503) from constraints, invalid UUIDs, SQL bugs & app exceptions', () => {
    const pgOutageVectors = [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      new AggregateError([Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })], 'All promises failed'),
      Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
      Object.assign(new Error('the database system is starting up'), { code: '57P03' }),
      Object.assign(new Error('too many clients already'), { code: '53300' }),
      Object.assign(new Error('connection failure'), { code: '08006' }),
      new Error('timeout exceeded when trying to connect')
    ];

    for (const vec of pgOutageVectors) {
      assert(isPgUnavailableError(vec), `Expected PG outage true for: ${vec.message}`);
      const httpErr = classifyHttpError(vec);
      assert(httpErr.status === 503 && httpErr.code === 'POSTGRES_UNAVAILABLE', `Expected 503 POSTGRES_UNAVAILABLE, got ${httpErr.status}/${httpErr.code}`);
      assert(!httpErr.message.includes('5433'), 'Public HTTP message must not leak ports or internal messages');
    }

    // 53300 too_many_connections IS transient unavailability (503)
    const tooManyConns = Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    assert(isPgUnavailableError(tooManyConns), '53300 too_many_connections must classify as PG unavailable');
    const tooManyClass = classifyDbError(tooManyConns);
    assert(tooManyClass.isUnavailable && tooManyClass.statusCode === 503, '53300 must map to 503');

    // 53400 configuration_limit_exceeded must NOT be blanket-classified as transient 503 outage
    const configLimitErr = Object.assign(new Error('max_stack_depth exceeded'), { code: '53400' });
    assert(!isPgUnavailableError(configLimitErr), '53400 configuration_limit_exceeded must NOT blindly trigger 503 outage');
    const configLimitClass = classifyDbError(configLimitErr);
    assert(
      !configLimitClass.isUnavailable &&
        configLimitClass.statusCode === 500 &&
        configLimitClass.code === 'PG_CONFIGURATION_LIMIT_EXCEEDED',
      `Expected 53400 to map to 500 PG_CONFIGURATION_LIMIT_EXCEEDED, got ${configLimitClass.statusCode}/${configLimitClass.code}`
    );
    assert(classifyHttpError(configLimitErr).status === 500, 'HTTP mapping for 53400 must be 500, not 503');

    // Unique constraint 23505 -> 409 CONFLICT (NEVER 503)
    const uniqueErr = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505' });
    assert(!isPgUnavailableError(uniqueErr), '23505 must not be classified as PG unavailable');
    const uniqueClass = classifyDbError(uniqueErr);
    assert(uniqueClass.category === 'CONFLICT' && uniqueClass.statusCode === 409, `Expected 409 CONFLICT, got ${uniqueClass.statusCode}`);

    // Foreign key / check constraint 23503 / 23514 -> 400 CONSTRAINT_VIOLATION (NEVER 503)
    const fkErr = Object.assign(new Error('insert or update on table violates foreign key constraint'), { code: '23503' });
    assert(!isPgUnavailableError(fkErr), '23503 must not be classified as PG unavailable');
    assert(classifyHttpError(fkErr).status === 400, '23503 must map to 400');

    // Invalid UUID syntax 22P02 -> 400 when input-driven, 500 by default (NEVER 503)
    const uuidErr = Object.assign(new Error('invalid input syntax for type uuid: "m2"'), { code: '22P02' });
    assert(!isPgUnavailableError(uuidErr), '22P02 must not be classified as PG unavailable');
    assert(classifyHttpError(uuidErr, { treatInvalidInputAs400: true }).status === 400, '22P02 input error should map to 400 when enabled');
    assert(classifyHttpError(uuidErr).status === 500, '22P02 unexpected internal error should map to 500 by default');

    // SQL syntax/schema programming errors -> 500 INTERNAL_DATABASE_ERROR (NEVER 503)
    for (const sqlState of ['42601', '42P01', '42703']) {
      const sqlErr = Object.assign(new Error(`SELECT * FROM secret_table WHERE bad_col = 1 (${sqlState})`), { code: sqlState });
      assert(!isPgUnavailableError(sqlErr), `SQL error ${sqlState} must NEVER be classified as outage`);
      const httpSql = classifyHttpError(sqlErr);
      assert(httpSql.status === 500, `Expected 500 for SQL error ${sqlState}, got ${httpSql.status}`);
      assert(!httpSql.message.includes('SELECT'), 'HTTP error response must never expose SQL statements');
    }

    // Unexpected JS/App error -> 500 INTERNAL (NEVER 503)
    const appErr = new TypeError("Cannot read properties of undefined (reading 'rows')");
    assert(!isPgUnavailableError(appErr) && !isRedisUnavailableError(appErr), 'App exception must not look like infra outage');
    assert(classifyHttpError(appErr).status === 500, 'App exception must map to 500');

    // Redis error helper preview for S1.3-B
    const redisErr = new Error('Connection is closed.');
    assert(isRedisUnavailableError(redisErr), 'Closed Redis error must match isRedisUnavailableError');
    const converted = toInfrastructureUnavailableError(redisErr, 'REDIS');
    assert(converted instanceof InfrastructureUnavailableError && converted.statusCode === 503, 'Must convert to InfrastructureUnavailableError(503)');

    // Credential sanitization helper
    const sanitized = sanitizeErrorForLog('Error connecting postgresql://postgres:TopSecret123@db.internal:5432/prod redis://default:RedisPass@cache:6379');
    assert(!sanitized.includes('TopSecret123') && !sanitized.includes('RedisPass'), `Sanitized log leaked secrets: ${sanitized}`);
  });

  // -------------------------------------------------------------------------
  // 4. GRACEFUL GATEWAY & POSTGRESQL SHUTDOWN LIFECYCLE
  // -------------------------------------------------------------------------
  const makeTestConfig = (): GatewayConfig => ({
    nodeEnv: 'test',
    port: 0,
    allowedOrigins: ['https://buyer.example.test'],
    jwtSecret: crypto.randomBytes(36).toString('base64url'),
    jwtIssuer: 'streetverse-api-test',
    jwtBuyerAudience: 'streetverse-buyer-test',
    jwtSellerAudience: 'streetverse-seller-test',
    jwtExpiresIn: '7d',
    redisUrl: 'redis://127.0.0.1:6399',
    customerDbUrl: 'postgresql://postgres:unit_secret@127.0.0.1:15991/test_cust',
    merchantDbUrl: 'postgresql://postgres:unit_secret@127.0.0.1:15992/test_merch',
    aiEngineUrl: 'http://127.0.0.1:8000'
  });

  await runCase('Graceful shutdown: SIGTERM rejects new connections, drains active requests, closes owned PG pools', async () => {
    const cfg = makeTestConfig();
    const { app, server, customerPool, merchantPool, shutdown } = createGatewayApp(cfg, {
      redis: { on: () => {} } as any
    });

    let ownedCustEnds = 0;
    let ownedMerchEnds = 0;
    const origCustEnd = customerPool.end.bind(customerPool);
    const origMerchEnd = merchantPool.end.bind(merchantPool);
    customerPool.end = async () => {
      ownedCustEnds++;
      return origCustEnd();
    };
    merchantPool.end = async () => {
      ownedMerchEnds++;
      return origMerchEnd();
    };

    let releaseSlowRequest!: () => void;
    let slowStarted!: () => void;
    const slowStartedPromise = new Promise<void>((r) => {
      slowStarted = r;
    });
    const slowGate = new Promise<void>((r) => {
      releaseSlowRequest = r;
    });

    app.get('/_test/slow', async (_req, res) => {
      slowStarted();
      await slowGate;
      res.status(200).json({ drained: true });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const fakeProc = new EventEmitter();
    const exitPromise = new Promise<number>((resolveExit) => {
      registerShutdownSignals(shutdown, {
        targetProcess: fakeProc as any,
        onExit: (code) => resolveExit(code),
        timeoutMs: 3000
      });
    });

    // 1. Start an active HTTP request before shutdown begins
    const activeReqPromise = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path: '/_test/slow', agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    await slowStartedPromise;

    // 2. Emit SIGTERM + redundant SIGINT while active request is in flight
    fakeProc.emit('SIGTERM');
    fakeProc.emit('SIGINT');

    assert(!server.listening, 'HTTP server must stop accepting new connections immediately on SIGTERM');
    assert(ownedCustEnds === 0 && ownedMerchEnds === 0, 'Pools must not end before active request finishes draining');

    // 3. New connections during shutdown must be refused
    const rejectedNewConn = await new Promise<boolean>((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path: '/api/health', agent: false },
        () => resolve(false)
      );
      req.on('error', () => resolve(true));
      req.end();
    });
    assert(rejectedNewConn, 'New HTTP requests after shutdown initiates must be refused');

    // 4. Release active request -> completes 200, then BOTH owned PG pools close
    releaseSlowRequest();
    const activeRes = await activeReqPromise;
    assert(activeRes.statusCode === 200 && activeRes.body.includes('drained'), `Active request failed: ${activeRes.statusCode}`);

    const exitCode = await exitPromise;
    assert(exitCode === 0, `Expected clean exit code 0, got ${exitCode}`);
    assert(ownedCustEnds === 1, `Owned Customer pool.end() must be called once, got ${ownedCustEnds}`);
    assert(ownedMerchEnds === 1, `Owned Merchant pool.end() must be called once, got ${ownedMerchEnds}`);
  });

  await runCase('Graceful shutdown: preserves injected test-owned pools and enforces bounded timeout', async () => {
    const cfg = makeTestConfig();
    let injectedCustEnds = 0;
    let injectedMerchEnds = 0;

    const injectedCustPool: StrictPgPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
      on: () => injectedCustPool,
      end: async () => {
        injectedCustEnds++;
      }
    };
    const injectedMerchPool: StrictPgPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
      on: () => injectedMerchPool,
      end: async () => {
        injectedMerchEnds++;
      }
    };

    const { app, server, shutdown } = createGatewayApp(cfg, {
      customerPool: injectedCustPool,
      merchantPool: injectedMerchPool,
      redis: { on: () => {} } as any
    });

    let stallStarted!: () => void;
    const stallStartedPromise = new Promise<void>((r) => {
      stallStarted = r;
    });

    app.get('/_test/hang', (_req, _res) => {
      stallStarted();
      // Intentionally never responds to test bounded timeout force-close
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const hangReqPromise = new Promise<void>((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path: '/_test/hang', agent: false },
        () => resolve()
      );
      req.on('error', () => resolve());
      req.end();
    });

    await stallStartedPromise;
    const startMs = Date.now();
    const res = await shutdown({ timeoutMs: 80 });
    const elapsedMs = Date.now() - startMs;
    await hangReqPromise;

    assert(res.timedOut === true, 'Shutdown must report timedOut=true when active connection exceeds deadline');
    assert(elapsedMs < 1000, `Bounded timeout exceeded limit (${elapsedMs}ms)`);
    assert(injectedCustEnds === 0, `Injected customer pool must NOT be closed by app shutdown (${injectedCustEnds})`);
    assert(injectedMerchEnds === 0, `Injected merchant pool must NOT be closed by app shutdown (${injectedMerchEnds})`);
  });

  await runCase('Graceful shutdown: SIGINT closes owned pools and logs pool.end failures without leaking credentials', async () => {
    const cfg = makeTestConfig();
    const { customerPool, merchantPool, shutdown } = createGatewayApp(cfg, {
      redis: { on: () => {} } as any
    });

    const shutdownSecret = 'OwnedPoolSecretXYZ';
    const origCustEnd = customerPool.end.bind(customerPool);
    customerPool.end = async () => {
      await origCustEnd();
      throw new Error(`close failure on postgresql://postgres:${shutdownSecret}@localhost:5433/cust`);
    };

    const fakeProc = new EventEmitter();
    const origConsoleError = console.error;
    const origConsoleLog = console.log;
    const errorLogs: string[] = [];
    console.error = (...args: any[]) => errorLogs.push(args.map(String).join(' '));
    console.log = () => {};

    try {
      const exitPromise = new Promise<number>((resolveExit) => {
        registerShutdownSignals(shutdown, {
          targetProcess: fakeProc as any,
          onExit: (code) => resolveExit(code),
          timeoutMs: 1000
        });
      });

      fakeProc.emit('SIGINT');
      const exitCode = await exitPromise;

      assert(exitCode === 1, `Pool shutdown error must exit with code 1, got ${exitCode}`);
      assert(errorLogs.length >= 1, 'Pool shutdown error must be logged');
      assert(
        errorLogs.every((l) => !l.includes(shutdownSecret)),
        `Shutdown error log leaked secret credentials: ${errorLogs.join(' | ')}`
      );
    } finally {
      console.error = origConsoleError;
      console.log = origConsoleLog;
      await merchantPool.end().catch(() => {});
    }
  });

  await runCase('withPgTransaction: captures checked-out client error event without crashing and passes error to release', async () => {
    const clientEmitter = new EventEmitter();
    const releaseArgs: Array<Error | boolean | undefined> = [];
    const clientSecret = 'CheckedOutPgSecret77';
    let commitAttempted = false;

    const mockClient = Object.assign(clientEmitter, {
      query: async (sql: string) => {
        if (sql === 'COMMIT') {
          commitAttempted = true;
          throw new Error('Client has encountered a connection error and is not queryable');
        }
        return { rows: [], rowCount: 0 };
      },
      release: (err?: Error | boolean) => {
        releaseArgs.push(err);
      }
    });

    const origConsoleError = console.error;
    const capturedLogs: string[] = [];
    console.error = (...args: any[]) => capturedLogs.push(args.map(String).join(' '));

    let caught: unknown;
    try {
      await withPgTransaction(
        { connect: async () => mockClient },
        async () => {
          clientEmitter.emit(
            'error',
            new Error(`Connection terminated unexpectedly on postgresql://postgres:${clientSecret}@localhost:5433/cust`)
          );
        }
      );
    } catch (err) {
      caught = err;
    } finally {
      console.error = origConsoleError;
    }

    assert(commitAttempted, 'Expected COMMIT attempt to surface post-drop failure');
    assert(caught instanceof Error, 'Expected checked-out failure to reject rather than resolving');
    assert(releaseArgs.length === 1 && releaseArgs[0] instanceof Error, 'Broken checked-out client must be passed to release(err)');
    assert(clientEmitter.listenerCount('error') === 0, 'Checked-out error listener must be detached on release');
    assert(
      capturedLogs.every((line) => !line.includes(clientSecret)),
      `Checked-out client error log leaked secret: ${capturedLogs.join(' | ')}`
    );
  });

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runS13PgInfraUnitTests()
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
      console.log(`\nS1.3-A PG Infra Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal S1.3-A unit test error:', err);
      process.exit(1);
    });
}
