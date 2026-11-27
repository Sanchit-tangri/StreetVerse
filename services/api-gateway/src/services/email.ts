import crypto from 'crypto';
import nodemailer, { Transporter } from 'nodemailer';
import {
  convertRedisCommandError,
  ensureRedisReady,
  ManagedRedisClient
} from '../db/redis';
import {
  InfrastructureUnavailableError,
  isRedisUnavailableError,
  sanitizeErrorForLog
} from '../utils/infraErrors';

export const OTP_TTL_SECONDS = 300; // 5 minutes
export const MAX_OTP_ATTEMPTS = 3;
export const RESEND_COOLDOWN_SECONDS = 45;

export interface EmailTransporterLike {
  sendMail: (mailOptions: Record<string, unknown>) => Promise<unknown>;
}

export interface EmailServiceOptions {
  redisClient: Partial<ManagedRedisClient> | null | undefined;
  nodeEnv: string;
  transporter?: EmailTransporterLike | null;
}

export interface ResendCooldownResult {
  allowed: boolean;
  token?: string;
  retryAfterSeconds?: number;
}

export interface OtpVerificationResult {
  valid: boolean;
  reason?: string;
}

export interface SendOtpEmailResult {
  sent: boolean;
  error?: string;
}

export interface TransactionalEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
}

export type TransactionalEmailResult =
  | { status: 'SENT'; providerMessageId?: string }
  | { status: 'UNCONFIGURED'; reason: string }
  | { status: 'FAILED'; transient: boolean; error: string };

