export type InfraDependency = 'POSTGRES_CUSTOMER' | 'POSTGRES_MERCHANT' | 'POSTGRES' | 'REDIS' | 'BOOKING';

export type DbErrorCategory =
  | 'INFRA_UNAVAILABLE'
  | 'CONFLICT'
  | 'CONSTRAINT_VIOLATION'
  | 'INVALID_INPUT'
  | 'SQL_ERROR'
  | 'INTERNAL';

export interface DbErrorClassification {
  category: DbErrorCategory;
  isUnavailable: boolean;
  statusCode: number;
  code: string;
  sqlState?: string;
}

export interface HttpErrorResponse {
  status: number;
  code: string;
  message: string;
}

/**
 * Typed error raised when a required backing dependency (PostgreSQL, Redis, etc.)
 * is unreachable, timed out, or unavailable so routes can fail closed with HTTP 503.
 */
export class InfrastructureUnavailableError extends Error {
  public readonly dependency: InfraDependency;
  public readonly statusCode = 503;
  public readonly errorCode: string;

  constructor(
    dependency: InfraDependency,
    message = 'Required infrastructure dependency is temporarily unavailable.',
    errorCode = 'INFRASTRUCTURE_UNAVAILABLE'
  ) {
    super(message);
    this.name = 'InfrastructureUnavailableError';
    this.dependency = dependency;
    this.errorCode = errorCode;
    Object.setPrototypeOf(this, InfrastructureUnavailableError.prototype);
  }
}

const PG_NETWORK_ERROR_CODES = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNABORTED',
  'EAI_AGAIN'
]);

const PG_UNAVAILABLE_SQLSTATES = new Set<string>([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300'  // too_many_connections (transient server connection saturation)
]);

const REDIS_UNAVAILABLE_MESSAGE_PATTERNS: RegExp[] = [
  /connection is closed/i,
  /connection is already closed/i,
  /connection is broken/i,
  /stream isn't writeable/i,
  /enableofflinequeue/i,
  /command timed out/i,
  /max retries per request limit/i,
  /maxretriesperrequest/i,
  /\bREADONLY\b/i,
  /\bLOADING\b/i,
  /connect ECONNREFUSED/i,
  /connect ETIMEDOUT/i
];

const PG_UNAVAILABLE_MESSAGE_PATTERNS: RegExp[] = [
  /timeout exceeded when trying to connect/i,
  /connection terminated unexpectedly/i,
  /cannot use a pool after calling end/i,
  /the database system is starting up/i,
  /the database system is shutting down/i
];

/**
 * Redacts connection URIs, embedded credentials, and SQL text so logs remain diagnostic
 * without leaking secrets.
 */
