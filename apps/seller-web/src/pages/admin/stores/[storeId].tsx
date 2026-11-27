import React, { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAdminSession } from '../../../hooks/useAdminSession';
import { AdminAuthCard } from '../../../components/admin/AdminAuthCard';
import { AdminPortalHeader } from '../../../components/admin/AdminPortalHeader';
import { AdminComplianceTab } from '../../../components/admin/AdminComplianceTab';
import { AdminOutboxTab } from '../../../components/admin/AdminOutboxTab';
import {
  SecureDocumentPreviewModal,
  SecureDocumentPreviewTarget
} from '../../../components/onboarding/SecureDocumentPreviewModal';
import {
  AdminReviewChecklistInput,
  AdminStoreOnboardingDetails,
  approveAdminSubmission,
  fetchAdminDocumentBlob,
  fetchAdminStoreDetails,
  hasAdminPermission,
  rejectAdminSubmission,
  requestAdminSubmissionInfo,
  startAdminSubmissionReview
} from '../../../utils/adminSession';
import {
  ADMIN_REVIEW_CHECKLIST_ITEMS,
  formatBytes,
  formatCategoryLabel,
  getOnboardingStatusMeta,
  REJECTION_CATEGORY_OPTIONS,
  REQUESTABLE_CORRECTION_TOPICS
} from '../../../utils/onboardingConstants';

type StoreDetailTab = 'REVIEW' | 'COMPLIANCE' | 'AUDIT' | 'OUTBOX';

function createInitialChecklist(): AdminReviewChecklistInput {
  return {
    sellerIdentityReviewed: false,
    businessNameAndCategoryConfirmed: false,
    fixedPhysicalShopConfirmed: false,
    gpsLocationChecked: false,
    storefrontPhotosInspected: false,
    premisesEvidenceChecked: false,
    categoryDocumentsChecked: false,
    informationConsistent: false,
    noUnresolvedDiscrepancy: false,
    confirmedRequirementKeys: []
  };
}

