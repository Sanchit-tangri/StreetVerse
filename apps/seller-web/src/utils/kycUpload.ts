export type SellerKycSubmissionStatus = 'SUBMITTED' | 'UNDER_REVIEW' | 'MORE_INFO_REQUIRED';

export interface SellerKycSubmission {
  submissionId: string;
  merchantId?: string;
  documentType: string;
  documentNumber: string;
  status: SellerKycSubmissionStatus;
  submittedAt: string;
}

export interface KycUploadOutcome {
  ok: boolean;
  submission: SellerKycSubmission | null;
  successMessage: string | null;
  errorMessage: string | null;
}

export interface StoredSellerMerchantProfile {
  id?: string;
  businessName?: string;
  category?: string;
  ownerPhone?: string;
  ownerEmail?: string;
  upiVpa?: string;
  address?: string;
  isOpen?: boolean;
}

export interface SellerKycDisplayInput {
  /** Only populated from live authenticated server responses in memory; never localStorage. */
  serverConfirmedSubmissions: SellerKycSubmission[];
  lastUploadError?: string | null;
}

export interface SellerKycDisplayStatus {
  isVerifiedApproved: boolean;
  hasPersistedSubmission: boolean;
  headerLabel: string;
  summaryLabel: string;
  badgeLabel: string;
  registrySubtitle: string;
}

function normalizeSubmissionStatus(rawStatus: unknown): SellerKycSubmissionStatus {
  if (rawStatus === 'UNDER_REVIEW' || rawStatus === 'MORE_INFO_REQUIRED') {
    return rawStatus;
  }
  // An upload acknowledgement must never self-promote a submission to verified/approved
  return 'SUBMITTED';
}

/**
 * Parses `streetverse_seller_merchant` from browser localStorage while stripping
 * any client-editable verification or submission fields (`kycApproval`, `isVerified`,
 * `submissions`, `kycSubmissions`, `kycStatus`).
 */
export function parseStoredSellerMerchant(rawJson: string): StoredSellerMerchantProfile {
  const parsed = JSON.parse(rawJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid stored merchant profile');
  }
  return {
    id: typeof parsed.id === 'string' ? parsed.id : undefined,
    businessName: typeof parsed.businessName === 'string' ? parsed.businessName : undefined,
    category: typeof parsed.category === 'string' ? parsed.category : undefined,
    ownerPhone: typeof parsed.ownerPhone === 'string' ? parsed.ownerPhone : undefined,
    ownerEmail: typeof parsed.ownerEmail === 'string' ? parsed.ownerEmail : undefined,
    upiVpa: typeof parsed.upiVpa === 'string' ? parsed.upiVpa : undefined,
    address: typeof parsed.address === 'string' ? parsed.address : undefined,
    isOpen: typeof parsed.isOpen === 'boolean' ? parsed.isOpen : undefined
  };
}

/**
 * Computes Seller KYC UI labels truthfully from session server responses only.
 * Never reads `localStorage`, `merchant.isVerified`, or `merchant.kycApproval`,
 * and cannot display approved/verified or pending-review status without genuine
 * server-confirmed persistence. Prepared for future authenticated server KYC status.
 */
export function resolveSellerKycDisplayStatus(
  input: SellerKycDisplayInput
): SellerKycDisplayStatus {
  const submissions = Array.isArray(input.serverConfirmedSubmissions)
    ? input.serverConfirmedSubmissions
    : [];
  const hasPersistedSubmission = submissions.length > 0;
  const hasFailedAttempt = Boolean(
    typeof input.lastUploadError === 'string' && input.lastUploadError.trim().length > 0
  );

  if (hasPersistedSubmission) {
    return {
      isVerifiedApproved: false,
      hasPersistedSubmission: true,
      headerLabel: 'KYC Submitted (Pending Review)',
      summaryLabel: 'Pending Admin Review',
      badgeLabel: 'Pending Review',
      registrySubtitle: 'Submitted regulatory records awaiting administrative verification review.'
    };
  }

  if (hasFailedAttempt) {
    return {
      isVerifiedApproved: false,
      hasPersistedSubmission: false,
      headerLabel: 'KYC Submission Unavailable',
      summaryLabel: 'Submission Unavailable',
      badgeLabel: 'Unverified',
      registrySubtitle: 'KYC submission storage is currently unavailable. No document was saved or verified.'
    };
  }

  return {
    isVerifiedApproved: false,
    hasPersistedSubmission: false,
    headerLabel: 'KYC Unverified',
    summaryLabel: 'Unverified — Not Submitted',
    badgeLabel: 'Unverified',
    registrySubtitle: 'No persisted KYC submissions on record for this merchant.'
  };
}

/**
 * Resolves the API response for `/api/v1/auth/seller/kyc/upload` without ever
 * fabricating fallback submissions or displaying verified/approved status from an upload.
 */
export function resolveKycUploadOutcome(httpOk: boolean, status: number, data: any): KycUploadOutcome {
  const rawSub = data && typeof data === 'object' ? data.submission : null;
  const rawId = rawSub && typeof rawSub.submissionId === 'string' ? rawSub.submissionId.trim() : '';

  if (
    httpOk &&
    status >= 200 &&
    status < 300 &&
    data &&
    data.success === true &&
    rawSub &&
    rawId &&
    typeof rawSub.documentType === 'string' &&
    rawSub.documentType.trim() &&
    typeof rawSub.documentNumber === 'string' &&
    rawSub.documentNumber.trim()
  ) {
    const normalizedStatus = normalizeSubmissionStatus(rawSub.status);
    return {
      ok: true,
      submission: {
        submissionId: rawId,
        merchantId: typeof rawSub.merchantId === 'string' ? rawSub.merchantId : undefined,
        documentType: rawSub.documentType.trim(),
        documentNumber: rawSub.documentNumber.trim(),
        status: normalizedStatus,
        submittedAt: typeof rawSub.submittedAt === 'string' ? rawSub.submittedAt : new Date().toISOString()
      },
      successMessage:
        typeof data.message === 'string' && data.message.trim() && !/verif(ied|ication complete)|approved/i.test(data.message)
          ? data.message.trim()
          : 'Document submitted for review. Verification remains pending administrative approval.',
      errorMessage: null
    };
  }

  const serverError =
    data && typeof data.error === 'string' && data.error.trim()
      ? data.error.trim()
      : status === 503
        ? 'KYC document submission is temporarily unavailable. No document was stored or verified.'
        : 'KYC document submission failed. Please verify your details and try again.';

  return {
    ok: false,
    submission: null,
    successMessage: null,
    errorMessage: serverError
  };
}
