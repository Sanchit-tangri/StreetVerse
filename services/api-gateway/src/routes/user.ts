import { Router, Response } from 'express';
import { StrictPgPool } from '../db/postgres';
import { AuthenticatedRequest, JwtAuthConfig, requireBuyerJwt } from '../middleware/authJwt';
import { EmailService, generateOtp } from '../services/email';
import {
  classifyHttpError,
  InfrastructureUnavailableError,
  isRedisUnavailableError,
  sanitizeErrorForLog
} from '../utils/infraErrors';

export function createUserRouter(
  customerPool: StrictPgPool,
  jwtConfig: JwtAuthConfig,
  emailService: EmailService
): Router {
  const router = Router();

  const isValidEmail = (email: string): boolean => {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
  };

  const bestEffortCleanup = async (fn: () => Promise<void>, label: string): Promise<void> => {
    try {
      await fn();
    } catch (cleanupErr) {
      console.warn(`[User API Cleanup - ${label}]: ${sanitizeErrorForLog(cleanupErr)}`);
    }
  };

  const handleUserRouteError = (res: Response, context: string, err: any) => {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Email address is already in use.' });
    }
    if (err instanceof InfrastructureUnavailableError || isRedisUnavailableError(err)) {
      const mapped = classifyHttpError(err);
      return res.status(mapped.status).json({ error: mapped.message });
    }
    console.error(`[User API] ${context} Error: ${sanitizeErrorForLog(err)}`);
    return res.status(500).json({ error: 'Internal server error.' });
  };

  // Require verified Buyer JWT on all user settings endpoints; never trust body userId
  router.use(requireBuyerJwt(jwtConfig));

  /**
   * Request Email Change
   * Generates a 6-digit OTP bound to (authenticated userId, normalized newEmail).
   */
  router.post('/request-email-change', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.auth?.sub;
      const { newEmail } = req.body;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      if (typeof newEmail !== 'string' || !newEmail.trim()) {
        return res.status(400).json({ error: 'Missing newEmail.' });
      }

      const normalizedNewEmail = newEmail.trim().toLowerCase();
      if (!isValidEmail(normalizedNewEmail)) {
        return res.status(400).json({ error: 'Invalid email address format.' });
      }

      // Verify the authenticated user exists and disallow changing to current email
      const currentUserRes = await customerPool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
      if (currentUserRes.rows.length === 0) {
        return res.status(404).json({ error: 'Authenticated user account not found.' });
      }

      const currentEmail = String(currentUserRes.rows[0].email || '').trim().toLowerCase();
      if (currentEmail === normalizedNewEmail) {
        return res.status(400).json({ error: 'New email address must differ from your current email address.' });
      }

      // Case-insensitive uniqueness check
      const emailCheck = await customerPool.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2',
        [normalizedNewEmail, userId]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ error: 'Email address is already in use.' });
      }

      // 45-second server-side cooldown per authenticated user
      const cooldown = await emailService.acquireResendCooldown('email-change', userId);
      if (!cooldown.allowed) {
        return res.status(429).json({
          error: `Please wait ${cooldown.retryAfterSeconds} seconds before requesting another verification code.`,
          retryAfterSeconds: cooldown.retryAfterSeconds
        });
      }

      const cooldownToken = cooldown.token || '';
      const bindingKey = `${userId}:${normalizedNewEmail}`;
      const otp = generateOtp();
      let otpToken = '';
      try {
        otpToken = await emailService.storeOtp('email-change', bindingKey, otp);
      } catch (storeErr) {
        await bestEffortCleanup(
          () => emailService.clearResendCooldown('email-change', userId, cooldownToken),
          'email-change-store'
        );
        throw storeErr;
      }

      const emailResult = await emailService.sendOtpEmail(normalizedNewEmail, otp, 'Email Change');
      if (!emailResult.sent) {
        await bestEffortCleanup(
          () => emailService.invalidateOtpIfOwned('email-change', bindingKey, otpToken),
          'email-change-invalidate'
        );
        await bestEffortCleanup(
          () => emailService.clearResendCooldown('email-change', userId, cooldownToken),
          'email-change-cooldown'
        );
        return res.status(502).json({
          error: 'Failed to send verification code to the new email address. Please try again later.'
        });
      }

      return res.status(200).json({ message: 'OTP sent to new email address.' });
    } catch (err) {
      return handleUserRouteError(res, 'Request Email Change', err);
    }
  });

  /**
   * Verify Email Change
   * Atomically verifies OTP bound to (authenticated userId, normalized newEmail)
   * and updates only existing columns on users.
   */
  router.post('/verify-email-change', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.auth?.sub;
      const { newEmail, otp } = req.body;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      if (typeof newEmail !== 'string' || !newEmail.trim() || typeof otp !== 'string' || !otp.trim()) {
        return res.status(400).json({ error: 'Missing newEmail or otp.' });
      }

      const normalizedNewEmail = newEmail.trim().toLowerCase();
      if (!isValidEmail(normalizedNewEmail)) {
        return res.status(400).json({ error: 'Invalid email address format.' });
      }

      const bindingKey = `${userId}:${normalizedNewEmail}`;
      const verification = await emailService.verifyOtp('email-change', bindingKey, otp);
      if (!verification.valid) {
        return res.status(400).json({ error: verification.reason || 'Invalid or expired OTP.' });
      }

      const updateResult = await customerPool.query(
        'UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, full_name, email, phone, home_address, is_verified',
        [normalizedNewEmail, userId]
      );

      if (updateResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const updatedUser = updateResult.rows[0];

      return res.status(200).json({
        message: 'Email updated successfully.',
        user: {
          id: updatedUser.id,
          fullName: updatedUser.full_name,
          email: updatedUser.email,
          phone: updatedUser.phone,
          address: updatedUser.home_address,
          role: req.auth!.role
        }
      });
    } catch (err: any) {
      return handleUserRouteError(res, 'Verify Email Change', err);
    }
  });

  return router;
}
