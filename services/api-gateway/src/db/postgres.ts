import pg from 'pg';
import { sanitizeErrorForLog } from '../utils/infraErrors';

export type PgDatabaseLabel = 'customer' | 'merchant';

export interface StrictPgQueryResult {
  rows: any[];
  rowCount: number | null;
}

export interface StrictPgClient {
  query: (text: string, values?: any[]) => Promise<StrictPgQueryResult>;
  release: (err?: Error | boolean) => void;
  on?: (event: string, listener: (...args: any[]) => void) => any;
  off?: (event: string, listener: (...args: any[]) => void) => any;
  removeListener?: (event: string, listener: (...args: any[]) => void) => any;
}

export interface StrictPgPool {
  query: (text: string, values?: any[]) => Promise<StrictPgQueryResult>;
  connect: () => Promise<StrictPgClient>;
  on: (event: string, listener: (...args: any[]) => void) => any;
  end: () => Promise<void>;
}

/**
 * Creates a strict PostgreSQL connection pool with zero in-memory fallback or import-time seeding.
 * Logs background pool errors cleanly without exposing connection strings or credentials.
 */
export function createStrictPgPool(
  connectionString: string,
  label: PgDatabaseLabel,
  overrides: Partial<pg.PoolConfig> = {}
): StrictPgPool {
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new Error(`Configuration error: Missing PostgreSQL connection string for "${label}" pool.`);
  }

  const pool = new pg.Pool({
    connectionString: connectionString.trim(),
    max: 10,
    connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 10000,
    ...overrides
  });

  pool.on('error', (err: unknown) => {
    const code =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    console.error(`[PostgreSQL:${label}] Background pool error (code=${code}): ${sanitizeErrorForLog(err)}`);
  });

  return pool as unknown as StrictPgPool;
}

/**
 * Executes a callback inside an explicit PostgreSQL transaction (`BEGIN` ... `COMMIT`),
 * rolling back on failure without masking the causal exception and always releasing the client.
 *
 * Commit-failure semantics (uncertain outcome):
 * If the database connection fails while `COMMIT` is in flight (e.g., socket drop / `08006`),
 * the server may have already committed or may have rolled back. `withPgTransaction` does NOT
 * issue a futile `ROLLBACK` after `COMMIT` has started and NEVER performs blind automatic retries,
 * because retrying non-idempotent writes on an uncertain `COMMIT` can duplicate state changes.
 * Callers needing retry safety must use explicit idempotency checks/keys before re-executing.
 */
export async function withPgTransaction<T>(
  pool: Pick<StrictPgPool, 'connect'>,
  callback: (client: StrictPgClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let transactionStarted = false;
  let commitAttempted = false;
  let checkedOutError: Error | undefined;

  // pg-pool detaches its idle error handler while a client is checked out.
  // Listen on the checked-out client so abrupt backend/socket termination destroys
  // the client cleanly instead of triggering an unhandled EventEmitter 'error' crash.
  const onClientError = (clientErr: unknown) => {
    const captured = clientErr instanceof Error ? clientErr : new Error(sanitizeErrorForLog(clientErr));
    if (!checkedOutError) {
      checkedOutError = captured;
    }
    const code =
      clientErr && typeof clientErr === 'object' && typeof (clientErr as { code?: unknown }).code === 'string'
        ? (clientErr as { code: string }).code
        : 'UNKNOWN';
    console.error(`[PostgreSQL] Checked-out transaction client error (code=${code}): ${sanitizeErrorForLog(clientErr)}`);
  };

  if (typeof client.on === 'function') {
    client.on('error', onClientError);
  }

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await callback(client);
    commitAttempted = true;
    await client.query('COMMIT');
    return result;
  } catch (err) {
    if (transactionStarted && !commitAttempted && !checkedOutError) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        const code =
          rollbackErr && typeof rollbackErr === 'object' && typeof (rollbackErr as { code?: unknown }).code === 'string'
            ? (rollbackErr as { code: string }).code
            : 'UNKNOWN';
        console.error(`[PostgreSQL] Transaction rollback failed (code=${code}): ${sanitizeErrorForLog(rollbackErr)}`);
      }
    }
    throw err;
  } finally {
    if (typeof client.off === 'function') {
      client.off('error', onClientError);
    } else if (typeof client.removeListener === 'function') {
      client.removeListener('error', onClientError);
    }
    client.release(checkedOutError);
  }
}
