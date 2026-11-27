import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  AdminAccountPublic,
  ADMIN_TOKEN_STORAGE_KEY,
  approveAdminSubmission,
  clearAdminSession,
  escalateAdminWarning,
  fetchAdminDocumentBlob,
  fetchAdminOutboxEvents,
  fetchAdminOutboxSummary,
  hasAdminPermission,
  hydrateAdminSession,
  issueAdminComplianceWarning,
  loginAdminAccount,
  reactivateAdminStore,
  readAdminAccessToken,
  rejectAdminSubmission,
  replayAdminOutboxEvent,
  requestAdminSubmissionInfo,
  resolveAdminWarning,
  saveAdminAccessToken,
  suspendAdminStore
} from '../../apps/seller-web/src/utils/adminSession';
import {
  deleteSellerDraftDocument,
  fetchAccountOwnerNotifications,
  fetchSellerDocumentBlob,
  fetchSellerOnboardingOverview,
  fetchSellerStoreCompliance,
  markAllStoreNotificationsRead,
  respondToSellerSuspension,
  respondToSellerWarning,
  saveSellerOnboardingDraft,
  submitSellerOnboardingApplication,
  uploadSellerOnboardingDocumentWithProgress
} from '../../apps/seller-web/src/utils/sellerOnboarding';
import {
  AuthorizedSellerStore,
  SELLER_SELECTED_STORE_STORAGE_KEY,
  SELLER_TOKEN_STORAGE_KEY,
  SessionStorageLike
} from '../../apps/seller-web/src/utils/sellerSession';
import { resolveNotificationTargetTab } from '../../apps/seller-web/src/components/onboarding/OwnerNotificationsWorkspace';

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

function makeJsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  const map = new Map<string, string>(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => map.get(name.toLowerCase()) ?? null
    } as unknown as Headers,
    json: async () => body
  } as Response;
}

const VALID_SAMPLE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhY3Rvci0xMjMifQ.sig_valid_example';

const OWNER_STORE: AuthorizedSellerStore = {
  id: '11111111-1111-4111-8111-111111111111',
  businessName: 'Mayur Kirana Mart',
  category: 'GROCERY',
  upiVpa: 'mayur@okaxis',
  address: 'Shop 4, Mayur Colony',
  pincode: '411038',
  isOpen: false,
  membershipId: 'mem-owner-1',
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
  ]
};

const STAFF_STORE: AuthorizedSellerStore = {
  ...OWNER_STORE,
  membershipId: 'mem-staff-2',
  role: 'STAFF',
  permissions: ['INVENTORY_READ', 'ORDER_MANAGE']
};

const ACTIVE_ADMIN: AdminAccountPublic = {
  id: '99999999-9999-4999-8999-999999999999',
  email: 'reviewer@streetverse.local',
  fullName: 'StreetVerse Reviewer',
  role: 'ADMIN',
  permissions: [
    'KYC_QUEUE_READ',
    'KYC_SUBMISSION_READ',
    'KYC_REVIEW_DECIDE',
    'STORE_COMPLIANCE_MANAGE'
  ],
  principalType: 'ADMIN_ACCOUNT',
  status: 'ACTIVE',
  lastLoginAt: null,
  createdAt: '2026-11-26T00:00:00Z',
  updatedAt: '2026-11-26T00:00:00Z'
};

