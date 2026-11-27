/**
 * Shared UI display constants and non-authoritative labels for StreetVerse
 * Merchant Onboarding, Compliance, and Admin Operations.
 *
 * Backend APIs enforce every permission, status transition, threshold, and
 * category requirement. These constants solely drive UI labels and selectors.
 */

export interface LabeledOption {
  value: string;
  label: string;
  hint?: string;
}

export const STORE_CATEGORY_OPTIONS: ReadonlyArray<LabeledOption> = [
  { value: 'GROCERY', label: 'Grocery & Kirana' },
  { value: 'RESTAURANT', label: 'Restaurant & Food Service' },
  { value: 'PHARMACY', label: 'Pharmacy & Medical' },
  { value: 'SALON', label: 'Salon & Grooming' },
  { value: 'FLORIST', label: 'Florist & Plants' },
  { value: 'PET_SHOP', label: 'Pet Shop & Supplies' },
  { value: 'HARDWARE', label: 'Hardware & Building Supplies' },
  { value: 'SPORTS', label: 'Sports & Fitness Retail' },
  { value: 'STATIONERY', label: 'Stationery & Books' },
  { value: 'CLOTHING', label: 'Clothing & Apparel' },
  { value: 'ELECTRONICS', label: 'Electronics & Appliances' }
];

export const PREMISES_OWNERSHIP_OPTIONS: ReadonlyArray<LabeledOption> = [
  { value: 'OWNED', label: 'Owned Property (Title / Deed / Tax Receipt)' },
  { value: 'RENTED', label: 'Rented Shop (Active Rental Agreement)' },
  { value: 'LEASED', label: 'Leased Premises (Commercial Lease Agreement)' }
];

export const REJECTION_CATEGORY_OPTIONS: ReadonlyArray<LabeledOption> = [
  { value: 'INVALID_DOCUMENT', label: 'Invalid, Expired, or Unreadable Document' },
  { value: 'MISSING_REQUIRED_DOCUMENT', label: 'Missing Mandatory Category / Premises Document' },
  { value: 'UNVERIFIED_PREMISES', label: 'Fixed Physical Shop Premises Unverified' },
  { value: 'INELIGIBLE_BUSINESS_TYPE', label: 'Ineligible Business Model (Not a Fixed Physical Shop)' },
  { value: 'LOCATION_MISMATCH', label: 'Shop Address / GPS Pin / Storefront Mismatch' },
  { value: 'IDENTITY_MISMATCH', label: 'Owner Identity / Document Mismatch' },
  { value: 'INCONSISTENT_INFORMATION', label: 'Inconsistent Application Information' },
  { value: 'OTHER', label: 'Other Verification Rejection' }
];

export const REQUESTABLE_CORRECTION_TOPICS: ReadonlyArray<LabeledOption> = [
  { value: 'STOREFRONT_LOCATION', label: 'Storefront Photo / Signboard Clarity' },
  { value: 'GPS_COORDINATES', label: 'GPS Pin / Coordinates Accuracy' },
  { value: 'SHOP_ADDRESS', label: 'Physical Shop Street Address / Pincode' },
  { value: 'PREMISES_CONFIRMATION', label: 'Premises Occupancy Proof' }
];

export const ORDINARY_VIOLATION_CATEGORY_OPTIONS: ReadonlyArray<LabeledOption> = [
  { value: 'HYGIENE_STANDARD', label: 'Hygiene & Cleanliness Standard' },
  { value: 'DOCUMENT_DISCREPANCY', label: 'Document Discrepancy' },
  { value: 'MISLEADING_LISTING', label: 'Misleading Storefront or Listing Information' },
  { value: 'ORDER_FULFILLMENT', label: 'Order Fulfillment Non-Compliance' },
  { value: 'CUSTOMER_SAFETY_MINOR', label: 'Minor Customer Safety Issue' },
  { value: 'OPERATIONAL_COMPLIANCE', label: 'General Operational Compliance' },
  { value: 'OTHER', label: 'Other Compliance Violation' }
];

export const SERIOUS_VIOLATION_CATEGORY_OPTIONS: ReadonlyArray<LabeledOption> = [
  { value: 'SUSPECTED_FRAUD', label: 'Suspected Fraud or Misrepresentation' },
  { value: 'IMMEDIATE_SAFETY_RISK', label: 'Immediate Public / Customer Safety Risk' },
  { value: 'MAJOR_LEGAL_COMPLIANCE', label: 'Major Legal / Regulatory Violation' }
];

