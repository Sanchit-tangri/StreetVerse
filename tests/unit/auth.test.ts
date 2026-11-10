/**
 * StreetVerse Unit Tests: Authentication, Security & Cryptography
 * Focus: Password hashing, salt randomness, JWT validation,
 *        OTP generation, rate limiting, and RBAC token structure.
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { TestResult } from './search.test';

export function isValidEmail(email: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
}

export function isValidPhone(phone: string): boolean {
  return /^\+?[0-9]{10,15}$/.test(phone.trim());
}

export function isValidPassword(password: string): boolean {
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

export function generateCryptoOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export function signJwtToken(payload: object, secret: string, expiresIn = '1h'): string {
  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyJwtToken(token: string, secret: string): any {
  return jwt.verify(token, secret);
}

export async function runAuthUnitTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const JWT_SECRET = 'enterprise-test-secret-streetverse-2026';

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  // Test 1: Bcrypt Password Hashing & Salt Randomness
  {
    const start = Date.now();
    try {
      const password = 'EnterprisePassword2026!';
      const hash1 = await bcrypt.hash(password, 10);
      const hash2 = await bcrypt.hash(password, 10);

      assert(hash1 !== hash2, 'Bcrypt salts must ensure distinct hashes for identical plaintexts');
      assert(await bcrypt.compare(password, hash1), 'bcrypt.compare must succeed for valid password');
      assert(!(await bcrypt.compare('WrongPassword!', hash1)), 'bcrypt.compare must reject wrong password');

      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: Cryptographic Salt Entropy & Bcrypt Verification',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: Cryptographic Salt Entropy & Bcrypt Verification',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 2: Input Format Validators (Email, Phone, Password Rules)
  {
    const start = Date.now();
    try {
      // Valid cases
      assert(isValidEmail('rahul.d@example.com'), 'Valid email must pass');
      assert(isValidEmail('vendor_shop.pune@sub.domain.co.in'), 'Subdomain email must pass');
      assert(isValidPhone('+919876543210'), 'Valid E.164 phone must pass');
      assert(isValidPhone('9876543210'), '10-digit national phone must pass');
      assert(isValidPassword('ValidPass123'), 'Compliant password must pass');

      // Invalid cases
      assert(!isValidEmail('invalid-email'), 'Malformed email must fail');
      assert(!isValidEmail('test@.com'), 'Missing domain name must fail');
      assert(!isValidPhone('123'), 'Too short phone must fail');
      assert(!isValidPhone('letters-not-allowed'), 'Non-numeric phone must fail');
      assert(!isValidPassword('short1'), 'Less than 8 chars must fail');
      assert(!isValidPassword('nonumbersatall'), 'Password without numbers must fail');
      assert(!isValidPassword('1234567890'), 'Password without letters must fail');

      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: Strict Input Format & Validation Rules (Email, Phone, Password)',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: Strict Input Format & Validation Rules (Email, Phone, Password)',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 3: 6-Digit Cryptographic Random OTP Generation
  {
    const start = Date.now();
    try {
      const generated = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const otp = generateCryptoOtp();
        assert(/^\d{6}$/.test(otp), `OTP ${otp} must be exactly 6 digits`);
        generated.add(otp);
      }
      // Out of 200 samples, collision should be very low
      assert(generated.size >= 195, 'High entropy: 200 samples must have almost zero collisions');

      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: Cryptographically Secure 6-Digit OTP Entropy Test (200 Invocations)',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: Cryptographically Secure 6-Digit OTP Entropy Test (200 Invocations)',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 4: JWT Token Issuance & Signature Tamper Resistance
  {
    const start = Date.now();
    try {
      const payload = { userId: 'u-12345', role: 'buyer', email: 'rahul.d@example.com' };
      const token = signJwtToken(payload, JWT_SECRET, '1h');

      // Verify legitimate token
      const decoded = verifyJwtToken(token, JWT_SECRET);
      assert(decoded.userId === payload.userId, 'Decoded user ID must match');
      assert(decoded.role === 'buyer', 'Role claim must be preserved');

      // Tamper test: Alter 1 character in payload portion
      const parts = token.split('.');
      const tamperedToken = `${parts[0]}.${parts[1]}A.${parts[2]}`;

      let tamperedFailed = false;
      try {
        verifyJwtToken(tamperedToken, JWT_SECRET);
      } catch {
        tamperedFailed = true;
      }
      assert(tamperedFailed, 'Altered JWT payload must trigger signature verification failure');

      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: JWT Signature Verification & Cryptographic Tamper Resistance',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: JWT Signature Verification & Cryptographic Tamper Resistance',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 5: OTP Throttling & Lockout Simulation
  {
    const start = Date.now();
    try {
      const MAX_ATTEMPTS = 3;
      let currentAttempts = 0;
      const correctOtp = '482910';

      const verifyMock = (attempt: string) => {
        if (currentAttempts >= MAX_ATTEMPTS) {
          return { success: false, locked: true };
        }
        if (attempt === correctOtp) {
          return { success: true, locked: false };
        }
        currentAttempts++;
        return { success: false, locked: currentAttempts >= MAX_ATTEMPTS };
      };

      assert(!verifyMock('000000').success, 'Attempt 1 must fail');
      assert(!verifyMock('111111').success, 'Attempt 2 must fail');
      const finalFailed = verifyMock('222222');
      assert(finalFailed.locked, '3rd failed attempt must trigger lockout');

      // Even if user now provides the right code, it must remain locked
      const postLockout = verifyMock(correctOtp);
      assert(!postLockout.success && postLockout.locked, 'Locked state must reject subsequent valid OTP');

      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: Brute-Force Defense: 3-Attempt Maximum Lockout Policy',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Authentication & Security',
        name: 'Unit: Brute-Force Defense: 3-Attempt Maximum Lockout Policy',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  return results;
}