export async function runMoCFrontendTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err: any) {
      results.push({ name, passed: false, error: err?.message || String(err) });
    }
  }

  // 1. Seller onboarding & compliance client blocks unauthenticated and STAFF users before network call
  await runCase(
    'Seller MO-C client blocks unauthenticated callers and STAFF memberships before calling API',
    async () => {
      let fetchCalls = 0;
      const mockFetch = (async () => {
        fetchCalls++;
        return makeJsonResponse(200, {});
      }) as typeof fetch;

      const unauth = await fetchSellerOnboardingOverview({
        apiUrl: 'https://api.test',
        token: 'not-a-jwt',
        activeStore: OWNER_STORE,
        fetchImpl: mockFetch
      });
      assert.strictEqual(unauth.ok, false);
      assert.strictEqual(unauth.authExpired, true);

      const staffCalls = await Promise.all([
        fetchSellerOnboardingOverview({ apiUrl: 'https://api.test', token: VALID_SAMPLE_JWT, activeStore: STAFF_STORE, fetchImpl: mockFetch }),
        saveSellerOnboardingDraft({ apiUrl: 'https://api.test', token: VALID_SAMPLE_JWT, activeStore: STAFF_STORE, payload: { businessName: 'X' }, fetchImpl: mockFetch }),
        uploadSellerOnboardingDocumentWithProgress({
          apiUrl: 'https://api.test',
          token: VALID_SAMPLE_JWT,
          activeStore: STAFF_STORE,
          requirementKey: 'STOREFRONT_PHOTO',
          file: new Blob(['abc'], { type: 'image/png' }),
          fetchImpl: mockFetch
        }),
        deleteSellerDraftDocument({ apiUrl: 'https://api.test', token: VALID_SAMPLE_JWT, activeStore: STAFF_STORE, documentId: 'doc-1', fetchImpl: mockFetch }),
        submitSellerOnboardingApplication({ apiUrl: 'https://api.test', token: VALID_SAMPLE_JWT, activeStore: STAFF_STORE, fetchImpl: mockFetch }),
        fetchSellerStoreCompliance({ apiUrl: 'https://api.test', token: VALID_SAMPLE_JWT, activeStore: STAFF_STORE, fetchImpl: mockFetch }),
        respondToSellerWarning({ apiUrl: 'https://api.test', token: VALID_SAMPLE_JWT, activeStore: STAFF_STORE, warningId: 'w-1', responseMessage: 'Fixed', fetchImpl: mockFetch }),
        respondToSellerSuspension({ apiUrl: 'https://api.test', token: VALID_SAMPLE_JWT, activeStore: STAFF_STORE, responseMessage: 'Fixed', fetchImpl: mockFetch }),
        markAllStoreNotificationsRead({ apiUrl: 'https://api.test', token: VALID_SAMPLE_JWT, activeStore: STAFF_STORE, fetchImpl: mockFetch })
      ]);

      for (const r of staffCalls) {
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.forbidden, true);
        assert.strictEqual(r.status, 403);
      }
      assert.strictEqual(fetchCalls, 0, 'No network calls may be attempted when STAFF lacks KYC_MANAGE');
    }
  );

  // 2. Owner onboarding draft, multipart upload, authenticated blob read, submit & notifications
  await runCase(
    'Seller Owner onboarding client transmits Bearer JWT, multipart doc upload, blob read, and 401 expiry',
    async () => {
      const seenPaths: string[] = [];
      let seenAuth: string | undefined;
      let progressSeen = 0;

      const uploadRes = await uploadSellerOnboardingDocumentWithProgress({
        apiUrl: 'https://gateway.test',
        token: VALID_SAMPLE_JWT,
        activeStore: OWNER_STORE,
        requirementKey: 'STOREFRONT_PHOTO',
        file: new Blob(['fakeimg'], { type: 'image/jpeg' }),
        filename: 'front.jpg',
        onProgress: (pct) => {
          progressSeen = pct;
        },
        fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
          seenPaths.push(String(url));
          seenAuth = (init?.headers as Record<string, string>)?.Authorization;
          assert.strictEqual(init?.method, 'POST');
          assert(init?.body instanceof FormData, 'Document upload must use FormData');
          return makeJsonResponse(201, {
            success: true,
            document: {
              id: 'doc-99',
              submissionId: 'sub-1',
              requirementKey: 'STOREFRONT_PHOTO',
              documentType: 'STOREFRONT_PHOTO',
              originalFilenameSanitized: 'front.jpg',
              mimeType: 'image/jpeg',
              fileSizeBytes: 7,
              sha256Checksum: 'deadbeef',
              uploadedAt: '2026-11-27T00:00:00Z',
              isStorefrontPhoto: true,
              isPremisesProof: false
            }
          });
        }) as typeof fetch
      });
      assert.strictEqual(uploadRes.ok, true);
      assert.strictEqual(progressSeen, 100);
      assert.strictEqual(seenAuth, `Bearer ${VALID_SAMPLE_JWT}`);
      assert(seenPaths[0].endsWith(`/api/v1/seller/stores/${OWNER_STORE.id}/onboarding/documents`));

      // Document blob fetch attaches Authorization header & reads filename
      const docBlobRes = await fetchSellerDocumentBlob({
        apiUrl: 'https://gateway.test',
        token: VALID_SAMPLE_JWT,
        activeStore: OWNER_STORE,
        documentId: 'doc-99',
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          assert.strictEqual(
            (init?.headers as Record<string, string>)?.Authorization,
            `Bearer ${VALID_SAMPLE_JWT}`
          );
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              'content-type': 'image/jpeg',
              'content-disposition': 'attachment; filename="front.jpg"'
            }),
            blob: async () => new Blob(['abc'], { type: 'image/jpeg' })
          } as Response;
        }) as typeof fetch
      });
      assert.strictEqual(docBlobRes.ok, true);
      assert.strictEqual(docBlobRes.data?.filename, 'front.jpg');

      // 401 sets authExpired
      const expiredRes = await fetchAccountOwnerNotifications({
        apiUrl: 'https://gateway.test',
        token: VALID_SAMPLE_JWT,
        fetchImpl: (async () => makeJsonResponse(401, { error: 'Expired token' })) as typeof fetch
      });
      assert.strictEqual(expiredRes.ok, false);
      assert.strictEqual(expiredRes.authExpired, true);
    }
  );

  // 3. Admin session hydration & storage strictly isolated from Seller/Buyer tokens
  await runCase(
    'Admin session uses isolated storage key, validates /api/v1/admin/me, and rejects Seller/Buyer tokens',
    async () => {
      const storage = new MemoryStorage();
      storage.setItem(SELLER_TOKEN_STORAGE_KEY, VALID_SAMPLE_JWT);
      storage.setItem(SELLER_SELECTED_STORE_STORAGE_KEY, OWNER_STORE.id);

      // Admin reader ignores Seller token cleanly
      assert.strictEqual(readAdminAccessToken(storage), null);

      // Admin login saves ONLY ADMIN_TOKEN_STORAGE_KEY and propagates 429 retry-after
      const throttled = await loginAdminAccount({
        apiUrl: 'https://gateway.test',
        email: 'reviewer@streetverse.local',
        password: 'StrongPassword#2026',
        storage,
        fetchImpl: (async () =>
          makeJsonResponse(
            429,
            { error: 'Too many failed login attempts.' },
            { 'Retry-After': '45' }
          )) as typeof fetch
      });
      assert.strictEqual(throttled.ok, false);
      assert.strictEqual(throttled.status, 429);
      assert.strictEqual(throttled.retryAfterSeconds, 45);
      assert.strictEqual(readAdminAccessToken(storage), null);

      // Successful login
      const loggedIn = await loginAdminAccount({
        apiUrl: 'https://gateway.test',
        email: 'reviewer@streetverse.local',
        password: 'StrongPassword#2026',
        storage,
        fetchImpl: (async (url: RequestInfo | URL) => {
          assert(String(url).endsWith('/api/v1/admin/auth/login'));
          return makeJsonResponse(200, {
            success: true,
            token: VALID_SAMPLE_JWT,
            expiresIn: '8h',
            admin: ACTIVE_ADMIN
          });
        }) as typeof fetch
      });
      assert.strictEqual(loggedIn.ok, true);
      assert.strictEqual(readAdminAccessToken(storage), VALID_SAMPLE_JWT);

      // /me returning SELLER principalType must fail closed and clear ONLY admin storage key
      const wrongPrincipal = await hydrateAdminSession({
        apiUrl: 'https://gateway.test',
        storage,
        fetchImpl: (async () =>
          makeJsonResponse(200, {
            success: true,
            admin: { ...ACTIVE_ADMIN, principalType: 'SELLER_ACCOUNT', role: 'SELLER' }
          })) as typeof fetch
      });
      assert.strictEqual(wrongPrincipal.status, 'forbidden');
      assert.strictEqual(readAdminAccessToken(storage), null);
      assert.strictEqual(
        storage.getItem(SELLER_TOKEN_STORAGE_KEY),
        VALID_SAMPLE_JWT,
        'Admin session clear must never touch Seller session token'
      );

      // 503 preserves valid Admin token cleanly
      saveAdminAccessToken(VALID_SAMPLE_JWT, storage);
      const outage = await hydrateAdminSession({
        apiUrl: 'https://gateway.test',
        storage,
        fetchImpl: (async () => makeJsonResponse(503, { error: 'DB unavailable' })) as typeof fetch
      });
      assert.strictEqual(outage.status, 'service_unavailable');
      assert.strictEqual(readAdminAccessToken(storage), VALID_SAMPLE_JWT);

      clearAdminSession(storage);
      assert.strictEqual(storage.getItem(ADMIN_TOKEN_STORAGE_KEY), null);
      assert.strictEqual(storage.getItem(SELLER_TOKEN_STORAGE_KEY), VALID_SAMPLE_JWT);
    }
  );

  // 4. Admin permission helper + authenticated document stream + review/compliance/outbox client calls
  await runCase(
    'Admin review, compliance, outbox, and binary document stream clients send expected payloads & Bearer auth',
    async () => {
      assert.strictEqual(hasAdminPermission(ACTIVE_ADMIN, 'KYC_REVIEW_DECIDE'), true);
      assert.strictEqual(
        hasAdminPermission({ ...ACTIVE_ADMIN, status: 'DISABLED' }, 'KYC_REVIEW_DECIDE'),
        false
      );

      const seen: Array<{ url: string; method: string; body?: any }> = [];
      const mockJsonFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        assert.strictEqual(
          (init?.headers as Record<string, string>)?.Authorization,
          `Bearer ${VALID_SAMPLE_JWT}`
        );
        seen.push({
          url: String(url),
          method: String(init?.method || 'GET'),
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return makeJsonResponse(200, { success: true, counts: { delivered: 1 }, events: [] });
      }) as typeof fetch;

      await approveAdminSubmission({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        submissionId: 'sub-1',
        checklist: {
          sellerIdentityReviewed: true,
          businessNameAndCategoryConfirmed: true,
          fixedPhysicalShopConfirmed: true,
          gpsLocationChecked: true,
          storefrontPhotosInspected: true,
          premisesEvidenceChecked: true,
          categoryDocumentsChecked: true,
          informationConsistent: true,
          noUnresolvedDiscrepancy: true,
          confirmedRequirementKeys: ['STOREFRONT_PHOTO', 'PREMISES_PROOF']
        },
        fetchImpl: mockJsonFetch
      });

      await requestAdminSubmissionInfo({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        submissionId: 'sub-1',
        reason: 'Please re-upload clearer signboard photo.',
        requestedCorrections: ['STOREFRONT_LOCATION'],
        requestedRequirements: ['STOREFRONT_PHOTO'],
        fetchImpl: mockJsonFetch
      });

      await rejectAdminSubmission({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        submissionId: 'sub-1',
        rejectionCategory: 'LOCATION_MISMATCH',
        reason: 'GPS pin is 4km away from address.',
        fetchImpl: mockJsonFetch
      });

      await issueAdminComplianceWarning({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        storeId: OWNER_STORE.id,
        violationCategory: 'HYGIENE_STANDARD',
        severity: 'MODERATE',
        reason: 'Expired display cleanliness check.',
        requiredCorrectiveAction: 'Submit clean counter photos.',
        fetchImpl: mockJsonFetch
      });

      await escalateAdminWarning({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        storeId: OWNER_STORE.id,
        warningId: 'w-1',
        notes: 'No owner response by deadline.',
        fetchImpl: mockJsonFetch
      });

      await resolveAdminWarning({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        storeId: OWNER_STORE.id,
        warningId: 'w-1',
        reason: 'Verified owner cleanup evidence.',
        correctiveEvidenceChecked: true,
        fetchImpl: mockJsonFetch
      });

      await suspendAdminStore({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        storeId: OWNER_STORE.id,
        suspensionType: 'ORDINARY_VIOLATION',
        violationCategory: 'HYGIENE_STANDARD',
        reason: '2+ open formal warnings unaddressed.',
        fetchImpl: mockJsonFetch
      });

      await reactivateAdminStore({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        storeId: OWNER_STORE.id,
        reason: 'All corrective actions verified.',
        correctiveEvidenceReviewed: true,
        warningResolutions: [
          {
            warningId: 'w-1',
            reason: 'Resolved upon reactivation',
            correctiveEvidenceChecked: true
          }
        ],
        fetchImpl: mockJsonFetch
      });

      await fetchAdminOutboxSummary({ apiUrl: 'https://gw.test', token: VALID_SAMPLE_JWT, fetchImpl: mockJsonFetch });
      await fetchAdminOutboxEvents({ apiUrl: 'https://gw.test', token: VALID_SAMPLE_JWT, status: 'TERMINAL_FAILED', fetchImpl: mockJsonFetch });
      await replayAdminOutboxEvent({ apiUrl: 'https://gw.test', token: VALID_SAMPLE_JWT, eventId: 'ev-1', reason: 'Retry', fetchImpl: mockJsonFetch });

      assert.strictEqual(seen.length, 11);
      assert(seen[0].url.endsWith('/api/v1/admin/onboarding/submissions/sub-1/approve'));
      assert(seen[1].url.endsWith('/api/v1/admin/onboarding/submissions/sub-1/request-information'));
      assert(seen[2].url.endsWith('/api/v1/admin/onboarding/submissions/sub-1/reject'));
      assert(seen[10].url.endsWith('/api/v1/admin/notifications/outbox/ev-1/replay'));

      const adminDocRes = await fetchAdminDocumentBlob({
        apiUrl: 'https://gw.test',
        token: VALID_SAMPLE_JWT,
        submissionId: 'sub-1',
        documentId: 'doc-1',
        fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
          assert(String(url).endsWith('/api/v1/admin/onboarding/submissions/sub-1/documents/doc-1/content'));
          assert.strictEqual((init?.headers as Record<string, string>)?.Authorization, `Bearer ${VALID_SAMPLE_JWT}`);
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="fssai.pdf"' }),
            blob: async () => new Blob(['pdf'], { type: 'application/pdf' })
          } as Response;
        }) as typeof fetch
      });
      assert.strictEqual(adminDocRes.ok, true);
      assert.strictEqual(adminDocRes.data?.filename, 'fssai.pdf');
    }
  );

  // 5. Notification deep-link routing & static audit across all new MO-C files
  await runCase(
    'Notification deep links map events accurately and MO-C frontend files contain zero token mixing, demo data, or unauthenticated doc URLs',
    async () => {
      assert.strictEqual(resolveNotificationTargetTab('STORE_APPROVED'), 'ONBOARDING');
      assert.strictEqual(resolveNotificationTargetTab('MORE_INFO_REQUIRED'), 'ONBOARDING');
      assert.strictEqual(resolveNotificationTargetTab('LOCATION_REVERIFICATION_REQUIRED'), 'ONBOARDING');
      assert.strictEqual(resolveNotificationTargetTab('COMPLIANCE_WARNING_ISSUED'), 'COMPLIANCE');
      assert.strictEqual(resolveNotificationTargetTab('STORE_SUSPENDED'), 'COMPLIANCE');
      assert.strictEqual(resolveNotificationTargetTab('STORE_REACTIVATED'), 'COMPLIANCE');

      const repoRoot = process.cwd();
      const filesToAudit = [
        'apps/seller-web/src/utils/adminSession.ts',
        'apps/seller-web/src/utils/sellerOnboarding.ts',
        'apps/seller-web/src/utils/onboardingConstants.ts',
        'apps/seller-web/src/hooks/useAdminSession.ts',
        'apps/seller-web/src/components/auth/SellerAuth.tsx',
        'apps/seller-web/src/components/admin/AdminAuthCard.tsx',
        'apps/seller-web/src/components/admin/AdminComplianceTab.tsx',
        'apps/seller-web/src/components/admin/AdminOutboxTab.tsx',
        'apps/seller-web/src/components/admin/AdminPortalHeader.tsx',
        'apps/seller-web/src/components/onboarding/SellerOnboardingWorkspace.tsx',
        'apps/seller-web/src/components/onboarding/SellerComplianceWorkspace.tsx',
        'apps/seller-web/src/components/onboarding/OwnerNotificationsWorkspace.tsx',
        'apps/seller-web/src/components/onboarding/StoreLocationPicker.tsx',
        'apps/seller-web/src/components/onboarding/SecureDocumentPreviewModal.tsx',
        'apps/seller-web/src/pages/index.tsx',
        'apps/seller-web/src/pages/admin/index.tsx',
        'apps/seller-web/src/pages/admin/stores/[storeId].tsx'
      ];

      for (const rel of filesToAudit) {
        const rawSrc = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        const codeOnly = rawSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        assert(!codeOnly.includes('streetverse-jwt-demo-'), `${rel} must not contain fake demo tokens`);
        assert(!codeOnly.includes('Password123!'), `${rel} must not contain demo passwords`);
        assert(!codeOnly.includes('handleDemoFill'), `${rel} must not include demo credential auto-fill`);
        assert(!codeOnly.includes("id: 'm1'"), `${rel} must not contain hardcoded fallback store ID m1`);
        assert(!codeOnly.includes('storage_key'), `${rel} must not expose private storage_key fields`);
        assert(!codeOnly.includes('DEFAULT_INVENTORY'), `${rel} must not contain static demo inventory data`);
        assert(!codeOnly.includes('ORD-9912'), `${rel} must not contain static demo order data`);
      }

      const adminFiles = [
        'apps/seller-web/src/utils/adminSession.ts',
        'apps/seller-web/src/hooks/useAdminSession.ts',
        'apps/seller-web/src/pages/admin/index.tsx',
        'apps/seller-web/src/pages/admin/stores/[storeId].tsx'
      ];
      for (const rel of adminFiles) {
        const rawSrc = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        const codeOnly = rawSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        assert(!codeOnly.includes('streetverse_seller_token'), `${rel} must stay isolated from seller token`);
        assert(!codeOnly.includes('streetverse_buyer_token'), `${rel} must stay isolated from buyer token`);
      }
    }
  );

  return results;
}

if (typeof require !== 'undefined' && require.main === module) {
  runMoCFrontendTests()
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
      console.log(`\nMO-C Frontend Operations Summary: ${results.length - failed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal MO-C test error:', err);
      process.exit(1);
    });
}
