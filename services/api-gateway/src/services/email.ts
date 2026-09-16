import path from 'path';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), 'services', 'api-gateway', '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
dotenv.config();

// Standard Redis client for OTP storage
export const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6380', {
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 100, 3000)
});

// Helper to configure SMTP transport dynamically
function getTransporter() {
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

const OTP_TTL_SECONDS = 300; // 5 minutes
const MAX_ATTEMPTS = 3;

/**
 * Generates a cryptographically random 6-digit numeric OTP
 */
export function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Stores the OTP in Redis with 5-minute TTL
 */
export async function storeOtp(scope: 'buyer' | 'seller', identifier: string, otp: string): Promise<void> {
  const normalized = identifier.trim().toLowerCase();
  const key = `otp:${scope}:${normalized}`;
  const attemptsKey = `otp_attempts:${scope}:${normalized}`;

  await redisClient.set(key, otp, 'EX', OTP_TTL_SECONDS);
  await redisClient.set(attemptsKey, '0', 'EX', OTP_TTL_SECONDS);
}

/**
 * Verifies an OTP against Redis, tracking attempts to prevent brute force
 */
export async function verifyOtp(scope: 'buyer' | 'seller', identifier: string, candidateOtp: string): Promise<{ valid: boolean; reason?: string }> {
  const normalized = identifier.trim().toLowerCase();
  const key = `otp:${scope}:${normalized}`;
  const attemptsKey = `otp_attempts:${scope}:${normalized}`;

  const storedOtp = await redisClient.get(key);
  if (!storedOtp) {
    return { valid: false, reason: 'OTP has expired or was not requested.' };
  }

  const attempts = parseInt((await redisClient.get(attemptsKey)) || '0', 10);
  if (attempts >= MAX_ATTEMPTS) {
    await redisClient.del(key);
    await redisClient.del(attemptsKey);
    return { valid: false, reason: 'Too many incorrect attempts. Please request a new OTP.' };
  }

  if (storedOtp !== candidateOtp.trim()) {
    await redisClient.incr(attemptsKey);
    return { valid: false, reason: `Invalid OTP. ${MAX_ATTEMPTS - (attempts + 1)} attempts remaining.` };
  }

  // Valid OTP -> delete to prevent reuse
  await redisClient.del(key);
  await redisClient.del(attemptsKey);
  return { valid: true };
}

/**
 * Sends OTP via SMTP email or logs to console if SMTP is unconfigured
 */
export async function sendOtpEmail(recipientEmail: string, otp: string, roleName: string): Promise<{ sent: boolean; preview?: string }> {
  const normalizedEmail = recipientEmail.trim().toLowerCase();
  const senderAddress = process.env.SMTP_FROM || '"StreetVerse Security" <security@streetverse.in>';

  const mailOptions = {
    from: senderAddress,
    to: normalizedEmail,
    subject: `[StreetVerse] Your ${roleName} Login Verification Code: ${otp}`,
    text: `Hello,\n\nYour 6-digit verification code for StreetVerse (${roleName}) is: ${otp}\n\nThis code will expire in 5 minutes.\nIf you did not request this code, please ignore this email.\n\nBest regards,\nStreetVerse Security Team`,
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; background: #FFFDF9; border: 1px solid #E6DFD5; border-radius: 12px; padding: 24px; color: #2C241B;">
        <h2 style="color: #7A3E1D; margin-top: 0;">StreetVerse Verification</h2>
        <p style="font-size: 15px; color: #5D5043;">Hello,</p>
        <p style="font-size: 15px; color: #5D5043;">Use the verification code below to complete your login to the <strong>${roleName}</strong> portal:</p>
        <div style="text-align: center; margin: 28px 0;">
          <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 6px; padding: 12px 28px; background: #F3ECE1; border-radius: 8px; color: #7A3E1D; border: 1px dashed #BFB29E;">
            ${otp}
          </span>
        </div>
        <p style="font-size: 13px; color: #8C7D6B;">This code is valid for <strong>5 minutes</strong>. Never share this code with anyone.</p>
        <hr style="border: none; border-top: 1px solid #E6DFD5; margin: 20px 0;" />
        <p style="font-size: 11px; color: #AFA495; text-align: center;">StreetVerse Hyperlocal Commerce & Service Discovery Platform &bull; MIT-WPU</p>
      </div>
    `
  };

  // Check if SMTP credentials are provided
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await getTransporter().sendMail(mailOptions);
      console.log(`[Email Service] Sent OTP email successfully to ${normalizedEmail}`);
      return { sent: true };
    } catch (error) {
      console.warn(`[Email Service] SMTP delivery failed:`, error);
      console.log(`[Email Service] Fallback OTP for ${normalizedEmail}: >>> [ ${otp} ] <<<`);
      return { sent: false, preview: otp };
    }
  } else {
    // Development / evaluation mode: Log to console
    console.log(`\n======================================================`);
    console.log(`   [DEV EMAIL MOCK] StreetVerse ${roleName} OTP Email`);
    console.log(`   To: ${normalizedEmail}`);
    console.log(`   Verification Code: >>> [ ${otp} ] <<< (Valid 5 mins)`);
    console.log(`======================================================\n`);
    return { sent: true, preview: otp };
  }
}
