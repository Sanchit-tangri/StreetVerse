import React, { useCallback, useEffect, useState } from 'react';
import {
  AuthorizedSellerStore,
  canManageStoreKyc
} from '../../utils/sellerSession';
import {
  fetchSellerStoreCompliance,
  OwnerComplianceWarningSummary,
  OwnerStoreComplianceView,
  respondToSellerSuspension,
  respondToSellerWarning,
  SafeEvidenceReference
} from '../../utils/sellerOnboarding';
import { formatCategoryLabel } from '../../utils/onboardingConstants';

export interface SellerComplianceWorkspaceProps {
  apiUrl: string;
  token: string;
  activeStore: AuthorizedSellerStore;
  onAuthExpired: (message?: string) => void;
}

export const SellerComplianceWorkspace: React.FC<SellerComplianceWorkspaceProps> = ({
  apiUrl,
  token,
  activeStore,
  onAuthExpired
}) => {
  const allowOwner = canManageStoreKyc(activeStore);
  const [data, setData] = useState<OwnerStoreComplianceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Suspension response form state
  const [suspensionMsg, setSuspensionMsg] = useState('');
  const [suspensionEvidenceLabel, setSuspensionEvidenceLabel] = useState('');
  const [submittingSuspension, setSubmittingSuspension] = useState(false);

  // Per-warning response draft state
  const [warningDrafts, setWarningDrafts] = useState<
    Record<string, { message: string; evidenceLabel: string; submitting: boolean }>
  >({});

  const loadCompliance = useCallback(async () => {
    if (!allowOwner) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await fetchSellerStoreCompliance({ apiUrl, token, activeStore });
    if (res.authExpired) {
      onAuthExpired(res.error || 'Seller session expired.');
      return;
    }
    if (!res.ok || !res.data) {
      setError(res.error || 'Unable to load store compliance record.');
      setLoading(false);
      return;
    }
    setData(res.data);
    setLoading(false);
  }, [allowOwner, apiUrl, token, activeStore, onAuthExpired]);

  useEffect(() => {
    void loadCompliance();
  }, [loadCompliance]);

  const handleSubmitSuspensionResponse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allowOwner || !suspensionMsg.trim() || submittingSuspension) return;
    setSubmittingSuspension(true);
    setError(null);
    setSuccessMsg(null);

    const evidence: SafeEvidenceReference[] = suspensionEvidenceLabel.trim()
      ? [{ kind: 'OWNER_REMEDIATION', label: suspensionEvidenceLabel.trim() }]
      : [];

    const res = await respondToSellerSuspension({
      apiUrl,
      token,
      activeStore,
      responseMessage: suspensionMsg.trim(),
      evidenceReferences: evidence
    });

    if (res.authExpired) {
      setSubmittingSuspension(false);
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Failed to submit suspension remediation response.');
      setSubmittingSuspension(false);
      return;
    }

    setSuccessMsg('Suspension remediation response submitted. Admin team has been notified for reactivation review.');
    setSuspensionMsg('');
    setSuspensionEvidenceLabel('');
    setSubmittingSuspension(false);
    await loadCompliance();
  };

  const updateWarningDraft = (
    warningId: string,
    patch: Partial<{ message: string; evidenceLabel: string; submitting: boolean }>
  ) => {
    setWarningDrafts((prev) => ({
      ...prev,
      [warningId]: {
        message: prev[warningId]?.message ?? '',
        evidenceLabel: prev[warningId]?.evidenceLabel ?? '',
        submitting: prev[warningId]?.submitting ?? false,
        ...patch
      }
    }));
  };

  const handleRespondWarning = async (w: OwnerComplianceWarningSummary, e: React.FormEvent) => {
    e.preventDefault();
    const draft = warningDrafts[w.id];
    if (!allowOwner || !draft?.message.trim() || draft?.submitting) return;
    updateWarningDraft(w.id, { submitting: true });
    setError(null);
    setSuccessMsg(null);

    const evidence: SafeEvidenceReference[] = draft.evidenceLabel.trim()
      ? [{ kind: 'OWNER_CORRECTIVE_NOTE', label: draft.evidenceLabel.trim() }]
      : [];

    const res = await respondToSellerWarning({
      apiUrl,
      token,
      activeStore,
      warningId: w.id,
      responseMessage: draft.message.trim(),
      evidenceReferences: evidence
    });

    if (res.authExpired) {
      updateWarningDraft(w.id, { submitting: false });
      onAuthExpired(res.error || undefined);
      return;
    }

    if (!res.ok) {
      setError(res.error || 'Failed to submit warning response.');
      updateWarningDraft(w.id, { submitting: false });
      return;
    }

    setSuccessMsg(`Corrective response recorded for Warning #${w.warningNumber}. Status remains Open until Admin resolves it.`);
    updateWarningDraft(w.id, { message: '', evidenceLabel: '', submitting: false });
    await loadCompliance();
  };

  if (!allowOwner) {
    return (
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs">
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 text-sm font-semibold flex items-start gap-2">
          <span className="material-symbols-outlined text-base shrink-0 mt-0.5">lock</span>
          <div>
            <p className="font-bold">Store Owner Permission Required</p>
            <p className="font-normal mt-0.5">
              Your role for {activeStore.businessName} is {activeStore.role}. Store compliance warnings and suspension appeals are restricted to active Store Owners.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container flex items-center gap-2 text-sm text-on-surface-variant">
        <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
        <span>Loading compliance and warning history for {activeStore.businessName}...</span>
      </div>
    );
  }

  const state = data?.complianceState;
  const counts = data?.warningCounts;
  const warnings = data?.warnings || [];

  return (
    <div className="flex flex-col gap-space-lg">
      {/* Header & Store-Scope Explanation */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">
              Store Compliance & Corrective Enforcement
            </h3>
            <p className="font-body-sm text-xs text-on-surface-variant mt-0.5">
              Store-specific compliance for <strong>{activeStore.businessName}</strong> ({formatCategoryLabel(activeStore.category)}). Warnings and suspensions affect only this individual store, never your other Seller Account stores.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadCompliance()}
            className="px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-container-high text-xs font-bold text-on-surface flex items-center gap-1 self-start"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
            <span>Refresh</span>
          </button>
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

        {/* KPI Cards */}
        {counts && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-sm">
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <p className="text-[11px] font-semibold text-outline uppercase">Store Status</p>
              <p className={`text-sm font-bold mt-1 ${state?.isSuspended ? 'text-error' : 'text-on-surface'}`}>
                {state?.onboardingStatus || 'UNKNOWN'}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <p className="text-[11px] font-semibold text-outline uppercase">Open Ordinary Warnings</p>
              <p className="text-sm font-bold mt-1 text-on-surface">{counts.openOrdinaryWarnings}</p>
            </div>
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <p className="text-[11px] font-semibold text-outline uppercase">Open Serious Warnings</p>
              <p className="text-sm font-bold mt-1 text-error">{counts.openSeriousWarnings}</p>
            </div>
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
              <p className="text-[11px] font-semibold text-outline uppercase">Overdue Open</p>
              <p className="text-sm font-bold mt-1 text-amber-700 dark:text-amber-300">
                {counts.overdueOpenWarnings}
              </p>
            </div>
          </div>
        )}

        {state?.lastReactivatedAt && (
          <div className="p-3 rounded-xl bg-secondary/10 border border-secondary/30 text-xs text-on-surface">
            <p className="font-bold text-secondary">
              Store Reactivated ({new Date(state.lastReactivatedAt).toLocaleString()})
            </p>
            {state.lastReactivationReason && <p className="mt-0.5">{state.lastReactivationReason}</p>}
          </div>
        )}
      </div>

      {/* Suspended Banner + Remediation Appeal Form */}
      {state?.isSuspended && (
        <div className="bg-surface-container-lowest p-space-lg rounded-2xl border-2 border-error/40 shadow-xs flex flex-col gap-space-md">
          <div className="flex items-start gap-2.5 text-error">
            <span className="material-symbols-outlined text-2xl shrink-0">gavel</span>
            <div>
              <h4 className="font-headline-sm text-base font-bold">
                Store Currently Suspended ({state.suspensionType || 'COMPLIANCE'})
              </h4>
              <p className="text-xs text-on-surface mt-1">
                <strong>Reason:</strong> {state.suspensionReason || 'Compliance enforcement action.'}
              </p>
              {state.suspendedAt && (
                <p className="text-[11px] text-outline mt-0.5">
                  Suspended at: {new Date(state.suspendedAt).toLocaleString()}
                </p>
              )}
            </div>
          </div>

          {state.ownerSuspensionResponse && (
            <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container text-xs">
              <p className="font-bold text-on-surface">
                Submitted Remediation Response ({state.ownerSuspensionRespondedAt ? new Date(state.ownerSuspensionRespondedAt).toLocaleString() : ''})
              </p>
              <p className="text-on-surface-variant mt-1">{state.ownerSuspensionResponse}</p>
            </div>
          )}

          <form onSubmit={handleSubmitSuspensionResponse} className="flex flex-col gap-2">
            <label className="text-xs font-bold text-on-surface">
              Submit / Update Suspension Remediation & Reactivation Evidence *
            </label>
            <textarea
              required
              minLength={5}
              rows={3}
              value={suspensionMsg}
              onChange={(e) => setSuspensionMsg(e.target.value)}
              placeholder="Explain the concrete corrective steps taken for this store and request Admin review..."
              className="w-full bg-surface-container-low border border-surface-container rounded-xl p-2.5 text-xs text-on-surface outline-none focus:ring-2 focus:ring-primary/40"
            />
            <input
              type="text"
              value={suspensionEvidenceLabel}
              onChange={(e) => setSuspensionEvidenceLabel(e.target.value)}
              placeholder="Optional evidence note (e.g., Updated sanitation log / uploaded renewed certificate)"
              className="w-full bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-xs text-on-surface outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              type="submit"
              disabled={submittingSuspension || suspensionMsg.trim().length < 5}
              className="self-start px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-bold disabled:opacity-50"
            >
              {submittingSuspension ? 'Submitting...' : 'Submit Suspension Remediation'}
            </button>
          </form>
        </div>
      )}

      {/* Warnings List */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
        <h4 className="font-headline-sm text-base font-bold text-on-surface">
          Store Compliance Warnings ({warnings.length})
        </h4>

        {warnings.length === 0 ? (
          <div className="p-6 rounded-xl bg-surface-container-low border border-dashed border-surface-container text-center text-xs text-on-surface-variant">
            No formal compliance warnings have been issued for {activeStore.businessName}.
          </div>
        ) : (
          <div className="flex flex-col gap-space-md">
            {warnings.map((w) => {
              const draft = warningDrafts[w.id] || { message: '', evidenceLabel: '', submitting: false };
              return (
                <div
                  key={w.id}
                  className="p-space-md rounded-xl bg-surface-container-low border border-surface-container flex flex-col gap-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-on-surface">Warning #{w.warningNumber}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                          w.status === 'OPEN'
                            ? 'bg-error-container text-on-error-container'
                            : 'bg-secondary-container text-on-secondary-container'
                        }`}
                      >
                        {w.status}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-surface-container-high text-on-surface-variant">
                        {w.severity} • {w.violationCategory.replace(/_/g, ' ')}
                      </span>
                      {w.isOverdue && w.status === 'OPEN' && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-800 dark:text-amber-200">
                          OVERDUE
                        </span>
                      )}
                      {w.isEscalated && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-error/15 text-error">
                          ESCALATED
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-outline">
                      Issued: {new Date(w.issuedAt).toLocaleString()}
                    </span>
                  </div>

                  <p className="text-xs text-on-surface">
                    <strong>Finding:</strong> {w.reason}
                  </p>
                  <p className="text-xs text-on-surface-variant">
                    <strong>Required Corrective Action:</strong> {w.requiredCorrectiveAction}
                  </p>
                  {w.correctiveDeadline && (
                    <p className="text-[11px] text-outline">
                      Corrective Deadline: {new Date(w.correctiveDeadline).toLocaleString()}
                    </p>
                  )}

                  {w.resolvedAt && (
                    <div className="p-2.5 rounded-lg bg-secondary/10 border border-secondary/30 text-xs text-secondary">
                      <strong>Resolved ({new Date(w.resolvedAt).toLocaleString()}):</strong>{' '}
                      {w.resolutionReason || 'Verified by Administrator.'}
                    </div>
                  )}

                  {w.responses.length > 0 && (
                    <div className="flex flex-col gap-1.5 mt-1 pl-3 border-l-2 border-primary/40">
                      <p className="text-[11px] font-bold text-outline uppercase">Owner Responses</p>
                      {w.responses.map((resp) => (
                        <div key={resp.id} className="text-xs bg-surface-container-lowest p-2 rounded-lg border border-surface-container">
                          <p className="text-on-surface">{resp.responseMessage}</p>
                          <p className="text-[10px] text-outline mt-0.5">
                            Submitted {new Date(resp.createdAt).toLocaleString()}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {w.status === 'OPEN' && (
                    <form onSubmit={(e) => void handleRespondWarning(w, e)} className="mt-2 pt-2 border-t border-surface-container flex flex-col gap-2">
                      <textarea
                        required
                        minLength={5}
                        rows={2}
                        value={draft.message}
                        onChange={(e) => updateWarningDraft(w.id, { message: e.target.value })}
                        placeholder="Submit corrective action explanation for this warning..."
                        className="w-full bg-surface-container-lowest border border-surface-container rounded-xl p-2 text-xs text-on-surface outline-none focus:ring-2 focus:ring-primary/40"
                      />
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={draft.evidenceLabel}
                          onChange={(e) => updateWarningDraft(w.id, { evidenceLabel: e.target.value })}
                          placeholder="Optional supporting evidence description"
                          className="flex-1 bg-surface-container-lowest border border-surface-container rounded-xl px-3 py-1.5 text-xs text-on-surface outline-none focus:ring-2 focus:ring-primary/40"
                        />
                        <button
                          type="submit"
                          disabled={draft.submitting || draft.message.trim().length < 5}
                          className="px-3 py-1.5 rounded-xl bg-primary text-on-primary text-xs font-bold disabled:opacity-50"
                        >
                          {draft.submitting ? 'Sending...' : 'Submit Corrective Response'}
                        </button>
                      </div>
                    </form>
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
