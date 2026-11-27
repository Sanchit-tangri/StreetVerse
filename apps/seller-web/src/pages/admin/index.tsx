import React, { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useAdminSession } from '../../hooks/useAdminSession';
import { AdminAuthCard } from '../../components/admin/AdminAuthCard';
import { AdminPortalHeader } from '../../components/admin/AdminPortalHeader';
import { AdminOutboxTab } from '../../components/admin/AdminOutboxTab';
import {
  AdminQueueItem,
  AdminStoreWarning,
  fetchAdminOnboardingQueue,
  fetchAdminWarningsList,
  hasAdminPermission
} from '../../utils/adminSession';
import {
  formatCategoryLabel,
  getOnboardingStatusMeta,
  STORE_CATEGORY_OPTIONS,
  WARNING_SEVERITY_OPTIONS
} from '../../utils/onboardingConstants';

type AdminHubTab = 'QUEUE' | 'COMPLIANCE' | 'OUTBOX';

const QUEUE_STATUS_TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Active Queue' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'UNDER_REVIEW', label: 'Under Review' },
  { value: 'MORE_INFO_REQUIRED', label: 'More Info' },
  { value: 'REVERIFICATION_REQUIRED', label: 'Re-verification' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'ALL', label: 'All Non-Draft' }
];

