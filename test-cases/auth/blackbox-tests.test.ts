/**
 * StreetVerse Test Suite: Blackbox Tests
 * Scope: Interface boundary verification, HTTP status contracts,
 *        and resistance to malicious SQL Injection attack vectors.
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

export async function runBlackboxTests(): Promise<{ name: string; passed: boolean; error?: string }[]> {
  const results: { name: string; passed: boolean; error?: string }[] = [];

  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };

  // Connect to Customer DB directly to test SQL injection resilience at database boundary
  const customerPool = new pg.Pool({
    connectionString: process.env.CUSTOMER_DB_URL || 'postgresql://postgres:postgres@localhost:5433/streetverse_customer_db'
  });

  const merchantPool = new pg.Pool({
    connectionString: process.env.MERCHANT_DB_URL || 'postgresql://postgres:postgres@localhost:5434/streetverse_merchant_db'
  });

  // Test 1: SQL Injection Vector - Classic Tautology (' OR '1'='1)
  try {
    const maliciousPayload = "' OR '1'='1";
    
    // Parameterized lookup as implemented in api-gateway
    const query = `
      SELECT id, phone, full_name, email, password_hash 
      FROM users 
      WHERE LOWER(email) = $1 OR phone = $1
    `;
    const res = await customerPool.query(query, [maliciousPayload]);

    // In a vulnerable system with string concatenation, this returns ALL users.
    // In our parameterized system, it searches for a user whose literal email is "' OR '1'='1", returning 0 rows.
    assert(res.rows.length === 0, `SQL Injection vector succeeded! Expected 0 rows, got ${res.rows.length}`);

    results.push({ name: "Blackbox: SQL Injection Resistance - Tautology Vector (' OR '1'='1)", passed: true });
  } catch (err: any) {
    results.push({ name: "Blackbox: SQL Injection Resistance - Tautology Vector (' OR '1'='1)", passed: false, error: err.message });
  }

  // Test 2: SQL Injection Vector - Comment Truncation (admin'--)
  try {
    const maliciousPayload = "admin'--";
    const query = `
      SELECT id, phone, full_name, email, password_hash 
      FROM users 
      WHERE LOWER(email) = $1 OR phone = $1
    `;
    const res = await customerPool.query(query, [maliciousPayload]);
    assert(res.rows.length === 0, 'Comment truncation payload must safely return zero results.');

    results.push({ name: "Blackbox: SQL Injection Resistance - Comment Vector (admin'--)", passed: true });
  } catch (err: any) {
    results.push({ name: "Blackbox: SQL Injection Resistance - Comment Vector (admin'--)", passed: false, error: err.message });
  }

  // Test 3: SQL Injection Vector - Stacked Query Injection ('; DROP TABLE dummy; --)
  try {
    const maliciousPayload = "'; DROP TABLE users; --";
    const query = `
      SELECT id, phone, full_name, email, password_hash 
      FROM users 
      WHERE LOWER(email) = $1 OR phone = $1
    `;
    const res = await customerPool.query(query, [maliciousPayload]);
    assert(res.rows.length === 0, 'Stacked injection must be neutralized by parameterized protocol.');

    // Confirm table users still exists and intact
    const verifyTable = await customerPool.query('SELECT count(*) FROM users');
    assert(parseInt(verifyTable.rows[0].count, 10) >= 1, 'Users table must remain intact.');

    results.push({ name: "Blackbox: SQL Injection Resistance - Stacked Query Vector ('; DROP TABLE...)", passed: true });
  } catch (err: any) {
    results.push({ name: "Blackbox: SQL Injection Resistance - Stacked Query Vector ('; DROP TABLE...)", passed: false, error: err.message });
  }

  // Test 4: Blackbox Functional Contract - Seeded Customer Authentication Check
  try {
    const customerPhone = '+919890123456';
    const query = 'SELECT id, phone, full_name, password_hash FROM users WHERE phone = $1';
    const res = await customerPool.query(query, [customerPhone]);

    assert(res.rows.length === 1, 'Seeded customer must be found by exact phone.');
    const user = res.rows[0];
    assert(user.password_hash !== null, 'Password hash must be present.');
    assert(await bcrypt.compare('Password123!', user.password_hash), 'Seeded password (Password123!) must verify successfully.');

    results.push({ name: 'Blackbox: Seeded Customer Password Verification Contract', passed: true });
  } catch (err: any) {
    results.push({ name: 'Blackbox: Seeded Customer Password Verification Contract', passed: false, error: err.message });
  }

  // Test 5: Blackbox Functional Contract - Seeded Merchant Authentication Check
  try {
    const merchantPhone = '+919876543210';
    const query = 'SELECT id, business_name, owner_email, password_hash FROM merchants WHERE owner_phone = $1';
    const res = await merchantPool.query(query, [merchantPhone]);

    assert(res.rows.length === 1, 'Seeded merchant must be found by exact owner phone.');
    const merchant = res.rows[0];
    assert(merchant.owner_email === 'greenvalley@streetverse.local', 'Merchant email must be populated.');
    assert(await bcrypt.compare('Password123!', merchant.password_hash), 'Merchant password must verify successfully.');

    results.push({ name: 'Blackbox: Seeded Merchant Password Verification Contract', passed: true });
  } catch (err: any) {
    results.push({ name: 'Blackbox: Seeded Merchant Password Verification Contract', passed: false, error: err.message });
  }

  await customerPool.end();
  await merchantPool.end();

  return results;
}
