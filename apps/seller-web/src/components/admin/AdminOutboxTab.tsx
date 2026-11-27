import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AdminOutboxEventRecord,
  AdminOutboxSummary,
  fetchAdminOutboxEvents,
  fetchAdminOutboxSummary,
  replayAdminOutboxEvent
} from '../../utils/adminSession';

export interface AdminOutboxTabProps {
  apiUrl: string;
  token: string;
  initialStoreId?: string;
  onAuthExpired: (message?: string) => void;
}

const OUTBOX_STATUS_FILTERS = [
  'ALL',
  'PENDING',
  'PROCESSING',
  'RETRYING',
  'DELIVERED',
  'TERMINAL_FAILED',
  'CANCELLED'
];

export const AdminOutboxTab: React.FC<AdminOutboxTabProps> = ({
  apiUrl,
  token,
  initialStoreId,
  onAuthExpired
}) => {
  const [summary, setSummary] = useState<AdminOutboxSummary | null>(null);
  const [events, setEvents] = useState<AdminOutboxEventRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [storeIdFilter, setStoreIdFilter] = useState(initialStoreId || '');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 25;

  const [loading, setLoading] = useState(true);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [replayReason, setReplayReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadOutbox = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [sumRes, evRes] = await Promise.all([
      fetchAdminOutboxSummary({ apiUrl, token }),
      fetchAdminOutboxEvents({
        apiUrl,
        token,
        status: statusFilter,
        storeId: storeIdFilter.trim() || undefined,
        eventType: eventTypeFilter.trim() || undefined,
        limit,
        offset
      })
    ]);

    setLoading(false);
    if (sumRes.authExpired || evRes.authExpired) {
      onAuthExpired(sumRes.error || evRes.error || undefined);
      return;
    }

    if (sumRes.ok && sumRes.data) {
      setSummary(sumRes.data);
    }
    if (!evRes.ok || !evRes.data) {
      setError(evRes.error || 'Failed to load outbox events.');
      return;
    }

    setEvents(evRes.data.events);
    setTotalCount(evRes.data.totalCount);
  }, [apiUrl, token, statusFilter, storeIdFilter, eventTypeFilter, offset, onAuthExpired]);

  useEffect(() => {
    void loadOutbox();
  }, [loadOutbox]);

  const handleReplay = async (eventId: string) => {
    if (replayingId) return;
    setReplayingId(eventId);
    setError(null);
    setSuccessMsg(null);
    const res = await replayAdminOutboxEvent({
      apiUrl,
      token,
      eventId,
      reason: replayReason.trim() || 'Admin operational replay via dashboard.'
    });
    setReplayingId(null);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Replay request failed.');
      return;
    }
    setSuccessMsg(`Outbox event ${eventId} queued back to PENDING for worker retry.`);
    setReplayReason('');
    await loadOutbox();
  };

  const c = summary?.counts;

  return (
    <div className="flex flex-col gap-space-md">
      {/* KPI Summary & Worker Telemetry */}
      {c && (
        <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-headline-sm text-base font-bold text-on-surface">
                Owner Notification Outbox &amp; Worker Telemetry
              </h3>
              <p className="text-xs text-on-surface-variant">
                PostgreSQL transactional outbox delivery state (`in_app_status` vs `email_status`) and dead-letter replay.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadOutbox()}
              className="px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-container-high text-xs font-bold flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
              <span>Refresh</span>
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <span className="text-outline block">Delivered</span>
              <strong className="text-base text-secondary">{c.delivered}</strong>
            </div>
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <span className="text-outline block">Pending / Retry</span>
              <strong className="text-base text-primary">{c.pending + c.retrying}</strong>
            </div>
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <span className="text-outline block">Terminal Failed</span>
              <strong className="text-base text-error">{c.terminalFailed}</strong>
            </div>
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <span className="text-outline block">Email Unconfigured</span>
              <strong className="text-base text-amber-700 dark:text-amber-300">{c.unconfiguredEmailCount}</strong>
            </div>
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <span className="text-outline block">Email Failed</span>
              <strong className="text-base text-error">{c.failedEmailCount}</strong>
            </div>
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <span className="text-outline block">Worker Status</span>
              <strong className="text-xs text-on-surface">
                {summary?.worker?.running ? 'RUNNING' : 'IDLE / STOPPED'}
                {summary?.worker ? ` (${summary.worker.totalTicks} ticks)` : ''}
              </strong>
            </div>
          </div>
        </div>
      )}

      {/* Filters & Event List */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {OUTBOX_STATUS_FILTERS.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => {
                setStatusFilter(st);
                setOffset(0);
              }}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold ${
                statusFilter === st
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container text-on-surface-variant'
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text"
            value={storeIdFilter}
            onChange={(e) => {
              setStoreIdFilter(e.target.value);
              setOffset(0);
            }}
            placeholder="Filter Store UUID (optional)"
            className="bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-xs font-mono"
          />
          <input
            type="text"
            value={eventTypeFilter}
            onChange={(e) => {
              setEventTypeFilter(e.target.value);
              setOffset(0);
            }}
            placeholder="Event Type (e.g. STORE_APPROVED)"
            className="bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-xs font-mono"
          />
          <input
            type="text"
            value={replayReason}
            onChange={(e) => setReplayReason(e.target.value)}
            placeholder="Replay audit note (used on Replay click)"
            className="bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-xs"
          />
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold">
            {error}
          </div>
        )}
        {successMsg && (
          <div className="p-3 rounded-xl bg-secondary/10 border border-secondary/30 text-secondary text-xs font-semibold">
            {successMsg}
          </div>
        )}

        {loading ? (
          <div className="p-6 text-center text-xs text-on-surface-variant">Loading outbox events...</div>
        ) : events.length === 0 ? (
          <div className="p-6 rounded-xl bg-surface-container-low border border-dashed border-surface-container text-center text-xs text-on-surface-variant">
            No matching outbox notification events.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-surface-container text-outline">
                  <th className="py-2 px-2">Store / Event</th>
                  <th className="py-2 px-2">Delivery State</th>
                  <th className="py-2 px-2">Channels</th>
                  <th className="py-2 px-2">Attempts / Error</th>
                  <th className="py-2 px-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-container">
                {events.map((ev) => {
                  const isReplayable =
                    ev.deliveryStatus === 'TERMINAL_FAILED' || ev.deliveryStatus === 'FAILED';
                  return (
                    <tr key={ev.id} className="hover:bg-surface-container-low">
                      <td className="py-2.5 px-2">
                        <Link
                          href={`/admin/stores/${ev.storeId}`}
                          className="font-bold text-primary hover:underline block"
                        >
                          {ev.storeBusinessName || ev.storeId}
                        </Link>
                        <span className="font-mono text-[11px] text-on-surface">{ev.eventType}</span>
                        <span className="block text-[10px] text-outline">
                          {new Date(ev.createdAt).toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2.5 px-2">
                        <span
                          className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                            ev.deliveryStatus === 'DELIVERED' || ev.deliveryStatus === 'SENT'
                              ? 'bg-secondary-container text-on-secondary-container'
                              : isReplayable
                                ? 'bg-error-container text-on-error-container'
                                : 'bg-surface-container-high text-on-surface'
                          }`}
                        >
                          {ev.deliveryStatus}
                        </span>
                      </td>
                      <td className="py-2.5 px-2 font-mono text-[11px]">
                        <div>In-App: {ev.inAppStatus}</div>
                        <div>Email: {ev.emailStatus}</div>
                      </td>
                      <td className="py-2.5 px-2">
                        <div>
                          Attempts: {ev.deliveryAttempts}/{ev.maxAttempts}
                        </div>
                        {(ev.lastError || ev.emailError) && (
                          <span className="text-[11px] text-error block max-w-xs truncate" title={ev.lastError || ev.emailError || ''}>
                            {ev.lastError || ev.emailError}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right">
                        {isReplayable ? (
                          <button
                            type="button"
                            disabled={replayingId === ev.id}
                            onClick={() => void handleReplay(ev.id)}
                            className="px-2.5 py-1 rounded-lg bg-primary text-on-primary font-bold disabled:opacity-50"
                          >
                            {replayingId === ev.id ? 'Replaying...' : 'Replay'}
                          </button>
                        ) : (
                          <span className="text-outline">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalCount > limit && (
          <div className="flex items-center justify-between pt-2 border-t border-surface-container text-xs">
            <span>
              Showing {offset + 1}–{Math.min(offset + events.length, totalCount)} of {totalCount}
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
    </div>
  );
};