export interface EmailService {
  storeOtp: (scopeOrIdentifier: string, identifierOrOtp: string, maybeOtp?: string) => Promise<string>;
  invalidateOtp: (scopeOrIdentifier: string, maybeIdentifier?: string) => Promise<void>;
  invalidateOtpIfOwned: (scope: string, identifier: string, expectedToken: string) => Promise<void>;
  acquireResendCooldown: (
    scope: string,
    identifier: string,
    cooldownSeconds?: number
  ) => Promise<ResendCooldownResult>;
  clearResendCooldown: (scope: string, identifier: string, expectedToken: string) => Promise<void>;
  verifyOtp: (
    scopeOrIdentifier: string,
    identifierOrCandidate: string,
    maybeCandidate?: string
  ) => Promise<OtpVerificationResult>;
  sendOtpEmail: (
    recipientEmail: string,
    otp: string,
    roleName?: string
  ) => Promise<SendOtpEmailResult>;
  sendTransactionalEmail?: (input: TransactionalEmailInput) => Promise<TransactionalEmailResult>;
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

const RELEASE_COOLDOWN_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RELEASE_OTP_LUA = `
if redis.call('GET', KEYS[3]) == ARGV[1] then
  return redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
end
return 0
`;

// Keys: KEYS[1]=ownerKey, KEYS[2]=otpKey, KEYS[3]=attemptsKey
// Args: ARGV[1]=opToken, ARGV[2]=otp, ARGV[3]=ttlSeconds
const STORE_OTP_LUA = `
local function is_ok_reply(res)
  if res == 'OK' then
    return true
  end
  if type(res) == 'table' and res.ok == 'OK' and res.err == nil then
    return true
  end
  return false
end

local function extract_err(res, fallback)
  if type(res) == 'table' and res.err ~= nil then
    return tostring(res.err)
  end
  return fallback
end

local function cleanup_owned(ownerKey, otpKey, attemptsKey, opToken)
  local cur = redis.pcall('GET', ownerKey)
  if type(cur) == 'table' and cur.err ~= nil then
    return 0
  end
  if cur == opToken then
    local delRes = redis.pcall('DEL', otpKey, attemptsKey, ownerKey)
    if type(delRes) == 'table' and delRes.err ~= nil then
      return 0
    end
  end
  return 1
end

local ownerRes = redis.pcall('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
if not is_ok_reply(ownerRes) then
  return {0, 'OWNER_WRITE_FAILED', extract_err(ownerRes, 'Failed to write OTP owner key'), 1}
end

local otpRes = redis.pcall('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
if not is_ok_reply(otpRes) then
  local cleaned = cleanup_owned(KEYS[1], KEYS[2], KEYS[3], ARGV[1])
  return {0, 'OTP_WRITE_FAILED', extract_err(otpRes, 'Failed to write OTP key'), cleaned}
end

local attemptsRes = redis.pcall('SET', KEYS[3], '0', 'EX', ARGV[3])
if not is_ok_reply(attemptsRes) then
  local cleaned = cleanup_owned(KEYS[1], KEYS[2], KEYS[3], ARGV[1])
  return {0, 'ATTEMPTS_WRITE_FAILED', extract_err(attemptsRes, 'Failed to write OTP attempts key'), cleaned}
end

return {1, 'OK', '', 1}
`;

function buildOtpKeys(
  scopeOrIdentifier: string,
  maybeIdentifier?: string
): { key: string; attemptsKey: string; ownerKey: string } {
  if (maybeIdentifier !== undefined) {
    const scope = scopeOrIdentifier.trim().toLowerCase();
    const identifier = maybeIdentifier.trim().toLowerCase();
    return {
      key: `otp:${scope}:${identifier}`,
      attemptsKey: `otp_attempts:${scope}:${identifier}`,
      ownerKey: `otp_owner:${scope}:${identifier}`
    };
  }
  const identifier = scopeOrIdentifier.trim().toLowerCase();
  return {
    key: `otp:${identifier}`,
    attemptsKey: `otp_attempts:${identifier}`,
    ownerKey: `otp_owner:${identifier}`
  };
}

function buildCooldownKey(scope: string, identifier: string): string {
  return `otp_cooldown:${scope.trim().toLowerCase()}:${identifier.trim().toLowerCase()}`;
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

function createSmtpTransporter(): Transporter {
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
 * Creates an isolated, fail-closed Email & OTP service bound strictly to the caller's
 * Redis client and environment configuration. Uses zero global mutable state and zero
 * implicit in-memory fallbacks.
 */
export function createEmailService(options: EmailServiceOptions): EmailService {
  const envName = (options.nodeEnv || 'development').trim().toLowerCase();
  const redisClient = options.redisClient;
  const customTransporter = options.transporter;

  const storeOtp = async (
    scopeOrIdentifier: string,
    identifierOrOtp: string,
    maybeOtp?: string
  ): Promise<string> => {
    const client = await ensureRedisReady(redisClient);
    const { key, attemptsKey, ownerKey } =
      maybeOtp !== undefined
        ? buildOtpKeys(scopeOrIdentifier, identifierOrOtp)
        : buildOtpKeys(scopeOrIdentifier);
    const otp = maybeOtp !== undefined ? maybeOtp : identifierOrOtp;
    const opToken = crypto.randomBytes(16).toString('hex');

    let evalResult: unknown;
    try {
      evalResult = await client.eval(
        STORE_OTP_LUA,
        3,
        ownerKey,
        key,
        attemptsKey,
        opToken,
        otp,
        String(OTP_TTL_SECONDS)
      );
    } catch (err) {
      // Best-effort ownership-checked rollback if eval fails at the transport layer
      try {
        await client.eval(RELEASE_OTP_LUA, 3, key, attemptsKey, ownerKey, opToken);
      } catch (cleanupErr) {
        console.warn(`[Email Service] Best-effort OTP state cleanup failed: ${sanitizeErrorForLog(cleanupErr)}`);
      }
      throw convertRedisCommandError(err, 'storeOtp');
    }

    if (!Array.isArray(evalResult) || evalResult[0] !== 1) {
      const reasonCode =
        Array.isArray(evalResult) && typeof evalResult[1] === 'string'
          ? evalResult[1]
          : 'INVALID_SCRIPT_REPLY';
      const detail =
        Array.isArray(evalResult) && typeof evalResult[2] === 'string'
          ? evalResult[2]
          : 'Invalid Redis storeOtp script response';
      const cleaned = Array.isArray(evalResult) ? evalResult[3] : 0;

      if (cleaned !== 1 && reasonCode !== 'OWNER_WRITE_FAILED') {
        try {
          await client.eval(RELEASE_OTP_LUA, 3, key, attemptsKey, ownerKey, opToken);
        } catch (cleanupErr) {
          console.warn(`[Email Service] Best-effort OTP state cleanup failed: ${sanitizeErrorForLog(cleanupErr)}`);
        }
      }

      const detailErr = new Error(`[${reasonCode}] ${detail}`);
      if (isRedisUnavailableError(detailErr)) {
        throw new InfrastructureUnavailableError(
          'REDIS',
          'Redis service became unavailable during storeOtp.',
          'REDIS_UNAVAILABLE'
        );
      }
      throw new InfrastructureUnavailableError(
        'REDIS',
        `Redis OTP storage failed (${reasonCode}): ${sanitizeErrorForLog(detailErr)}`,
        'REDIS_COMMAND_FAILED'
      );
    }

    return opToken;
  };

  const invalidateOtp = async (scopeOrIdentifier: string, maybeIdentifier?: string): Promise<void> => {
    const client = await ensureRedisReady(redisClient);
    const { key, attemptsKey, ownerKey } = buildOtpKeys(scopeOrIdentifier, maybeIdentifier);
    try {
      await client.del(key, attemptsKey, ownerKey);
    } catch (err) {
      throw convertRedisCommandError(err, 'invalidateOtp');
    }
  };

  const invalidateOtpIfOwned = async (
    scope: string,
    identifier: string,
    expectedToken: string
  ): Promise<void> => {
    if (!expectedToken) {
      return;
    }
    const client = await ensureRedisReady(redisClient);
    const { key, attemptsKey, ownerKey } = buildOtpKeys(scope, identifier);
    try {
      await client.eval(RELEASE_OTP_LUA, 3, key, attemptsKey, ownerKey, expectedToken);
    } catch (err) {
      throw convertRedisCommandError(err, 'invalidateOtpIfOwned');
    }
  };

  const acquireResendCooldown = async (
    scope: string,
    identifier: string,
    cooldownSeconds: number = RESEND_COOLDOWN_SECONDS
  ): Promise<ResendCooldownResult> => {
    const client = await ensureRedisReady(redisClient);
    const cooldownKey = buildCooldownKey(scope, identifier);
    const token = crypto.randomBytes(16).toString('hex');

    try {
      const setRes = await client.set(cooldownKey, token, 'EX', cooldownSeconds, 'NX');
      if (setRes === 'OK') {
        return { allowed: true, token };
      }
      if (setRes === null) {
        const ttl = await client.ttl(cooldownKey);
        return {
          allowed: false,
          retryAfterSeconds: ttl > 0 ? ttl : cooldownSeconds
        };
      }
      throw new InfrastructureUnavailableError(
        'REDIS',
        'Unexpected Redis cooldown acquisition reply.',
        'REDIS_COMMAND_FAILED'
      );
    } catch (err) {
      throw convertRedisCommandError(err, 'acquireResendCooldown');
    }
  };

  const clearResendCooldown = async (
    scope: string,
    identifier: string,
    expectedToken: string
  ): Promise<void> => {
    if (!expectedToken) {
      return;
    }
    const client = await ensureRedisReady(redisClient);
    const cooldownKey = buildCooldownKey(scope, identifier);
    try {
      await client.eval(RELEASE_COOLDOWN_LUA, 1, cooldownKey, expectedToken);
    } catch (err) {
      throw convertRedisCommandError(err, 'clearResendCooldown');
    }
  };

  const verifyOtp = async (
    scopeOrIdentifier: string,
    identifierOrCandidate: string,
    maybeCandidate?: string
  ): Promise<OtpVerificationResult> => {
    const { key, attemptsKey } =
      maybeCandidate !== undefined
        ? buildOtpKeys(scopeOrIdentifier, identifierOrCandidate)
        : buildOtpKeys(scopeOrIdentifier);
    const candidateOtp = (maybeCandidate !== undefined ? maybeCandidate : identifierOrCandidate).trim();

    if (!candidateOtp) {
      return { valid: false, reason: 'OTP code is required.' };
    }

    const client = await ensureRedisReady(redisClient);

    let evalRes: unknown;
    try {
      evalRes = await client.eval(
        VERIFY_OTP_LUA,
        2,
        key,
        attemptsKey,
        candidateOtp,
        String(MAX_OTP_ATTEMPTS)
      );
    } catch (err) {
      throw convertRedisCommandError(err, 'verifyOtp');
    }

    if (!Array.isArray(evalRes) || evalRes.length < 3) {
      throw new InfrastructureUnavailableError(
        'REDIS',
        'Unexpected Redis verification script response.',
        'REDIS_COMMAND_FAILED'
      );
    }

    const [ok, code, remaining] = evalRes as [number, string, number];
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
  };

  const sendOtpEmail = async (
    recipientEmail: string,
    otp: string,
    roleName: string = 'User'
  ): Promise<SendOtpEmailResult> => {
    const normalizedEmail = recipientEmail.trim().toLowerCase();
    const senderAddress = process.env.SMTP_FROM || '"StreetVerse Security" <security@streetverse.in>';

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

    if (customTransporter || (customTransporter !== null && isSmtpConfigured())) {
      try {
        const transporter = customTransporter || createSmtpTransporter();
        await transporter.sendMail(mailOptions);
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
      return { sent: true };
    }

    console.error(`[Email Service] SMTP is not configured in ${envName} environment.`);
    return { sent: false, error: 'SMTP email delivery is not configured.' };
  };

  /**
   * Sends a transactional Owner notification email using configured SMTP or injected
   * transporter. Never fakes successful delivery when SMTP credentials are missing,
   * even in development or test mode.
   *
   * Note on idempotency: Standard SMTP does not guarantee broker-level deduplication.
   * We attach `X-StreetVerse-Idempotency-Key` as informational metadata cleanly.
   */
  const sendTransactionalEmail = async (
    input: TransactionalEmailInput
  ): Promise<TransactionalEmailResult> => {
    const normalizedEmail = (input.to || '').trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return {
        status: 'FAILED',
        transient: false,
        error: 'Invalid recipient email address.'
      };
    }

    const canSend = Boolean(customTransporter) || (customTransporter !== null && isSmtpConfigured());
    if (!canSend) {
      return {
        status: 'UNCONFIGURED',
        reason: 'SMTP email credentials are not configured.'
      };
    }

    const senderAddress = process.env.SMTP_FROM || '"StreetVerse Notifications" <noreply@streetverse.in>';
    try {
      const transporter = customTransporter || createSmtpTransporter();
      const mailResult = await transporter.sendMail({
        from: senderAddress,
        to: normalizedEmail,
        subject: input.subject,
        text: input.text,
        html: input.html,
        ...(input.idempotencyKey
          ? { headers: { 'X-StreetVerse-Idempotency-Key': input.idempotencyKey } }
          : {})
      });
      const msgId =
        mailResult && typeof mailResult === 'object' && typeof (mailResult as { messageId?: unknown }).messageId === 'string'
          ? (mailResult as { messageId: string }).messageId
          : undefined;
      return { status: 'SENT', providerMessageId: msgId };
    } catch (err: unknown) {
      const responseCode =
        err && typeof err === 'object' && typeof (err as { responseCode?: unknown }).responseCode === 'number'
          ? (err as { responseCode: number }).responseCode
          : null;
      const errCode =
        err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : '';
      // Treat 5xx permanent SMTP rejections (e.g. 550 mailbox invalid) as non-transient; network/4xx as transient
      const isPermanentSmtp5xx = responseCode !== null && responseCode >= 500 && responseCode < 600 && errCode !== 'ETIMEDOUT';
      return {
        status: 'FAILED',
        transient: !isPermanentSmtp5xx,
        error: sanitizeErrorForLog(err) || 'SMTP transactional email delivery failed.'
      };
    }
  };

  return {
    storeOtp,
    invalidateOtp,
    invalidateOtpIfOwned,
    acquireResendCooldown,
    clearResendCooldown,
    verifyOtp,
    sendOtpEmail,
    sendTransactionalEmail
  };
}
