import crypto from 'crypto';
import nodemailer, { Transporter } from 'nodemailer';
import Redis from 'ioredis';

export const OTP_TTL_SECONDS = 300; // 5 minutes
export const MAX_OTP_ATTEMPTS = 3;
export const RESEND_COOLDOWN_SECONDS = 45;

let configuredRedisUrl: string | undefined;
let configuredNodeEnv: string | undefined;
let redisClientInstance: Redis | null = null;
let injectedRedisClient: Redis | null = null;
let injectedTransporter: Pick<Transporter, 'sendMail'> | null = null;

/**
 * Configures runtime options for email and Redis-backed OTP storage.
 */
export function configureEmailService(options: {
  redisUrl?: string;
  nodeEnv?: string;
  redisClient?: Redis | null;
  transporter?: Pick<Transporter, 'sendMail'> | null;
}): void {
  if (options.redisUrl !== undefined) {
    if (redisClientInstance && configuredRedisUrl !== options.redisUrl) {
      redisClientInstance.disconnect();
      redisClientInstance = null;
    }
    configuredRedisUrl = options.redisUrl;
  }
  if (options.nodeEnv !== undefined) {
    configuredNodeEnv = options.nodeEnv.trim().toLowerCase();
  }
  if (options.redisClient !== undefined) {
    injectedRedisClient = options.redisClient;
  }
  if (options.transporter !== undefined) {
    injectedTransporter = options.transporter;
  }
}

export function configureEmailRedis(redisUrl: string): void {
  configureEmailService({ redisUrl });
}

/**
 * Returns the lazily initialized Redis client so importing email.ts has no
 * top-level Redis or dotenv side effects.
 */
export function getRedisClient(): Redis {
  if (injectedRedisClient) {
    return injectedRedisClient;
  }
  if (!redisClientInstance) {
    const url = configuredRedisUrl || process.env.REDIS_URL || 'redis://localhost:6380';
    redisClientInstance = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      retryStrategy: (times) => Math.min(times * 100, 3000)
    });
    redisClientInstance.on('error', () => {
      // Suppress unhandled redis connection errors when Docker is offline
    });
  }
  return redisClientInstance;
}

async function getReadyRedisClient(): Promise<Redis | null> {
  if (injectedRedisClient) {
    return injectedRedisClient;
  }
  const client = getRedisClient();
  if (client.status === 'ready') {
    return client;
  }
  if (client.status === 'wait') {
    try {
      await client.connect();
      return client;
    } catch {
      return null;
    }
  }
  return null;
}

export function disconnectEmailRedis(): void {
  if (redisClientInstance) {
    redisClientInstance.disconnect();
    redisClientInstance = null;
  }
}

/**
 * DEFERRED S1.3: Process-local OTP/cooldown fallbacks exist only until S1.3 removes
 * runtime memory fallback and enforces strict Redis availability.
 */
const memoryOtpMap = new Map<string, { otp: string; attempts: number; expiresAt: number }>();
const memoryCooldownMap = new Map<string, number>();

export function clearMemoryOtpStateForTests(): void {
  memoryOtpMap.clear();
  memoryCooldownMap.clear();
}

const VERIFY_OTP_LUA = `
local otpKey = KEYS[1]
local attemptsKey = KEYS[2]
local candidate = ARGV[1]
local maxAttempts = tonumber(ARGV[2])

local stored = redis.call('GET', otpKey)
if not stored then
  return {0, 'EXPIRED', 0}
end

local attempts = tonumber(redis.call('GET', attemptsKey) or '0')
if attempts >= maxAttempts then
  redis.call('DEL', otpKey, attemptsKey)
  return {0, 'LOCKED', 0}
end

if stored ~= candidate then
  local nextAttempts = redis.call('INCR', attemptsKey)
  if nextAttempts >= maxAttempts then
    redis.call('DEL', otpKey, attemptsKey)
    return {0, 'LOCKED', 0}
  end
  local ttl = redis.call('TTL', otpKey)
  if ttl > 0 then
    redis.call('EXPIRE', attemptsKey, ttl)
  end
  return {0, 'MISMATCH', maxAttempts - nextAttempts}
end

redis.call('DEL', otpKey, attemptsKey)
return {1, 'OK', 0}
`;

function buildOtpKeys(scopeOrIdentifier: string, maybeIdentifier?: string): { key: string; attemptsKey: string } {
  if (maybeIdentifier !== undefined) {
    const scope = scopeOrIdentifier.trim().toLowerCase();
    const identifier = maybeIdentifier.trim().toLowerCase();
    return {
      key: `otp:${scope}:${identifier}`,
      attemptsKey: `otp_attempts:${scope}:${identifier}`
    };
  }
  const identifier = scopeOrIdentifier.trim().toLowerCase();
  return {
    key: `otp:${identifier}`,
    attemptsKey: `otp_attempts:${identifier}`
  };
}

