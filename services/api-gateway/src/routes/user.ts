import { Router, Request, Response } from 'express';
import pg from 'pg';
import { generateOtp, storeOtp, verifyOtp, sendOtpEmail } from '../services/email';

export function createUserRouter(customerPool: pg.Pool): Router {
  const router = Router();

  const isValidEmail = (email: string): boolean => {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
  };

  /**
   * Request Email Change
   * Sends an OTP to the NEW email address.
   */
  router.post('/request-email-change', async (req: Request, res: Response) => {
    try {
      const { newEmail, userId } = req.body;

      if (!newEmail || !userId) {
        return res.status(400).json({ error: 'Missing newEmail or userId.' });
      }

      if (!isValidEmail(newEmail)) {
        return res.status(400).json({ error: 'Invalid email address format.' });
      }

      // Check if new email already exists
      const emailCheck = await customerPool.query('SELECT id FROM users WHERE email = $1', [newEmail.toLowerCase()]);
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ error: 'Email address is already in use.' });
      }

      // Generate and send OTP to the NEW email
      const otp = generateOtp();
      await storeOtp(`email-change:${newEmail}`, otp);
      
      const emailSent = await sendOtpEmail(newEmail, otp);
      if (!emailSent) {
        return res.status(500).json({ error: 'Failed to send OTP to the new email address. Please check SMTP configuration.' });
      }

      return res.status(200).json({ message: 'OTP sent to new email address.' });
    } catch (err: any) {
      console.error('[User API] Request Email Change Error:', err);
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  /**
   * Verify Email Change
   * Verifies the OTP and updates the email in the DB.
   */
  router.post('/verify-email-change', async (req: Request, res: Response) => {
    try {
      const { newEmail, userId, otp } = req.body;

      if (!newEmail || !userId || !otp) {
        return res.status(400).json({ error: 'Missing newEmail, userId, or otp.' });
      }

      const isValid = await verifyOtp(`email-change:${newEmail}`, otp);
      if (!isValid) {
        return res.status(400).json({ error: 'Invalid or expired OTP.' });
      }

      // Update the user's email
      const updateResult = await customerPool.query(
        'UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, full_name, email, phone, role',
        [newEmail.toLowerCase(), userId]
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
          role: updatedUser.role
        }
      });
    } catch (err: any) {
      console.error('[User API] Verify Email Change Error:', err);
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
