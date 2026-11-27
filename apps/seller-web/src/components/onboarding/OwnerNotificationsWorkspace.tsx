import React, { useCallback, useEffect, useState } from 'react';
import {
  AuthorizedSellerStore,
  canManageStoreKyc
} from '../../utils/sellerSession';
import {
  fetchAccountOwnerNotifications,
  fetchAccountUnreadSummary,
  fetchStoreOwnerNotifications,
  markAllStoreNotificationsRead,
  markOwnerNotificationRead,
  OwnerNotificationRecord
} from '../../utils/sellerOnboarding';

export interface OwnerNotificationsWorkspaceProps {
  apiUrl: string;
  token: string;
  activeStore: AuthorizedSellerStore;
  authorizedStores: AuthorizedSellerStore[];
  onUnreadCountChange?: (totalUnread: number) => void;
  onNavigateTarget: (target: { storeId: string; tab: 'ONBOARDING' | 'COMPLIANCE' }) => void;
  onAuthExpired: (message?: string) => void;
}

const COMPLIANCE_EVENT_PREFIXES = ['WARNING_', 'SUSPENSION_', 'STORE_SUSPENDED', 'STORE_REACTIVATED', 'COMPLIANCE_'];

export function resolveNotificationTargetTab(eventType: string): 'ONBOARDING' | 'COMPLIANCE' {
  const upper = String(eventType || '').toUpperCase();
  if (COMPLIANCE_EVENT_PREFIXES.some((prefix) => upper.includes(prefix))) {
    return 'COMPLIANCE';
  }
  return 'ONBOARDING';
}