export function sanitizeErrorForLog(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unknown infrastructure error';

  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_PG_URI]')
    .replace(/rediss?:\/\/[^\s'"]+/gi, '[REDACTED_REDIS_URI]')
    .replace(/(password|secret|token|key)=[^\s&;,'"]+/gi, '$1=[REDACTED]')
    .slice(0, 300);
}

function extractErrorCodes(err: unknown): string[] {
  if (!err || typeof err !== 'object') {
    return [];
  }
  const codes: string[] = [];
  const obj = err as { code?: unknown; errors?: unknown[] };
  if (typeof obj.code === 'string' && obj.code.trim()) {
    codes.push(obj.code.trim().toUpperCase());
  }
  if (Array.isArray(obj.errors)) {
    for (const inner of obj.errors) {
      if (inner && typeof inner === 'object' && typeof (inner as { code?: unknown }).code === 'string') {
        const innerCode = String((inner as { code: string }).code).trim().toUpperCase();
        if (innerCode) codes.push(innerCode);
      }
    }
  }
  return codes;
}

function extractPgSqlState(err: unknown): string | undefined {
  for (const code of extractErrorCodes(err)) {
    if (/^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * Returns true ONLY for PostgreSQL infrastructure, socket, pool-connection, or shutdown failures.
 * Never classifies SQL syntax (42*), constraint violations (23*), or input format errors (22*) as 503.
 */
export function isPgUnavailableError(err: unknown): boolean {
  if (err instanceof InfrastructureUnavailableError) {
    return err.dependency === 'POSTGRES' || err.dependency === 'POSTGRES_CUSTOMER' || err.dependency === 'POSTGRES_MERCHANT';
  }
  if (!err || typeof err !== 'object') {
    return false;
  }

  const sqlState = extractPgSqlState(err);
  if (sqlState) {
    // Explicit non-infrastructure SQLSTATE classes
    if (
      sqlState.startsWith('22') ||
      sqlState.startsWith('23') ||
      sqlState.startsWith('40') ||
      sqlState.startsWith('42') ||
      sqlState.startsWith('28') ||
      sqlState.startsWith('P0')
    ) {
      return false;
    }
    if (sqlState.startsWith('08') || PG_UNAVAILABLE_SQLSTATES.has(sqlState)) {
      return true;
    }
  }

  const codes = extractErrorCodes(err);
  if (codes.some((c) => PG_NETWORK_ERROR_CODES.has(c))) {
    return true;
  }

  const message = typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
  return PG_UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Returns true ONLY for Redis connectivity/readiness/unavailability errors.
 */
export function isRedisUnavailableError(err: unknown): boolean {
  if (err instanceof InfrastructureUnavailableError) {
    return err.dependency === 'REDIS';
  }
  if (!err || typeof err !== 'object') {
    return false;
  }

  const codes = extractErrorCodes(err);
  if (codes.some((c) => PG_NETWORK_ERROR_CODES.has(c))) {
    return true;
  }

  const message = typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : '';
  return REDIS_UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Converts low-level driver failures to a typed InfrastructureUnavailableError when applicable.
 */
export function toInfrastructureUnavailableError(
  err: unknown,
  dependency: InfraDependency
): InfrastructureUnavailableError | null {
  if (err instanceof InfrastructureUnavailableError) {
    return err;
  }
  if ((dependency === 'REDIS' && isRedisUnavailableError(err)) || (dependency !== 'REDIS' && isPgUnavailableError(err))) {
    const label = dependency === 'REDIS' ? 'REDIS_UNAVAILABLE' : 'POSTGRES_UNAVAILABLE';
    const message =
      dependency === 'REDIS'
        ? 'Redis verification service is temporarily unavailable.'
        : 'PostgreSQL database service is temporarily unavailable.';
    return new InfrastructureUnavailableError(dependency, message, label);
  }
  return null;
}

/**
 * Classifies PostgreSQL and infrastructure failures into distinct categories without
 * confusing SQL programming/constraint errors with 503 outages.
 */
export function classifyDbError(
  err: unknown,
  options: { treatInvalidInputAs400?: boolean } = {}
): DbErrorClassification {
  if (err instanceof InfrastructureUnavailableError) {
    return {
      category: 'INFRA_UNAVAILABLE',
      isUnavailable: true,
      statusCode: 503,
      code: err.errorCode
    };
  }

  if (isPgUnavailableError(err)) {
    return {
      category: 'INFRA_UNAVAILABLE',
      isUnavailable: true,
      statusCode: 503,
      code: 'POSTGRES_UNAVAILABLE'
    };
  }

  if (isRedisUnavailableError(err)) {
    return {
      category: 'INFRA_UNAVAILABLE',
      isUnavailable: true,
      statusCode: 503,
      code: 'REDIS_UNAVAILABLE'
    };
  }

  const sqlState = extractPgSqlState(err);
  if (sqlState) {
    if (sqlState === '23505' || sqlState === '23P01') {
      return {
        category: 'CONFLICT',
        isUnavailable: false,
        statusCode: 409,
        code: 'CONFLICT',
        sqlState
      };
    }
    if (sqlState === '23503' || sqlState === '23514' || sqlState === '23502') {
      return {
        category: 'CONSTRAINT_VIOLATION',
        isUnavailable: false,
        statusCode: 400,
        code: 'CONSTRAINT_VIOLATION',
        sqlState
      };
    }
    if (sqlState === '22P02' || sqlState.startsWith('22')) {
      return {
        category: options.treatInvalidInputAs400 ? 'INVALID_INPUT' : 'SQL_ERROR',
        isUnavailable: false,
        statusCode: options.treatInvalidInputAs400 ? 400 : 500,
        code: options.treatInvalidInputAs400 ? 'INVALID_INPUT' : 'INTERNAL_DATABASE_ERROR',
        sqlState
      };
    }
    if (sqlState === '53400') {
      // configuration_limit_exceeded is often query/session/config driven and fails deterministically;
      // do not blanket-classify every 53400 as a transient 503 infrastructure outage.
      return {
        category: 'SQL_ERROR',
        isUnavailable: false,
        statusCode: 500,
        code: 'PG_CONFIGURATION_LIMIT_EXCEEDED',
        sqlState
      };
    }
    if (sqlState.startsWith('42') || sqlState.startsWith('28') || sqlState.startsWith('P0')) {
      return {
        category: 'SQL_ERROR',
        isUnavailable: false,
        statusCode: 500,
        code: 'INTERNAL_DATABASE_ERROR',
        sqlState
      };
    }
  }

  return {
    category: 'INTERNAL',
    isUnavailable: false,
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    sqlState
  };
}

/**
 * Produces a public-safe HTTP response mapping without exposing SQL, credentials, or stack traces.
 */
export function classifyHttpError(
  err: unknown,
  options: { treatInvalidInputAs400?: boolean } = {}
): HttpErrorResponse {
  if (err instanceof InfrastructureUnavailableError) {
    return {
      status: 503,
      code: err.errorCode,
      message: 'Required service is temporarily unavailable. Please try again shortly.'
    };
  }

  const classified = classifyDbError(err, options);
  switch (classified.category) {
    case 'INFRA_UNAVAILABLE':
      return {
        status: 503,
        code: classified.code,
        message: 'Required service is temporarily unavailable. Please try again shortly.'
      };
    case 'CONFLICT':
      return {
        status: 409,
        code: classified.code,
        message: 'Resource conflict: a matching record already exists.'
      };
    case 'CONSTRAINT_VIOLATION':
    case 'INVALID_INPUT':
      return {
        status: 400,
        code: classified.code,
        message: 'Invalid request parameters.'
      };
    case 'SQL_ERROR':
    case 'INTERNAL':
    default:
      return {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.'
      };
  }
}
