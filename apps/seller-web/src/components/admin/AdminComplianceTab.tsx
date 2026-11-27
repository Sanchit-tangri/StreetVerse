import React, { useCallback, useEffect, useState } from 'react';
import {
  AdminAccountPublic,
  AdminStoreComplianceView,
  escalateAdminWarning,
  fetchAdminStoreCompliance,
  hasAdminPermission,
  issueAdminComplianceWarning,
  reactivateAdminStore,
  resolveAdminWarning,
  suspendAdminStore
} from '../../utils/adminSession';
import {
  ORDINARY_VIOLATION_CATEGORY_OPTIONS,
  SERIOUS_VIOLATION_CATEGORY_OPTIONS,
  WARNING_SEVERITY_OPTIONS
} from '../../utils/onboardingConstants';

export interface AdminComplianceTabProps {
  apiUrl: string;
  token: string;
  admin: AdminAccountPublic;
  storeId: string;
  onRefreshStoreDetails: () => void;
  onAuthExpired: (message?: string) => void;
}

export const AdminComplianceTab: React.FC<AdminComplianceTabProps> = ({
  apiUrl,
  token,
  admin,
  storeId,
  onRefreshStoreDetails,
  onAuthExpired
}) => {
  const canManageCompliance = hasAdminPermission(admin, 'STORE_COMPLIANCE_MANAGE');
  const [data, setData] = useState<AdminStoreComplianceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Issue warning state
  const [warnSeverity, setWarnSeverity] = useState('MODERATE');
  const [warnCategory, setWarnCategory] = useState('OPERATIONAL_COMPLIANCE');
  const [warnReason, setWarnReason] = useState('');
  const [warnAction, setWarnAction] = useState('');
  const [warnDeadline, setWarnDeadline] = useState('');
  const [warnEvidenceLabel, setWarnEvidenceLabel] = useState('');

  // Suspend store state
  const [suspendType, setSuspendType] = useState<'ORDINARY_VIOLATION' | 'PROTECTIVE_SERIOUS_RISK'>(
    'ORDINARY_VIOLATION'
  );
  const [suspendCategory, setSuspendCategory] = useState('OPERATIONAL_COMPLIANCE');
  const [suspendReason, setSuspendReason] = useState('');
  const [suspendEvidenceLabel, setSuspendEvidenceLabel] = useState('');

  // Warning resolution / escalation per-row form state
  const [rowNotes, setRowNotes] = useState<
    Record<string, { reason: string; checked: boolean; allowWithoutOwner: boolean; escalateNotes: string }>
  >({});

  // Reactivation form state
  const [reactivateReason, setReactivateReason] = useState('');
  const [reactivateChecked, setReactivateChecked] = useState(false);
  const [reactivateWarningReasons, setReactivateWarningReasons] = useState<
    Record<string, { reason: string; checked: boolean; allowWithoutOwner: boolean }>
  >({});

  const loadCompliance = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetchAdminStoreCompliance({ apiUrl, token, storeId });
    setLoading(false);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok || !res.data) {
      setError(res.error || 'Unable to load store compliance data.');
      return;
    }
    setData(res.data);
  }, [apiUrl, token, storeId, onAuthExpired]);

  useEffect(() => {
    void loadCompliance();
  }, [loadCompliance]);

  const handleIssueWarning = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageCompliance || busy) return;
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    const res = await issueAdminComplianceWarning({
      apiUrl,
      token,
      storeId,
      violationCategory: warnCategory,
      severity: warnSeverity,
      reason: warnReason.trim(),
      requiredCorrectiveAction: warnAction.trim(),
      ...(warnDeadline ? { correctiveDeadline: new Date(warnDeadline).toISOString() } : {}),
      evidenceReferences: warnEvidenceLabel.trim()
        ? [{ kind: 'ADMIN_FINDING', label: warnEvidenceLabel.trim() }]
        : []
    });
    setBusy(false);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Failed to issue compliance warning.');
      return;
    }
    setSuccessMsg('Formal store compliance warning issued and queued for Owner notification.');
    setWarnReason('');
    setWarnAction('');
    setWarnDeadline('');
    setWarnEvidenceLabel('');
    await loadCompliance();
    onRefreshStoreDetails();
  };

  const handleSuspendStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageCompliance || busy) return;
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    const res = await suspendAdminStore({
      apiUrl,
      token,
      storeId,
      suspensionType: suspendType,
      violationCategory: suspendCategory,
      reason: suspendReason.trim(),
      evidenceReferences: suspendEvidenceLabel.trim()
        ? [{ kind: 'COMPLIANCE_EVIDENCE', label: suspendEvidenceLabel.trim() }]
        : []
    });
    setBusy(false);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Suspension blocked by compliance rules.');
      return;
    }
    setSuccessMsg('Store suspended for compliance enforcement and Owner notification queued.');
    setSuspendReason('');
    setSuspendEvidenceLabel('');
    await loadCompliance();
    onRefreshStoreDetails();
  };

  const handleEscalateWarning = async (warningId: string) => {
    const note = rowNotes[warningId]?.escalateNotes?.trim();
    if (!canManageCompliance || busy || !note) return;
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    const res = await escalateAdminWarning({ apiUrl, token, storeId, warningId, notes: note });
    setBusy(false);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Failed to escalate warning.');
      return;
    }
    setSuccessMsg('Warning escalated and logged in audit history.');
    await loadCompliance();
  };

  const handleResolveWarning = async (warningId: string) => {
    const entry = rowNotes[warningId];
    if (!canManageCompliance || busy || !entry?.reason?.trim() || !entry.checked) return;
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    const res = await resolveAdminWarning({
      apiUrl,
      token,
      storeId,
      warningId,
      reason: entry.reason.trim(),
      correctiveEvidenceChecked: entry.checked,
      allowResolutionWithoutOwnerResponse: entry.allowWithoutOwner
    });
    setBusy(false);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Failed to resolve warning.');
      return;
    }
    setSuccessMsg('Warning resolved.');
    await loadCompliance();
    onRefreshStoreDetails();
  };

  const handleReactivateStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageCompliance || busy || !data) return;
    const openWarnings = data.warnings.filter((w) => w.status === 'OPEN');

    const warningResolutions = openWarnings.map((w) => {
      const cfg = reactivateWarningReasons[w.id];
      return {
        warningId: w.id,
        reason: cfg?.reason?.trim() || reactivateReason.trim(),
        correctiveEvidenceChecked: Boolean(cfg?.checked),
        allowResolutionWithoutOwnerResponse: Boolean(cfg?.allowWithoutOwner)
      };
    });

    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    const res = await reactivateAdminStore({
      apiUrl,
      token,
      storeId,
      reason: reactivateReason.trim(),
      correctiveEvidenceReviewed: reactivateChecked,
      warningResolutions
    });
    setBusy(false);
    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Reactivation blocked. Verify open warning resolutions and owner evidence.');
      return;
    }
    setSuccessMsg('Store reactivated cleanly and all selected OPEN warnings atomically resolved.');
    setReactivateReason('');
    setReactivateChecked(false);
    await loadCompliance();
    onRefreshStoreDetails();
  };

  if (loading || !data) {
    return (
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container text-xs text-on-surface-variant flex items-center gap-2">
        <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
        <span>{loading ? 'Loading store compliance state...' : error || 'Compliance record unavailable.'}</span>
      </div>
    );
  }

  const openWarnings = data.warnings.filter((w) => w.status === 'OPEN');
  const warningCategoryOptions =
    warnSeverity === 'HIGH' || warnSeverity === 'CRITICAL'
      ? [...ORDINARY_VIOLATION_CATEGORY_OPTIONS, ...SERIOUS_VIOLATION_CATEGORY_OPTIONS]
      : ORDINARY_VIOLATION_CATEGORY_OPTIONS;
  const suspendCategoryOptions =
    suspendType === 'PROTECTIVE_SERIOUS_RISK'
      ? SERIOUS_VIOLATION_CATEGORY_OPTIONS
      : ORDINARY_VIOLATION_CATEGORY_OPTIONS;

  return (
    <div className="flex flex-col gap-space-lg">
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

      {/* Warning Counts & Policy Summary */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-headline-sm text-base font-bold text-on-surface">
            Compliance Overview &amp; Warning Thresholds
          </h4>
          <span
            className={`px-3 py-1 rounded-full text-xs font-bold ${
              data.complianceState.isSuspended
                ? 'bg-error-container text-on-error-container'
                : 'bg-surface-container text-on-surface'
            }`}
          >
            Status: {data.complianceState.onboardingStatus}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
          <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
            <span className="text-outline block">Open Ordinary</span>
            <strong className="text-base text-on-surface">{data.warningCounts.openOrdinaryWarnings}</strong>
          </div>
          <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
            <span className="text-outline block">Open Serious</span>
            <strong className="text-base text-error">{data.warningCounts.openSeriousWarnings}</strong>
          </div>
          <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
            <span className="text-outline block">Total Open</span>
            <strong className="text-base text-on-surface">{data.warningCounts.totalOpenWarnings}</strong>
          </div>
          <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
            <span className="text-outline block">Overdue Open</span>
            <strong className="text-base text-amber-700 dark:text-amber-300">
              {data.warningCounts.overdueOpenWarnings}
            </strong>
          </div>
          <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
            <span className="text-outline block">Resolved</span>
            <strong className="text-base text-secondary">{data.warningCounts.resolvedWarnings}</strong>
          </div>
        </div>
        <p className="text-xs text-outline">
          Policy enforced on backend: Ordinary suspension requires at least <strong>2 currently OPEN formal ordinary warnings</strong> on this store. Protective suspension handles serious fraud/safety/legal risks directly.
        </p>
      </div>

      {/* Issue New Warning & Suspend Store Forms */}
      {canManageCompliance && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-space-md">
          {/* Issue Warning */}
          <form
            onSubmit={handleIssueWarning}
            className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3"
          >
            <h4 className="font-headline-sm text-sm font-bold text-on-surface">
              Issue Store Compliance Warning
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold block mb-1">Severity</label>
                <select
                  value={warnSeverity}
                  onChange={(e) => {
                    const nextSev = e.target.value;
                    setWarnSeverity(nextSev);
                    if (nextSev !== 'HIGH' && nextSev !== 'CRITICAL') {
                      if (SERIOUS_VIOLATION_CATEGORY_OPTIONS.some((c) => c.value === warnCategory)) {
                        setWarnCategory('OPERATIONAL_COMPLIANCE');
                      }
                    }
                  }}
                  className="w-full bg-surface-container-low border border-surface-container rounded-xl px-2.5 py-2 text-xs"
                >
                  {WARNING_SEVERITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold block mb-1">Violation Category</label>
                <select
                  value={warnCategory}
                  onChange={(e) => setWarnCategory(e.target.value)}
                  className="w-full bg-surface-container-low border border-surface-container rounded-xl px-2.5 py-2 text-xs"
                >
                  {warningCategoryOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <textarea
              required
              rows={2}
              value={warnReason}
              onChange={(e) => setWarnReason(e.target.value)}
              placeholder="Compliance finding / reason *"
              className="w-full bg-surface-container-low border border-surface-container rounded-xl p-2.5 text-xs"
            />
            <textarea
              required
              rows={2}
              value={warnAction}
              onChange={(e) => setWarnAction(e.target.value)}
              placeholder="Required corrective action for Store Owner *"
              className="w-full bg-surface-container-low border border-surface-container rounded-xl p-2.5 text-xs"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-semibold text-outline block mb-1">
                  Corrective Deadline (optional)
                </label>
                <input
                  type="datetime-local"
                  value={warnDeadline}
                  onChange={(e) => setWarnDeadline(e.target.value)}
                  className="w-full bg-surface-container-low border border-surface-container rounded-xl px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-outline block mb-1">
                  Evidence Reference Label
                </label>
                <input
                  type="text"
                  value={warnEvidenceLabel}
                  onChange={(e) => setWarnEvidenceLabel(e.target.value)}
                  placeholder="Optional inspection note"
                  className="w-full bg-surface-container-low border border-surface-container rounded-xl px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded-xl bg-amber-600 text-white text-xs font-bold self-start disabled:opacity-50"
            >
              Issue Formal Warning
            </button>
          </form>

          {/* Suspend OR Reactivate */}
          {!data.complianceState.isSuspended ? (
            <form
              onSubmit={handleSuspendStore}
              className="bg-surface-container-lowest p-space-lg rounded-2xl border border-error/30 shadow-xs flex flex-col gap-3"
            >
              <h4 className="font-headline-sm text-sm font-bold text-error">
                Suspend Merchant Store
              </h4>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-semibold block mb-1">Suspension Type</label>
                  <select
                    value={suspendType}
                    onChange={(e) => {
                      const next = e.target.value as 'ORDINARY_VIOLATION' | 'PROTECTIVE_SERIOUS_RISK';
                      setSuspendType(next);
                      setSuspendCategory(
                        next === 'PROTECTIVE_SERIOUS_RISK'
                          ? 'IMMEDIATE_SAFETY_RISK'
                          : 'OPERATIONAL_COMPLIANCE'
                      );
                    }}
                    className="w-full bg-surface-container-low border border-surface-container rounded-xl px-2.5 py-2 text-xs"
                  >
                    <option value="ORDINARY_VIOLATION">
                      Ordinary Violation ({data.warningCounts.openOrdinaryWarnings}/2 open warnings)
                    </option>
                    <option value="PROTECTIVE_SERIOUS_RISK">
                      Protective Serious Risk (Immediate)
                    </option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold block mb-1">Category</label>
                  <select
                    value={suspendCategory}
                    onChange={(e) => setSuspendCategory(e.target.value)}
                    className="w-full bg-surface-container-low border border-surface-container rounded-xl px-2.5 py-2 text-xs"
                  >
                    {suspendCategoryOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {suspendType === 'ORDINARY_VIOLATION' &&
                data.warningCounts.openOrdinaryWarnings < 2 && (
                  <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-500/10 p-2 rounded-lg">
                    Note: Store currently has {data.warningCounts.openOrdinaryWarnings} OPEN formal ordinary warning(s). Backend requires at least 2 OPEN ordinary warnings for ordinary suspension.
                  </p>
                )}
              <textarea
                required
                rows={3}
                value={suspendReason}
                onChange={(e) => setSuspendReason(e.target.value)}
                placeholder="Detailed suspension reason *"
                className="w-full bg-surface-container-low border border-surface-container rounded-xl p-2.5 text-xs"
              />
              <input
                type="text"
                value={suspendEvidenceLabel}
                onChange={(e) => setSuspendEvidenceLabel(e.target.value)}
                placeholder="Evidence reference (optional)"
                className="w-full bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-xs"
              />
              <button
                type="submit"
                disabled={
                  busy ||
                  (suspendType === 'ORDINARY_VIOLATION' &&
                    data.warningCounts.openOrdinaryWarnings < 2)
                }
                className="px-4 py-2 rounded-xl bg-error text-on-error text-xs font-bold self-start disabled:opacity-40"
              >
                Execute Store Suspension
              </button>
            </form>
          ) : (
            <form
              onSubmit={handleReactivateStore}
              className="bg-surface-container-lowest p-space-lg rounded-2xl border-2 border-secondary/40 shadow-xs flex flex-col gap-3"
            >
              <h4 className="font-headline-sm text-sm font-bold text-secondary">
                Reactivate Suspended Store
              </h4>
              {data.complianceState.ownerSuspensionResponse ? (
                <div className="p-2.5 rounded-xl bg-secondary/10 border border-secondary/30 text-xs">
                  <strong>Owner Remediation Submitted:</strong> {data.complianceState.ownerSuspensionResponse}
                </div>
              ) : (
                <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 p-2 rounded-lg">
                  Owner has not submitted a suspension remediation appeal yet.
                </p>
              )}

              {openWarnings.length > 0 && (
                <div className="flex flex-col gap-2 max-h-56 overflow-y-auto pr-1">
                  <p className="text-xs font-bold text-on-surface">
                    Atomic Resolution Required for {openWarnings.length} Open Warning(s):
                  </p>
                  {openWarnings.map((w) => {
                    const entry = reactivateWarningReasons[w.id] || {
                      reason: '',
                      checked: false,
                      allowWithoutOwner: false
                    };
                    return (
                      <div key={w.id} className="p-2.5 rounded-xl bg-surface-container-low border border-surface-container text-xs flex flex-col gap-1.5">
                        <span className="font-bold">
                          Warning #{w.warningNumber}: {w.violationCategory} (Owner responses: {w.responses.length})
                        </span>
                        <input
                          type="text"
                          required
                          placeholder="Resolution reason *"
                          value={entry.reason}
                          onChange={(e) =>
                            setReactivateWarningReasons((prev) => ({
                              ...prev,
                              [w.id]: { ...entry, reason: e.target.value }
                            }))
                          }
                          className="w-full bg-surface-container-lowest border border-surface-container rounded-lg px-2.5 py-1 text-xs"
                        />
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={entry.checked}
                            onChange={(e) =>
                              setReactivateWarningReasons((prev) => ({
                                ...prev,
                                [w.id]: { ...entry, checked: e.target.checked }
                              }))
                            }
                          />
                          <span>Corrective evidence checked *</span>
                        </label>
                        {w.responses.length === 0 && (
                          <label className="flex items-center gap-1.5 text-amber-800 dark:text-amber-200">
                            <input
                              type="checkbox"
                              checked={entry.allowWithoutOwner}
                              onChange={(e) =>
                                setReactivateWarningReasons((prev) => ({
                                  ...prev,
                                  [w.id]: { ...entry, allowWithoutOwner: e.target.checked }
                                }))
                              }
                            />
                            <span>Explicitly resolve without owner warning response</span>
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <textarea
                required
                rows={2}
                value={reactivateReason}
                onChange={(e) => setReactivateReason(e.target.value)}
                placeholder="Final Admin reactivation justification *"
                className="w-full bg-surface-container-low border border-surface-container rounded-xl p-2.5 text-xs"
              />
              <label className="flex items-center gap-2 text-xs font-semibold">
                <input
                  type="checkbox"
                  checked={reactivateChecked}
                  onChange={(e) => setReactivateChecked(e.target.checked)}
                />
                <span>I confirm all corrective evidence has been reviewed *</span>
              </label>
              <button
                type="submit"
                disabled={busy || !reactivateChecked || !reactivateReason.trim()}
                className="px-4 py-2 rounded-xl bg-secondary text-on-secondary text-xs font-bold self-start disabled:opacity-40"
              >
                Approve Store Reactivation
              </button>
            </form>
          )}
        </div>
      )}

      {/* Warnings Management List */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
        <h4 className="font-headline-sm text-base font-bold text-on-surface">
          Store Compliance Warnings ({data.warnings.length})
        </h4>

        {data.warnings.length === 0 ? (
          <div className="p-6 rounded-xl bg-surface-container-low border border-dashed border-surface-container text-center text-xs text-on-surface-variant">
            No warnings recorded for this store.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {data.warnings.map((w) => {
              const entry = rowNotes[w.id] || {
                reason: '',
                checked: false,
                allowWithoutOwner: false,
                escalateNotes: ''
              };
              const updateRow = (patch: Partial<typeof entry>) =>
                setRowNotes((prev) => ({ ...prev, [w.id]: { ...entry, ...patch } }));

              return (
                <div
                  key={w.id}
                  className="p-4 rounded-xl bg-surface-container-low border border-surface-container flex flex-col gap-2 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm">Warning #{w.warningNumber}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full font-bold text-[11px] ${
                          w.status === 'OPEN'
                            ? 'bg-error-container text-on-error-container'
                            : 'bg-secondary-container text-on-secondary-container'
                        }`}
                      >
                        {w.status}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-surface-container-high font-semibold">
                        {w.severity} • {w.violationCategory}
                      </span>
                      {w.isOverdue && w.status === 'OPEN' && (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-800 dark:text-amber-200 font-bold">
                          OVERDUE
                        </span>
                      )}
                      {w.escalatedAt && (
                        <span className="px-2 py-0.5 rounded-full bg-error/15 text-error font-bold">
                          ESCALATED
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-outline">
                      Issued {new Date(w.issuedAt).toLocaleString()}
                    </span>
                  </div>

                  <p>
                    <strong>Reason:</strong> {w.reason}
                  </p>
                  <p className="text-on-surface-variant">
                    <strong>Required Action:</strong> {w.requiredCorrectiveAction}
                  </p>
                  {w.escalationNotes && (
                    <p className="p-2 rounded bg-error/5 border border-error/20 text-error">
                      <strong>Internal Escalation Notes:</strong> {w.escalationNotes}
                    </p>
                  )}

                  {w.responses.length > 0 && (
                    <div className="pl-3 border-l-2 border-primary/40 flex flex-col gap-1">
                      <span className="text-[11px] font-bold text-outline uppercase">
                        Owner Responses ({w.responses.length})
                      </span>
                      {w.responses.map((r) => (
                        <div key={r.id} className="p-2 rounded bg-surface-container-lowest border border-surface-container">
                          <p>{r.responseMessage}</p>
                          <p className="text-[10px] text-outline mt-0.5">
                            {new Date(r.createdAt).toLocaleString()}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {w.status === 'OPEN' && canManageCompliance && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-surface-container mt-1">
                      {/* Escalate */}
                      <div className="flex flex-col gap-1.5">
                        <input
                          type="text"
                          placeholder="Escalation notes..."
                          value={entry.escalateNotes}
                          onChange={(e) => updateRow({ escalateNotes: e.target.value })}
                          className="bg-surface-container-lowest border border-surface-container rounded-lg px-2.5 py-1.5 text-xs"
                        />
                        <button
                          type="button"
                          disabled={busy || !entry.escalateNotes.trim()}
                          onClick={() => void handleEscalateWarning(w.id)}
                          className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-bold self-start disabled:opacity-40"
                        >
                          Escalate Warning
                        </button>
                      </div>

                      {/* Resolve */}
                      <div className="flex flex-col gap-1.5">
                        <input
                          type="text"
                          placeholder="Resolution verification reason..."
                          value={entry.reason}
                          onChange={(e) => updateRow({ reason: e.target.value })}
                          className="bg-surface-container-lowest border border-surface-container rounded-lg px-2.5 py-1.5 text-xs"
                        />
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={entry.checked}
                            onChange={(e) => updateRow({ checked: e.target.checked })}
                          />
                          <span>Corrective evidence verified</span>
                        </label>
                        {w.responses.length === 0 && (
                          <label className="flex items-center gap-1.5 text-amber-800 dark:text-amber-200">
                            <input
                              type="checkbox"
                              checked={entry.allowWithoutOwner}
                              onChange={(e) => updateRow({ allowWithoutOwner: e.target.checked })}
                            />
                            <span>Resolve without owner response</span>
                          </label>
                        )}
                        <button
                          type="button"
                          disabled={busy || !entry.checked || !entry.reason.trim()}
                          onClick={() => void handleResolveWarning(w.id)}
                          className="px-3 py-1.5 rounded-lg bg-secondary text-on-secondary font-bold self-start disabled:opacity-40"
                        >
                          Resolve Warning
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