export default function AdminStoreDetailPage() {
  const router = useRouter();
  const storeId = typeof router.query.storeId === 'string' ? router.query.storeId : '';
  const session = useAdminSession();

  const [activeTab, setActiveTab] = useState<StoreDetailTab>('REVIEW');
  const [details, setDetails] = useState<AdminStoreOnboardingDetails | null>(null);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);

  // Secure Document Preview Modal
  const [previewTarget, setPreviewTarget] = useState<
    (SecureDocumentPreviewTarget & { submissionId: string }) | null
  >(null);

  // Review Decision Inputs
  const [checklist, setChecklist] = useState<AdminReviewChecklistInput>(createInitialChecklist);
  const [reviewNotes, setReviewNotes] = useState('');
  const [moreInfoReason, setMoreInfoReason] = useState('');
  const [requestedCorrections, setRequestedCorrections] = useState<string[]>([]);
  const [requestedRequirements, setRequestedRequirements] = useState<string[]>([]);
  const [rejectCategory, setRejectCategory] = useState('INVALID_DOCUMENT');
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    if (!router.isReady) return;
    const rawTab = typeof router.query.tab === 'string' ? router.query.tab.toUpperCase() : '';
    if (rawTab === 'REVIEW' || rawTab === 'COMPLIANCE' || rawTab === 'AUDIT' || rawTab === 'OUTBOX') {
      setActiveTab(rawTab);
    }
  }, [router.isReady, router.query.tab]);

  const loadDetails = useCallback(async () => {
    if (!storeId || session.status !== 'authenticated' || !session.token) return;
    setLoading(true);
    setError(null);
    const res = await fetchAdminStoreDetails({
      apiUrl: session.apiUrl,
      token: session.token,
      storeId
    });
    setLoading(false);
    if (res.authExpired) {
      session.logout(res.error || undefined);
      return;
    }
    if (!res.ok || !res.data) {
      setError(res.error || 'Failed to load store onboarding details.');
      return;
    }
    setDetails(res.data);
    setSelectedSubmissionId((prev) => {
      if (prev && res.data!.submissions.some((s) => s.id === prev)) return prev;
      return (
        res.data!.profile?.currentSubmissionId ||
        res.data!.submissions[0]?.id ||
        ''
      );
    });
  }, [storeId, session]);

  useEffect(() => {
    if (router.isReady && storeId && session.status === 'authenticated') {
      void loadDetails();
    }
  }, [router.isReady, storeId, session.status, loadDetails]);

  const loadAdminDocForPreview = useCallback(
    async (documentId: string) => {
      if (!session.token || !previewTarget) {
        return { ok: false, error: 'Missing document stream context.' };
      }
      const res = await fetchAdminDocumentBlob({
        apiUrl: session.apiUrl,
        token: session.token,
        submissionId: previewTarget.submissionId,
        documentId
      });
      if (res.authExpired) {
        session.logout(res.error || undefined);
      }
      return {
        ok: res.ok,
        error: res.error,
        blob: res.data?.blob,
        mimeType: res.data?.mimeType,
        filename: res.data?.filename
      };
    },
    [session, previewTarget]
  );

  if (!session.authChecked) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center text-sm text-on-surface">
        <span>Verifying Admin Session...</span>
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

  const canDecide = hasAdminPermission(session.admin, 'KYC_REVIEW_DECIDE');
  const canReadDocs = hasAdminPermission(session.admin, 'KYC_SUBMISSION_READ');
  const canCompliance = hasAdminPermission(session.admin, 'STORE_COMPLIANCE_MANAGE');

  const selectedSubmission =
    details?.submissions.find((s) => s.id === selectedSubmissionId) || details?.submissions[0] || null;
  const isCurrentSubmission =
    Boolean(selectedSubmission && details?.profile?.currentSubmissionId === selectedSubmission.id);
  const submissionDocs = details
    ? details.documents.filter((d) => d.submissionId === selectedSubmission?.id)
    : [];

  const mandatoryReqKeys = details
    ? details.requirements.filter((r) => r.isMandatory).map((r) => r.requirementKey.toUpperCase())
    : [];
  const allFlagsChecked = ADMIN_REVIEW_CHECKLIST_ITEMS.every((item) => checklist[item.key] === true);
  const allMandatoryConfirmed = mandatoryReqKeys.every((key) =>
    checklist.confirmedRequirementKeys.includes(key)
  );
  const prereqsClear =
    Boolean(details?.prerequisiteCheck) &&
    details!.prerequisiteCheck.missingRequirements.length === 0 &&
    !details!.prerequisiteCheck.missingGps &&
    !details!.prerequisiteCheck.missingPremisesConfirmation &&
    !details!.prerequisiteCheck.missingAddress;

  const subStatus = selectedSubmission?.status || '';
  const canStartReview = canDecide && isCurrentSubmission && subStatus === 'SUBMITTED';
  const canFinalizeDecision =
    canDecide &&
    isCurrentSubmission &&
    (subStatus === 'SUBMITTED' || subStatus === 'UNDER_REVIEW');

  const handleStartReview = async () => {
    if (!selectedSubmission || !canStartReview || busyAction) return;
    setBusyAction(true);
    setActionError(null);
    setActionSuccess(null);
    const res = await startAdminSubmissionReview({
      apiUrl: session.apiUrl,
      token: session.token!,
      submissionId: selectedSubmission.id,
      reviewNotes: reviewNotes.trim() || undefined
    });
    setBusyAction(false);
    if (res.authExpired) {
      session.logout(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setActionError(res.error || 'Failed to start review.');
      return;
    }
    setActionSuccess(`Submission v${selectedSubmission.submissionVersion} moved to UNDER_REVIEW.`);
    await loadDetails();
  };

  const handleApprove = async () => {
    if (!selectedSubmission || !canFinalizeDecision || busyAction) return;
    setBusyAction(true);
    setActionError(null);
    setActionSuccess(null);
    const res = await approveAdminSubmission({
      apiUrl: session.apiUrl,
      token: session.token!,
      submissionId: selectedSubmission.id,
      checklist,
      reviewNotes: reviewNotes.trim() || undefined
    });
    setBusyAction(false);
    if (res.authExpired) {
      session.logout(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setActionError(res.error || 'Approval blocked by validation rules.');
      return;
    }
    setActionSuccess(`Store verified and submission v${selectedSubmission.submissionVersion} approved.`);
    await loadDetails();
  };

  const handleRequestInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSubmission || !canFinalizeDecision || busyAction || !moreInfoReason.trim()) return;
    setBusyAction(true);
    setActionError(null);
    setActionSuccess(null);
    const res = await requestAdminSubmissionInfo({
      apiUrl: session.apiUrl,
      token: session.token!,
      submissionId: selectedSubmission.id,
      reason: moreInfoReason.trim(),
      requestedCorrections,
      requestedRequirements,
      reviewNotes: reviewNotes.trim() || undefined
    });
    setBusyAction(false);
    if (res.authExpired) {
      session.logout(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setActionError(res.error || 'Failed to request more information.');
      return;
    }
    setActionSuccess('Requested additional information and notified Store Owner.');
    setMoreInfoReason('');
    setRequestedCorrections([]);
    setRequestedRequirements([]);
    await loadDetails();
  };

  const handleReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSubmission || !canFinalizeDecision || busyAction || !rejectReason.trim()) return;
    setBusyAction(true);
    setActionError(null);
    setActionSuccess(null);
    const res = await rejectAdminSubmission({
      apiUrl: session.apiUrl,
      token: session.token!,
      submissionId: selectedSubmission.id,
      reason: rejectReason.trim(),
      rejectionCategory: rejectCategory,
      reviewNotes: reviewNotes.trim() || undefined
    });
    setBusyAction(false);
    if (res.authExpired) {
      session.logout(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setActionError(res.error || 'Failed to reject submission.');
      return;
    }
    setActionSuccess('Submission rejected with reason logged and Owner notification queued.');
    setRejectReason('');
    await loadDetails();
  };

  const toggleStringInArray = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  return (
    <div className="min-h-screen bg-surface text-on-surface flex flex-col">
      <Head>
        <title>
          {details ? `${details.store.businessName} — Admin Store Review` : 'Admin Store Review — StreetVerse'}
        </title>
      </Head>

      <AdminPortalHeader
        admin={session.admin}
        subtitle={details ? details.store.businessName : 'Store Inspection'}
        onLogout={session.logout}
      />

      <main className="w-full pt-28 flex-1 pb-16">
        <div className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin flex flex-col gap-space-lg">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              href="/admin"
              className="text-xs font-bold text-primary hover:underline flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">arrow_back</span>
              <span>Back to Admin Operations Queue</span>
            </Link>
            <button
              type="button"
              onClick={() => void loadDetails()}
              className="px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-container-high text-xs font-bold flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
              <span>Reload Store Data</span>
            </button>
          </div>

          {loading ? (
            <div className="p-8 bg-surface-container-lowest rounded-2xl border border-surface-container text-center text-xs text-on-surface-variant">
              Loading store onboarding profile, submissions, and audit records...
            </div>
          ) : error || !details ? (
            <div role="alert" className="p-6 bg-error/10 border border-error/30 rounded-2xl text-error text-sm font-semibold">
              {error || 'Store not found.'}
            </div>
          ) : (
            <>
              {/* Store Overview Header Card */}
              <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h1 className="font-headline-sm text-xl font-bold text-on-surface">
                        {details.store.businessName}
                      </h1>
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-bold ${
                          getOnboardingStatusMeta(details.profile?.status).toneClass
                        }`}
                      >
                        {getOnboardingStatusMeta(details.profile?.status).label}
                      </span>
                      <span className="px-2.5 py-0.5 rounded-full bg-surface-container text-xs font-semibold">
                        {formatCategoryLabel(details.store.category)}
                      </span>
                    </div>
                    <p className="font-mono text-xs text-outline mt-1">
                      Store ID: {details.store.id} • Storefront Active: {details.store.isOpen ? 'OPEN' : 'CLOSED'}
                    </p>
                  </div>
                </div>

                {details.profile?.reverificationRequired && (
                  <div className="p-3 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-900 dark:text-amber-200 text-xs font-semibold">
                    <strong>Location Re-verification Alert:</strong>{' '}
                    {details.profile.reverificationReason || 'Address or GPS coordinates changed beyond 100m threshold.'}
                    {details.profile.approvedAddress && (
                      <span className="block font-normal mt-1">
                        Previously Approved: {details.profile.approvedAddress} ({details.profile.approvedPincode}) — [
                        {details.profile.approvedLatitude}, {details.profile.approvedLongitude}]
                      </span>
                    )}
                  </div>
                )}

                {/* Navigation Subtabs */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-surface-container">
                  <button
                    type="button"
                    onClick={() => setActiveTab('REVIEW')}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold ${
                      activeTab === 'REVIEW'
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container text-on-surface-variant'
                    }`}
                  >
                    KYC Submission &amp; Verification ({details.submissions.length})
                  </button>
                  {canCompliance && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('COMPLIANCE')}
                      className={`px-3.5 py-1.5 rounded-xl text-xs font-bold ${
                        activeTab === 'COMPLIANCE'
                          ? 'bg-primary text-on-primary'
                          : 'bg-surface-container text-on-surface-variant'
                      }`}
                    >
                      Warnings &amp; Suspension Compliance
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveTab('AUDIT')}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold ${
                      activeTab === 'AUDIT'
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container text-on-surface-variant'
                    }`}
                  >
                    Audit &amp; Delivery History ({details.auditEvents.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('OUTBOX')}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold ${
                      activeTab === 'OUTBOX'
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container text-on-surface-variant'
                    }`}
                  >
                    Store Outbox Events
                  </button>
                </div>
              </div>

              {/* SUBTAB 1: KYC REVIEW */}
              {activeTab === 'REVIEW' && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-space-lg">
                  {/* Left 2 cols: Submission Versions, Snapshots & Documents */}
                  <div className="lg:col-span-2 flex flex-col gap-space-md">
                    {/* Store Profile & Location Coordinates Card */}
                    <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3 text-xs">
                      <h3 className="font-headline-sm text-sm font-bold text-on-surface">
                        Store Location, Fixed-Shop Eligibility &amp; Owners
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
                          <p className="font-bold text-on-surface">Current Profile Location</p>
                          <p className="text-on-surface-variant mt-1">
                            {details.profile?.address || details.store.address},{' '}
                            {details.profile?.pincode || details.store.pincode}
                          </p>
                          <p className="font-mono text-[11px] text-outline mt-1">
                            GPS: {details.profile?.latitude ?? details.store.latitude},{' '}
                            {details.profile?.longitude ?? details.store.longitude}
                            {details.profile?.gpsAccuracyMeters
                              ? ` (±${details.profile.gpsAccuracyMeters}m)`
                              : ''}
                          </p>
                          <p className="text-[11px] text-outline mt-1">
                            Ownership: {details.profile?.premisesOwnershipType || 'Not set'} • Fixed Shop:{' '}
                            {details.profile?.fixedPremisesConfirmed ? 'Confirmed' : 'Pending'}
                          </p>
                          {(details.profile?.latitude || details.store.latitude) && (
                            <a
                              href={`https://www.openstreetmap.org/?mlat=${
                                details.profile?.latitude ?? details.store.latitude
                              }&mlon=${details.profile?.longitude ?? details.store.longitude}#map=18/${
                                details.profile?.latitude ?? details.store.latitude
                              }/${details.profile?.longitude ?? details.store.longitude}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-block mt-1.5 text-primary font-bold hover:underline"
                            >
                              Verify GPS Pin on OpenStreetMap ↗
                            </a>
                          )}
                        </div>

                        <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
                          <p className="font-bold text-on-surface">Authorized Store Memberships</p>
                          <div className="flex flex-col gap-1.5 mt-1.5">
                            {details.memberships.map((m) => (
                              <div key={m.membershipId} className="flex items-center justify-between gap-2">
                                <span className="truncate">
                                  <strong>{m.role}:</strong> {m.email}
                                </span>
                                <span className="px-1.5 py-0.5 rounded bg-surface-container text-[10px] font-bold">
                                  {m.membershipStatus}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Submission Selector & Snapshot Details */}
                    <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-headline-sm text-sm font-bold text-on-surface">
                          Submission Versions &amp; Attached Evidence
                        </h3>
                        {details.submissions.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {details.submissions.map((sub) => (
                              <button
                                key={sub.id}
                                type="button"
                                onClick={() => setSelectedSubmissionId(sub.id)}
                                className={`px-2.5 py-1 rounded-lg text-xs font-bold ${
                                  selectedSubmission?.id === sub.id
                                    ? 'bg-primary text-on-primary'
                                    : 'bg-surface-container text-on-surface-variant'
                                }`}
                              >
                                v{sub.submissionVersion} ({sub.status})
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {!selectedSubmission ? (
                        <div className="p-6 rounded-xl bg-surface-container-low border border-dashed border-surface-container text-center text-xs text-on-surface-variant">
                          No KYC submission created by Store Owner yet.
                        </div>
                      ) : (
                        <>
                          <div className="p-3.5 rounded-xl bg-surface-container-low border border-surface-container text-xs flex flex-col gap-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-bold text-sm">
                                Submission v{selectedSubmission.submissionVersion} — {selectedSubmission.status}
                              </span>
                              <span className="text-outline">
                                {selectedSubmission.submittedAt
                                  ? `Submitted ${new Date(selectedSubmission.submittedAt).toLocaleString()}`
                                  : 'Unsubmitted Draft'}
                              </span>
                            </div>
                            <p className="text-on-surface-variant">
                              Snapshot: <strong>{selectedSubmission.businessNameSnapshot}</strong> ({selectedSubmission.categorySnapshot}) — {selectedSubmission.addressSnapshot}, {selectedSubmission.pincodeSnapshot}
                            </p>
                            {selectedSubmission.ownerFeedbackReason && (
                              <p className="text-on-surface mt-1">
                                <strong>Owner Feedback Sent:</strong> {selectedSubmission.ownerFeedbackReason}
                              </p>
                            )}
                            {selectedSubmission.reviewNotes && (
                              <p className="text-outline mt-0.5">
                                <strong>Internal Notes:</strong> {selectedSubmission.reviewNotes}
                              </p>
                            )}
                          </div>

                          {/* Documents Attached to Selected Submission */}
                          <div className="flex flex-col gap-2">
                            <h4 className="text-xs font-bold text-outline uppercase">
                              Documents in Version v{selectedSubmission.submissionVersion} ({submissionDocs.length})
                            </h4>
                            {submissionDocs.length === 0 ? (
                              <p className="text-xs text-on-surface-variant">No files attached to this submission.</p>
                            ) : (
                              submissionDocs.map((doc) => (
                                <div
                                  key={doc.id}
                                  className="p-3 rounded-xl bg-surface-container-low border border-surface-container flex items-center justify-between gap-2 text-xs"
                                >
                                  <div className="min-w-0">
                                    <p className="font-bold text-on-surface truncate">
                                      {doc.requirementKey} — {doc.originalFilenameSanitized}
                                    </p>
                                    <p className="text-[11px] font-mono text-outline truncate">
                                      {doc.mimeType} • {formatBytes(doc.fileSizeBytes)} • SHA-256: {doc.sha256Checksum.slice(0, 16)}...
                                    </p>
                                  </div>
                                  {canReadDocs && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPreviewTarget({
                                          submissionId: selectedSubmission.id,
                                          documentId: doc.id,
                                          filename: doc.originalFilenameSanitized,
                                          mimeType: doc.mimeType,
                                          sha256Checksum: doc.sha256Checksum
                                        })
                                      }
                                      className="px-3 py-1.5 rounded-lg bg-primary text-on-primary font-bold shrink-0"
                                    >
                                      Inspect Document
                                    </button>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Right col: Review Decision Panel */}
                  <div className="lg:col-span-1 flex flex-col gap-space-md">
                    <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
                      <h3 className="font-headline-sm text-base font-bold text-on-surface">
                        Administrative Verification Decision
                      </h3>

                      {actionError && (
                        <div role="alert" className="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold">
                          {actionError}
                        </div>
                      )}
                      {actionSuccess && (
                        <div className="p-3 rounded-xl bg-secondary/10 border border-secondary/30 text-secondary text-xs font-semibold">
                          {actionSuccess}
                        </div>
                      )}

                      {!canDecide ? (
                        <p className="text-xs text-outline">
                          Your Admin account does not have KYC_REVIEW_DECIDE permission.
                        </p>
                      ) : !selectedSubmission || !isCurrentSubmission ? (
                        <p className="text-xs text-on-surface-variant">
                          Select the store&apos;s current active submission version to perform review actions.
                        </p>
                      ) : (
                        <>
                          {!prereqsClear && (
                            <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-xs text-amber-900 dark:text-amber-200">
                              <strong>Approval Prerequisites Incomplete:</strong>
                              <ul className="list-disc pl-4 mt-1">
                                {details.prerequisiteCheck.missingAddress && <li>Missing address/pincode</li>}
                                {details.prerequisiteCheck.missingGps && <li>Missing valid GPS pin</li>}
                                {details.prerequisiteCheck.missingPremisesConfirmation && (
                                  <li>Fixed physical shop unconfirmed</li>
                                )}
                                {details.prerequisiteCheck.missingRequirements.map((r) => (
                                  <li key={r}>Missing requirement: {r}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          <div>
                            <label className="text-xs font-semibold block mb-1">
                              Internal Review Notes (optional)
                            </label>
                            <textarea
                              rows={2}
                              value={reviewNotes}
                              onChange={(e) => setReviewNotes(e.target.value)}
                              placeholder="Reviewer observations or audit notes..."
                              className="w-full bg-surface-container-low border border-surface-container rounded-xl p-2 text-xs"
                            />
                          </div>

                          {/* Start Review */}
                          {canStartReview && (
                            <button
                              type="button"
                              disabled={busyAction}
                              onClick={() => void handleStartReview()}
                              className="w-full py-2 rounded-xl bg-primary/15 text-primary text-xs font-bold hover:bg-primary/25 disabled:opacity-50"
                            >
                              Mark Submission Under Review
                            </button>
                          )}

                          {canFinalizeDecision && (
                            <>
                              {/* Structured Checklist & Approve */}
                              <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container flex flex-col gap-2 text-xs">
                                <p className="font-bold text-on-surface">
                                  Structured Approval Checklist
                                </p>
                                {ADMIN_REVIEW_CHECKLIST_ITEMS.map((item) => (
                                  <label key={item.key} className="flex items-start gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={checklist[item.key]}
                                      onChange={(e) =>
                                        setChecklist((prev) => ({
                                          ...prev,
                                          [item.key]: e.target.checked
                                        }))
                                      }
                                      className="mt-0.5"
                                    />
                                    <span>{item.label}</span>
                                  </label>
                                ))}

                                {mandatoryReqKeys.length > 0 && (
                                  <div className="pt-2 border-t border-surface-container">
                                    <p className="font-bold text-[11px] text-outline uppercase mb-1">
                                      Confirm Mandatory Requirements Verified
                                    </p>
                                    {mandatoryReqKeys.map((key) => (
                                      <label key={key} className="flex items-center gap-2 cursor-pointer mt-1">
                                        <input
                                          type="checkbox"
                                          checked={checklist.confirmedRequirementKeys.includes(key)}
                                          onChange={() =>
                                            setChecklist((prev) => ({
                                              ...prev,
                                              confirmedRequirementKeys: toggleStringInArray(
                                                prev.confirmedRequirementKeys,
                                                key
                                              )
                                            }))
                                          }
                                        />
                                        <span className="font-mono text-[11px]">{key}</span>
                                      </label>
                                    ))}
                                  </div>
                                )}

                                <button
                                  type="button"
                                  disabled={
                                    busyAction ||
                                    !allFlagsChecked ||
                                    !allMandatoryConfirmed ||
                                    !prereqsClear
                                  }
                                  onClick={() => void handleApprove()}
                                  className="w-full mt-2 py-2.5 rounded-xl bg-secondary text-on-secondary font-bold disabled:opacity-40"
                                >
                                  Approve Physical Store Onboarding
                                </button>
                              </div>

                              {/* Request More Info */}
                              <form
                                onSubmit={handleRequestInfo}
                                className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex flex-col gap-2 text-xs"
                              >
                                <p className="font-bold text-amber-900 dark:text-amber-200">
                                  Request Additional Information
                                </p>
                                <textarea
                                  required
                                  rows={2}
                                  value={moreInfoReason}
                                  onChange={(e) => setMoreInfoReason(e.target.value)}
                                  placeholder="Clear explanation of required corrections for Store Owner *"
                                  className="w-full bg-surface-container-lowest border border-surface-container rounded-xl p-2 text-xs"
                                />
                                <div className="flex flex-col gap-1">
                                  {REQUESTABLE_CORRECTION_TOPICS.map((t) => (
                                    <label key={t.value} className="flex items-center gap-1.5 text-[11px]">
                                      <input
                                        type="checkbox"
                                        checked={requestedCorrections.includes(t.value)}
                                        onChange={() =>
                                          setRequestedCorrections((prev) =>
                                            toggleStringInArray(prev, t.value)
                                          )
                                        }
                                      />
                                      <span>{t.label}</span>
                                    </label>
                                  ))}
                                </div>
                                {details.requirements.length > 0 && (
                                  <div className="flex flex-wrap gap-1 pt-1">
                                    {details.requirements.map((r) => (
                                      <label
                                        key={r.requirementKey}
                                        className="px-2 py-0.5 rounded bg-surface-container-lowest border border-surface-container text-[10px] font-mono flex items-center gap-1 cursor-pointer"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={requestedRequirements.includes(r.requirementKey)}
                                          onChange={() =>
                                            setRequestedRequirements((prev) =>
                                              toggleStringInArray(prev, r.requirementKey)
                                            )
                                          }
                                        />
                                        <span>{r.requirementKey}</span>
                                      </label>
                                    ))}
                                  </div>
                                )}
                                <button
                                  type="submit"
                                  disabled={busyAction || !moreInfoReason.trim()}
                                  className="w-full py-2 rounded-xl bg-amber-600 text-white font-bold disabled:opacity-40"
                                >
                                  Send More-Info Request
                                </button>
                              </form>

                              {/* Reject Submission */}
                              <form
                                onSubmit={handleReject}
                                className="p-3 rounded-xl bg-error/10 border border-error/30 flex flex-col gap-2 text-xs"
                              >
                                <p className="font-bold text-error">Reject Application</p>
                                <select
                                  value={rejectCategory}
                                  onChange={(e) => setRejectCategory(e.target.value)}
                                  className="w-full bg-surface-container-lowest border border-surface-container rounded-xl px-2.5 py-2 text-xs"
                                >
                                  {REJECTION_CATEGORY_OPTIONS.map((c) => (
                                    <option key={c.value} value={c.value}>
                                      {c.label}
                                    </option>
                                  ))}
                                </select>
                                <textarea
                                  required
                                  rows={2}
                                  value={rejectReason}
                                  onChange={(e) => setRejectReason(e.target.value)}
                                  placeholder="Mandatory rejection explanation for Store Owner *"
                                  className="w-full bg-surface-container-lowest border border-surface-container rounded-xl p-2 text-xs"
                                />
                                <button
                                  type="submit"
                                  disabled={busyAction || !rejectReason.trim()}
                                  className="w-full py-2 rounded-xl bg-error text-on-error font-bold disabled:opacity-40"
                                >
                                  Reject Submission
                                </button>
                              </form>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* SUBTAB 2: COMPLIANCE MANAGEMENT */}
              {activeTab === 'COMPLIANCE' && canCompliance && (
                <AdminComplianceTab
                  apiUrl={session.apiUrl}
                  token={session.token}
                  admin={session.admin}
                  storeId={details.store.id}
                  onRefreshStoreDetails={() => void loadDetails()}
                  onAuthExpired={session.logout}
                />
              )}

              {/* SUBTAB 3: AUDIT & NOTIFICATION DELIVERY */}
              {activeTab === 'AUDIT' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-space-md">
                  <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
                    <h3 className="font-headline-sm text-base font-bold text-on-surface">
                      Immutable Onboarding Audit Events ({details.auditEvents.length})
                    </h3>
                    <div className="flex flex-col gap-2 max-h-[520px] overflow-y-auto pr-1 text-xs">
                      {details.auditEvents.map((ev) => (
                        <div key={ev.id} className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-on-surface">{ev.eventType}</span>
                            <span className="text-[11px] text-outline">
                              {new Date(ev.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-[11px] text-outline mt-0.5">
                            Actor: {ev.actorType} {ev.actorId ? `(${ev.actorId})` : ''}
                          </p>
                          {ev.eventMetadata != null && (
                            <pre className="mt-1.5 p-2 rounded bg-surface-container-lowest text-[10px] font-mono overflow-x-auto">
                              {JSON.stringify(ev.eventMetadata, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-headline-sm text-base font-bold text-on-surface">
                        Owner Notification Outbox History ({details.ownerNotificationEvents.length})
                      </h3>
                      <button
                        type="button"
                        onClick={() => setActiveTab('OUTBOX')}
                        className="text-xs font-bold text-primary hover:underline"
                      >
                        Inspect / Replay Outbox →
                      </button>
                    </div>
                    <div className="flex flex-col gap-2 max-h-[520px] overflow-y-auto pr-1 text-xs">
                      {details.ownerNotificationEvents.length === 0 ? (
                        <p className="text-on-surface-variant">No notification events emitted for this store yet.</p>
                      ) : (
                        details.ownerNotificationEvents.map((ne) => (
                          <div key={ne.id} className="p-3 rounded-xl bg-surface-container-low border border-surface-container">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold">{ne.eventType}</span>
                              <span className="px-2 py-0.5 rounded-full bg-surface-container-high font-bold text-[10px]">
                                {ne.deliveryStatus}
                              </span>
                            </div>
                            <p className="text-[11px] text-outline mt-1">
                              Attempts: {ne.deliveryAttempts} • Created: {new Date(ne.createdAt).toLocaleString()}
                              {ne.dispatchedAt ? ` • Dispatched: ${new Date(ne.dispatchedAt).toLocaleString()}` : ''}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* SUBTAB 4: OUTBOX SCOPED TO STORE */}
              {activeTab === 'OUTBOX' && (
                <AdminOutboxTab
                  apiUrl={session.apiUrl}
                  token={session.token}
                  initialStoreId={details.store.id}
                  onAuthExpired={session.logout}
                />
              )}
            </>
          )}
        </div>
      </main>

      <SecureDocumentPreviewModal
        target={previewTarget}
        loader={loadAdminDocForPreview}
        onClose={() => setPreviewTarget(null)}
      />
    </div>
  );
}
