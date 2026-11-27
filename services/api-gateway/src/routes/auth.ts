import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { StrictPgPool, withPgTransaction } from '../db/postgres';
import {
  AuthenticatedRequest,
  JwtAuthConfig,
  requireSellerJwt,
  SELLER_ACCOUNT_PRINCIPAL_TYPE,
  verifyAccessToken
} from '../middleware/authJwt';
import { EmailService, generateOtp } from '../services/email';
import { listSellerAccountWithMemberships, verifySellerStorePermission } from '../services/sellerRbac';
import {
  classifyHttpError,
  InfrastructureUnavailableError,
  isRedisUnavailableError,
  sanitizeErrorForLog
} from '../utils/infraErrors';
import { normalizePhoneNumber } from '../utils/phone';
import { handleListSellerStores } from './seller';

export function createAuthRouter(
  customerPool: StrictPgPool,
  merchantPool: StrictPgPool,
  jwtConfig: JwtAuthConfig,
  emailService: EmailService
): Router {
  const router = Router();
  const BCRYPT_SALT_ROUNDS = 10;

  const isValidEmail = (email: string): boolean => {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
  };

  const isValidPassword = (password: string): boolean => {
    // At least 8 chars, 1 number, 1 letter
    return typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
  };

  const bestEffortCleanup = async (fn: () => Promise<void>, label: string): Promise<void> => {
    try {
      await fn();
    } catch (cleanupErr) {
      console.warn(`[Auth Cleanup - ${label}]: ${sanitizeErrorForLog(cleanupErr)}`);
    }
  };

  const handleAuthRouteError = (
    res: Response,
    context: string,
    error: any,
    defaultMessage: string,
    uniqueConflictMessage?: string
  ) => {
    if (uniqueConflictMessage && error?.code === '23505') {
      return res.status(409).json({ error: uniqueConflictMessage });
    }
    if (error instanceof InfrastructureUnavailableError || isRedisUnavailableError(error)) {
      const mapped = classifyHttpError(error);
      return res.status(mapped.status).json({ error: mapped.message });
    }
    console.error(`[Auth Error - ${context}]: ${sanitizeErrorForLog(error)}`);
    return res.status(500).json({ error: defaultMessage });
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

      const phoneNorm = normalizePhoneNumber(String(phone));
      if (!phoneNorm.valid || !phoneNorm.e164 || !phoneNorm.legacyCandidates) {
        return res.status(400).json({ error: phoneNorm.error || 'Invalid phone number format.' });
      }

      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email address format.' });
      }

      if (!isValidPassword(password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long and contain both letters and numbers.' });
      }

      const normalizedPhone = phoneNorm.e164;
      const phoneCandidates = phoneNorm.legacyCandidates;
      const normalizedEmail = email.trim().toLowerCase();
      const trimmedName = full_name.trim();

      // Check existing canonical and legacy phone representations + case-insensitive email
      const existingUserQuery = 'SELECT id, phone, email FROM users WHERE phone = ANY($1) OR LOWER(email) = $2';
      const existingRes = await customerPool.query(existingUserQuery, [phoneCandidates, normalizedEmail]);

      if (existingRes.rows.length > 0) {
        const match = existingRes.rows[0];
        if (phoneCandidates.includes(match.phone)) {
          return res.status(409).json({ error: 'A customer account with this phone number already exists.' });
        }
        return res.status(409).json({ error: 'A customer account with this email address already exists.' });
      }

      // Hash password securely
      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

      // Insert new buyer with canonical E.164 phone
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

      // Generate & store OTP in Redis before email dispatch
      const otp = generateOtp();
      const otpToken = await emailService.storeOtp('buyer', normalizedEmail, otp);
      const emailResult = await emailService.sendOtpEmail(normalizedEmail, otp, 'Buyer Registration');
      if (!emailResult.sent) {
        await bestEffortCleanup(
          () => emailService.invalidateOtpIfOwned('buyer', normalizedEmail, otpToken),
          'buyer-register'
        );
        return res.status(502).json({
          error: 'Account created, but failed to deliver verification email. Please try resending the code.'
        });
      }

      return res.status(201).json({
        message: 'Registration successful. A 6-digit verification code has been sent to your email.',
        email: normalizedEmail,
        userId: newUser.id,
        requiresOtp: true
      });
    } catch (error: any) {
      return handleAuthRouteError(
        res,
        'Buyer Register',
        error,
        'An internal error occurred during registration. Please try again.',
        'A customer account with these details already exists.'
      );
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

      const rawIdent = String(identifier).trim();
      let result;

      if (rawIdent.includes('@')) {
        const normalizedEmail = rawIdent.toLowerCase();
        result = await customerPool.query(
          `SELECT id, phone, full_name, email, password_hash, is_verified, home_address
           FROM users
           WHERE LOWER(email) = $1`,
          [normalizedEmail]
        );
      } else {
        const phoneNorm = normalizePhoneNumber(rawIdent);
        if (!phoneNorm.valid || !phoneNorm.legacyCandidates) {
          return res.status(401).json({ error: 'Invalid credentials. Please check your phone/email and password.' });
        }
        result = await customerPool.query(
          `SELECT id, phone, full_name, email, password_hash, is_verified, home_address
           FROM users
           WHERE phone = ANY($1)`,
          [phoneNorm.legacyCandidates]
        );
        if (result.rows.length > 1) {
          return res.status(409).json({
            error: 'Multiple accounts match this phone number format. Account reconciliation is required before sign in.'
          });
        }
      }

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

      // Enforce 45-second account-level login OTP cooldown after password verification
      const cooldown = await emailService.acquireResendCooldown('buyer-login', user.id);
      if (!cooldown.allowed) {
        return res.status(429).json({
          error: `Please wait ${cooldown.retryAfterSeconds} seconds before requesting another login OTP.`,
          retryAfterSeconds: cooldown.retryAfterSeconds
        });
      }

      // Generate and store OTP in Redis before email dispatch
      const cooldownToken = cooldown.token || '';
      const otp = generateOtp();
      let otpToken = '';
      try {
        otpToken = await emailService.storeOtp('buyer', user.email, otp);
      } catch (storeErr) {
        await bestEffortCleanup(
          () => emailService.clearResendCooldown('buyer-login', user.id, cooldownToken),
          'buyer-login-store'
        );
        throw storeErr;
      }

      const emailResult = await emailService.sendOtpEmail(user.email, otp, 'Buyer Login');
      if (!emailResult.sent) {
        await bestEffortCleanup(
          () => emailService.invalidateOtpIfOwned('buyer', user.email, otpToken),
          'buyer-login-otp'
        );
        await bestEffortCleanup(
          () => emailService.clearResendCooldown('buyer-login', user.id, cooldownToken),
          'buyer-login-cooldown'
        );
        return res.status(502).json({ error: 'Failed to deliver verification OTP email.' });
      }

      return res.status(200).json({
        message: 'Credentials verified. A 6-digit verification OTP has been sent to your registered email.',
        email: user.email,
        requiresOtp: true
      });
    } catch (error: any) {
      return handleAuthRouteError(res, 'Buyer Login', error, 'Authentication service temporarily unavailable.');
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
      const verification = await emailService.verifyOtp('buyer', normalizedEmail, otp);

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
        jwtConfig.jwtSecret,
        {
          issuer: jwtConfig.jwtIssuer,
          audience: jwtConfig.jwtBuyerAudience,
          expiresIn: jwtConfig.jwtExpiresIn as jwt.SignOptions['expiresIn']
        }
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
      return handleAuthRouteError(res, 'Buyer Verify OTP', error, 'OTP verification failed.');
    }
  });

  // =========================================================================
  // 2. SELLER / MERCHANT AUTHENTICATION
  // =========================================================================

  /**
   * Seller Registration (Atomic Merchant DB Transaction:
   * Seller Account -> Merchant Store -> OWNER Membership)
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

      const phoneNorm = normalizePhoneNumber(String(owner_phone));
      if (!phoneNorm.valid || !phoneNorm.e164 || !phoneNorm.legacyCandidates) {
        return res.status(400).json({ error: phoneNorm.error || 'Invalid owner phone number format.' });
      }

      if (!isValidEmail(owner_email)) {
        return res.status(400).json({ error: 'Invalid owner email format.' });
      }

      if (!isValidPassword(password)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long with letters and numbers.' });
      }

      const normalizedPhone = phoneNorm.e164;
      const phoneCandidates = phoneNorm.legacyCandidates;
      const normalizedEmail = owner_email.trim().toLowerCase();
      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      const lat = parseFloat(latitude) || 18.5074;
      const lon = parseFloat(longitude) || 73.8077;

      const txResult = await withPgTransaction(merchantPool, async (client) => {
        const existingAccountRes = await client.query(
          'SELECT id, phone, email FROM seller_accounts WHERE phone = ANY($1) OR LOWER(email) = $2',
          [phoneCandidates, normalizedEmail]
        );
        if (existingAccountRes.rows.length > 0) {
          const match = existingAccountRes.rows[0];
          if (phoneCandidates.includes(match.phone)) {
            return { conflict: 'A seller account with this phone number already exists.' };
          }
          return { conflict: 'A seller account with this email address already exists.' };
        }

        const existingLegacyStoreRes = await client.query(
          'SELECT id, owner_phone, owner_email FROM merchants WHERE owner_phone = ANY($1) OR LOWER(owner_email) = $2',
          [phoneCandidates, normalizedEmail]
        );
        if (existingLegacyStoreRes.rows.length > 0) {
          const match = existingLegacyStoreRes.rows[0];
          if (phoneCandidates.includes(match.owner_phone)) {
            return { conflict: 'A merchant account with this phone number already exists.' };
          }
          return { conflict: 'A merchant account with this email address already exists.' };
        }

        const accountIns = await client.query(
          `INSERT INTO seller_accounts (phone, email, password_hash, is_email_verified, status)
           VALUES ($1, $2, $3, false, 'ACTIVE')
           RETURNING id, phone, email, is_email_verified, status`,
          [normalizedPhone, normalizedEmail, passwordHash]
        );
        const sellerAccount = accountIns.rows[0];

        const storeIns = await client.query(
          `INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, upi_vpa, address, pincode, latitude, longitude, is_open, is_verified)
           VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, false, false)
           RETURNING id, business_name, category, owner_phone, owner_email, upi_vpa, address, is_open`,
          [
            business_name.trim(),
            category.toUpperCase(),
            normalizedPhone,
            normalizedEmail,
            upi_vpa.trim(),
            address.trim(),
            pincode.trim(),
            lat,
            lon
          ]
        );
        const newMerchant = storeIns.rows[0];

        await client.query(
          `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status)
           VALUES ($1, $2, 'OWNER', 'ACTIVE')
           RETURNING id`,
          [sellerAccount.id, newMerchant.id]
        );

        const onboardingTableCheck = await client.query(
          `SELECT to_regclass('public.store_onboarding_profiles') AS tbl`
        );
        if (onboardingTableCheck.rows[0]?.tbl) {
          await client.query(
            `INSERT INTO store_onboarding_profiles (merchant_id, status)
             VALUES ($1, 'PENDING_SUBMISSION')
             ON CONFLICT (merchant_id) DO NOTHING`,
            [newMerchant.id]
          );
        }

        return { sellerAccount, newMerchant };
      });

      if ('conflict' in txResult && txResult.conflict) {
        return res.status(409).json({ error: txResult.conflict });
      }

      const { sellerAccount, newMerchant } = txResult as { sellerAccount: any; newMerchant: any };

      // Generate & store OTP in Redis before email dispatch
      const otp = generateOtp();
      const otpToken = await emailService.storeOtp('seller', normalizedEmail, otp);
      const emailResult = await emailService.sendOtpEmail(normalizedEmail, otp, 'Merchant Registration');
      if (!emailResult.sent) {
        await bestEffortCleanup(
          () => emailService.invalidateOtpIfOwned('seller', normalizedEmail, otpToken),
          'seller-register'
        );
        return res.status(502).json({
          error: 'Merchant registered, but failed to deliver verification email. Please try resending the code.'
        });
      }

      return res.status(201).json({
        message: 'Merchant registered successfully. Verification OTP sent to owner email.',
        email: normalizedEmail,
        sellerAccountId: sellerAccount.id,
        merchantId: newMerchant.id,
        requiresOtp: true
      });
    } catch (error: any) {
      return handleAuthRouteError(
        res,
        'Seller Register',
        error,
        'Failed to complete merchant registration.',
        'A merchant account with these details already exists.'
      );
    }
  });

  /**
   * Seller Password Login -> Authenticates strictly against `seller_accounts` and triggers OTP step
   */
  router.post('/seller/login', async (req: Request, res: Response) => {
    try {
      const { identifier, password } = req.body;

      if (!identifier || !password) {
        return res.status(400).json({ error: 'Seller phone/email and password are required.' });
      }

      const rawIdent = String(identifier).trim();
      let result;

      if (rawIdent.includes('@')) {
        const normalizedEmail = rawIdent.toLowerCase();
        result = await merchantPool.query(
          `SELECT id, phone, email, password_hash, is_email_verified, status
           FROM seller_accounts
           WHERE LOWER(email) = $1`,
          [normalizedEmail]
        );
      } else {
        const phoneNorm = normalizePhoneNumber(rawIdent);
        if (!phoneNorm.valid || !phoneNorm.legacyCandidates) {
          return res.status(401).json({ error: 'Invalid merchant credentials.' });
        }
        result = await merchantPool.query(
          `SELECT id, phone, email, password_hash, is_email_verified, status
           FROM seller_accounts
           WHERE phone = ANY($1)`,
          [phoneNorm.legacyCandidates]
        );
        if (result.rows.length > 1) {
          return res.status(409).json({
            error: 'Multiple seller accounts match this phone number format. Account reconciliation is required before sign in.'
          });
        }
      }

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid merchant credentials.' });
      }

      const account = result.rows[0];

      if (!account.password_hash) {
        return res.status(401).json({ error: 'Password not initialized for this seller account.' });
      }

      const isMatch = await bcrypt.compare(password, account.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid merchant credentials.' });
      }

      if (account.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'Seller account is not active.', code: 'SELLER_ACCOUNT_INACTIVE' });
      }

      const email = String(account.email || '').trim().toLowerCase();
      if (!email) {
        return res.status(500).json({ error: 'Seller account email is missing.' });
      }

      // Enforce 45-second account-level login OTP cooldown after password verification
      const cooldown = await emailService.acquireResendCooldown('seller-login', account.id);
      if (!cooldown.allowed) {
        return res.status(429).json({
          error: `Please wait ${cooldown.retryAfterSeconds} seconds before requesting another login OTP.`,
          retryAfterSeconds: cooldown.retryAfterSeconds
        });
      }

      // Generate and store OTP before email dispatch
      const cooldownToken = cooldown.token || '';
      const otp = generateOtp();
      let otpToken = '';
      try {
        otpToken = await emailService.storeOtp('seller', email, otp);
      } catch (storeErr) {
        await bestEffortCleanup(
          () => emailService.clearResendCooldown('seller-login', account.id, cooldownToken),
          'seller-login-store'
        );
        throw storeErr;
      }

      const emailResult = await emailService.sendOtpEmail(email, otp, 'Merchant Login');
      if (!emailResult.sent) {
        await bestEffortCleanup(
          () => emailService.invalidateOtpIfOwned('seller', email, otpToken),
          'seller-login-otp'
        );
        await bestEffortCleanup(
          () => emailService.clearResendCooldown('seller-login', account.id, cooldownToken),
          'seller-login-cooldown'
        );
        return res.status(502).json({ error: 'Failed to deliver merchant verification OTP email.' });
      }

      return res.status(200).json({
        message: 'Credentials verified. 6-digit OTP sent to merchant registered email.',
        email,
        requiresOtp: true
      });
    } catch (error: any) {
      return handleAuthRouteError(res, 'Seller Login', error, 'Merchant authentication service error.');
    }
  });

  /**
   * Seller Verify OTP & Issue Seller Account JWT
   */
  router.post('/seller/verify-otp', async (req: Request, res: Response) => {
    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        return res.status(400).json({ error: 'Email and OTP code are required.' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const verification = await emailService.verifyOtp('seller', normalizedEmail, otp);

      if (!verification.valid) {
        return res.status(400).json({ error: verification.reason || 'Invalid or expired OTP.' });
      }

      const acctRes = await merchantPool.query(
        `SELECT id, phone, email, is_email_verified, status
         FROM seller_accounts
         WHERE LOWER(email) = $1`,
        [normalizedEmail]
      );

      if (acctRes.rows.length === 0) {
        return res.status(404).json({ error: 'Seller account not found.' });
      }

      const account = acctRes.rows[0];
      if (account.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'Seller account is not active.', code: 'SELLER_ACCOUNT_INACTIVE' });
      }

      // Mark only Seller Account email verification; never mutate merchants.is_verified (KYC flag)
      await merchantPool.query(
        'UPDATE seller_accounts SET is_email_verified = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [account.id]
      );

      const profile = await listSellerAccountWithMemberships(merchantPool, account.id);
      if (!profile.ok) {
        return res.status(profile.status).json({ error: profile.error, code: profile.code });
      }

      const token = jwt.sign(
        {
          sub: account.id,
          role: 'SELLER',
          principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE
        },
        jwtConfig.jwtSecret,
        {
          issuer: jwtConfig.jwtIssuer,
          audience: jwtConfig.jwtSellerAudience,
          expiresIn: jwtConfig.jwtExpiresIn as jwt.SignOptions['expiresIn']
        }
      );

      const stores = profile.memberships.map((m) => ({
        ...m.store,
        membershipId: m.membershipId,
        role: m.role,
        membershipStatus: m.status,
        permissions: m.permissions
      }));

      return res.status(200).json({
        message: 'Merchant authentication successful.',
        token,
        sellerAccount: {
          ...profile.sellerAccount,
          isEmailVerified: true
        },
        stores,
        merchant: stores[0] || null
      });
    } catch (error: any) {
      return handleAuthRouteError(res, 'Seller Verify OTP', error, 'Merchant OTP verification failed.');
    }
  });

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ALLOWED_KYC_DOCUMENT_TYPES = new Set<string>([
    'FSSAI_LICENSE',
    'GSTIN_CERTIFICATE',
    'SHOP_ESTABLISHMENT_ACT',
    'TRADE_LICENSE',
    'AADHAAR_PAN'
  ]);

  /**
   * Seller KYC Document Submission
   * Requires verified Seller Account JWT and active OWNER membership for the requested store.
   * Preserves honest fail-closed 503 KYC_SUBMISSION_UNAVAILABLE until document persistence exists.
   */
  router.post(
    '/seller/kyc/upload',
    requireSellerJwt(jwtConfig),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sellerAccountId = req.auth?.sub;
        if (!sellerAccountId) {
          return res.status(401).json({ error: 'Seller authentication required.', code: 'SELLER_AUTH_REQUIRED' });
        }

        const { merchantId, documentType, documentNumber } = req.body ?? {};

        if (
          typeof merchantId !== 'string' ||
          !merchantId.trim() ||
          typeof documentType !== 'string' ||
          !documentType.trim() ||
          typeof documentNumber !== 'string' ||
          !documentNumber.trim()
        ) {
          return res.status(400).json({
            error: 'merchantId, documentType, and documentNumber are required.',
            code: 'INVALID_KYC_INPUT'
          });
        }

        const normalizedMerchantId = merchantId.trim();
        if (!UUID_REGEX.test(normalizedMerchantId)) {
          return res.status(400).json({
            error: 'Invalid merchantId format. Expected a valid UUID.',
            code: 'INVALID_MERCHANT_ID'
          });
        }

        const normalizedDocType = documentType.trim().toUpperCase();
        if (!ALLOWED_KYC_DOCUMENT_TYPES.has(normalizedDocType)) {
          return res.status(400).json({
            error: 'Unsupported KYC documentType.',
            code: 'INVALID_DOCUMENT_TYPE'
          });
        }

        const normalizedDocNumber = documentNumber.trim();
        if (normalizedDocNumber.length > 100) {
          return res.status(400).json({
            error: 'documentNumber exceeds maximum allowed length.',
            code: 'INVALID_DOCUMENT_NUMBER'
          });
        }

        const accessCheck = await verifySellerStorePermission({
          merchantPool,
          sellerAccountId,
          storeId: normalizedMerchantId,
          requiredPermission: 'KYC_MANAGE'
        });

        if (!accessCheck.ok) {
          return res.status(accessCheck.status).json({
            error: accessCheck.error,
            code: accessCheck.code
          });
        }

        // Database schema currently lacks persistent KYC submission tables/columns and cannot
        // record document metadata without conflating submission with `merchants.is_verified`.
        return res.status(503).json({
          success: false,
          code: 'KYC_SUBMISSION_UNAVAILABLE',
          error: 'KYC document submission is temporarily unavailable until document persistence is provisioned. No document was stored or verified.'
        });
      } catch (error: unknown) {
        const mapped = classifyHttpError(error, { treatInvalidInputAs400: true });
        if (mapped.status === 503 || mapped.status === 400 || mapped.status === 409) {
          return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
        }
        console.error(`[Auth Error - Seller KYC Upload]: ${sanitizeErrorForLog(error)}`);
        return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
      }
    }
  );

  /**
   * Authenticated Seller Stores Discovery Endpoint
   */
  router.get('/seller/stores', requireSellerJwt(jwtConfig), async (req: AuthenticatedRequest, res: Response) => {
    return handleListSellerStores(req, res, merchantPool);
  });

  // =========================================================================
  // 3. COMMON AUTH UTILITIES
  // =========================================================================

  /**
   * Resend OTP endpoint (strictly limited to buyer/seller scopes with 45s cooldown)
   */
  router.post('/resend-otp', async (req: Request, res: Response) => {
    try {
      const { scope, email } = req.body;
      if (scope !== 'buyer' && scope !== 'seller') {
        return res.status(400).json({ error: 'Invalid scope. Only buyer and seller scopes are allowed.' });
      }
      if (typeof email !== 'string' || !isValidEmail(email)) {
        return res.status(400).json({ error: 'Valid email address is required.' });
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Verify target account exists for the requested portal before dispatching OTP
      const accountRes =
        scope === 'buyer'
          ? await customerPool.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail])
          : await merchantPool.query('SELECT id, status FROM seller_accounts WHERE LOWER(email) = $1', [normalizedEmail]);

      if (accountRes.rows.length === 0) {
        return res.status(404).json({ error: 'Account not found for OTP resend.' });
      }

      if (scope === 'seller' && accountRes.rows[0].status !== 'ACTIVE') {
        return res.status(403).json({ error: 'Seller account is not active.', code: 'SELLER_ACCOUNT_INACTIVE' });
      }

      const cooldown = await emailService.acquireResendCooldown(`resend:${scope}`, normalizedEmail);
      if (!cooldown.allowed) {
        return res.status(429).json({
          error: `Please wait ${cooldown.retryAfterSeconds} seconds before requesting another OTP.`,
          retryAfterSeconds: cooldown.retryAfterSeconds
        });
      }

      const cooldownToken = cooldown.token || '';
      const otp = generateOtp();
      let otpToken = '';
      try {
        otpToken = await emailService.storeOtp(scope, normalizedEmail, otp);
      } catch (storeErr) {
        await bestEffortCleanup(
          () => emailService.clearResendCooldown(`resend:${scope}`, normalizedEmail, cooldownToken),
          'resend-otp-store'
        );
        throw storeErr;
      }

      const emailResult = await emailService.sendOtpEmail(
        normalizedEmail,
        otp,
        scope === 'buyer' ? 'Buyer Portal' : 'Merchant Portal'
      );

      if (!emailResult.sent) {
        await bestEffortCleanup(
          () => emailService.invalidateOtpIfOwned(scope, normalizedEmail, otpToken),
          'resend-otp-invalidate'
        );
        await bestEffortCleanup(
          () => emailService.clearResendCooldown(`resend:${scope}`, normalizedEmail, cooldownToken),
          'resend-otp-cooldown'
        );
        return res.status(502).json({ error: 'Failed to deliver OTP email. Please try again later.' });
      }

      return res.status(200).json({
        message: 'A fresh 6-digit OTP has been dispatched to your email.',
        email: normalizedEmail
      });
    } catch (error) {
      return handleAuthRouteError(res, 'Resend OTP', error, 'Failed to resend OTP.');
    }
  });

  /**
   * Server-backed Authenticated Identity Introspection
   */
  router.get('/me', async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authentication token provided.' });
    }

    const token = authHeader.substring(7).trim();
    const verification = verifyAccessToken(token, jwtConfig);
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error });
    }

    try {
      const principal = verification.principal;

      if (principal.role === 'BUYER') {
        const userRes = await customerPool.query(
          `SELECT id, phone, full_name, email, home_address, preferred_language, is_verified, created_at
           FROM users
           WHERE id = $1`,
          [principal.sub]
        );

        if (userRes.rows.length === 0) {
          return res.status(404).json({ error: 'User profile not found.', code: 'USER_NOT_FOUND' });
        }

        const userRow = userRes.rows[0];
        return res.status(200).json({
          authenticated: true,
          role: 'BUYER',
          audience: principal.audience,
          user: {
            id: userRow.id,
            fullName: userRow.full_name,
            phone: userRow.phone,
            email: userRow.email,
            address: userRow.home_address,
            preferredLanguage: userRow.preferred_language,
            isEmailVerified: Boolean(userRow.is_verified),
            createdAt: userRow.created_at
          }
        });
      }

      const profile = await listSellerAccountWithMemberships(merchantPool, principal.sub);
      if (!profile.ok) {
        return res.status(profile.status).json({ error: profile.error, code: profile.code });
      }

      return res.status(200).json({
        authenticated: true,
        role: 'SELLER',
        principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE,
        audience: principal.audience,
        sellerAccount: profile.sellerAccount,
        memberships: profile.memberships,
        stores: profile.memberships.map((m) => ({
          ...m.store,
          membershipId: m.membershipId,
          role: m.role,
          membershipStatus: m.status,
          permissions: m.permissions
        }))
      });
    } catch (error: unknown) {
      const mapped = classifyHttpError(error, { treatInvalidInputAs400: false });
      if (mapped.status === 503) {
        return res.status(503).json({ error: mapped.message, code: mapped.code });
      }
      console.error(`[Auth Error - Me]: ${sanitizeErrorForLog(error)}`);
      return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