export const OwnerNotificationsWorkspace: React.FC<OwnerNotificationsWorkspaceProps> = ({
  apiUrl,
  token,
  activeStore,
  authorizedStores,
  onUnreadCountChange,
  onNavigateTarget,
  onAuthExpired
}) => {
  const allowOwner = canManageStoreKyc(activeStore);
  const ownedStoreIds = new Set(authorizedStores.filter((s) => canManageStoreKyc(s)).map((s) => s.id));
  const [scope, setScope] = useState<'STORE' | 'ACCOUNT'>(allowOwner ? 'STORE' : 'ACCOUNT');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const limit = 15;

  const [notifications, setNotifications] = useState<OwnerNotificationRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [byStoreUnread, setByStoreUnread] = useState<
    Array<{ storeId: string; storeBusinessName: string; unreadCount: number }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshUnreadSummary = useCallback(async () => {
    const summaryRes = await fetchAccountUnreadSummary({ apiUrl, token });
    if (summaryRes.ok && summaryRes.data) {
      setByStoreUnread(summaryRes.data.byStore || []);
      onUnreadCountChange?.(summaryRes.data.unreadCount);
    }
  }, [apiUrl, token, onUnreadCountChange]);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    setError(null);

    if (scope === 'STORE') {
      if (!allowOwner) {
        setNotifications([]);
        setTotalCount(0);
        setUnreadCount(0);
        setLoading(false);
        return;
      }
      const res = await fetchStoreOwnerNotifications({
        apiUrl,
        token,
        activeStore,
        unreadOnly,
        limit,
        offset
      });
      if (res.authExpired) {
        onAuthExpired(res.error || undefined);
        return;
      }
      if (!res.ok || !res.data) {
        setError(res.error || 'Failed to load store notifications.');
        setLoading(false);
        return;
      }
      setNotifications(res.data.notifications);
      setTotalCount(res.data.totalCount);
      setUnreadCount(res.data.unreadCount);
      setLoading(false);
      void refreshUnreadSummary();
      return;
    }

    const res = await fetchAccountOwnerNotifications({
      apiUrl,
      token,
      unreadOnly,
      limit,
      offset
    });
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok || !res.data) {
      setError(res.error || 'Failed to load account notifications.');
      setLoading(false);
      return;
    }
    setNotifications(res.data.notifications);
    setTotalCount(res.data.totalCount);
    setUnreadCount(res.data.unreadCount);
    setLoading(false);
    void refreshUnreadSummary();
  }, [scope, allowOwner, apiUrl, token, activeStore, unreadOnly, offset, onAuthExpired, refreshUnreadSummary]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  const handleMarkOneRead = async (notification: OwnerNotificationRecord) => {
    if (busyId) return;
    setBusyId(notification.id);
    setError(null);
    const res = await markOwnerNotificationRead({
      apiUrl,
      token,
      notificationId: notification.id,
      activeStore: scope === 'STORE' ? activeStore : undefined
    });
    setBusyId(null);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Failed to mark notification read.');
      return;
    }
    await loadNotifications();
  };

  const handleMarkAllStoreRead = async () => {
    if (!allowOwner || markingAll) return;
    setMarkingAll(true);
    setError(null);
    const res = await markAllStoreNotificationsRead({ apiUrl, token, activeStore });
    setMarkingAll(false);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Failed to mark all notifications read.');
      return;
    }
    await loadNotifications();
  };

  return (
    <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-sm">
        <div>
          <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface flex items-center gap-2">
            <span>Owner Onboarding & Compliance Notifications</span>
            {unreadCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-primary text-on-primary text-xs font-bold">
                {unreadCount} unread
              </span>
            )}
          </h3>
          <p className="font-body-sm text-xs text-on-surface-variant mt-0.5">
            Durable store-scoped decisions, document requests, warnings, and reactivation updates from PostgreSQL outbox delivery.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setScope('STORE');
              setOffset(0);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold ${
              scope === 'STORE'
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container text-on-surface-variant'
            }`}
          >
            Current Store Only
          </button>
          <button
            type="button"
            onClick={() => {
              setScope('ACCOUNT');
              setOffset(0);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold ${
              scope === 'ACCOUNT'
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container text-on-surface-variant'
            }`}
          >
            All Owned Stores
          </button>

          <label className="flex items-center gap-1.5 text-xs font-semibold text-on-surface ml-1 cursor-pointer">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => {
                setUnreadOnly(e.target.checked);
                setOffset(0);
              }}
            />
            <span>Unread only</span>
          </label>

          {scope === 'STORE' && allowOwner && unreadCount > 0 && (
            <button
              type="button"
              disabled={markingAll}
              onClick={() => void handleMarkAllStoreRead()}
              className="px-3 py-1.5 rounded-xl bg-secondary text-on-secondary text-xs font-bold disabled:opacity-50"
            >
              {markingAll ? 'Marking...' : 'Mark Store All Read'}
            </button>
          )}
        </div>
      </div>

      {byStoreUnread.length > 0 && scope === 'ACCOUNT' && (
        <div className="flex flex-wrap gap-2">
          {byStoreUnread.map((entry) => (
            <span
              key={entry.storeId}
              className="px-2.5 py-1 rounded-full bg-surface-container-low border border-surface-container text-[11px] font-semibold text-on-surface"
            >
              {entry.storeBusinessName}: <strong>{entry.unreadCount}</strong> unread
            </span>
          ))}
        </div>
      )}

      {scope === 'STORE' && !allowOwner && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 text-xs font-semibold">
          Store notifications for {activeStore.businessName} are restricted to active Store Owners. Switch to &ldquo;All Owned Stores&rdquo; if you own other stores.
        </div>
      )}

      {error && (
        <div role="alert" className="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-6 text-center text-xs text-on-surface-variant flex items-center justify-center gap-2">
          <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
          <span>Loading notifications...</span>
        </div>
      ) : notifications.length === 0 ? (
        <div className="p-6 rounded-xl bg-surface-container-low border border-dashed border-surface-container text-center text-xs text-on-surface-variant">
          {unreadOnly ? 'No unread notifications in this view.' : 'No owner notifications recorded yet.'}
        </div>
      ) : (
        <div className="flex flex-col gap-space-sm">
          {notifications.map((n) => {
            const targetTab = resolveNotificationTargetTab(n.eventType);
            const canOpenStore = ownedStoreIds.has(n.storeId);
            return (
              <div
                key={n.id}
                className={`p-space-md rounded-xl border flex flex-col sm:flex-row sm:items-start justify-between gap-3 transition-colors ${
                  n.isRead
                    ? 'bg-surface-container-low border-surface-container opacity-90'
                    : 'bg-primary/5 border-primary/30'
                }`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {!n.isRead && <span className="w-2 h-2 rounded-full bg-primary shrink-0" />}
                    <span className="font-bold text-sm text-on-surface">{n.title}</span>
                    <span className="px-2 py-0.5 rounded-full bg-surface-container text-[11px] font-semibold text-on-surface-variant">
                      {n.storeBusinessName}
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-surface-container-high text-[10px] font-mono text-outline">
                      {n.eventType}
                    </span>
                  </div>
                  <p className="text-xs text-on-surface mt-1.5">{n.message}</p>
                  <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[11px] text-outline">
                    <span>{new Date(n.createdAt).toLocaleString()}</span>
                    {n.submissionVersion !== null && <span>Submission v{n.submissionVersion}</span>}
                    {n.readAt && <span>Read {new Date(n.readAt).toLocaleString()}</span>}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {canOpenStore && (
                    <button
                      type="button"
                      onClick={() => onNavigateTarget({ storeId: n.storeId, tab: targetTab })}
                      className="px-3 py-1.5 rounded-lg bg-surface-container-lowest border border-surface-container hover:border-primary text-primary text-xs font-bold"
                    >
                      {targetTab === 'COMPLIANCE' ? 'Open Compliance' : 'Open Onboarding'}
                    </button>
                  )}
                  {!n.isRead && (
                    <button
                      type="button"
                      disabled={busyId === n.id}
                      onClick={() => void handleMarkOneRead(n)}
                      className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold disabled:opacity-50"
                    >
                      {busyId === n.id ? 'Saving...' : 'Mark Read'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalCount > limit && (
        <div className="flex items-center justify-between pt-2 border-t border-surface-container text-xs text-on-surface-variant">
          <span>
            Showing {offset + 1}–{Math.min(offset + notifications.length, totalCount)} of {totalCount}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
              className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40 font-semibold"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={offset + limit >= totalCount}
              onClick={() => setOffset(offset + limit)}
              className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40 font-semibold"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
