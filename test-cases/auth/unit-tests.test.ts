/**
 * StreetVerse Test Suite: Unit Tests
 * Scope: Isolated functions for validation, cryptography, OTP generation, and JWT verification.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// 1. Validator Functions under test
export function isValidEmail(email: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
}

export function isValidPhone(phone: string): boolean {
  return /^\+?[0-9]{10,15}$/.test(phone.trim());
}

export function isValidPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
}

export function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export async function runUnitTests(): Promise<{ name: string; passed: boolean; error?: string }[]> {
  const results: { name: string; passed: boolean; error?: string }[] = [];

  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };

  // Test 1: Password Hashing & Verification
  try {
    const plain = 'StreetVerse2026!';
    const hash1 = await bcrypt.hash(plain, 10);
    const hash2 = await bcrypt.hash(plain, 10);

    assert(hash1 !== hash2, 'Salted bcrypt hashes must be unique across invocations.');
    assert(await bcrypt.compare(plain, hash1), 'bcrypt.compare must return true for identical password.');
    assert(!(await bcrypt.compare('WrongPassword!', hash1)), 'bcrypt.compare must return false for incorrect password.');
    
    results.push({ name: 'Unit: Password Hashing & Salt Verification', passed: true });
  } catch (err: any) {
    results.push({ name: 'Unit: Password Hashing & Salt Verification', passed: false, error: err.message });
  }

  // Test 2: Phone Validator Regex
  try {
    assert(isValidPhone('+919876543210'), 'Valid Indian international phone must pass.');
    assert(isValidPhone('9876543210'), 'Valid 10-digit phone must pass.');
    assert(!isValidPhone('12345'), 'Too short phone number must fail.');
    assert(!isValidPhone('9876543210abcd'), 'Phone containing alphabets must fail.');
    assert(!isValidPhone("98765' OR '1'='1"), 'Phone containing SQL characters must fail.');

    results.push({ name: 'Unit: Phone Number Regex Validation', passed: true });
  } catch (err: any) {
    results.push({ name: 'Unit: Phone Number Regex Validation', passed: false, error: err.message });
  }

  // Test 3: Email Validator Regex
  try {
    assert(isValidEmail('rahul.deshmukh@example.com'), 'Standard email must pass.');
    assert(isValidEmail('store@streetverse.in'), 'Short domain email must pass.');
    assert(!isValidEmail('plainaddress'), 'Address without @ must fail.');
    assert(!isValidEmail('missing@domain'), 'Email without TLD must fail.');
    assert(!isValidEmail("admin'--@domain.com"), 'Email with SQL injection symbols must fail.');

    results.push({ name: 'Unit: Email Format Validation', passed: true });
  } catch (err: any) {
    results.push({ name: 'Unit: Email Format Validation', passed: false, error: err.message });
  }

  // Test 4: Password Complexity Enforcement
  try {
    assert(isValidPassword('Password123!'), 'Standard alphanumeric password must pass.');
    assert(isValidPassword('kothrud2026'), '8+ alphanumeric must pass.');
    assert(!isValidPassword('short1'), 'Less than 8 chars must fail.');
    assert(!isValidPassword('onlyletters'), 'Letters without digits must fail.');
    assert(!isValidPassword('12345678'), 'Digits without letters must fail.');

    results.push({ name: 'Unit: Password Complexity Rules', passed: true });
  } catch (err: any) {
    results.push({ name: 'Unit: Password Complexity Rules', passed: false, error: err.message });
  }

  // Test 5: 6-Digit OTP Generator
  try {
    for (let i = 0; i < 20; i++) {
      const code = generateOtp();
      assert(code.length === 6, 'OTP must strictly be 6 characters in length.');
      assert(/^\d{6}$/.test(code), 'OTP must consist solely of numeric digits.');
    }

    results.push({ name: 'Unit: 6-Digit Crypto-Random OTP Generation', passed: true });
  } catch (err: any) {
    results.push({ name: 'Unit: 6-Digit Crypto-Random OTP Generation', passed: false, error: err.message });
  }

  // Test 6: JWT Token Signing & Claim Verification
  try {
    const secret = 'test-secret-key-12345';
    const payload = { sub: 'usr-123', role: 'BUYER', email: 'rahul@example.com' };
    const token = jwt.sign(payload, secret, { expiresIn: '1h' });

    const decoded = jwt.verify(token, secret) as any;
    assert(decoded.sub === 'usr-123', 'Decoded JWT sub claim must match.');
    assert(decoded.role === 'BUYER', 'Decoded JWT role claim must match.');

    // Reject forged token
    let forgedFailed = false;
    try {
      jwt.verify(token, 'wrong-secret');
    } catch {
      forgedFailed = true;
    }
    assert(forgedFailed, 'Verification with wrong secret must throw an error.');

    results.push({ name: 'Unit: JWT Token Issuance & Tamper Resistance', passed: true });
  } catch (err: any) {
    results.push({ name: 'Unit: JWT Token Issuance & Tamper Resistance', passed: false, error: err.message });
  }

  return results;
}
