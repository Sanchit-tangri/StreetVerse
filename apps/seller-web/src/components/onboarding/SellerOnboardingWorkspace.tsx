import React, { useCallback, useEffect, useState } from 'react';
import {
  AuthorizedSellerStore,
  canManageStoreKyc
} from '../../utils/sellerSession';
import {
  deleteSellerDraftDocument,
  DocumentRequirement,
  fetchSellerDocumentBlob,
  fetchSellerOnboardingOverview,
  fetchSellerOnboardingSubmissions,
  KycDocumentSummary,
  OnboardingOverview,
  PremisesOwnershipType,
  saveSellerOnboardingDraft,
  SubmissionSummary,
  submitSellerOnboardingApplication,
  uploadSellerOnboardingDocumentWithProgress
} from '../../utils/sellerOnboarding';
import {
  formatBytes,
  formatCategoryLabel,
  getOnboardingStatusMeta,
  PREMISES_OWNERSHIP_OPTIONS,
  REJECTION_CATEGORY_OPTIONS,
  STORE_CATEGORY_OPTIONS
} from '../../utils/onboardingConstants';
import { StoreLocationPicker } from './StoreLocationPicker';
import {
  SecureDocumentPreviewModal,
  SecureDocumentPreviewTarget
} from './SecureDocumentPreviewModal';

export interface SellerOnboardingWorkspaceProps {
  apiUrl: string;
  token: string;
  activeStore: AuthorizedSellerStore;
  onStatusSync?: (status: { onboardingStatus: string; submissionsCount: number }) => void;
  onAuthExpired: (message?: string) => void;
}

