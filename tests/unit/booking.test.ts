/**
 * StreetVerse Unit Tests: Appointment Scheduling & 5-Minute Atomic Lock Engine
 * Focus: Redis NX locking semantics, double-booking prevention, 
 *        5-minute TTL expiration, and dynamic UPI QR generation.
 */

import crypto from 'crypto';
import { TestResult } from './search.test';

const uuidv4 = () => crypto.randomUUID();

export interface LockState {
  userId: string;
  lockToken: string;
  expiresAt: number;
}

export class InMemoryAtomicLockManager {
  private locks = new Map<string, LockState>();

  /**
   * Simulates Redis SET lock:slot:<id> <token> EX 300 NX
   */
  public acquireLock(slotId: string, userId: string, ttlSeconds = 300): { acquired: boolean; token?: string } {
    const now = Date.now();
    const existing = this.locks.get(slotId);

    // If an existing lock has expired, reclaim it
    if (existing && existing.expiresAt <= now) {
      this.locks.delete(slotId);
    }

    if (this.locks.has(slotId)) {
      return { acquired: false };
    }

    const token = uuidv4();
    this.locks.set(slotId, {
      userId,
      lockToken: token,
      expiresAt: now + ttlSeconds * 1000
    });

    return { acquired: true, token };
  }

  public releaseLock(slotId: string, token: string): boolean {
    const existing = this.locks.get(slotId);
    if (!existing || existing.lockToken !== token) {
      return false;
    }
    this.locks.delete(slotId);
    return true;
  }

  public isSlotLocked(slotId: string): boolean {
    const existing = this.locks.get(slotId);
    if (!existing) return false;
    if (existing.expiresAt <= Date.now()) {
      this.locks.delete(slotId);
      return false;
    }
    return true;
  }
}

export function generateDynamicUpiString(params: {
  merchantVpa: string;
  merchantName: string;
  amount: number;
  transactionRef: string;
  note: string;
}): string {
  const enc = encodeURIComponent;
  return `upi://pay?pa=${enc(params.merchantVpa)}&pn=${enc(params.merchantName)}&am=${params.amount.toFixed(2)}&cu=INR&tr=${enc(params.transactionRef)}&tn=${enc(params.note)}`;
}

export async function runBookingUnitTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  // Test 1: Atomic Holding Lock Acquisition (First Come, First Served)
  {
    const start = Date.now();
    try {
      const lockMgr = new InMemoryAtomicLockManager();
      const slotId = 'slot-salon-01';
      const user1 = 'user-buyer-001';
      const user2 = 'user-buyer-002';

      const res1 = lockMgr.acquireLock(slotId, user1, 300);
      assert(res1.acquired, 'Customer 1 must successfully acquire the lock');
      assert(typeof res1.token === 'string', 'Lock token must be issued');

      // Concurrent customer attempt
      const res2 = lockMgr.acquireLock(slotId, user2, 300);
      assert(!res2.acquired, 'Customer 2 must be blocked while Customer 1 holds the 5-min lock');

      results.push({
        suite: 'Booking & Slot Locking',
        name: 'Unit: Redis NX Atomic Slot Reservation & Double-Booking Prevention',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Booking & Slot Locking',
        name: 'Unit: Redis NX Atomic Slot Reservation & Double-Booking Prevention',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 2: Lock Release Upon Payment Completion
  {
    const start = Date.now();
    try {
      const lockMgr = new InMemoryAtomicLockManager();
      const slotId = 'slot-salon-02';
      const user1 = 'user-buyer-001';
      const user2 = 'user-buyer-002';

      const lock = lockMgr.acquireLock(slotId, user1, 300);
      assert(lockMgr.isSlotLocked(slotId), 'Slot must be reported as locked');

      // Attempt release with invalid token
      const badRelease = lockMgr.releaseLock(slotId, 'bogus-token');
      assert(!badRelease, 'Release with invalid token must fail');

      // Release with correct token
      const validRelease = lockMgr.releaseLock(slotId, lock.token!);
      assert(validRelease, 'Release with legitimate token must succeed');
      assert(!lockMgr.isSlotLocked(slotId), 'Slot must now be unlocked');

      // Customer 2 can now acquire the unlocked slot
      const nextAcquisition = lockMgr.acquireLock(slotId, user2, 300);
      assert(nextAcquisition.acquired, 'Subsequent customer must successfully acquire released slot');

      results.push({
        suite: 'Booking & Slot Locking',
        name: 'Unit: Tokenized Lock Release Contract on Payment Confirmation',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Booking & Slot Locking',
        name: 'Unit: Tokenized Lock Release Contract on Payment Confirmation',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 3: 5-Minute TTL Expiration & Auto-Reclaim
  {
    const start = Date.now();
    try {
      const lockMgr = new InMemoryAtomicLockManager();
      const slotId = 'slot-salon-03';
      const user1 = 'user-abandoned-checkout';
      const user2 = 'user-patient-buyer';

      // Lock with 0.1s TTL (100 milliseconds) for unit test
      lockMgr.acquireLock(slotId, user1, 0.05);

      // Verify immediate lock holds
      assert(lockMgr.isSlotLocked(slotId), 'Lock must be active immediately after acquisition');

      // Sleep 60ms to let TTL expire
      await new Promise((r) => setTimeout(r, 65));

      // Slot should now be auto-reclaimed
      assert(!lockMgr.isSlotLocked(slotId), 'Lock must expire automatically after TTL without manual deletion');

      const reacquired = lockMgr.acquireLock(slotId, user2, 300);
      assert(reacquired.acquired, 'New user must seamlessly claim an expired lock');

      results.push({
        suite: 'Booking & Slot Locking',
        name: 'Unit: 5-Minute TTL Automated Eviction (Abandoned Cart Recovery)',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Booking & Slot Locking',
        name: 'Unit: 5-Minute TTL Automated Eviction (Abandoned Cart Recovery)',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  // Test 4: Dynamic UPI Payment Intent URL Validation (NPCI Spec)
  {
    const start = Date.now();
    try {
      const upiUrl = generateDynamicUpiString({
        merchantVpa: 'aurasalon.kothrud@okaxis',
        merchantName: 'Aura Unisex Salon',
        amount: 250.0,
        transactionRef: 'SV_TXN_98234710',
        note: 'HaircutSlot_slot-01'
      });

      assert(upiUrl.startsWith('upi://pay?'), 'Must be a valid NPCI UPI intent schema');
      assert(upiUrl.includes('pa=aurasalon.kothrud%40okaxis'), 'Must contain encoded merchant VPA');
      assert(upiUrl.includes('am=250.00'), 'Must contain exact 2-decimal amount');
      assert(upiUrl.includes('cu=INR'), 'Currency must be INR');
      assert(upiUrl.includes('tr=SV_TXN_98234710'), 'Transaction ref must be preserved');

      results.push({
        suite: 'Booking & Slot Locking',
        name: 'Unit: Dynamic NPCI-Compliant UPI QR Intent Generation',
        passed: true,
        durationMs: Date.now() - start
      });
    } catch (e: any) {
      results.push({
        suite: 'Booking & Slot Locking',
        name: 'Unit: Dynamic NPCI-Compliant UPI QR Intent Generation',
        passed: false,
        durationMs: Date.now() - start,
        error: e.message
      });
    }
  }

  return results;
}
