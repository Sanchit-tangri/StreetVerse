import React, { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { SellerAuth } from '../components/auth/SellerAuth';
import { SellerOnboardingWorkspace } from '../components/onboarding/SellerOnboardingWorkspace';
import { SellerComplianceWorkspace } from '../components/onboarding/SellerComplianceWorkspace';
import { OwnerNotificationsWorkspace } from '../components/onboarding/OwnerNotificationsWorkspace';
import {
  resolveSellerKycDisplayStatus,
  SellerKycSubmission
} from '../utils/kycUpload';
import {
  AuthorizedSellerStore,
  canManageStoreKyc,
  clearSellerSession,
  hydrateSellerSession,
  resolveSellerApiUrl,
  SellerAccountProfile,
  switchSelectedSellerStore
} from '../utils/sellerSession';
import {
  fetchAccountUnreadSummary,
  fetchSellerOnboardingOverview,
  fetchSellerOnboardingSubmissions
} from '../utils/sellerOnboarding';
import {
  formatCategoryLabel,
  getOnboardingStatusMeta
} from '../utils/onboardingConstants';

type SellerPortalTab = 'ONBOARDING' | 'COMPLIANCE' | 'NOTIFICATIONS';

export default function SellerDashboard() {
  const router = useRouter();
  const [sellerAccount, setSellerAccount] = useState<SellerAccountProfile | null>(null);
  const [authorizedStores, setAuthorizedStores] = useState<AuthorizedSellerStore[]>([]);
  const [activeStore, setActiveStore] = useState<AuthorizedSellerStore | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<
    'unauthenticated' | 'authenticated' | 'no_stores' | 'service_unavailable'
  >('unauthenticated');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<SellerPortalTab>('ONBOARDING');

  // Theme & Canvas
  const [theme, setTheme] = useState<'light' | 'warm-beige' | 'sky-blue' | 'dark'>('light');

  // Live backend summary indicators for header & KPI cards (zero fabricated metrics)
  const [onboardingStatus, setOnboardingStatus] = useState<string | null>(null);
  const [submissionsCount, setSubmissionsCount] = useState<number>(0);
  const [serverConfirmedSubmissions, setServerConfirmedSubmissions] = useState<SellerKycSubmission[]>([]);
  const [unreadAlertsCount, setUnreadAlertsCount] = useState<number>(0);

  const API_URL = resolveSellerApiUrl();

  // Apply theme classes
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    body.classList.remove('theme-warm-beige', 'theme-sky-blue', 'dark');

    if (theme === 'dark') {
      root.classList.add('dark');
      body.classList.add('dark');
      body.style.backgroundColor = '#090D16';
    } else if (theme === 'warm-beige') {
      root.classList.remove('dark');
      body.classList.add('theme-warm-beige');
      body.style.backgroundColor = '#F7F4EA';
    } else if (theme === 'sky-blue') {
      root.classList.remove('dark');
      body.classList.add('theme-sky-blue');
      body.style.backgroundColor = '#EBF4FF';
    } else {
      root.classList.remove('dark');
      body.style.backgroundColor = '#faf8ff';
    }
  }, [theme]);

  // Honor deep link query params (`?tab=ONBOARDING|COMPLIANCE|NOTIFICATIONS&storeId=...`)
  useEffect(() => {
    if (!router.isReady) return;
    const rawTab = typeof router.query.tab === 'string' ? router.query.tab.toUpperCase() : '';
    if (rawTab === 'ONBOARDING' || rawTab === 'COMPLIANCE' || rawTab === 'NOTIFICATIONS') {
      setActiveTab(rawTab);
    }
    const rawStoreId = typeof router.query.storeId === 'string' ? router.query.storeId : '';
    if (rawStoreId && authorizedStores.length > 0 && activeStore?.id !== rawStoreId) {
      const switched = switchSelectedSellerStore(authorizedStores, rawStoreId);
      if (switched) {
        setActiveStore(switched);
      }
    }
  }, [router.isReady, router.query.tab, router.query.storeId, authorizedStores, activeStore?.id]);

  const refreshSellerSession = useCallback(async () => {
    const result = await hydrateSellerSession({ apiUrl: API_URL });

    if (result.status === 'authenticated' && result.sellerAccount && result.activeStore && result.token) {
      setSellerAccount(result.sellerAccount);
      setAuthorizedStores(result.stores);
      setActiveStore(result.activeStore);
      setAuthToken(result.token);
      setSessionStatus('authenticated');
      setSessionError(null);
    } else if (result.status === 'no_stores' && result.sellerAccount && result.token) {
      setSellerAccount(result.sellerAccount);
      setAuthorizedStores([]);
      setActiveStore(null);
      setAuthToken(result.token);
      setSessionStatus('no_stores');
      setSessionError(result.errorMessage);
    } else if (result.status === 'service_unavailable') {
      setSellerAccount(null);
      setAuthorizedStores([]);
      setActiveStore(null);
      setAuthToken(result.token);
      setSessionStatus('service_unavailable');
      setSessionError(
        result.errorMessage || 'Authentication service is temporarily unavailable. Please retry.'
      );
    } else {
      setSellerAccount(null);
      setAuthorizedStores([]);
      setActiveStore(null);
      setAuthToken(null);
      setSessionStatus('unauthenticated');
      setSessionError(result.errorMessage);
    }

    setAuthChecked(true);
  }, [API_URL]);

  useEffect(() => {
    void refreshSellerSession();
  }, [refreshSellerSession]);

  const handleLogout = useCallback((notice?: string) => {
    clearSellerSession();
    setSellerAccount(null);
    setAuthorizedStores([]);
    setActiveStore(null);
    setAuthToken(null);
    setOnboardingStatus(null);
    setSubmissionsCount(0);
    setServerConfirmedSubmissions([]);
    setUnreadAlertsCount(0);
    setSessionStatus('unauthenticated');
    setSessionError(typeof notice === 'string' && notice.trim().length > 0 ? notice : null);
  }, []);

  // Load initial unread notifications & store onboarding summary for header/KPI badges
  useEffect(() => {
    if (sessionStatus !== 'authenticated' || !authToken || !activeStore) return;
    let cancelled = false;

    void fetchAccountUnreadSummary({ apiUrl: API_URL, token: authToken }).then((res) => {
      if (!cancelled && res.ok && res.data) {
        setUnreadAlertsCount(res.data.unreadCount);
      }
    });

    if (canManageStoreKyc(activeStore)) {
      void Promise.all([
        fetchSellerOnboardingOverview({ apiUrl: API_URL, token: authToken, activeStore }),
        fetchSellerOnboardingSubmissions({ apiUrl: API_URL, token: authToken, activeStore })
      ]).then(([ovRes, subRes]) => {
        if (cancelled) return;
        if (ovRes.authExpired || subRes.authExpired) {
          handleLogout(ovRes.error || subRes.error || undefined);
          return;
        }
        if (ovRes.ok && ovRes.data) {
          setOnboardingStatus(ovRes.data.verificationStatus.status);
        }
        if (subRes.ok && subRes.data) {
          setSubmissionsCount(subRes.data.submissions.length);
          const mapped: SellerKycSubmission[] = subRes.data.submissions
            .filter((s) => s.status !== 'DRAFT')
            .map((s) => ({
              submissionId: s.id,
              merchantId: activeStore.id,
              documentType: s.categorySnapshot,
              documentNumber: `v${s.submissionVersion}`,
              status:
                s.status === 'UNDER_REVIEW' || s.status === 'MORE_INFO_REQUIRED'
                  ? s.status
                  : 'SUBMITTED',
              submittedAt: s.submittedAt || s.createdAt
            }));
          setServerConfirmedSubmissions(mapped);
        }
      });
    } else {
      setOnboardingStatus(null);
      setSubmissionsCount(0);
      setServerConfirmedSubmissions([]);
    }

    return () => {
      cancelled = true;
    };
  }, [API_URL, sessionStatus, authToken, activeStore, handleLogout]);

  const handleSelectStore = (nextStoreId: string) => {
    const switched = switchSelectedSellerStore(authorizedStores, nextStoreId);
    if (!switched) return;
    setActiveStore(switched);
    setOnboardingStatus(null);
    setSubmissionsCount(0);
    setServerConfirmedSubmissions([]);
  };

  const handleStatusSync = useCallback(
    (summary: { onboardingStatus: string; submissionsCount: number }) => {
      setOnboardingStatus(summary.onboardingStatus);
      setSubmissionsCount(summary.submissionsCount);
    },
    []
  );

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center font-body-md text-on-surface">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
          <span>Loading StreetVerse Merchant Portal...</span>
        </div>
      </div>
    );
  }

  if (sessionStatus === 'service_unavailable') {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6 font-body-md text-on-surface">
        <div className="max-w-md w-full bg-surface-container-lowest rounded-2xl border border-surface-container p-6 shadow-sm flex flex-col gap-4 text-center">
          <span className="material-symbols-outlined text-3xl text-error mx-auto">cloud_off</span>
          <h2 className="font-headline-sm text-headline-sm font-bold">
            Seller Session Check Unavailable
          </h2>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            {sessionError || 'Unable to verify your seller session right now. Your token has been preserved.'}
          </p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center mt-2">
            <button
              className="px-4 py-2 rounded-xl bg-primary text-on-primary font-label-md font-bold"
              onClick={() => {
                setAuthChecked(false);
                void refreshSellerSession();
              }}
              type="button"
            >
              Retry Connection
            </button>
            <button
              className="px-4 py-2 rounded-xl bg-surface-container text-on-surface font-label-md font-semibold"
              onClick={() => handleLogout()}
              type="button"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (sessionStatus === 'unauthenticated' || !sellerAccount || !authToken) {
    return (
      <div>
        <SellerAuth
          sessionNotice={sessionError}
          onAuthSuccess={(session) => {
            setSellerAccount(session.sellerAccount);
            setAuthorizedStores(session.stores);
            setActiveStore(session.activeStore);
            setAuthToken(session.token);
            setSessionStatus(session.status);
            setSessionError(null);
          }}
        />
        <div className="fixed bottom-4 right-4 z-40">
          <Link
            href="/admin"
            className="px-3.5 py-2 rounded-xl bg-surface-container-lowest/95 border border-surface-container shadow-md text-xs font-bold text-on-surface hover:border-primary flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined text-sm text-primary">admin_panel_settings</span>
            <span>Admin Operations Portal</span>
          </Link>
        </div>
      </div>
    );
  }

  if (sessionStatus === 'no_stores' || !activeStore) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6 font-body-md text-on-surface">
        <div className="max-w-lg w-full bg-surface-container-lowest rounded-2xl border border-surface-container p-6 shadow-sm flex flex-col gap-4">
          <div className="flex items-center gap-2 text-primary">
            <span className="material-symbols-outlined text-2xl">storefront</span>
            <h2 className="font-headline-sm text-headline-sm font-bold text-on-surface">
              No Authorized Stores Assigned
            </h2>
          </div>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Signed in as <strong>{sellerAccount.email}</strong>, but this seller account currently has no active store memberships. Contact your store owner or administrator to assign store access.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="px-4 py-2 rounded-xl bg-primary text-on-primary font-label-md font-bold"
              onClick={() => {
                setAuthChecked(false);
                void refreshSellerSession();
              }}
              type="button"
            >
              Refresh Store Memberships
            </button>
            <button
              className="px-4 py-2 rounded-xl bg-error/10 text-error font-label-md font-semibold"
              onClick={() => handleLogout()}
              type="button"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  const allowKycManage = canManageStoreKyc(activeStore);
  const kycFallbackDisplay = resolveSellerKycDisplayStatus({
    serverConfirmedSubmissions
  });
  const statusMeta = onboardingStatus ? getOnboardingStatusMeta(onboardingStatus) : null;
  const isApprovedByServer = onboardingStatus === 'APPROVED';

  return (
    <div className="bg-surface font-body-md text-body-md text-on-surface min-h-screen flex flex-col selection:bg-primary-container selection:text-on-primary">
      <Head>
        <title>{activeStore.businessName} — StreetVerse Merchant Portal</title>
        <meta
          name="description"
          content="Manage physical store onboarding, KYC verification documents, compliance warnings, and owner notifications."
        />
      </Head>

      {/* Top Command Bar */}
      <header className="fixed top-0 left-0 w-full z-50 bg-surface/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] border-b border-surface-container">
        <div className="h-20 w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin flex items-center justify-between gap-space-md">
          <div className="flex items-center gap-space-md min-w-0">
            <div className="w-9 h-9 rounded-xl bg-primary text-on-primary flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-xl">storefront</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="font-headline-sm text-headline-sm font-bold text-on-surface tracking-tight truncate">
                  {activeStore.businessName}
                </h1>
                <span className="bg-secondary-container text-on-secondary-container px-2 py-0.5 rounded-full font-label-sm text-label-sm font-bold">
                  {formatCategoryLabel(activeStore.category)}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full font-label-sm text-label-sm font-bold ${
                    activeStore.role === 'OWNER'
                      ? 'bg-primary/15 text-primary'
                      : 'bg-surface-container text-on-surface-variant'
                  }`}
                >
                  Role: {activeStore.role}
                </span>
              </div>
              <p className="font-label-sm text-label-sm text-outline truncate">
                Store ID: #{activeStore.id} • {sellerAccount.email}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-space-sm shrink-0">
            {/* Unread Notifications Button */}
            <button
              type="button"
              onClick={() => setActiveTab('NOTIFICATIONS')}
              className="relative px-3 py-1.5 rounded-xl bg-surface-container-low hover:bg-surface-container border border-surface-container text-xs font-bold text-on-surface flex items-center gap-1.5"
              title="Owner Onboarding & Compliance Notifications"
            >
              <span className="material-symbols-outlined text-base text-primary">notifications</span>
              <span className="hidden sm:inline">Alerts</span>
              {unreadAlertsCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-error text-on-error text-[10px] font-bold">
                  {unreadAlertsCount}
                </span>
              )}
            </button>

            {/* Theme Dots */}
            <div className="hidden md:flex items-center bg-surface-container-low p-space-2xs rounded-full gap-space-2xs">
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  theme === 'light' ? 'bg-surface shadow-xs scale-110' : 'hover:bg-surface-container'
                }`}
                onClick={() => setTheme('light')}
                title="Light Default"
                type="button"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  theme === 'dark' ? 'bg-surface shadow-xs scale-110' : 'hover:bg-surface-container'
                }`}
                onClick={() => setTheme('dark')}
                title="Noir Canvas"
                type="button"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-slate-900" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  theme === 'warm-beige' ? 'bg-surface shadow-xs scale-110' : 'hover:bg-surface-container'
                }`}
                onClick={() => setTheme('warm-beige')}
                title="Warm Beige"
                type="button"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-amber-700" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  theme === 'sky-blue' ? 'bg-surface shadow-xs scale-110' : 'hover:bg-surface-container'
                }`}
                onClick={() => setTheme('sky-blue')}
                title="Sky Blue"
                type="button"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-sky-400" />
              </button>
            </div>

            <Link
              href="/admin"
              className="hidden lg:flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-surface-container-low hover:bg-surface-container text-xs font-bold text-on-surface-variant"
            >
              <span className="material-symbols-outlined text-sm text-primary">admin_panel_settings</span>
              <span>Admin Portal</span>
            </Link>

            <button
              className="flex items-center gap-1 px-space-sm py-space-xs rounded-xl bg-error/10 hover:bg-error/20 text-error font-label-md text-label-md font-semibold transition-colors"
              onClick={() => handleLogout()}
              type="button"
            >
              <span className="material-symbols-outlined text-base">logout</span>
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full pt-28 bg-surface flex-1">
        <div className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin flex flex-col gap-space-lg">
          {/* Utility Control Strip */}
          <div className="flex flex-wrap items-center justify-between gap-space-sm bg-surface-container-low rounded-xl px-space-md py-space-sm shadow-xs border border-surface-container">
            <div className="flex items-center gap-space-md flex-wrap">
              <div className="flex items-center gap-2">
                <label
                  htmlFor="seller-store-selector"
                  className="font-label-sm text-label-sm text-outline font-semibold uppercase"
                >
                  Active Store:
                </label>
                <select
                  id="seller-store-selector"
                  aria-label="Select Authorized Store"
                  className="bg-surface-container-lowest border border-surface-container rounded-lg px-2.5 py-1 font-label-sm text-label-sm font-semibold text-on-surface outline-none focus:ring-2 focus:ring-primary/40"
                  value={activeStore.id}
                  onChange={(e) => handleSelectStore(e.target.value)}
                >
                  {authorizedStores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.businessName} ({store.role})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="font-label-sm text-label-sm text-outline font-semibold uppercase">Storefront Visibility:</span>
                <span
                  className={`px-2.5 py-1 rounded-full font-label-sm text-label-sm font-bold flex items-center gap-1.5 ${
                    activeStore.isOpen
                      ? 'bg-secondary text-on-secondary'
                      : 'bg-surface-container-high text-outline'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${activeStore.isOpen ? 'bg-white' : 'bg-outline'}`} />
                  <span>{activeStore.isOpen ? 'OPEN' : 'NOT YET ACTIVE'}</span>
                </span>
              </div>

              <div className="hidden sm:flex items-center gap-1 text-on-surface-variant font-label-sm text-label-sm">
                <span className="material-symbols-outlined text-primary text-base">account_balance_wallet</span>
                <span>
                  UPI VPA: <strong>{activeStore.upiVpa || 'Not configured'}</strong>
                </span>
              </div>
            </div>

            <div
              className={`flex items-center gap-1.5 font-label-sm text-label-sm font-semibold ${
                isApprovedByServer ? 'text-secondary' : 'text-on-surface-variant'
              }`}
            >
              <span className="material-symbols-outlined text-base">
                {isApprovedByServer ? 'verified' : 'shield'}
              </span>
              <span>{statusMeta ? statusMeta.label : kycFallbackDisplay.headerLabel}</span>
            </div>
          </div>

          {/* Truthful Server-Derived Summary KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm">
            <div className="bg-surface-container-lowest p-space-md rounded-2xl border border-surface-container shadow-xs">
              <div className="flex items-center justify-between text-outline mb-1">
                <span className="font-label-sm text-label-sm">Verification Status</span>
                <span className="material-symbols-outlined text-primary">verified_user</span>
              </div>
              <p className="font-headline-sm text-base font-bold text-on-surface">
                {statusMeta ? statusMeta.label : kycFallbackDisplay.summaryLabel}
              </p>
              <p className="font-label-sm text-xs text-outline mt-1">
                Authoritative Merchant DB state
              </p>
            </div>

            <div className="bg-surface-container-lowest p-space-md rounded-2xl border border-surface-container shadow-xs">
              <div className="flex items-center justify-between text-outline mb-1">
                <span className="font-label-sm text-label-sm">Store Role & Access</span>
                <span className="material-symbols-outlined text-secondary">badge</span>
              </div>
              <p className="font-headline-sm text-base font-bold text-on-surface">{activeStore.role}</p>
              <p className="font-label-sm text-xs text-on-surface-variant mt-1">
                {allowKycManage
                  ? 'Full Onboarding & Compliance Owner'
                  : 'Staff operational access (Onboarding gated)'}
              </p>
            </div>

            <div className="bg-surface-container-lowest p-space-md rounded-2xl border border-surface-container shadow-xs">
              <div className="flex items-center justify-between text-outline mb-1">
                <span className="font-label-sm text-label-sm">Submission Versions</span>
                <span className="material-symbols-outlined text-primary">history</span>
              </div>
              <p className="font-headline-sm text-base font-bold text-on-surface">
                {allowKycManage ? `${submissionsCount} Recorded` : 'Owner Only'}
              </p>
              <p className="font-label-sm text-xs text-outline mt-1">
                Immutable application snapshots
              </p>
            </div>

            <div className="bg-surface-container-lowest p-space-md rounded-2xl border border-surface-container shadow-xs">
              <div className="flex items-center justify-between text-outline mb-1">
                <span className="font-label-sm text-label-sm">Unread Owner Alerts</span>
                <span className="material-symbols-outlined text-amber-600">notifications_active</span>
              </div>
              <p className="font-headline-sm text-base font-bold text-on-surface">
                {unreadAlertsCount} Unread
              </p>
              <button
                type="button"
                onClick={() => setActiveTab('NOTIFICATIONS')}
                className="font-label-sm text-xs text-primary font-semibold hover:underline mt-1"
              >
                Open Notification Center →
              </button>
            </div>
          </div>

          {/* Portal Section Tabs */}
          <div className="flex items-center gap-space-2xs bg-surface-container-low p-space-2xs rounded-xl overflow-x-auto border border-surface-container">
            <button
              className={`px-space-md py-space-xs rounded-lg font-label-md text-label-md transition-all flex items-center gap-1.5 ${
                activeTab === 'ONBOARDING'
                  ? 'bg-surface-container-lowest text-primary font-bold shadow-xs'
                  : 'text-on-surface-variant hover:text-on-surface font-semibold'
              }`}
              onClick={() => setActiveTab('ONBOARDING')}
              type="button"
            >
              <span className="material-symbols-outlined text-base">verified</span>
              <span>Store Onboarding & KYC</span>
            </button>

            <button
              className={`px-space-md py-space-xs rounded-lg font-label-md text-label-md transition-all flex items-center gap-1.5 ${
                activeTab === 'COMPLIANCE'
                  ? 'bg-surface-container-lowest text-primary font-bold shadow-xs'
                  : 'text-on-surface-variant hover:text-on-surface font-semibold'
              }`}
              onClick={() => setActiveTab('COMPLIANCE')}
              type="button"
            >
              <span className="material-symbols-outlined text-base">gavel</span>
              <span>Compliance & Warnings</span>
            </button>

            <button
              className={`px-space-md py-space-xs rounded-lg font-label-md text-label-md transition-all flex items-center gap-1.5 ${
                activeTab === 'NOTIFICATIONS'
                  ? 'bg-surface-container-lowest text-primary font-bold shadow-xs'
                  : 'text-on-surface-variant hover:text-on-surface font-semibold'
              }`}
              onClick={() => setActiveTab('NOTIFICATIONS')}
              type="button"
            >
              <span className="material-symbols-outlined text-base">notifications</span>
              <span>Owner Notifications ({unreadAlertsCount})</span>
            </button>
          </div>

          {activeTab === 'ONBOARDING' && (
            <SellerOnboardingWorkspace
              apiUrl={API_URL}
              token={authToken}
              activeStore={activeStore}
              onStatusSync={handleStatusSync}
              onAuthExpired={handleLogout}
            />
          )}

          {activeTab === 'COMPLIANCE' && (
            <SellerComplianceWorkspace
              apiUrl={API_URL}
              token={authToken}
              activeStore={activeStore}
              onAuthExpired={handleLogout}
            />
          )}

          {activeTab === 'NOTIFICATIONS' && (
            <OwnerNotificationsWorkspace
              apiUrl={API_URL}
              token={authToken}
              activeStore={activeStore}
              authorizedStores={authorizedStores}
              onUnreadCountChange={setUnreadAlertsCount}
              onNavigateTarget={({ storeId, tab }) => {
                const switched = switchSelectedSellerStore(authorizedStores, storeId);
                if (switched) {
                  setActiveStore(switched);
                }
                setActiveTab(tab);
              }}
              onAuthExpired={handleLogout}
            />
          )}
        </div>
      </main>

      <footer className="w-full bg-surface-container-low py-space-xl mt-space-3xl border-t border-surface-container">
        <div className="max-w-7xl mx-auto px-margin-mobile lg:px-margin flex flex-col md:flex-row items-center justify-between gap-space-md">
          <div className="flex items-center gap-space-sm">
            <span className="font-label-md text-label-md font-bold text-on-surface">
              StreetVerse Merchant Operations
            </span>
            <span className="text-outline">•</span>
            <Link href="/admin" className="font-label-sm text-label-sm text-primary hover:underline">
              Admin Operations Portal
            </Link>
          </div>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            © 2026 StreetVerse Platform. Store-Scoped Verification & Compliance.
          </p>
        </div>
      </footer>
    </div>
  );
}
