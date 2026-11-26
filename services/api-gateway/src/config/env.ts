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
  jwtExpiresIn: string;
  redisUrl: string;
  customerDbUrl: string;
  merchantDbUrl: string;
  aiEngineUrl: string;
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
  const jwtExpiresIn = (env.JWT_EXPIRES_IN || '7d').trim();

  if (!jwtIssuer) {
    throw new Error('Configuration error: JWT_ISSUER must not be empty.');
  }
  if (!jwtBuyerAudience || !jwtSellerAudience) {
    throw new Error('Configuration error: JWT_BUYER_AUDIENCE and JWT_SELLER_AUDIENCE must not be empty.');
  }
  if (jwtBuyerAudience === jwtSellerAudience) {
    throw new Error('Configuration error: JWT_BUYER_AUDIENCE and JWT_SELLER_AUDIENCE must be distinct.');
  }
  if (!jwtExpiresIn) {
    throw new Error('Configuration error: JWT_EXPIRES_IN must not be empty.');
  }

  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS, nodeEnv);

  return {
    nodeEnv,
    port,
    allowedOrigins,
    jwtSecret,
    jwtIssuer,
    jwtBuyerAudience,
    jwtSellerAudience,
    jwtExpiresIn,
    redisUrl: (env.REDIS_URL || 'redis://localhost:6380').trim(),
    customerDbUrl: (env.CUSTOMER_DB_URL || 'postgresql://postgres:postgres@localhost:5433/streetverse_customer_db').trim(),
    merchantDbUrl: (env.MERCHANT_DB_URL || 'postgresql://postgres:postgres@localhost:5434/streetverse_merchant_db').trim(),
    aiEngineUrl: (env.AI_ENGINE_URL || 'http://localhost:8000').trim()
  };
}

/**
 * Loads env files and returns validated runtime configuration.
 */
export function bootstrapGatewayConfig(): GatewayConfig {
  loadGatewayEnvFiles();
  return parseGatewayConfig(process.env);
}