function buildCooldownKey(scope: string, identifier: string): string {
  return `otp_cooldown:${scope.trim().toLowerCase()}:${identifier.trim().toLowerCase()}`;
}

function getRuntimeEnv(): string {
  return (configuredNodeEnv || process.env.NODE_ENV || 'development').trim().toLowerCase();
}

function isPlaceholderConfigValue(val: string): boolean {
  const trimmed = val.trim();
  return !trimmed || /^(YOUR_|CHANGE_ME|REPLACE_WITH|EXAMPLE_|TODO_|<.*>)/i.test(trimmed);
}

function isSmtpConfigured(): boolean {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  return !isPlaceholderConfigValue(user) && !isPlaceholderConfigValue(pass);
}

function getTransporter(): Pick<Transporter, 'sendMail'> {
  if (injectedTransporter) {
    return injectedTransporter;
  }
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

/**
 * Generates a cryptographically random 6-digit numeric OTP (100000 through 999999 inclusive).
 */
export function generateOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Stores the OTP in Redis with 5-minute TTL (isolated memory fallback retained until S1.3).
 */
export async function storeOtp(
  scopeOrIdentifier: string,
  identifierOrOtp: string,
  maybeOtp?: string
): Promise<void> {
  const { key, attemptsKey } =
    maybeOtp !== undefined
      ? buildOtpKeys(scopeOrIdentifier, identifierOrOtp)
      : buildOtpKeys(scopeOrIdentifier);
  const otp = maybeOtp !== undefined ? maybeOtp : identifierOrOtp;

  try {
    const client = await getReadyRedisClient();
    if (client) {
      await client.set(key, otp, 'EX', OTP_TTL_SECONDS);
      await client.set(attemptsKey, '0', 'EX', OTP_TTL_SECONDS);
      memoryOtpMap.delete(key);
      return;
    }
  } catch {
    // Fall through to deferred S1.3 memory fallback when Redis is unavailable
  }

  memoryOtpMap.set(key, {
    otp,
    attempts: 0,
    expiresAt: Date.now() + OTP_TTL_SECONDS * 1000
  });
}

/**
 * Invalidates an active OTP challenge and its attempt counter.
 */
export async function invalidateOtp(scopeOrIdentifier: string, maybeIdentifier?: string): Promise<void> {
  const { key, attemptsKey } = buildOtpKeys(scopeOrIdentifier, maybeIdentifier);
  memoryOtpMap.delete(key);

  try {
    const client = await getReadyRedisClient();
    if (client) {
      await client.del(key, attemptsKey);
    }
  } catch {
    // Ignore Redis error on cleanup
  }
}

/**
 * Atomically enforces a 45-second server-side resend cooldown.
 */
export async function acquireResendCooldown(
  scope: string,
  identifier: string,
  cooldownSeconds: number = RESEND_COOLDOWN_SECONDS
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const cooldownKey = buildCooldownKey(scope, identifier);

  try {
    const client = await getReadyRedisClient();
    if (client) {
      const setRes = await client.set(cooldownKey, '1', 'EX', cooldownSeconds, 'NX');
      if (setRes === 'OK') {
        memoryCooldownMap.delete(cooldownKey);
        return { allowed: true };
      }
      const ttl = await client.ttl(cooldownKey);
      return {
        allowed: false,
        retryAfterSeconds: ttl > 0 ? ttl : cooldownSeconds
      };
    }
  } catch {
    // Fall through to memory cooldown map until S1.3 removes fallback
  }

  const now = Date.now();
  const expiresAt = memoryCooldownMap.get(cooldownKey);
  if (expiresAt && expiresAt > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000))
    };
  }
  memoryCooldownMap.set(cooldownKey, now + cooldownSeconds * 1000);
  return { allowed: true };
}

