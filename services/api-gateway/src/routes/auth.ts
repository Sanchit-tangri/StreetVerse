import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { generateOtp, storeOtp, verifyOtp, sendOtpEmail } from '../services/email';

export function createAuthRouter(customerPool: pg.Pool, merchantPool: pg.Pool): Router {
  const router = Router();
  const JWT_SECRET = process.env.JWT_SECRET || 'streetverse-secure-jwt-capstone-token-secret-2026';
  const BCRYPT_SALT_ROUNDS = 10;

  // Validation helpers
  const isValidEmail = (email: string): boolean => {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
  };

  const isValidPhone = (phone: string): boolean => {
    // Allows optional + and 10 to 15 digits
    return /^\+?[0-9]{10,15}$/.test(phone.trim());
  };

  const isValidPassword = (password: string): boolean => {
    // At least 8 chars, 1 number, 1 letter
    return typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
  };

  // =========================================================================
  // 1. BUYER AUTHENTICATION
  // =========================================================================

  /**
   * Buyer Registration (SQL-Injection Proof via Parameterized Queries)
   */
  router.post('/buyer/register', async (req: Request, res: Response) => {
    try {
      const { phone, full_name, email, password, home_address } = req.body;

      if (!phone || !full_name || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields (phone, full_name, email, password).' });
      }

      if (!isValidPhone(phone)) {
        return res.status(400).json({ error: 'Invalid phone number format. Must be 10-15 digits.' });
      }

      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email address format.' });
      }

      if (!isValidPassword(password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both letters and numbers.' });
      }

      const normalizedPhone = phone.trim();
      const normalizedEmail = email.trim().toLowerCase();
      const trimmedName = full_name.trim();

      // Check for existing user strictly with parameterized query
      const existingUserQuery = 'SELECT id, phone, email FROM users WHERE phone = $1 OR email = $2';
      const existingRes = await customerPool.query(existingUserQuery, [normalizedPhone, normalizedEmail]);

      if (existingRes.rows.length > 0) {
        const match = existingRes.rows[0];
        if (match.phone === normalizedPhone) {
          return res.status(409).json({ error: 'A customer account with this phone number already exists.' });
        }
        return res.status(409).json({ error: 'A customer account with this email address already exists.' });
      }

      // Hash password securely
      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

      // Insert new buyer
      const insertQuery = `
        INSERT INTO users (phone, full_name, email, password_hash, home_address, is_verified)
        VALUES ($1, $2, $3, $4, $5, false)
        RETURNING id, phone, full_name, email, home_address;
      `;
      const insertRes = await customerPool.query(insertQuery, [
        normalizedPhone,
        trimmedName,
        normalizedEmail,
        passwordHash,
        home_address || ''
      ]);

      const newUser = insertRes.rows[0];

      // Generate & send OTP
      const otp = generateOtp();
      await storeOtp('buyer', normalizedEmail, otp);
      await sendOtpEmail(normalizedEmail, otp, 'Buyer Registration');

      return res.status(201).json({
        message: 'Registration successful. A 6-digit verification code has been sent to your email.',
        email: normalizedEmail,
        userId: newUser.id,
        requiresOtp: true
      });
    } catch (error: any) {
      console.error('[Auth Error - Buyer Register]:', error);
      return res.status(500).json({ error: 'An internal error occurred during registration. Please try again.' });
    }
  });

  /**
   * Buyer Password Login -> Triggers OTP step
   */
  router.post('/buyer/login', async (req: Request, res: Response) => {
    try {
      const { identifier, password } = req.body;

      if (!identifier || !password) {
        return res.status(400).json({ error: 'Identifier (phone or email) and password are required.' });
      }

      const normalizedIdentifier = identifier.trim().toLowerCase();

      // Parameterized query: find user by phone or email
      const findUserQuery = `
        SELECT id, phone, full_name, email, password_hash, is_verified, home_address 
        FROM users 
        WHERE LOWER(email) = $1 OR phone = $1
      `;
      const result = await customerPool.query(findUserQuery, [normalizedIdentifier]);

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials. Please check your phone/email and password.' });
      }

      const user = result.rows[0];

      if (!user.password_hash) {
        return res.status(401).json({ error: 'Account password not configured. Please use sign up.' });
      }

      // Constant-time bcrypt password comparison
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid credentials. Please check your phone/email and password.' });
      }

      // Generate and store OTP in Redis
      const otp = generateOtp();
      await storeOtp('buyer', user.email, otp);
      await sendOtpEmail(user.email, otp, 'Buyer Login');

      return res.status(200).json({
        message: 'Credentials verified. A 6-digit verification OTP has been sent to your registered email.',
        email: user.email,
        requiresOtp: true
      });
    } catch (error: any) {
      console.error('[Auth Error - Buyer Login]:', error);
      return res.status(500).json({ error: 'Authentication service temporarily unavailable.' });
    }
  });

  /**
   * Buyer Verify OTP & Issue Token
   */
  router.post('/buyer/verify-otp', async (req: Request, res: Response) => {
    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        return res.status(400).json({ error: 'Email and OTP code are required.' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const verification = await verifyOtp('buyer', normalizedEmail, otp);

      if (!verification.valid) {
        return res.status(400).json({ error: verification.reason || 'Invalid or expired OTP.' });
      }

      // Retrieve full user record
      const userRes = await customerPool.query(
        'SELECT id, phone, full_name, email, home_address FROM users WHERE LOWER(email) = $1',
        [normalizedEmail]
      );

      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'User profile not found.' });
      }

      const user = userRes.rows[0];

      // Mark verified in DB
      await customerPool.query('UPDATE users SET is_verified = true WHERE id = $1', [user.id]);

      // Issue signed JWT
      const token = jwt.sign(
        {
          sub: user.id,
          role: 'BUYER',
          phone: user.phone,
          fullName: user.full_name,
          email: user.email
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.status(200).json({
        message: 'Verification successful. Welcome to StreetVerse!',
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          phone: user.phone,
          email: user.email,
          address: user.home_address
        }
      });
    } catch (error: any) {
      console.error('[Auth Error - Buyer Verify OTP]:', error);
      return res.status(500).json({ error: 'OTP verification failed.' });
    }
  });

  // =========================================================================
  // 2. SELLER / MERCHANT AUTHENTICATION
  // =========================================================================

  /**
   * Seller Registration (SQL-Injection Proof via Parameterized Queries)
   */
  router.post('/seller/register', async (req: Request, res: Response) => {
    try {
      const {
        business_name,
        category,
        owner_phone,
        owner_email,
        password,
        upi_vpa,
        address,
        pincode,
        latitude,
        longitude
      } = req.body;

      if (!business_name || !category || !owner_phone || !owner_email || !password || !upi_vpa || !address || !pincode) {
        return res.status(400).json({ error: 'Missing required merchant registration fields.' });
      }

      if (!isValidPhone(owner_phone)) {
        return res.status(400).json({ error: 'Invalid owner phone number format.' });
      }

      if (!isValidEmail(owner_email)) {
        return res.status(400).json({ error: 'Invalid owner email format.' });
      }

      if (!isValidPassword(password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long with letters and numbers.' });
      }

      const normalizedPhone = owner_phone.trim();
      const normalizedEmail = owner_email.trim().toLowerCase();

      // Check existing merchant strictly with parameterized queries
      const existingRes = await merchantPool.query(
        'SELECT id, owner_phone, owner_email FROM merchants WHERE owner_phone = $1 OR owner_email = $2',
        [normalizedPhone, normalizedEmail]
      );

      if (existingRes.rows.length > 0) {
        const match = existingRes.rows[0];
        if (match.owner_phone === normalizedPhone) {
          return res.status(409).json({ error: 'A merchant account with this phone number already exists.' });
        }
        return res.status(409).json({ error: 'A merchant account with this email address already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      const lat = parseFloat(latitude) || 18.5074;
      const lon = parseFloat(longitude) || 73.8077;

      const insertQuery = `
        INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, upi_vpa, address, pincode, latitude, longitude, is_open, is_verified)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, false)
        RETURNING id, business_name, category, owner_phone, owner_email, upi_vpa, address;
      `;
      const insertRes = await merchantPool.query(insertQuery, [
        business_name.trim(),
        category.toUpperCase(),
        normalizedPhone,
        normalizedEmail,
        passwordHash,
        upi_vpa.trim(),
        address.trim(),
        pincode.trim(),
        lat,
        lon
      ]);

      const newMerchant = insertRes.rows[0];

      // Generate & send OTP
      const otp = generateOtp();
      await storeOtp('seller', normalizedEmail, otp);
      await sendOtpEmail(normalizedEmail, otp, 'Merchant Registration');

      return res.status(201).json({
        message: 'Merchant registered successfully. Verification OTP sent to owner email.',
        email: normalizedEmail,
        merchantId: newMerchant.id,
        requiresOtp: true
      });
    } catch (error: any) {
      console.error('[Auth Error - Seller Register]:', error);
      return res.status(500).json({ error: 'Failed to complete merchant registration.' });
    }
  });

  /**
   * Seller Password Login -> Triggers OTP step
   */
  router.post('/seller/login', async (req: Request, res: Response) => {
    try {
      const { identifier, password } = req.body;

      if (!identifier || !password) {
        return res.status(400).json({ error: 'Merchant phone/email and password are required.' });
      }

      const normalizedIdentifier = identifier.trim().toLowerCase();

      // Parameterized query
      const findMerchantQuery = `
        SELECT id, business_name, category, owner_phone, owner_email, password_hash, upi_vpa, address, is_open
        FROM merchants
        WHERE LOWER(owner_email) = $1 OR owner_phone = $1
      `;
      const result = await merchantPool.query(findMerchantQuery, [normalizedIdentifier]);

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid merchant credentials.' });
      }

      const merchant = result.rows[0];

      if (!merchant.password_hash) {
        return res.status(401).json({ error: 'Password not initialized for this merchant.' });
      }

      const isMatch = await bcrypt.compare(password, merchant.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid merchant credentials.' });
      }

      // Generate & send OTP
      const email = merchant.owner_email || `${merchant.owner_phone}@streetverse.local`;
      const otp = generateOtp();
      await storeOtp('seller', email, otp);
      await sendOtpEmail(email, otp, 'Merchant Login');

      return res.status(200).json({
        message: 'Credentials verified. 6-digit OTP sent to merchant registered email.',
        email,
        requiresOtp: true
      });
    } catch (error: any) {
      console.error('[Auth Error - Seller Login]:', error);
      return res.status(500).json({ error: 'Merchant authentication service error.' });
    }
  });

  /**
   * Seller Verify OTP & Issue Token
   */
  router.post('/seller/verify-otp', async (req: Request, res: Response) => {
    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        return res.status(400).json({ error: 'Email and OTP code are required.' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const verification = await verifyOtp('seller', normalizedEmail, otp);

      if (!verification.valid) {
        return res.status(400).json({ error: verification.reason || 'Invalid or expired OTP.' });
      }

      // Retrieve full merchant record
      const merchantRes = await merchantPool.query(
        `SELECT id, business_name, category, owner_phone, owner_email, upi_vpa, address, is_open 
         FROM merchants 
         WHERE LOWER(owner_email) = $1 OR owner_phone = $1`,
        [normalizedEmail]
      );

      if (merchantRes.rows.length === 0) {
        return res.status(404).json({ error: 'Merchant profile not found.' });
      }

      const merchant = merchantRes.rows[0];

      // Mark verified
      await merchantPool.query('UPDATE merchants SET is_verified = true WHERE id = $1', [merchant.id]);

      // Issue signed JWT
      const token = jwt.sign(
        {
          sub: merchant.id,
          role: 'SELLER',
          businessName: merchant.business_name,
          category: merchant.category,
          ownerPhone: merchant.owner_phone,
          ownerEmail: merchant.owner_email
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.status(200).json({
        message: 'Merchant authentication successful.',
        token,
        merchant: {
          id: merchant.id,
          businessName: merchant.business_name,
          category: merchant.category,
          ownerPhone: merchant.owner_phone,
          ownerEmail: merchant.owner_email,
          upiVpa: merchant.upi_vpa,
          address: merchant.address,
          isOpen: merchant.is_open
        }
      });
    } catch (error: any) {
      console.error('[Auth Error - Seller Verify OTP]:', error);
      return res.status(500).json({ error: 'Merchant OTP verification failed.' });
    }
  });

  // =========================================================================
  // 3. COMMON AUTH UTILITIES
  // =========================================================================

  /**
   * Resend OTP endpoint
   */
  router.post('/resend-otp', async (req: Request, res: Response) => {
    try {
      const { scope, email } = req.body;
      if (!scope || !email || (scope !== 'buyer' && scope !== 'seller')) {
        return res.status(400).json({ error: 'Invalid scope (buyer/seller) or email.' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const otp = generateOtp();
      await storeOtp(scope, normalizedEmail, otp);
      await sendOtpEmail(normalizedEmail, otp, scope === 'buyer' ? 'Buyer Portal' : 'Merchant Portal');

      return res.status(200).json({
        message: 'A fresh 6-digit OTP has been dispatched to your email.',
        email: normalizedEmail
      });
    } catch (error) {
      console.error('[Auth Error - Resend OTP]:', error);
      return res.status(500).json({ error: 'Failed to resend OTP.' });
    }
  });

  /**
   * Token Introspection / Current Session Profile
   */
  router.get('/me', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authentication token provided.' });
    }

    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return res.status(200).json({ authenticated: true, user: decoded });
    } catch (err: any) {
      return res.status(401).json({ error: 'Authentication token is invalid or expired.', details: err.message });
    }
  });

  return router;
}