export default function AdminOperationsDashboard() {
  const session = useAdminSession();
  const [activeTab, setActiveTab] = useState<AdminHubTab>('QUEUE');

  // Queue filters & state
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<'submitted_asc' | 'submitted_desc'>('submitted_asc');
  const [queueOffset, setQueueOffset] = useState(0);
  const queueLimit = 20;

  const [queueItems, setQueueItems] = useState<AdminQueueItem[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  // Compliance global warnings state
  const [warnStatus, setWarnStatus] = useState('OPEN');
  const [warnOverdueOnly, setWarnOverdueOnly] = useState(false);
  const [warnSeverity, setWarnSeverity] = useState('');
  const [warnOffset, setWarnOffset] = useState(0);
  const warnLimit = 25;
  const [warnings, setWarnings] = useState<Array<AdminStoreWarning & { businessName: string; category: string }>>([]);
  const [warningsTotal, setWarningsTotal] = useState(0);
  const [warningsLoading, setWarningsLoading] = useState(false);
  const [warningsError, setWarningsError] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    if (session.status !== 'authenticated' || !session.token || !session.admin) return;
    if (!hasAdminPermission(session.admin, 'KYC_QUEUE_READ')) return;
    setQueueLoading(true);
    setQueueError(null);
    const res = await fetchAdminOnboardingQueue({
      apiUrl: session.apiUrl,
      token: session.token,
      status: statusFilter || undefined,
      category: categoryFilter || undefined,
      search: appliedSearch || undefined,
      sort: sortOrder,
      limit: queueLimit,
      offset: queueOffset
    });
    setQueueLoading(false);
    if (res.authExpired) {
      session.logout(res.error || undefined);
      return;
    }
    if (!res.ok || !res.data) {
      setQueueError(res.error || 'Failed to load onboarding review queue.');
      return;
    }
    setQueueItems(res.data.items);
    setQueueTotal(res.data.totalCount);
    setStatusCounts(res.data.statusCounts || {});
  }, [session, statusFilter, categoryFilter, appliedSearch, sortOrder, queueOffset]);

  const loadWarnings = useCallback(async () => {
    if (session.status !== 'authenticated' || !session.token || !session.admin) return;
    if (!hasAdminPermission(session.admin, 'STORE_COMPLIANCE_MANAGE')) return;
    setWarningsLoading(true);
    setWarningsError(null);
    const res = await fetchAdminWarningsList({
      apiUrl: session.apiUrl,
      token: session.token,
      status: warnStatus,
      overdueOnly: warnOverdueOnly,
      severity: warnSeverity || undefined,
      limit: warnLimit,
      offset: warnOffset
    });
    setWarningsLoading(false);
    if (res.authExpired) {
      session.logout(res.error || undefined);
      return;
    }
    if (!res.ok || !res.data) {
      setWarningsError(res.error || 'Failed to load compliance warnings.');
      return;
    }
    setWarnings(res.data.warnings);
    setWarningsTotal(res.data.totalCount);
  }, [session, warnStatus, warnOverdueOnly, warnSeverity, warnOffset]);

  useEffect(() => {
    if (session.status === 'authenticated' && activeTab === 'QUEUE') {
      void loadQueue();
    }
  }, [session.status, activeTab, loadQueue]);

  useEffect(() => {
    if (session.status === 'authenticated' && activeTab === 'COMPLIANCE') {
      void loadWarnings();
    }
  }, [session.status, activeTab, loadWarnings]);

  if (!session.authChecked) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center text-sm text-on-surface">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
          <span>Verifying Admin Session (/api/v1/admin/me)...</span>
        </div>
      </div>
    );
  }

  if (session.status === 'service_unavailable') {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6 text-on-surface">
        <div className="max-w-md w-full bg-surface-container-lowest p-6 rounded-2xl border border-surface-container text-center flex flex-col gap-3">
          <span className="material-symbols-outlined text-3xl text-error mx-auto">cloud_off</span>
          <h2 className="font-headline-sm text-lg font-bold">Admin Session Check Unavailable</h2>
          <p className="text-xs text-on-surface-variant">
            {session.errorMessage || 'Unable to verify Admin session. Your token has been preserved.'}
          </p>
          <div className="flex justify-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => void session.refresh()}
              className="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-bold"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => session.logout()}
              className="px-4 py-2 rounded-xl bg-surface-container text-xs font-semibold"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (session.status !== 'authenticated' || !session.admin || !session.token) {
    return (
      <AdminAuthCard
        sessionNotice={session.errorMessage}
        onLoginSuccess={session.acceptLogin}
      />
    );
  }

  const canReadQueue = hasAdminPermission(session.admin, 'KYC_QUEUE_READ');
  const canManageCompliance = hasAdminPermission(session.admin, 'STORE_COMPLIANCE_MANAGE');

  return (
    <div className="min-h-screen bg-surface text-on-surface flex flex-col">
      <Head>
        <title>Admin Operations Queue — StreetVerse</title>
      </Head>

      <AdminPortalHeader admin={session.admin} subtitle="Onboarding & Compliance Operations" onLogout={session.logout} />

      <main className="w-full pt-28 flex-1 pb-16">
        <div className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin flex flex-col gap-space-lg">
          {/* Navigation Tabs */}
          <div className="flex items-center gap-2 bg-surface-container-low p-1.5 rounded-xl border border-surface-container overflow-x-auto">
            {canReadQueue && (
              <button
                type="button"
                onClick={() => setActiveTab('QUEUE')}
                className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
                  activeTab === 'QUEUE'
                    ? 'bg-surface-container-lowest text-primary shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-base">fact_check</span>
                <span>Onboarding Review Queue ({queueTotal})</span>
              </button>
            )}
            {canManageCompliance && (
              <button
                type="button"
                onClick={() => setActiveTab('COMPLIANCE')}
                className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
                  activeTab === 'COMPLIANCE'
                    ? 'bg-surface-container-lowest text-primary shadow-xs'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-base">gavel</span>
                <span>Store Compliance Warnings</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setActiveTab('OUTBOX')}
              className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 ${
                activeTab === 'OUTBOX'
                  ? 'bg-surface-container-lowest text-primary shadow-xs'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-base">outbox</span>
              <span>Notification Outbox &amp; Replay</span>
            </button>
          </div>

          {/* TAB 1: ONBOARDING QUEUE */}
          {activeTab === 'QUEUE' && canReadQueue && (
            <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="font-headline-sm text-lg font-bold text-on-surface">
                    Merchant Onboarding Verification Queue
                  </h2>
                  <p className="text-xs text-on-surface-variant">
                    Priority-neutral submitted applications ready for administrative inspection and document verification.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadQueue()}
                  className="px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-container-high text-xs font-bold flex items-center gap-1 self-start"
                >
                  <span className="material-symbols-outlined text-sm">refresh</span>
                  <span>Refresh Queue</span>
                </button>
              </div>

              {/* Status Filter Pills */}
              <div className="flex flex-wrap gap-1.5">
                {QUEUE_STATUS_TABS.map((t) => {
                  const count = t.value && t.value !== 'ALL' ? statusCounts[t.value] : undefined;
                  return (
                    <button
                      key={t.value || 'DEFAULT'}
                      type="button"
                      onClick={() => {
                        setStatusFilter(t.value);
                        setQueueOffset(0);
                      }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold ${
                        statusFilter === t.value
                          ? 'bg-primary text-on-primary'
                          : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                      }`}
                    >
                      {t.label}
                      {count !== undefined ? ` (${count})` : ''}
                    </button>
                  );
                })}
              </div>

              {/* Filter Bar */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setAppliedSearch(searchInput.trim());
                  setQueueOffset(0);
                }}
                className="grid grid-cols-1 md:grid-cols-4 gap-2"
              >
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search business name, store ID, pincode, email..."
                  className="md:col-span-2 bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-xs"
                />
                <select
                  value={categoryFilter}
                  onChange={(e) => {
                    setCategoryFilter(e.target.value);
                    setQueueOffset(0);
                  }}
                  className="bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-xs"
                >
                  <option value="">All Categories</option>
                  {STORE_CATEGORY_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <select
                    value={sortOrder}
                    onChange={(e) => {
                      setSortOrder(e.target.value as 'submitted_asc' | 'submitted_desc');
                      setQueueOffset(0);
                    }}
                    className="flex-1 bg-surface-container-low border border-surface-container rounded-xl px-2.5 py-2 text-xs"
                  >
                    <option value="submitted_asc">Oldest First (FIFO)</option>
                    <option value="submitted_desc">Newest First</option>
                  </select>
                  <button
                    type="submit"
                    className="px-3 py-2 rounded-xl bg-primary text-on-primary text-xs font-bold"
                  >
                    Search
                  </button>
                </div>
              </form>

              {queueError && (
                <div role="alert" className="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold">
                  {queueError}
                </div>
              )}

              {queueLoading ? (
                <div className="p-8 text-center text-xs text-on-surface-variant">Loading onboarding queue...</div>
              ) : queueItems.length === 0 ? (
                <div className="p-8 rounded-xl bg-surface-container-low border border-dashed border-surface-container text-center text-xs text-on-surface-variant">
                  No store submissions match the selected filters.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {queueItems.map((item) => {
                    const stMeta = getOnboardingStatusMeta(item.onboardingStatus);
                    const sub = item.currentSubmission;
                    return (
                      <div
                        key={item.storeId}
                        className="p-4 rounded-xl bg-surface-container-low border border-surface-container flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                      >
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link
                              href={`/admin/stores/${item.storeId}`}
                              className="font-bold text-sm text-primary hover:underline"
                            >
                              {item.businessName}
                            </Link>
                            <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${stMeta.toneClass}`}>
                              {stMeta.label}
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-surface-container text-[11px] font-semibold">
                              {formatCategoryLabel(item.category)}
                            </span>
                            {item.isResubmission && (
                              <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-bold">
                                Resubmission
                              </span>
                            )}
                            {item.reverificationRequired && (
                              <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-800 dark:text-amber-200 text-[11px] font-bold">
                                Location Re-verification
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-on-surface-variant truncate">
                            {item.currentLocation.address || 'No address saved'}
                            {item.currentLocation.pincode ? `, ${item.currentLocation.pincode}` : ''}
                            {item.primaryOwner ? ` • Owner: ${item.primaryOwner.email}` : ''}
                          </p>
                          <div className="flex flex-wrap items-center gap-3 text-[11px] text-outline">
                            <span className="font-mono">Store: {item.storeId}</span>
                            {sub && (
                              <>
                                <span>Version: v{sub.submissionVersion}</span>
                                <span>
                                  Mandatory Docs: {sub.requiredDocumentSummary.mandatoryUploadedCount}/
                                  {sub.requiredDocumentSummary.mandatoryRequiredCount}
                                </span>
                                <span>Total Files: {sub.documentCount}</span>
                                {sub.submittedAt && (
                                  <span>Submitted: {new Date(sub.submittedAt).toLocaleString()}</span>
                                )}
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <Link
                            href={`/admin/stores/${item.storeId}?tab=compliance`}
                            className="px-3 py-2 rounded-xl bg-surface-container-lowest border border-surface-container hover:border-primary text-xs font-bold text-on-surface"
                          >
                            Compliance
                          </Link>
                          <Link
                            href={`/admin/stores/${item.storeId}`}
                            className="px-3.5 py-2 rounded-xl bg-primary text-on-primary text-xs font-bold"
                          >
                            Inspect &amp; Review →
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {queueTotal > queueLimit && (
                <div className="flex items-center justify-between pt-2 border-t border-surface-container text-xs">
                  <span>
                    Showing {queueOffset + 1}–{Math.min(queueOffset + queueItems.length, queueTotal)} of {queueTotal}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={queueOffset === 0}
                      onClick={() => setQueueOffset(Math.max(0, queueOffset - queueLimit))}
                      className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40 font-semibold"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={queueOffset + queueLimit >= queueTotal}
                      onClick={() => setQueueOffset(queueOffset + queueLimit)}
                      className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40 font-semibold"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: GLOBAL COMPLIANCE WARNINGS */}
          {activeTab === 'COMPLIANCE' && canManageCompliance && (
            <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-headline-sm text-lg font-bold text-on-surface">
                    Platform Compliance Warnings Tracker
                  </h2>
                  <p className="text-xs text-on-surface-variant">
                    Review open, overdue, and escalated store warnings across the network and jump straight to store compliance controls.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <select
                    value={warnStatus}
                    onChange={(e) => {
                      setWarnStatus(e.target.value);
                      setWarnOffset(0);
                    }}
                    className="bg-surface-container-low border border-surface-container rounded-xl px-3 py-1.5"
                  >
                    <option value="OPEN">Open Warnings</option>
                    <option value="RESOLVED">Resolved Warnings</option>
                    <option value="ALL">All Statuses</option>
                  </select>
                  <select
                    value={warnSeverity}
                    onChange={(e) => {
                      setWarnSeverity(e.target.value);
                      setWarnOffset(0);
                    }}
                    className="bg-surface-container-low border border-surface-container rounded-xl px-3 py-1.5"
                  >
                    <option value="">All Severities</option>
                    {WARNING_SEVERITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 font-semibold">
                    <input
                      type="checkbox"
                      checked={warnOverdueOnly}
                      onChange={(e) => {
                        setWarnOverdueOnly(e.target.checked);
                        setWarnOffset(0);
                      }}
                    />
                    <span>Overdue Only</span>
                  </label>
                </div>
              </div>

              {warningsError && (
                <div role="alert" className="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold">
                  {warningsError}
                </div>
              )}

              {warningsLoading ? (
                <div className="p-6 text-center text-xs text-on-surface-variant">Loading warnings...</div>
              ) : warnings.length === 0 ? (
                <div className="p-6 rounded-xl bg-surface-container-low border border-dashed border-surface-container text-center text-xs text-on-surface-variant">
                  No warnings match these filters.
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {warnings.map((w) => (
                    <div
                      key={w.id}
                      className="p-3.5 rounded-xl bg-surface-container-low border border-surface-container flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                    >
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            href={`/admin/stores/${w.storeId}?tab=compliance`}
                            className="font-bold text-sm text-primary hover:underline"
                          >
                            {w.businessName} — Warning #{w.warningNumber}
                          </Link>
                          <span className="px-2 py-0.5 rounded-full bg-surface-container-high font-bold text-[10px]">
                            {w.status} • {w.severity}
                          </span>
                          {w.isOverdue && w.status === 'OPEN' && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-800 dark:text-amber-200 font-bold text-[10px]">
                              OVERDUE
                            </span>
                          )}
                          {w.escalatedAt && (
                            <span className="px-2 py-0.5 rounded-full bg-error/15 text-error font-bold text-[10px]">
                              ESCALATED
                            </span>
                          )}
                        </div>
                        <p className="text-on-surface mt-1">{w.reason}</p>
                        <p className="text-[11px] text-outline mt-0.5">
                          Category: {w.violationCategory} • Owner responses: {w.responses.length} • Issued:{' '}
                          {new Date(w.issuedAt).toLocaleString()}
                        </p>
                      </div>
                      <Link
                        href={`/admin/stores/${w.storeId}?tab=compliance`}
                        className="px-3 py-1.5 rounded-xl bg-primary text-on-primary font-bold shrink-0 self-start"
                      >
                        Manage Compliance →
                      </Link>
                    </div>
                  ))}
                </div>
              )}

              {warningsTotal > warnLimit && (
                <div className="flex items-center justify-between pt-2 border-t border-surface-container text-xs">
                  <span>
                    Showing {warnOffset + 1}–{Math.min(warnOffset + warnings.length, warningsTotal)} of {warningsTotal}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={warnOffset === 0}
                      onClick={() => setWarnOffset(Math.max(0, warnOffset - warnLimit))}
                      className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40 font-semibold"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={warnOffset + warnLimit >= warningsTotal}
                      onClick={() => setWarnOffset(warnOffset + warnLimit)}
                      className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40 font-semibold"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: OUTBOX MONITORING & REPLAY */}
          {activeTab === 'OUTBOX' && (
            <AdminOutboxTab
              apiUrl={session.apiUrl}
              token={session.token}
              onAuthExpired={session.logout}
            />
          )}
        </div>
      </main>
    </div>
  );
}