export async function clearResendCooldown(scope: string, identifier: string): Promise<void> {
  const cooldownKey = buildCooldownKey(scope, identifier);
  memoryCooldownMap.delete(cooldownKey);

  try {
    const client = await getReadyRedisClient();
    if (client) {
      await client.del(cooldownKey);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Atomically verifies an OTP via Redis Lua script (or synchronous single-use memory fallback until S1.3).
 */
export async function verifyOtp(
  scopeOrIdentifier: string,
  identifierOrCandidate: string,
  maybeCandidate?: string
): Promise<{ valid: boolean; reason?: string }> {
  const { key, attemptsKey } =
    maybeCandidate !== undefined
      ? buildOtpKeys(scopeOrIdentifier, identifierOrCandidate)
      : buildOtpKeys(scopeOrIdentifier);
  const candidateOtp = (maybeCandidate !== undefined ? maybeCandidate : identifierOrCandidate).trim();

  if (!candidateOtp) {
    return { valid: false, reason: 'OTP code is required.' };
  }

  try {
    const client = await getReadyRedisClient();
    if (client) {
      const evalRes = (await client.eval(
        VERIFY_OTP_LUA,
        2,
        key,
        attemptsKey,
        candidateOtp,
        String(MAX_OTP_ATTEMPTS)
      )) as [number, string, number];

      const [ok, code, remaining] = evalRes;
      memoryOtpMap.delete(key);

      if (ok === 1) {
        return { valid: true };
      }
      if (code === 'EXPIRED') {
        return { valid: false, reason: 'OTP has expired or was not requested.' };
      }
      if (code === 'LOCKED') {
        return { valid: false, reason: 'Too many incorrect attempts. Please request a new OTP.' };
      }
      return { valid: false, reason: `Invalid OTP. ${remaining} attempts remaining.` };
    }
  } catch {
    // Fall through to deferred S1.3 memory fallback when Redis is unavailable
  }

  // Memory fallback executes synchronously with zero await points, preventing concurrent replay in single-process tests
  const mem = memoryOtpMap.get(key);
  if (!mem || mem.expiresAt <= Date.now()) {
    memoryOtpMap.delete(key);
    return { valid: false, reason: 'OTP has expired or was not requested.' };
  }

  if (mem.attempts >= MAX_OTP_ATTEMPTS) {
    memoryOtpMap.delete(key);
    return { valid: false, reason: 'Too many incorrect attempts. Please request a new OTP.' };
  }

  if (mem.otp !== candidateOtp) {
    mem.attempts += 1;
    if (mem.attempts >= MAX_OTP_ATTEMPTS) {
      memoryOtpMap.delete(key);
      return { valid: false, reason: 'Too many incorrect attempts. Please request a new OTP.' };
    }
    return { valid: false, reason: `Invalid OTP. ${MAX_OTP_ATTEMPTS - mem.attempts} attempts remaining.` };
  }

  memoryOtpMap.delete(key);
  return { valid: true };
}

/**
 * Sends OTP via SMTP with honest delivery reporting.
 * Never returns sent: true when SMTP delivery fails or when SMTP is unconfigured in staging/production.
 */
export async function sendOtpEmail(
  recipientEmail: string,
  otp: string,
  roleName: string = 'User'
): Promise<{ sent: boolean; error?: string }> {
  const normalizedEmail = recipientEmail.trim().toLowerCase();
  const senderAddress = process.env.SMTP_FROM || '"StreetVerse Security" <security@streetverse.in>';
  const envName = getRuntimeEnv();

  const mailOptions = {
    from: senderAddress,
    to: normalizedEmail,
    subject: `[StreetVerse] Your ${roleName} Verification Code`,
    text: `Hello,\n\nYour 6-digit verification code for StreetVerse (${roleName}) is: ${otp}\n\nThis code will expire in 5 minutes.\nIf you did not request this code, please ignore this email.\n\nBest regards,\nStreetVerse Security Team`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; background: #FFFDF9; border: 1px solid #E6DFD5; border-radius: 12px; padding: 24px; color: #2C241B;">
        <h2 style="color: #7A3E1D; margin-top: 0;">StreetVerse Verification</h2>
        <p style="font-size: 15px; color: #5D5043;">Hello,</p>
        <p style="font-size: 15px; color: #5D5043;">Use the verification code below to complete your request for <strong>${roleName}</strong>:</p>
        <div style="text-align: center; margin: 28px 0;">
          <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 6px; padding: 12px 28px; background: #F3ECE1; border-radius: 8px; color: #7A3E1D; border: 1px dashed #BFB29E;">
            ${otp}
          </span>
        </div>
        <p style="font-size: 13px; color: #8C7D6B;">This code is valid for <strong>5 minutes</strong>. Never share this code with anyone.</p>
        <hr style="border: none; border-top: 1px solid #E6DFD5; margin: 20px 0;" />
        <p style="font-size: 11px; color: #AFA495; text-align: center;">StreetVerse Hyperlocal Commerce &bull; Security</p>
      </div>
    `
  };

  if (injectedTransporter || isSmtpConfigured()) {
    try {
      await getTransporter().sendMail(mailOptions);
      return { sent: true };
    } catch {
      console.error(`[Email Service] SMTP delivery failed for ${normalizedEmail}.`);
      return { sent: false, error: 'SMTP email delivery failed.' };
    }
  }

  if (envName === 'development') {
    console.log(`\n======================================================`);
    console.log(`   [DEV EMAIL MOCK] StreetVerse ${roleName} OTP Email`);
    console.log(`   To: ${normalizedEmail}`);
    console.log(`   Verification Code: >>> [ ${otp} ] <<< (Valid 5 mins)`);
    console.log(`======================================================\n`);
    return { sent: true };
  }

  if (envName === 'test') {
    // Controlled test fallback avoids printing OTP values to stdout
    return { sent: true };
  }

  console.error(`[Email Service] SMTP is not configured in ${envName} environment.`);
  return { sent: false, error: 'SMTP email delivery is not configured.' };
}
