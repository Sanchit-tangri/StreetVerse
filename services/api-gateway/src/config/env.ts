import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export const VALID_NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type ValidNodeEnv = (typeof VALID_NODE_ENVS)[number];

export interface GatewayConfig {
  nodeEnv: ValidNodeEnv;
  port: number;
  allowedOrigins: string[];
  jwtSecret: string;
  jwtIssuer: string;
  jwtBuyerAudience: string;
  jwtSellerAudience: string;
  jwtAdminAudience?: string;
  jwtExpiresIn: string;
  jwtAdminExpiresIn?: string;
  redisUrl: string;
  customerDbUrl: string;
  merchantDbUrl: string;
  aiEngineUrl: string;
  /**
   * Absolute path to the private KYC document storage directory.
   * Files are written here and must NOT be reachable via Express static routes.
   * Defaults to `<gateway-root>/data/kyc-documents`.
   *
   * Limitation: at-rest encryption is not implemented in MO-A.
   * Production deployments must use an encrypted volume or SSE object storage.
   */
  kycStorageDir?: string;
  notificationWorkerEnabled?: boolean;
  notificationWorkerPollMs?: number;
  notificationWorkerBatchSize?: number;
  notificationWorkerLeaseMs?: number;
  notificationWorkerMaxAttempts?: number;
  notificationWorkerBaseRetryMs?: number;
  notificationWorkerMaxRetryMs?: number;
}

export interface LoadEnvOptions {
  gatewayEnvPath?: string;
  rootEnvPath?: string;
  targetEnv?: NodeJS.ProcessEnv;
  forceReload?: boolean;
}

export const MIN_JWT_SECRET_BYTES = 32;

const EXPOSED_OR_WEAK_SECRETS = new Set<string>([
  'streetverse-secure-jwt-capstone-token-secret-2026',
  'enterprise-test-secret-streetverse-2026',
  'test-secret-key-12345',
  'secret',
  'jwt-secret',
  'changeme',
  'dev-secret'
]);

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^YOUR_/i,
  /^CHANGE_ME/i,
  /^REPLACE_WITH/i,
  /^EXAMPLE_/i,
  /^TODO_/i,
  /^<.*>$/,
  /PLACEHOLDER/i
];

let envFilesLoaded = false;

/**
 * Resolves gateway and root .env file paths independently of process.cwd().
 */
export function resolveGatewayEnvPaths(baseDir: string = __dirname): {
  gatewayEnvPath: string;
  rootEnvPath: string;
} {
  return {
    gatewayEnvPath: path.resolve(baseDir, '..', '..', '.env'),
    rootEnvPath: path.resolve(baseDir, '..', '..', '..', '..', '.env')
  };
}

/**
 * Loads environment variables deterministically independent of process.cwd().
 * Priority: existing targetEnv (OS/platform env vars) > gateway .env > root .env.
 */
export function loadGatewayEnvFiles(options: LoadEnvOptions = {}): void {
  const usingDefaults =
    !options.gatewayEnvPath &&
    !options.rootEnvPath &&
    (!options.targetEnv || options.targetEnv === process.env);

  if (usingDefaults && envFilesLoaded && !options.forceReload) return;

  const defaults = resolveGatewayEnvPaths();
  const gatewayEnvPath = options.gatewayEnvPath ?? defaults.gatewayEnvPath;
  const rootEnvPath = options.rootEnvPath ?? defaults.rootEnvPath;
  const targetEnv = options.targetEnv ?? process.env;

  if (fs.existsSync(gatewayEnvPath)) {
    dotenv.config({ path: gatewayEnvPath, processEnv: targetEnv as Record<string, string>, override: false });
  }
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath, processEnv: targetEnv as Record<string, string>, override: false });
  }

  if (usingDefaults) {
    envFilesLoaded = true;
  }
}

/**
 * Validates NODE_ENV against accepted environments; defaults to development only when omitted.
 */