export const SellerOnboardingWorkspace: React.FC<SellerOnboardingWorkspaceProps> = ({
  apiUrl,
  token,
  activeStore,
  onStatusSync,
  onAuthExpired
}) => {
  const allowOwner = canManageStoreKyc(activeStore);
  const [overview, setOverview] = useState<OnboardingOverview | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [locationWarningBanner, setLocationWarningBanner] = useState<string | null>(null);

  // Store Profile & Location draft state
  const [businessName, setBusinessName] = useState('');
  const [category, setCategory] = useState('GROCERY');
  const [businessTypeConfirmed, setBusinessTypeConfirmed] = useState(false);
  const [fixedPremisesConfirmed, setFixedPremisesConfirmed] = useState(false);
  const [premisesOwnershipType, setPremisesOwnershipType] = useState<PremisesOwnershipType>('RENTED');
  const [address, setAddress] = useState('');
  const [pincode, setPincode] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [gpsAccuracyMeters, setGpsAccuracyMeters] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);

  // Per-requirement upload progress & status
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [submittingApp, setSubmittingApp] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<SecureDocumentPreviewTarget | null>(null);

  const hydrateOverview = useCallback(async () => {
    if (!allowOwner) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [ovRes, subRes] = await Promise.all([
      fetchSellerOnboardingOverview({ apiUrl, token, activeStore }),
      fetchSellerOnboardingSubmissions({ apiUrl, token, activeStore })
    ]);

    if (ovRes.authExpired || subRes.authExpired) {
      onAuthExpired(ovRes.error || subRes.error || undefined);
      return;
    }

    if (!ovRes.ok || !ovRes.data) {
      setError(ovRes.error || 'Unable to load store onboarding workspace.');
      setLoading(false);
      return;
    }

    const ov = ovRes.data;
    setOverview(ov);
    setBusinessName(ov.profile.businessName || ov.store.businessName || '');
    setCategory(ov.profile.category || ov.store.category || 'GROCERY');
    setBusinessTypeConfirmed(Boolean(ov.profile.businessTypeConfirmed));
    setFixedPremisesConfirmed(Boolean(ov.profile.fixedPremisesConfirmed));
    setPremisesOwnershipType(ov.profile.premisesOwnershipType || 'RENTED');
    setAddress(ov.profile.address || '');
    setPincode(ov.profile.pincode || '');
    setLatitude(ov.profile.latitude !== null ? String(ov.profile.latitude) : '');
    setLongitude(ov.profile.longitude !== null ? String(ov.profile.longitude) : '');
    setGpsAccuracyMeters(
      ov.profile.gpsAccuracyMeters !== null ? String(ov.profile.gpsAccuracyMeters) : ''
    );

    const subs = subRes.ok && subRes.data ? subRes.data.submissions : [];
    setSubmissions(subs);
    onStatusSync?.({
      onboardingStatus: ov.verificationStatus.status,
      submissionsCount: subs.length
    });
    setLoading(false);
  }, [allowOwner, apiUrl, token, activeStore, onAuthExpired, onStatusSync]);

  useEffect(() => {
    void hydrateOverview();
  }, [hydrateOverview]);

  const handleSaveDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allowOwner || !overview?.availableActions.canEditDraft || savingDraft) return;
    setError(null);
    setSuccessMsg(null);
    setLocationWarningBanner(null);

    const parsedLat = latitude.trim() ? Number(latitude) : undefined;
    const parsedLng = longitude.trim() ? Number(longitude) : undefined;
    const parsedAcc = gpsAccuracyMeters.trim() ? Number(gpsAccuracyMeters) : undefined;

    if (
      (parsedLat !== undefined && !Number.isFinite(parsedLat)) ||
      (parsedLng !== undefined && !Number.isFinite(parsedLng))
    ) {
      setError('Latitude and Longitude must be valid decimal numbers.');
      return;
    }

    setSavingDraft(true);
    const res = await saveSellerOnboardingDraft({
      apiUrl,
      token,
      activeStore,
      payload: {
        businessName: businessName.trim(),
        category,
        businessType: 'FIXED_SHOP',
        businessTypeConfirmed,
        fixedPremisesConfirmed,
        premisesOwnershipType,
        address: address.trim(),
        pincode: pincode.trim(),
        ...(parsedLat !== undefined ? { latitude: parsedLat } : {}),
        ...(parsedLng !== undefined ? { longitude: parsedLng } : {}),
        ...(parsedAcc !== undefined && Number.isFinite(parsedAcc) ? { gpsAccuracyMeters: parsedAcc } : {})
      }
    });
    setSavingDraft(false);

    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok || !res.data) {
      setError(res.error || 'Failed to save onboarding draft.');
      return;
    }

    if (res.data.locationChangeDetected) {
      setLocationWarningBanner(
        res.data.message ||
          'Approved shop location changed significantly. Store has entered Re-verification Required state and requires resubmission.'
      );
    } else {
      setSuccessMsg(
        res.data.message ||
          'Store profile and location saved to your onboarding draft. Updating category automatically refreshes required documents.'
      );
    }

    await hydrateOverview();
  };

  const handleFileUpload = async (reqItem: DocumentRequirement, file: File) => {
    if (!allowOwner || !overview?.availableActions.canUploadDocuments || uploadingKey) return;
    setError(null);
    setSuccessMsg(null);

    if (file.size > 10 * 1024 * 1024) {
      setError(`File "${file.name}" exceeds the 10 MB upload limit.`);
      return;
    }

    const isPhotoReq =
      reqItem.documentType === 'STOREFRONT_PHOTO' ||
      reqItem.requirementKey.toUpperCase().includes('STOREFRONT');
    if (isPhotoReq && file.type && !['image/jpeg', 'image/png'].includes(file.type.toLowerCase())) {
      setError('Storefront photos must be clear JPEG or PNG images.');
      return;
    }

    setUploadingKey(reqItem.requirementKey);
    setUploadProgress((prev) => ({ ...prev, [reqItem.requirementKey]: 5 }));

    const res = await uploadSellerOnboardingDocumentWithProgress({
      apiUrl,
      token,
      activeStore,
      requirementKey: reqItem.requirementKey,
      file,
      filename: file.name,
      onProgress: (pct) => {
        setUploadProgress((prev) => ({ ...prev, [reqItem.requirementKey]: pct }));
      }
    });

    setUploadingKey(null);
    setUploadProgress((prev) => {
      const next = { ...prev };
      delete next[reqItem.requirementKey];
      return next;
    });

    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok || !res.data) {
      setError(res.error || `Failed to upload document for ${reqItem.label}.`);
      return;
    }

    setSuccessMsg(`Uploaded "${res.data.document.originalFilenameSanitized}" for ${reqItem.label}.`);
    await hydrateOverview();
  };

  const handleDeleteDocument = async (doc: KycDocumentSummary) => {
    if (!allowOwner || !overview?.availableActions.canDeleteDraftDocuments || deletingDocId) return;
    setDeletingDocId(doc.id);
    setError(null);
    setSuccessMsg(null);

    const res = await deleteSellerDraftDocument({
      apiUrl,
      token,
      activeStore,
      documentId: doc.id
    });
    setDeletingDocId(null);

    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }
    if (!res.ok) {
      setError(res.error || 'Unable to delete document.');
      return;
    }

    setSuccessMsg(`Removed draft document "${doc.originalFilenameSanitized}".`);
    await hydrateOverview();
  };

  const handleSubmitApplication = async () => {
    if (!allowOwner || !overview?.availableActions.canSubmit || submittingApp) return;
    setSubmittingApp(true);
    setError(null);
    setSuccessMsg(null);

    const res = await submitSellerOnboardingApplication({ apiUrl, token, activeStore });
    setSubmittingApp(false);

    if (res.authExpired) {
      onAuthExpired(res.error || undefined);
      return;
    }

    if (!res.ok || !res.data) {
      const detailText =
        res.details && Array.isArray((res.details as any).missingRequirements) && (res.details as any).missingRequirements.length > 0
          ? ` Missing: ${(res.details as any).missingRequirements.join(', ')}.`
          : '';
      setError(`${res.error || 'Submission blocked by verification checklist.'}${detailText}`);
      return;
    }

    setSuccessMsg(
      `${res.data.message} (Submission v${res.data.submissionVersion}, immutable snapshot locked for Admin review.)`
    );
    await hydrateOverview();
  };

  const loadDocumentForPreview = useCallback(
    async (documentId: string) => {
      const res = await fetchSellerDocumentBlob({ apiUrl, token, activeStore, documentId });
      if (res.authExpired) {
        onAuthExpired(res.error || undefined);
      }
      return {
        ok: res.ok,
        error: res.error,
        blob: res.data?.blob,
        mimeType: res.data?.mimeType,
        filename: res.data?.filename
      };
    },
    [apiUrl, token, activeStore, onAuthExpired]
  );

  if (!allowOwner) {
    return (
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs">
        <div
          role="note"
          className="p-4 bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 rounded-xl text-sm font-semibold flex items-start gap-2.5"
        >
          <span className="material-symbols-outlined text-lg shrink-0 mt-0.5">lock</span>
          <div>
            <p className="font-bold">Store Owner Access Required for Store Onboarding</p>
            <p className="font-normal mt-1">
              Your authenticated role for <strong>{activeStore.businessName}</strong> is <strong>{activeStore.role}</strong>. Store profile edits, KYC document uploads, private document previews, and onboarding submissions are permitted exclusively for the active Store Owner (<code>KYC_MANAGE</code>).
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading || !overview) {
    return (
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container flex items-center gap-2 text-sm text-on-surface-variant">
        <span className="material-symbols-outlined text-primary animate-spin">progress_activity</span>
        <span>
          {loading ? `Loading onboarding record for ${activeStore.businessName}...` : error || 'Onboarding record unavailable.'}
        </span>
      </div>
    );
  }

  const statusMeta = getOnboardingStatusMeta(overview.verificationStatus.status);
  const canEdit = overview.availableActions.canEditDraft;
  const canUpload = overview.availableActions.canUploadDocuments;
  const canDelete = overview.availableActions.canDeleteDraftDocuments;
  const canSubmit = overview.availableActions.canSubmit;
  const latestSub = overview.latestSubmission;
  const approvedSub = submissions.find((s) => s.id === overview.profile.approvedSubmissionId);

  const storefrontDocsCount = overview.documents.filter(
    (d) => d.isStorefrontPhoto && (d.mimeType === 'image/jpeg' || d.mimeType === 'image/png')
  ).length;
  const premisesDocsCount = overview.documents.filter((d) => d.isPremisesProof).length;

  const isResubmissionState =
    overview.verificationStatus.status === 'MORE_INFO_REQUIRED' ||
    overview.verificationStatus.status === 'REJECTED' ||
    overview.verificationStatus.status === 'REVERIFICATION_REQUIRED';

  const latestRejectionLabel = latestSub?.rejectionCategory
    ? REJECTION_CATEGORY_OPTIONS.find((r) => r.value === latestSub.rejectionCategory)?.label ||
      latestSub.rejectionCategory
    : null;

  return (
    <div className="flex flex-col gap-space-lg">
      {/* 1. Verification Status & Resubmission / Feedback Header */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-sm">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                Physical Store Onboarding & Verification
              </h3>
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${statusMeta.toneClass}`}>
                {statusMeta.label}
              </span>
            </div>
            <p className="font-body-sm text-xs text-on-surface-variant mt-1">{statusMeta.description}</p>
          </div>

          <button
            type="button"
            onClick={() => void hydrateOverview()}
            className="px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-container-high text-xs font-bold text-on-surface flex items-center gap-1 self-start"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
            <span>Refresh Status</span>
          </button>
        </div>

        {/* Admin Feedback Card for MORE_INFO_REQUIRED / REJECTED / APPROVED */}
        {latestSub && (latestSub.feedbackReason || latestSub.rejectionCategory || (latestSub.requestedRequirements && latestSub.requestedRequirements.length > 0)) && (
          <div
            className={`p-4 rounded-xl border text-xs flex flex-col gap-1.5 ${
              latestSub.status === 'REJECTED'
                ? 'bg-error/10 border-error/30 text-on-surface'
                : latestSub.status === 'MORE_INFO_REQUIRED'
                  ? 'bg-amber-500/15 border-amber-500/40 text-on-surface'
                  : 'bg-surface-container-low border-surface-container text-on-surface'
            }`}
          >
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="font-bold text-sm">
                Latest Admin Review (Submission v{latestSub.submissionVersion} — {latestSub.status.replace(/_/g, ' ')})
              </span>
              {latestSub.reviewedAt && (
                <span className="text-[11px] text-outline">
                  Reviewed: {new Date(latestSub.reviewedAt).toLocaleString()}
                </span>
              )}
            </div>
            {latestRejectionLabel && (
              <p>
                <strong>Category:</strong> {latestRejectionLabel}
              </p>
            )}
            {latestSub.feedbackReason && (
              <p>
                <strong>Reviewer Feedback:</strong> {latestSub.feedbackReason}
              </p>
            )}
            {latestSub.requestedRequirements && latestSub.requestedRequirements.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                <strong>Items Requested:</strong>
                {latestSub.requestedRequirements.map((item) => (
                  <span
                    key={item}
                    className="px-2 py-0.5 rounded bg-surface-container-lowest border border-surface-container font-mono text-[11px]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}
            {isResubmissionState && canEdit && (
              <p className="font-semibold text-primary mt-1">
                Resubmission Unlocked: Update the requested profile details or draft documents below, save your draft, and click &ldquo;Submit Resubmission for Review&rdquo;.
              </p>
            )}
          </div>
        )}

        {locationWarningBanner && (
          <div role="alert" className="p-3 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-900 dark:text-amber-200 text-xs font-semibold">
            {locationWarningBanner}
          </div>
        )}

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
      </div>

      {/* 2. Store Profile, Physical Shop Eligibility & GPS Location Form */}
      <form
        onSubmit={handleSaveDraft}
        className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h4 className="font-headline-sm text-base font-bold text-on-surface">
              Step 1: Store Details, Fixed Physical Premises & GPS Location
            </h4>
            <p className="text-xs text-on-surface-variant">
              Required documents update automatically when you change store category and save draft.
            </p>
          </div>
          {!canEdit && (
            <span className="px-3 py-1 rounded-full bg-surface-container text-xs font-semibold text-outline">
              Locked while {overview.verificationStatus.status.replace(/_/g, ' ')}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-space-sm">
          <div>
            <label className="text-xs font-semibold text-on-surface block mb-1">
              Store / Legal Business Name *
            </label>
            <input
              type="text"
              required
              disabled={!canEdit}
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              className="w-full bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-on-surface block mb-1">
              Store Category *
            </label>
            <select
              disabled={!canEdit}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
            >
              {STORE_CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-on-surface block mb-1">
              Premises Occupancy Type *
            </label>
            <select
              disabled={!canEdit}
              value={premisesOwnershipType}
              onChange={(e) => setPremisesOwnershipType(e.target.value as PremisesOwnershipType)}
              className="w-full bg-surface-container-low border border-surface-container rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
            >
              {PREMISES_OWNERSHIP_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
          <label className="p-3 rounded-xl bg-surface-container-low border border-surface-container flex items-start gap-2.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={businessTypeConfirmed}
              onChange={(e) => setBusinessTypeConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <strong className="text-on-surface block">Fixed Physical Shop Confirmation *</strong>
              <span className="text-on-surface-variant">
                I confirm this business operates from a permanent brick-and-mortar retail/service storefront (home kitchens, cloud-only, and street-cart setups are ineligible).
              </span>
            </span>
          </label>

          <label className="p-3 rounded-xl bg-surface-container-low border border-surface-container flex items-start gap-2.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={fixedPremisesConfirmed}
              onChange={(e) => setFixedPremisesConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <strong className="text-on-surface block">Physical Occupancy & Inspection Readiness *</strong>
              <span className="text-on-surface-variant">
                I confirm this store lawfully occupies the physical shop address below and matches the uploaded storefront signboard photographs.
              </span>
            </span>
          </label>
        </div>

        <StoreLocationPicker
          address={address}
          pincode={pincode}
          latitude={latitude}
          longitude={longitude}
          gpsAccuracyMeters={gpsAccuracyMeters}
          gpsCapturedAt={overview.profile.gpsCapturedAt}
          disabled={!canEdit}
          hasApprovedLocationHistory={overview.profile.hasApprovedLocationHistory}
          approvedAddress={approvedSub?.addressSnapshot}
          approvedPincode={approvedSub?.pincodeSnapshot}
          approvedLatitude={approvedSub?.latitudeSnapshot}
          approvedLongitude={approvedSub?.longitudeSnapshot}
          reverificationRequired={overview.verificationStatus.reverificationRequired}
          reverificationReason={overview.verificationStatus.reverificationReason}
          onChangeAddress={setAddress}
          onChangePincode={setPincode}
          onChangeLatitude={setLatitude}
          onChangeLongitude={setLongitude}
          onChangeGpsAccuracy={setGpsAccuracyMeters}
        />

        {canEdit && (
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={savingDraft}
              className="px-5 py-2.5 rounded-xl bg-primary text-on-primary text-xs font-bold flex items-center gap-1.5 stitch-btn disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-base">save</span>
              <span>{savingDraft ? 'Saving Draft...' : 'Save Profile & Location Draft'}</span>
            </button>
          </div>
        )}
      </form>

      {/* 3. Category-Specific Document Requirements & Evidence Upload */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h4 className="font-headline-sm text-base font-bold text-on-surface">
              Step 2: Category-Specific KYC Documents & Location Proof ({formatCategoryLabel(overview.profile.category || overview.store.category)})
            </h4>
            <p className="text-xs text-on-surface-variant mt-0.5">
              Storefront photos require JPEG/PNG (at least 2 photos, max 5 storefront/premises images). Licences & premises proofs accept PDF, JPEG, or PNG up to 10 MB (max 10 files total).
            </p>
          </div>
          <div className="text-xs font-semibold text-on-surface-variant shrink-0">
            Storefront Photos: <strong>{storefrontDocsCount}/2+</strong> • Total Files: <strong>{overview.documents.length}/10</strong>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
          {overview.requirements.map((reqItem) => {
            const matchingDocs = overview.documents.filter(
              (d) => d.requirementKey.toUpperCase() === reqItem.requirementKey.toUpperCase()
            );
            const pct = uploadProgress[reqItem.requirementKey];
            const isPhoto =
              reqItem.documentType === 'STOREFRONT_PHOTO' ||
              reqItem.requirementKey.toUpperCase().includes('STOREFRONT');
            const isUploadingThis = uploadingKey === reqItem.requirementKey;

            return (
              <div
                key={reqItem.requirementKey}
                className="p-space-md rounded-xl bg-surface-container-low border border-surface-container flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-bold text-sm text-on-surface">{reqItem.label}</p>
                    <div className="flex items-center gap-1 shrink-0">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          reqItem.isMandatory
                            ? 'bg-primary/15 text-primary'
                            : 'bg-surface-container text-outline'
                        }`}
                      >
                        {reqItem.isMandatory ? 'Mandatory' : 'Optional'}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          reqItem.fulfilled
                            ? 'bg-secondary-container text-on-secondary-container'
                            : 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
                        }`}
                      >
                        {reqItem.fulfilled ? 'Uploaded' : 'Needed'}
                      </span>
                    </div>
                  </div>
                  {reqItem.description && (
                    <p className="text-xs text-on-surface-variant mt-1">{reqItem.description}</p>
                  )}
                  <p className="text-[11px] font-mono text-outline mt-1">
                    Key: {reqItem.requirementKey} • Accepted: {isPhoto ? 'JPEG / PNG' : 'PDF / JPEG / PNG'}
                  </p>
                </div>

                {/* Matching uploaded documents */}
                {matchingDocs.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {matchingDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="px-2.5 py-2 rounded-lg bg-surface-container-lowest border border-surface-container flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-on-surface truncate">
                            {doc.originalFilenameSanitized}
                          </p>
                          <p className="text-[10px] text-outline">
                            {formatBytes(doc.fileSizeBytes)} • {doc.mimeType}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              setPreviewTarget({
                                documentId: doc.id,
                                filename: doc.originalFilenameSanitized,
                                mimeType: doc.mimeType,
                                sha256Checksum: doc.sha256Checksum
                              })
                            }
                            className="px-2 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface font-semibold"
                          >
                            View
                          </button>
                          {canDelete && (
                            <button
                              type="button"
                              disabled={deletingDocId === doc.id}
                              onClick={() => void handleDeleteDocument(doc)}
                              className="px-2 py-1 rounded bg-error/10 hover:bg-error/20 text-error font-semibold disabled:opacity-40"
                            >
                              {deletingDocId === doc.id ? '...' : 'Remove'}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Progress bar + File Input */}
                {typeof pct === 'number' && (
                  <div className="w-full">
                    <div className="h-1.5 w-full rounded-full bg-surface-container overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-150"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-[10px] font-semibold text-primary mt-0.5">Uploading {pct}%...</p>
                  </div>
                )}

                {canUpload && (
                  <label className="block">
                    <span className="sr-only">Upload file for {reqItem.label}</span>
                    <input
                      type="file"
                      accept={isPhoto ? 'image/jpeg,image/png' : 'application/pdf,image/jpeg,image/png'}
                      disabled={Boolean(uploadingKey)}
                      onChange={(e) => {
                        const selected = e.target.files?.[0];
                        e.currentTarget.value = '';
                        if (selected) void handleFileUpload(reqItem, selected);
                      }}
                      className="block w-full text-xs text-on-surface-variant file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer disabled:opacity-50"
                    />
                    {isUploadingThis && (
                      <span className="text-[11px] text-primary font-semibold">Sending encrypted stream...</span>
                    )}
                  </label>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. Readiness Checklist & Submit Application */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-sm">
          <div>
            <h4 className="font-headline-sm text-base font-bold text-on-surface">
              Step 3: Verification Readiness & Final Submission
            </h4>
            <p className="text-xs text-on-surface-variant mt-0.5">
              Submitting freezes an immutable snapshot (store details, GPS coordinates, applicable requirements, and attached documents) for Administrative KYC review. Store remains inactive until Admin approval.
            </p>
          </div>

          {canSubmit && (
            <button
              type="button"
              disabled={submittingApp}
              onClick={() => void handleSubmitApplication()}
              className="px-5 py-2.5 rounded-xl bg-secondary text-on-secondary text-xs font-bold flex items-center gap-1.5 self-start stitch-btn disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-base">send</span>
              <span>
                {submittingApp
                  ? 'Submitting...'
                  : isResubmissionState
                    ? 'Submit Resubmission for Review'
                    : 'Submit Onboarding Application'}
              </span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
          <div className="p-2.5 rounded-xl bg-surface-container-low border border-surface-container flex items-center gap-2">
            <span className={`material-symbols-outlined text-base ${!overview.missingPremisesConfirmation ? 'text-secondary' : 'text-amber-600'}`}>
              {!overview.missingPremisesConfirmation ? 'check_circle' : 'pending'}
            </span>
            <span>Fixed physical shop confirmed</span>
          </div>
          <div className="p-2.5 rounded-xl bg-surface-container-low border border-surface-container flex items-center gap-2">
            <span className={`material-symbols-outlined text-base ${!overview.missingAddress && !overview.missingGps ? 'text-secondary' : 'text-amber-600'}`}>
              {!overview.missingAddress && !overview.missingGps ? 'check_circle' : 'pending'}
            </span>
            <span>Shop address & GPS pin saved</span>
          </div>
          <div className="p-2.5 rounded-xl bg-surface-container-low border border-surface-container flex items-center gap-2">
            <span className={`material-symbols-outlined text-base ${storefrontDocsCount >= 2 && premisesDocsCount >= 1 ? 'text-secondary' : 'text-amber-600'}`}>
              {storefrontDocsCount >= 2 && premisesDocsCount >= 1 ? 'check_circle' : 'pending'}
            </span>
            <span>2+ storefront & 1+ premises proof</span>
          </div>
          <div className="p-2.5 rounded-xl bg-surface-container-low border border-surface-container flex items-center gap-2">
            <span className={`material-symbols-outlined text-base ${overview.missingRequirements.length === 0 ? 'text-secondary' : 'text-amber-600'}`}>
              {overview.missingRequirements.length === 0 ? 'check_circle' : 'pending'}
            </span>
            <span>
              {overview.missingRequirements.length === 0
                ? 'All category docs uploaded'
                : `${overview.missingRequirements.length} mandatory doc(s) pending`}
            </span>
          </div>
        </div>
      </div>

      {/* 5. Immutable Submission History & Versions */}
      <div className="bg-surface-container-lowest p-space-lg rounded-2xl border border-surface-container shadow-xs flex flex-col gap-space-md">
        <h4 className="font-headline-sm text-base font-bold text-on-surface">
          Onboarding Submission History ({submissions.length})
        </h4>

        {submissions.length === 0 ? (
          <div className="p-6 rounded-xl bg-surface-container-low border border-dashed border-surface-container text-center text-xs text-on-surface-variant">
            No submission versions created yet. Complete Steps 1 & 2 and click Submit above.
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {submissions.map((sub) => (
              <div
                key={sub.id}
                className="p-3.5 rounded-xl bg-surface-container-low border border-surface-container flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-on-surface">Version v{sub.submissionVersion}</span>
                    <span className="px-2 py-0.5 rounded-full bg-surface-container-high font-bold text-[11px] text-on-surface">
                      {sub.status.replace(/_/g, ' ')}
                    </span>
                    {sub.isReverification && (
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-800 dark:text-amber-200 font-bold text-[11px]">
                        Location Re-verification
                      </span>
                    )}
                  </div>
                  <p className="text-on-surface-variant mt-1">
                    {sub.businessNameSnapshot} ({formatCategoryLabel(sub.categorySnapshot)}) — {sub.addressSnapshot}, {sub.pincodeSnapshot}
                  </p>
                  {sub.feedbackReason && (
                    <p className="text-on-surface mt-1">
                      <strong>Feedback:</strong> {sub.feedbackReason}
                    </p>
                  )}
                </div>
                <div className="text-left sm:text-right text-[11px] text-outline shrink-0">
                  <p>Submitted: {sub.submittedAt ? new Date(sub.submittedAt).toLocaleString() : 'Draft'}</p>
                  {sub.reviewedAt && <p>Reviewed: {new Date(sub.reviewedAt).toLocaleString()}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <SecureDocumentPreviewModal
        target={previewTarget}
        loader={loadDocumentForPreview}
        onClose={() => setPreviewTarget(null)}
      />
    </div>
  );
};
