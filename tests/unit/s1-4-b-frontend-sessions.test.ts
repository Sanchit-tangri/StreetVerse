import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  buildBuyerAuthHeaders,
  BUYER_TOKEN_STORAGE_KEY,
  clearBuyerSession,
  hydrateBuyerSession,
  LEGACY_BUYER_USER_STORAGE_KEY,
  readBuyerAccessToken,
  saveBuyerAccessToken,
  SessionStorageLike
} from '../../apps/buyer-web/src/utils/buyerSession';
import {
  AuthorizedSellerStore,
  buildSellerAuthHeaders,
  canManageStoreKyc,
  hasSellerPermission,
  hydrateSellerSession,
  LEGACY_SELLER_MERCHANT_STORAGE_KEY,
  SELLER_SELECTED_STORE_STORAGE_KEY,
  SELLER_TOKEN_STORAGE_KEY,
  submitProtectedSellerKyc,
  switchSelectedSellerStore
} from '../../apps/seller-web/src/utils/sellerSession';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

class MemoryStorage implements SessionStorageLike {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  } as Response;
}

const VALID_SAMPLE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.sig_valid_example';

export async function runS14BFrontendSessionTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err: any) {
      results.push({ name, passed: false, error: err?.message || String(err) });
    }
  }

  // =========================================================================
  // 1. BUYER: Unsigned demo token and tampered local user JSON rejected
  // =========================================================================
  await runCase('Buyer session rejects unsigned demo tokens and tampered localStorage user profile', async () => {
    const storage = new MemoryStorage();
    storage.setItem(BUYER_TOKEN_STORAGE_KEY, 'streetverse-jwt-demo-rahul-deshmukh-pune');
    storage.setItem(
      LEGACY_BUYER_USER_STORAGE_KEY,
      JSON.stringify({ id: 'c1000000-0000-0000-0000-000000000001', fullName: 'Forged User' })
    );

    let fetchCalled = 0;
    const mockFetch = (async () => {
      fetchCalled++;
      return makeJsonResponse(200, {});
    }) as typeof fetch;

    assert.strictEqual(readBuyerAccessToken(storage), null);
    assert.strictEqual(storage.getItem(BUYER_TOKEN_STORAGE_KEY), null);
    assert.strictEqual(storage.getItem(LEGACY_BUYER_USER_STORAGE_KEY), null);

    // Tampered local user cache alone must never grant auth
    storage.setItem(
      LEGACY_BUYER_USER_STORAGE_KEY,
      JSON.stringify({ id: 'forged-buyer', email: 'attacker@example.com' })
    );
    const hydration = await hydrateBuyerSession({
      apiUrl: 'https://api.example.test',
      storage,
      fetchImpl: mockFetch
    });

    assert.strictEqual(fetchCalled, 0, 'Demo/missing token must not invoke /auth/me');
    assert.strictEqual(hydration.status, 'unauthenticated');
    assert.strictEqual(hydration.user, null);
    assert.strictEqual(hydration.token, null);
    assert.strictEqual(storage.getItem(LEGACY_BUYER_USER_STORAGE_KEY), null);
  });

  // =========================================================================
  // 2. BUYER: Valid session hydrates from /api/v1/auth/me without caching profile JSON
  // =========================================================================
  await runCase('Buyer session hydrates authoritative profile from /api/v1/auth/me and stores only token', async () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_BUYER_USER_STORAGE_KEY, JSON.stringify({ id: 'stale', fullName: 'Stale' }));

    let seenUrl = '';
    let seenAuthHeader: string | undefined;
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuthHeader = (init?.headers as Record<string, string>)?.Authorization;
      return makeJsonResponse(200, {
        authenticated: true,
        role: 'BUYER',
        audience: 'streetverse-buyer',
        user: {
          id: 'b2222222-2222-4222-8222-222222222222',
          fullName: 'Asha Deshmukh',
          phone: '+919822001122',
          email: 'asha@example.com',
          address: 'Kothrud, Pune',
          preferredLanguage: 'en',
          isEmailVerified: true
        }
      });
    }) as typeof fetch;

    assert.strictEqual(saveBuyerAccessToken(VALID_SAMPLE_JWT, storage), true);
    const hydration = await hydrateBuyerSession({
      apiUrl: 'https://gateway.example.test/',
      storage,
      fetchImpl: mockFetch
    });

    assert.strictEqual(seenUrl, 'https://gateway.example.test/api/v1/auth/me');
    assert.strictEqual(seenAuthHeader, `Bearer ${VALID_SAMPLE_JWT}`);
    assert.strictEqual(hydration.status, 'authenticated');
    assert.strictEqual(hydration.user?.id, 'b2222222-2222-4222-8222-222222222222');
    assert.strictEqual(hydration.user?.fullName, 'Asha Deshmukh');
    assert.strictEqual(storage.getItem(BUYER_TOKEN_STORAGE_KEY), VALID_SAMPLE_JWT);
    assert.strictEqual(storage.getItem(LEGACY_BUYER_USER_STORAGE_KEY), null);
  });

  // =========================================================================
  // 3. BUYER: 401/403 clears session; 503/network preserves valid token cleanly
  // =========================================================================
  await runCase('Buyer hydration clears token on 401/403 and preserves valid token on 503 or network error', async () => {
    const storage = new MemoryStorage();
    saveBuyerAccessToken(VALID_SAMPLE_JWT, storage);

    // 503 preserves token for retry
    const res503 = await hydrateBuyerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: (async () =>
        makeJsonResponse(503, { code: 'AUTH_SERVICE_UNAVAILABLE', error: 'DB unavailable' })) as typeof fetch
    });
    assert.strictEqual(res503.status, 'service_unavailable');
    assert.strictEqual(res503.user, null);
    assert.strictEqual(storage.getItem(BUYER_TOKEN_STORAGE_KEY), VALID_SAMPLE_JWT);

    // Network error also preserves token
    const resNet = await hydrateBuyerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch
    });
    assert.strictEqual(resNet.status, 'service_unavailable');
    assert.strictEqual(resNet.user, null);
    assert.strictEqual(storage.getItem(BUYER_TOKEN_STORAGE_KEY), VALID_SAMPLE_JWT);

    // 403 wrong role (Seller token used on Buyer portal) clears token immediately
    const res403 = await hydrateBuyerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: (async () =>
        makeJsonResponse(403, { code: 'ROLE_FORBIDDEN', error: 'Buyer role required' })) as typeof fetch
    });
    assert.strictEqual(res403.status, 'forbidden');
    assert.strictEqual(res403.user, null);
    assert.strictEqual(storage.getItem(BUYER_TOKEN_STORAGE_KEY), null);

    // 401 expired clears token
    saveBuyerAccessToken(VALID_SAMPLE_JWT, storage);
    const res401 = await hydrateBuyerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: (async () =>
        makeJsonResponse(401, { code: 'TOKEN_EXPIRED', error: 'Session expired' })) as typeof fetch
    });
    assert.strictEqual(res401.status, 'unauthenticated');
    assert.strictEqual(storage.getItem(BUYER_TOKEN_STORAGE_KEY), null);

    clearBuyerSession(storage);
    assert.strictEqual(buildBuyerAuthHeaders(null).Authorization, undefined);
  });

  // =========================================================================
  // 4. SELLER: Legacy localStorage merchant blob rejected; 401 legacy token cleared
  // =========================================================================
  await runCase('Seller session ignores streetverse_seller_merchant JSON and clears legacy rejected tokens', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LEGACY_SELLER_MERCHANT_STORAGE_KEY,
      JSON.stringify({ id: 'm1', businessName: 'Spoofed Store', isVerified: true })
    );

    const noTokenResult = await hydrateSellerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: (async () => makeJsonResponse(200, {})) as typeof fetch
    });
    assert.strictEqual(noTokenResult.status, 'unauthenticated');
    assert.strictEqual(noTokenResult.activeStore, null);
    assert.strictEqual(storage.getItem(LEGACY_SELLER_MERCHANT_STORAGE_KEY), null);

    // Legacy Merchant-ID Seller JWT rejected by backend /auth/me with 401
    storage.setItem(SELLER_TOKEN_STORAGE_KEY, VALID_SAMPLE_JWT);
    storage.setItem(SELLER_SELECTED_STORE_STORAGE_KEY, 'm1');
    const legacy401 = await hydrateSellerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: (async () =>
        makeJsonResponse(401, { code: 'LEGACY_TOKEN_UNSUPPORTED', error: 'Please sign in again' })) as typeof fetch
    });
    assert.strictEqual(legacy401.status, 'unauthenticated');
    assert.strictEqual(legacy401.activeStore, null);
    assert.strictEqual(storage.getItem(SELLER_TOKEN_STORAGE_KEY), null);
    assert.strictEqual(storage.getItem(SELLER_SELECTED_STORE_STORAGE_KEY), null);
  });

  // =========================================================================
  // 5. SELLER: Dual hydration, store switching, forged store rejection, RBAC matrix
  // =========================================================================
  await runCase('Seller dual hydration validates store selection, strips client flags, and switches OWNER vs STAFF permissions', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SELLER_TOKEN_STORAGE_KEY, VALID_SAMPLE_JWT);
    storage.setItem(SELLER_SELECTED_STORE_STORAGE_KEY, 'forged-store-id-999');
    storage.setItem(
      LEGACY_SELLER_MERCHANT_STORAGE_KEY,
      JSON.stringify({ id: 'm1', kycApproval: { status: 'APPROVED' } })
    );

    const calledUrls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calledUrls.push(url);
      assert.strictEqual(
        (init?.headers as Record<string, string>)?.Authorization,
        `Bearer ${VALID_SAMPLE_JWT}`
      );
      if (url.endsWith('/api/v1/auth/me')) {
        return makeJsonResponse(200, {
          authenticated: true,
          role: 'SELLER',
          principalType: 'SELLER_ACCOUNT',
          sellerAccount: {
            id: 'sa-11111111-1111-4111-8111-111111111111',
            phone: '+919876500001',
            email: 'owner@streetverse.test',
            isEmailVerified: true,
            status: 'ACTIVE'
          }
        });
      }
      if (url.endsWith('/api/v1/seller/stores')) {
        return makeJsonResponse(200, {
          success: true,
          sellerAccountId: 'sa-11111111-1111-4111-8111-111111111111',
          stores: [
            {
              id: 'store-owner-1',
              businessName: 'Owner Flagship Store',
              category: 'GROCERY',
              upiVpa: 'owner@okaxis',
              address: 'FC Road, Pune',
              pincode: '411004',
              isOpen: true,
              membershipId: 'mem-1',
              role: 'OWNER',
              membershipStatus: 'ACTIVE',
              permissions: [
                'STORE_SETTINGS_WRITE',
                'STAFF_MANAGE',
                'KYC_MANAGE',
                'INVENTORY_READ',
                'INVENTORY_WRITE',
                'PRICE_WRITE',
                'ORDER_MANAGE',
                'SLOT_MANAGE',
                'FINANCIAL_REPORTS_READ'
              ],
              // Untrusted fields must be stripped during normalization
              isVerified: true,
              kycApproval: { status: 'APPROVED' }
            },
            {
              id: 'store-staff-2',
              businessName: 'Partner Branch Store',
              category: 'SALON',
              upiVpa: 'branch@okaxis',
              address: 'Baner, Pune',
              pincode: '411045',
              isOpen: false,
              membershipId: 'mem-2',
              role: 'STAFF',
              membershipStatus: 'ACTIVE',
              permissions: [
                'INVENTORY_READ',
                'INVENTORY_WRITE',
                'PRICE_WRITE',
                'ORDER_MANAGE',
                'SLOT_MANAGE'
              ]
            }
          ]
        });
      }
      return makeJsonResponse(404, {});
    }) as typeof fetch;

    const hydration = await hydrateSellerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: mockFetch
    });

    assert.deepStrictEqual(calledUrls, [
      'https://gateway.example.test/api/v1/auth/me',
      'https://gateway.example.test/api/v1/seller/stores'
    ]);
    assert.strictEqual(hydration.status, 'authenticated');
    assert.strictEqual(hydration.stores.length, 2);
    // Forged stored ID fell back safely to stores[0]
    assert.strictEqual(hydration.activeStore?.id, 'store-owner-1');
    assert.strictEqual(hydration.activeStore?.role, 'OWNER');
    assert.strictEqual('isVerified' in (hydration.activeStore as any), false);
    assert.strictEqual('kycApproval' in (hydration.activeStore as any), false);
    assert.strictEqual(storage.getItem(LEGACY_SELLER_MERCHANT_STORAGE_KEY), null);
    assert.strictEqual(storage.getItem(SELLER_SELECTED_STORE_STORAGE_KEY), 'store-owner-1');
    assert.strictEqual(canManageStoreKyc(hydration.activeStore), true);
    assert.strictEqual(hasSellerPermission(hydration.activeStore, 'STAFF_MANAGE'), true);

    // Attempt switching to unauthorized/forged store -> ignored
    assert.strictEqual(switchSelectedSellerStore(hydration.stores, 'store-forged', storage), null);
    assert.strictEqual(storage.getItem(SELLER_SELECTED_STORE_STORAGE_KEY), 'store-owner-1');

    // Switch to authorized STAFF store -> updates preference & restricts KYC_MANAGE
    const staffStore = switchSelectedSellerStore(hydration.stores, 'store-staff-2', storage);
    assert.strictEqual(staffStore?.id, 'store-staff-2');
    assert.strictEqual(staffStore?.role, 'STAFF');
    assert.strictEqual(storage.getItem(SELLER_SELECTED_STORE_STORAGE_KEY), 'store-staff-2');
    assert.strictEqual(canManageStoreKyc(staffStore), false);
    assert.strictEqual(hasSellerPermission(staffStore, 'INVENTORY_WRITE'), true);

    // Reload picks remembered authorized store 'store-staff-2'
    const reloaded = await hydrateSellerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: mockFetch
    });
    assert.strictEqual(reloaded.status, 'authenticated');
    assert.strictEqual(reloaded.activeStore?.id, 'store-staff-2');
    assert.strictEqual(canManageStoreKyc(reloaded.activeStore), false);
  });

  // =========================================================================
  // 6. SELLER: Zero authorized stores & 503/network outage resilience
  // =========================================================================
  await runCase('Seller returns no_stores without m1 fallback and preserves token on 503 outage', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SELLER_TOKEN_STORAGE_KEY, VALID_SAMPLE_JWT);
    storage.setItem(SELLER_SELECTED_STORE_STORAGE_KEY, 'm1');

    const emptyStoresResult = await hydrateSellerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/v1/auth/me')) {
          return makeJsonResponse(200, {
            authenticated: true,
            role: 'SELLER',
            principalType: 'SELLER_ACCOUNT',
            sellerAccount: {
              id: 'sa-empty',
              phone: '+919800000000',
              email: 'empty@streetverse.test',
              isEmailVerified: true,
              status: 'ACTIVE'
            }
          });
        }
        return makeJsonResponse(200, { success: true, stores: [] });
      }) as typeof fetch
    });

    assert.strictEqual(emptyStoresResult.status, 'no_stores');
    assert.strictEqual(emptyStoresResult.activeStore, null);
    assert.strictEqual(emptyStoresResult.stores.length, 0);
    assert.strictEqual(storage.getItem(SELLER_SELECTED_STORE_STORAGE_KEY), null);
    assert.strictEqual(storage.getItem(SELLER_TOKEN_STORAGE_KEY), VALID_SAMPLE_JWT);

    // Outage on /seller/stores must preserve valid token
    const outageStores = await hydrateSellerSession({
      apiUrl: 'https://gateway.example.test',
      storage,
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/v1/auth/me')) {
          return makeJsonResponse(200, {
            authenticated: true,
            role: 'SELLER',
            principalType: 'SELLER_ACCOUNT',
            sellerAccount: {
              id: 'sa-empty',
              phone: '+919800000000',
              email: 'empty@streetverse.test',
              isEmailVerified: true,
              status: 'ACTIVE'
            }
          });
        }
        return makeJsonResponse(503, { code: 'DB_UNAVAILABLE', error: 'Merchant DB unavailable' });
      }) as typeof fetch
    });
    assert.strictEqual(outageStores.status, 'service_unavailable');
    assert.strictEqual(outageStores.activeStore, null);
    assert.strictEqual(storage.getItem(SELLER_TOKEN_STORAGE_KEY), VALID_SAMPLE_JWT);
  });

  // =========================================================================
  // 7. SELLER KYC: Bearer JWT + selected merchantId, STAFF block, 503/401/403
  // =========================================================================
  await runCase('Protected Seller KYC enforces OWNER/KYC_MANAGE, sends Bearer JWT + merchantId, and handles 503/401/403', async () => {
    const ownerStore: AuthorizedSellerStore = {
      id: 'store-owner-99',
      businessName: 'Owner Store',
      category: 'GROCERY',
      upiVpa: 'owner@okaxis',
      address: 'Pune',
      pincode: '411004',
      isOpen: true,
      membershipId: 'mem-owner',
      role: 'OWNER',
      membershipStatus: 'ACTIVE',
      permissions: ['KYC_MANAGE', 'INVENTORY_READ']
    };
    const staffStore: AuthorizedSellerStore = {
      ...ownerStore,
      membershipId: 'mem-staff',
      role: 'STAFF',
      permissions: ['INVENTORY_READ', 'ORDER_MANAGE']
    };

    // STAFF blocked cleanly before issuing upload call
    let kycFetchCalls = 0;
    const staffBlock = await submitProtectedSellerKyc({
      apiUrl: 'https://gateway.example.test',
      token: VALID_SAMPLE_JWT,
      activeStore: staffStore,
      documentType: 'FSSAI_LICENSE',
      documentNumber: '11521038000412',
      fetchImpl: (async () => {
        kycFetchCalls++;
        return makeJsonResponse(200, {});
      }) as typeof fetch
    });
    assert.strictEqual(kycFetchCalls, 0);
    assert.strictEqual(staffBlock.forbidden, true);
    assert.strictEqual(staffBlock.outcome.ok, false);

    // OWNER sends Authorization Bearer JWT + selected merchantId and preserves 503 unavailable semantics
    let capturedBody: any = null;
    let capturedAuth: string | undefined;
    const owner503 = await submitProtectedSellerKyc({
      apiUrl: 'https://gateway.example.test',
      token: VALID_SAMPLE_JWT,
      activeStore: ownerStore,
      documentType: 'GSTIN_CERTIFICATE',
      documentNumber: '27AABCU9603R1ZM',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
        capturedBody = JSON.parse(String(init?.body || '{}'));
        return makeJsonResponse(503, {
          success: false,
          code: 'KYC_SUBMISSION_UNAVAILABLE',
          error: 'KYC document submission is temporarily unavailable until document persistence is provisioned.'
        });
      }) as typeof fetch
    });
    assert.strictEqual(capturedAuth, `Bearer ${VALID_SAMPLE_JWT}`);
    assert.deepStrictEqual(capturedBody, {
      merchantId: 'store-owner-99',
      documentType: 'GSTIN_CERTIFICATE',
      documentNumber: '27AABCU9603R1ZM'
    });
    assert.strictEqual(owner503.httpStatus, 503);
    assert.strictEqual(owner503.outcome.ok, false);
    assert.strictEqual(owner503.outcome.submission, null);

    // 401 signals authExpired
    const owner401 = await submitProtectedSellerKyc({
      apiUrl: 'https://gateway.example.test',
      token: VALID_SAMPLE_JWT,
      activeStore: ownerStore,
      documentType: 'FSSAI_LICENSE',
      documentNumber: '11521038000412',
      fetchImpl: (async () => makeJsonResponse(401, { error: 'Token expired' })) as typeof fetch
    });
    assert.strictEqual(owner401.authExpired, true);
    assert.strictEqual(owner401.outcome.ok, false);

    // 403 from server preserves forbidden without marking authExpired
    const owner403 = await submitProtectedSellerKyc({
      apiUrl: 'https://gateway.example.test',
      token: VALID_SAMPLE_JWT,
      activeStore: ownerStore,
      documentType: 'FSSAI_LICENSE',
      documentNumber: '11521038000412',
      fetchImpl: (async () => makeJsonResponse(403, { error: 'Missing KYC_MANAGE' })) as typeof fetch
    });
    assert.strictEqual(owner403.forbidden, true);
    assert.strictEqual(owner403.authExpired, false);
    assert.strictEqual(buildSellerAuthHeaders(VALID_SAMPLE_JWT).Authorization, `Bearer ${VALID_SAMPLE_JWT}`);
  });

  // =========================================================================
  // 8. STATIC SOURCE AUDIT: Zero quick-demo bypass, zero 'm1' / user JSON trust
  // =========================================================================
  await runCase('Buyer & Seller frontends contain no demo-token bypasses, m1 fallback, or local profile trust', async () => {
    const repoRoot = process.cwd();
    const buyerAuthSrc = fs.readFileSync(
      path.join(repoRoot, 'apps/buyer-web/src/components/auth/BuyerAuth.tsx'),
      'utf8'
    );
    const buyerPageSrc = fs.readFileSync(
      path.join(repoRoot, 'apps/buyer-web/src/pages/index.tsx'),
      'utf8'
    );
    const profileModalSrc = fs.readFileSync(
      path.join(repoRoot, 'apps/buyer-web/src/components/dashboard/ProfileSettingsModal.tsx'),
      'utf8'
    );
    const sellerAuthSrc = fs.readFileSync(
      path.join(repoRoot, 'apps/seller-web/src/components/auth/SellerAuth.tsx'),
      'utf8'
    );
    const sellerPageSrc = fs.readFileSync(
      path.join(repoRoot, 'apps/seller-web/src/pages/index.tsx'),
      'utf8'
    );

    assert(!buyerAuthSrc.includes('handleQuickDemoLogin'), 'BuyerAuth must remove handleQuickDemoLogin');
    assert(!buyerAuthSrc.includes('streetverse-jwt-demo-'), 'BuyerAuth must remove fake demo token');
    assert(!buyerAuthSrc.includes('streetverse_buyer_user'), 'BuyerAuth must not store buyer profile JSON');
    assert(buyerAuthSrc.includes('hydrateBuyerSession'), 'BuyerAuth must hydrate session after OTP verify');

    assert(!buyerPageSrc.includes('c1000000-0000-0000-0000-000000000001'), 'Buyer page must not fall back to hardcoded userId');
    assert(!buyerPageSrc.includes('streetverse_buyer_user'), 'Buyer page must not read or write streetverse_buyer_user');
    assert(buyerPageSrc.includes('hydrateBuyerSession'), 'Buyer page must hydrate session from backend /me');
    assert(buyerPageSrc.includes('buildBuyerAuthHeaders'), 'Buyer page must send Bearer auth headers');

    assert(!profileModalSrc.includes('localStorage.getItem'), 'ProfileSettingsModal must use centralized buyerSession');
    assert(profileModalSrc.includes('buildBuyerAuthHeaders'), 'ProfileSettingsModal must attach Bearer token via buyerSession');

    assert(!sellerAuthSrc.includes('streetverse_seller_merchant'), 'SellerAuth must not store streetverse_seller_merchant');
    assert(sellerAuthSrc.includes('hydrateSellerSession'), 'SellerAuth must hydrate session + stores after OTP verify');

    assert(!sellerPageSrc.includes("id: 'm1'"), 'Seller page must remove unauthenticated m1 fallback');
    assert(!sellerPageSrc.includes('streetverse.merchant@okhdfcbank'), 'Seller page must remove hardcoded dummy VPA fallback');
    assert(!sellerPageSrc.includes('streetverse_seller_merchant'), 'Seller page must not read streetverse_seller_merchant');
    assert(sellerPageSrc.includes('hydrateSellerSession'), 'Seller page must hydrate Seller Account & stores');
    assert(sellerPageSrc.includes('switchSelectedSellerStore'), 'Seller page must support store switching');
    assert(sellerPageSrc.includes('canManageStoreKyc'), 'Seller page must gate Owner-only KYC controls');
    assert(
      sellerPageSrc.includes('submitProtectedSellerKyc') ||
        sellerPageSrc.includes('SellerOnboardingWorkspace'),
      'Seller page must submit KYC/onboarding via authenticated Owner workspace'
    );
  });

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runS14BFrontendSessionTests()
    .then((results) => {
      let failed = 0;
      for (const r of results) {
        if (r.passed) {
          console.log(`  PASS: ${r.name}`);
        } else {
          failed++;
          console.error(`  FAIL: ${r.name} -> ${r.error}`);
        }
      }
      console.log(
        `\nS1.4-B Frontend Sessions Summary: ${results.length - failed} passed, ${failed} failed`
      );
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal S1.4-B test error:', err);
      process.exit(1);
    });
}