export function validateNodeEnv(rawNodeEnv: string | undefined): ValidNodeEnv {
  if (rawNodeEnv === undefined) {
    return 'development';
  }
  const normalized = rawNodeEnv.trim().toLowerCase();
  if (!normalized || !(VALID_NODE_ENVS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Configuration error: Invalid NODE_ENV "${rawNodeEnv}". Allowed values: ${VALID_NODE_ENVS.join(', ')}.`
    );
  }
  return normalized as ValidNodeEnv;
}

/**
 * Validates JWT secret strength and rejects exposed defaults or placeholders.
 * Never includes the secret value in thrown error messages.
 */
export function validateJwtSecret(rawSecret: string | undefined): string {
  if (typeof rawSecret !== 'string') {
    throw new Error('Configuration error: JWT_SECRET is required.');
  }

  const trimmed = rawSecret.trim();
  if (!trimmed) {
    throw new Error('Configuration error: JWT_SECRET must not be empty.');
  }

  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    throw new Error('Configuration error: JWT_SECRET appears to be an unconfigured placeholder value.');
  }

  if (EXPOSED_OR_WEAK_SECRETS.has(trimmed.toLowerCase())) {
    throw new Error('Configuration error: JWT_SECRET matches a known insecure or exposed legacy secret.');
  }

  if (Buffer.byteLength(trimmed, 'utf8') < MIN_JWT_SECRET_BYTES) {
    throw new Error(`Configuration error: JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes long.`);
  }

  return trimmed;
}

/**
 * Parses and validates ALLOWED_ORIGINS according to environment rules.
 */
export function parseAllowedOrigins(rawOrigins: string | undefined, nodeEnv?: string): string[] {
  const envName = validateNodeEnv(nodeEnv);
  const isProdOrStaging = envName === 'production' || envName === 'staging';
  const isTest = envName === 'test';
  const raw = (rawOrigins ?? '').trim();

  if (!raw) {
    if (isProdOrStaging) {
      throw new Error(`Configuration error: ALLOWED_ORIGINS is required when NODE_ENV=${envName}.`);
    }
    if (isTest) {
      throw new Error('Configuration error: ALLOWED_ORIGINS must be explicitly configured when NODE_ENV=test.');
    }
    return ['http://localhost:3000', 'http://localhost:3001'];
  }

  const parts = raw.split(',').map((item) => item.trim());
  const normalizedOrigins: string[] = [];

  for (const part of parts) {
    if (!part) {
      throw new Error('Configuration error: ALLOWED_ORIGINS contains an empty entry.');
    }
    if (part === '*' || part.includes('*')) {
      throw new Error('Configuration error: Wildcard origins (*) are not permitted in ALLOWED_ORIGINS.');
    }
    if (part.includes('?') || part.includes('#')) {
      throw new Error(`Configuration error: Origin "${part}" must not contain query strings or fragments.`);
    }

    let parsed: URL;
    try {
      parsed = new URL(part);
    } catch {
      throw new Error(`Configuration error: "${part}" is not a valid URL origin.`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Configuration error: Origin "${part}" must use http or https.`);
    }
    if (isProdOrStaging && parsed.protocol !== 'https:') {
      throw new Error(`Configuration error: Origin "${part}" must use https in ${envName} environment.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`Configuration error: Origin "${part}" must not contain embedded credentials.`);
    }
    if (parsed.pathname !== '/') {
      throw new Error(`Configuration error: Origin "${part}" must not contain a path.`);
    }
    if (parsed.search || parsed.hash) {
      throw new Error(`Configuration error: Origin "${part}" must not contain query strings or fragments.`);
    }

    if (!normalizedOrigins.includes(parsed.origin)) {
      normalizedOrigins.push(parsed.origin);
    }
  }

  if (normalizedOrigins.length === 0) {
    throw new Error('Configuration error: ALLOWED_ORIGINS must specify at least one valid origin.');
  }

  return normalizedOrigins;
}

/**
 * Pure configuration parser and validator accepting an injected environment object
 * so configuration behaviour can be unit-tested independently.
 */
export function parseGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const nodeEnv = validateNodeEnv(env.NODE_ENV);

  const rawPort = (env.PORT || '5000').trim();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Configuration error: Invalid PORT value "${rawPort}".`);
  }

  const jwtSecret = validateJwtSecret(env.JWT_SECRET);
  const jwtIssuer = (env.JWT_ISSUER || 'streetverse-api').trim();
  const jwtBuyerAudience = (env.JWT_BUYER_AUDIENCE || 'streetverse-buyer').trim();
  const jwtSellerAudience = (env.JWT_SELLER_AUDIENCE || 'streetverse-seller').trim();
  const jwtAdminAudience = (env.JWT_ADMIN_AUDIENCE || 'streetverse-admin').trim();
  const jwtExpiresIn = (env.JWT_EXPIRES_IN || '7d').trim();
  const jwtAdminExpiresIn = (env.JWT_ADMIN_EXPIRES_IN || '8h').trim();

  if (!jwtIssuer) {
    throw new Error('Configuration error: JWT_ISSUER must not be empty.');
  }
  if (!jwtBuyerAudience || !jwtSellerAudience || !jwtAdminAudience) {
    throw new Error('Configuration error: JWT_BUYER_AUDIENCE, JWT_SELLER_AUDIENCE, and JWT_ADMIN_AUDIENCE must not be empty.');
  }
  if (
    jwtBuyerAudience === jwtSellerAudience ||
    jwtAdminAudience === jwtBuyerAudience ||
    jwtAdminAudience === jwtSellerAudience
  ) {
    throw new Error('Configuration error: JWT Buyer, Seller, and Admin audiences must be distinct.');
  }
  if (!jwtExpiresIn || !jwtAdminExpiresIn) {
    throw new Error('Configuration error: JWT_EXPIRES_IN and JWT_ADMIN_EXPIRES_IN must not be empty.');
  }

  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS, nodeEnv);

  const parsePositiveIntOrDefault = (rawVal: string | undefined, fallback: number, name: string): number => {
    if (rawVal === undefined || rawVal.trim() === '') return fallback;
    const parsed = Number(rawVal.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Configuration error: Invalid ${name} "${rawVal}". Must be a positive integer.`);
    }
    return parsed;
  };

  const rawWorkerEnabled = (env.NOTIFICATION_WORKER_ENABLED ?? '').trim().toLowerCase();
  const notificationWorkerEnabled = rawWorkerEnabled
    ? rawWorkerEnabled !== 'false' && rawWorkerEnabled !== '0'
    : nodeEnv !== 'test';

  return {
    nodeEnv,
    port,
    allowedOrigins,
    jwtSecret,
    jwtIssuer,
    jwtBuyerAudience,
    jwtSellerAudience,
    jwtAdminAudience,
    jwtExpiresIn,
    jwtAdminExpiresIn,
    redisUrl: (env.REDIS_URL || 'redis://localhost:6380').trim(),
    customerDbUrl: (env.CUSTOMER_DB_URL || 'postgresql://postgres:postgres@localhost:5433/streetverse_customer_db').trim(),
    merchantDbUrl: (env.MERCHANT_DB_URL || 'postgresql://postgres:postgres@localhost:5434/streetverse_merchant_db').trim(),
    aiEngineUrl: (env.AI_ENGINE_URL || 'http://localhost:8000').trim(),
    kycStorageDir: (env.KYC_STORAGE_DIR || path.resolve(__dirname, '..', '..', 'data', 'kyc-documents')).trim(),
    notificationWorkerEnabled,
    notificationWorkerPollMs: parsePositiveIntOrDefault(env.NOTIFICATION_WORKER_POLL_MS, 5000, 'NOTIFICATION_WORKER_POLL_MS'),
    notificationWorkerBatchSize: parsePositiveIntOrDefault(env.NOTIFICATION_WORKER_BATCH_SIZE, 20, 'NOTIFICATION_WORKER_BATCH_SIZE'),
    notificationWorkerLeaseMs: parsePositiveIntOrDefault(env.NOTIFICATION_WORKER_LEASE_MS, 30000, 'NOTIFICATION_WORKER_LEASE_MS'),
    notificationWorkerMaxAttempts: parsePositiveIntOrDefault(env.NOTIFICATION_WORKER_MAX_ATTEMPTS, 5, 'NOTIFICATION_WORKER_MAX_ATTEMPTS'),
    notificationWorkerBaseRetryMs: parsePositiveIntOrDefault(env.NOTIFICATION_WORKER_BASE_RETRY_MS, 2000, 'NOTIFICATION_WORKER_BASE_RETRY_MS'),
    notificationWorkerMaxRetryMs: parsePositiveIntOrDefault(env.NOTIFICATION_WORKER_MAX_RETRY_MS, 60000, 'NOTIFICATION_WORKER_MAX_RETRY_MS')
  };
}

/**
 * Loads env files and returns validated runtime configuration.
 */
export function bootstrapGatewayConfig(): GatewayConfig {
  loadGatewayEnvFiles();
  return parseGatewayConfig(process.env);
}
