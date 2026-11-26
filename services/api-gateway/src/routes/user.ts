import { Router, Response } from 'express';
import pg from 'pg';
import { AuthenticatedRequest, JwtAuthConfig, requireBuyerJwt } from '../middleware/authJwt';
import {
  acquireResendCooldown,
  clearResendCooldown,
  generateOtp,
  invalidateOtp,
  sendOtpEmail,
  storeOtp,
  verifyOtp
} from '../services/email';

export function createUserRouter(customerPool: pg.Pool, jwtConfig: JwtAuthConfig): Router {
  const router = Router();

  const isValidEmail = (email: string): boolean => {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
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
      const cooldown = await acquireResendCooldown('email-change', userId);
      if (!cooldown.allowed) {
        return res.status(429).json({
          error: `Please wait ${cooldown.retryAfterSeconds} seconds before requesting another verification code.`,
          retryAfterSeconds: cooldown.retryAfterSeconds
        });
      }

      const bindingKey = `${userId}:${normalizedNewEmail}`;
      const otp = generateOtp();
      await storeOtp('email-change', bindingKey, otp);

      const emailResult = await sendOtpEmail(normalizedNewEmail, otp, 'Email Change');
      if (!emailResult.sent) {
        await invalidateOtp('email-change', bindingKey);
        await clearResendCooldown('email-change', userId);
        return res.status(502).json({
          error: 'Failed to send verification code to the new email address. Please try again later.'
        });
      }

      return res.status(200).json({ message: 'OTP sent to new email address.' });
    } catch (err) {
      console.error('[User API] Request Email Change Error:', err);
      return res.status(500).json({ error: 'Internal server error.' });
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
      const verification = await verifyOtp('email-change', bindingKey, otp);
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
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Email address is already in use.' });
      }
      console.error('[User API] Verify Email Change Error:', err);
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