export const WARNING_SEVERITY_OPTIONS: ReadonlyArray<LabeledOption> = [
  { value: 'LOW', label: 'Low' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'HIGH', label: 'High' },
  { value: 'CRITICAL', label: 'Critical' }
];

export const ADMIN_REVIEW_CHECKLIST_ITEMS: ReadonlyArray<{
  key:
    | 'sellerIdentityReviewed'
    | 'businessNameAndCategoryConfirmed'
    | 'fixedPhysicalShopConfirmed'
    | 'gpsLocationChecked'
    | 'storefrontPhotosInspected'
    | 'premisesEvidenceChecked'
    | 'categoryDocumentsChecked'
    | 'informationConsistent'
    | 'noUnresolvedDiscrepancy';
  label: string;
}> = [
  { key: 'sellerIdentityReviewed', label: 'Seller account identity & contact details reviewed' },
  { key: 'businessNameAndCategoryConfirmed', label: 'Business name & store category match documents' },
  { key: 'fixedPhysicalShopConfirmed', label: 'Fixed physical shop premises confirmed (eligible business type)' },
  { key: 'gpsLocationChecked', label: 'GPS coordinates checked against street address & pincode' },
  { key: 'storefrontPhotosInspected', label: 'Minimum 2 clear storefront/signboard photographs inspected' },
  { key: 'premisesEvidenceChecked', label: 'Premises occupancy proof (owned/rented/leased) checked' },
  { key: 'categoryDocumentsChecked', label: 'Applicable category licences / proofs checked' },
  { key: 'informationConsistent', label: 'All submitted metadata & attachments are consistent' },
  { key: 'noUnresolvedDiscrepancy', label: 'No unresolved material discrepancy remains' }
];

export interface StatusStyleMeta {
  label: string;
  toneClass: string;
  description: string;
}

export function getOnboardingStatusMeta(status: string | null | undefined): StatusStyleMeta {
  const normalized = String(status || 'PENDING_SUBMISSION').toUpperCase();
  switch (normalized) {
    case 'APPROVED':
      return {
        label: 'Verified & Approved',
        toneClass: 'bg-secondary-container text-on-secondary-container',
        description: 'Physical store location and required compliance records have passed administrative review.'
      };
    case 'UNDER_REVIEW':
      return {
        label: 'Under Admin Review',
        toneClass: 'bg-primary/15 text-primary',
        description: 'Submission snapshot is locked and actively being verified by an administrator.'
      };
    case 'SUBMITTED':
      return {
        label: 'Submitted (Queued)',
        toneClass: 'bg-primary/10 text-primary',
        description: 'Immutable application submitted and awaiting administrative queue pickup.'
      };
    case 'MORE_INFO_REQUIRED':
      return {
        label: 'More Info Required',
        toneClass: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
        description: 'Reviewer requested corrections or additional evidence before a final decision can be made.'
      };
    case 'REJECTED':
      return {
        label: 'Rejected',
        toneClass: 'bg-error-container text-on-error-container',
        description: 'Submission was rejected. Review the feedback below and prepare a corrected resubmission.'
      };
    case 'SUSPENDED':
      return {
        label: 'Suspended',
        toneClass: 'bg-error-container text-on-error-container font-bold',
        description: 'This store is temporarily suspended due to compliance enforcement and requires remediation.'
      };
    case 'REVERIFICATION_REQUIRED':
      return {
        label: 'Location Re-verification Required',
        toneClass: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
        description: 'Physical store address or GPS location changed beyond threshold and must be re-verified.'
      };
    case 'DRAFT':
      return {
        label: 'Draft In Progress',
        toneClass: 'bg-surface-container-high text-on-surface-variant',
        description: 'Complete store profile, GPS coordinates, premises proof, and required uploads before submitting.'
      };
    default:
      return {
        label: 'Pending Onboarding Submission',
        toneClass: 'bg-surface-container-high text-on-surface-variant',
        description: 'New store awaiting onboarding details, physical location proof, and verification submission.'
      };
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  const num = Number(bytes ?? 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatCategoryLabel(category: string | null | undefined): string {
  const normalized = String(category || '').toUpperCase();
  const match = STORE_CATEGORY_OPTIONS.find((opt) => opt.value === normalized);
  return match ? match.label : normalized || 'Unspecified';
}

export function computeApproximateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
