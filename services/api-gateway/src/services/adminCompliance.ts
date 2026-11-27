import { StrictPgClient, StrictPgPool, withPgTransaction } from '../db/postgres';
import { STORE_UUID_REGEX } from './sellerRbac';
import { classifyHttpError, sanitizeErrorForLog } from '../utils/infraErrors';
import { AdminServiceResult } from './adminAuth';

// =========================================================================
// MO-B3: Store-Specific Compliance Warnings, Corrective Responses,
//        Escalations, Protective & Ordinary Suspension, and Admin Reactivation
//
// Business & security invariants:
//   - Warnings and suspensions are strictly store-scoped (`merchant_id`).
//   - Warning numbers (`warning_number`) are sequential and unique per store.
//   - Warning thresholds count unresolved (`OPEN`) formal ordinary warnings only.
//   - Resolved warnings never revert to OPEN, never delete, and do not count.
//   - Unresolved warnings never auto-expire; `isOverdue` is derived cleanly.
//   - Serious fraud/safety/legal risks support immediate protective suspension.
//   - Only authenticated ACTIVE Admins issue/resolve/escalate/suspend/reactivate.
//   - Only active store OWNERs can respond to warnings/suspensions; STAFF cannot.
//   - Reactivation requires reviewed corrective evidence and explicit Admin
//     decision, and NEVER automatically sets `merchants.is_open = true`.
//   - All state changes record immutable audit events AND outbox notifications.
// =========================================================================

export const ORDINARY_VIOLATION_CATEGORIES = new Set<string>([
  'HYGIENE_STANDARD',
  'DOCUMENT_DISCREPANCY',
  'MISLEADING_LISTING',
  'ORDER_FULFILLMENT',
  'CUSTOMER_SAFETY_MINOR',
  'OPERATIONAL_COMPLIANCE',
  'OTHER'
]);

export const SERIOUS_VIOLATION_CATEGORIES = new Set<string>([
  'SUSPECTED_FRAUD',
  'IMMEDIATE_SAFETY_RISK',
  'MAJOR_LEGAL_COMPLIANCE'
]);

export const ALL_VIOLATION_CATEGORIES = new Set<string>([
  ...ORDINARY_VIOLATION_CATEGORIES,
  ...SERIOUS_VIOLATION_CATEGORIES
]);

export const WARNING_SEVERITIES = new Set<string>(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']);
export const SUSPENSION_TYPES = new Set<string>(['ORDINARY_VIOLATION', 'PROTECTIVE_SERIOUS_RISK']);

export interface SafeEvidenceReference {
  kind: string;
  referenceId?: string;
  label: string;
}

export interface WarningResponseRecord {
  id: string;
  warningId: string;
  respondedBySellerAccountId: string;
  responseMessage: string;
  evidenceReferences: SafeEvidenceReference[];
  createdAt: string;
}

export interface StoreComplianceWarningSummary {
  id: string;
  storeId: string;
  warningNumber: number;
  violationCategory: string;
  severity: string;
  isFormalOrdinary: boolean;
  reason: string;
  requiredCorrectiveAction: string;
  issuedByAdminId: string;
  issuedAt: string;
  correctiveDeadline: string | null;
  status: 'OPEN' | 'RESOLVED';
  isOverdue: boolean;
  escalatedAt: string | null;
  escalatedByAdminId: string | null;
  escalationNotes: string | null;
  resolvedByAdminId: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  resolutionEvidenceChecked: boolean;
  evidenceReferences: SafeEvidenceReference[];
  responses: WarningResponseRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface OwnerComplianceWarningSummary {
  id: string;
  storeId: string;
  warningNumber: number;
  violationCategory: string;
  severity: string;
  isFormalOrdinary: boolean;
  reason: string;
  requiredCorrectiveAction: string;
  issuedAt: string;
  correctiveDeadline: string | null;
  status: 'OPEN' | 'RESOLVED';
  isOverdue: boolean;
  isEscalated: boolean;
  escalatedAt: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  evidenceReferences: SafeEvidenceReference[];
  responses: WarningResponseRecord[];
}

export interface StoreWarningCounts {
  openOrdinaryWarnings: number;
  openSeriousWarnings: number;
  totalOpenWarnings: number;
  overdueOpenWarnings: number;
  resolvedWarnings: number;
  totalWarningsIssued: number;
}

export interface AdminStoreComplianceView {
  store: {
    id: string;
    businessName: string;
    category: string;
    isOpen: boolean;
  };
  complianceState: {
    onboardingStatus: string;
    preSuspensionStatus: string | null;
    isSuspended: boolean;
    suspendedAt: string | null;
    suspendedByAdminId: string | null;
    suspensionType: string | null;
    suspensionReason: string | null;
    suspensionEvidence: SafeEvidenceReference[] | null;
    ownerSuspensionResponse: string | null;
    ownerSuspensionEvidence: SafeEvidenceReference[] | null;
    ownerSuspensionRespondedAt: string | null;
    lastReactivatedAt: string | null;
    lastReactivatedByAdminId: string | null;
    lastReactivationReason: string | null;
  };
  warningCounts: StoreWarningCounts;
  warnings: StoreComplianceWarningSummary[];
  auditEvents: Array<{
    id: string;
    actorType: string;
    actorId: string | null;
    eventType: string;
    eventMetadata: unknown;
    createdAt: string;
  }>;
  notificationEvents: Array<{
    id: string;
    warningId: string | null;
    recipientRole: string;
    eventType: string;
    deliveryStatus: string;
    createdAt: string;
  }>;
}

export interface OwnerStoreComplianceView {
  store: {
    id: string;
    businessName: string;
    category: string;
    isOpen: boolean;
  };
  complianceState: {
    onboardingStatus: string;
    isSuspended: boolean;
    suspendedAt: string | null;
    suspensionType: string | null;
    suspensionReason: string | null;
    ownerSuspensionResponse: string | null;
    ownerSuspensionEvidence: SafeEvidenceReference[] | null;
    ownerSuspensionRespondedAt: string | null;
    lastReactivatedAt: string | null;
    lastReactivationReason: string | null;
  };
  warningCounts: StoreWarningCounts;
  warnings: OwnerComplianceWarningSummary[];
}

function toIsoRequired(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string' && val.trim().length > 0) {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? val : d.toISOString();
  }
  return new Date().toISOString();
}

function toIsoNullable(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return toIsoRequired(val);
}

function containsUnsafePathTokens(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    lower.includes('/var/') ||
    lower.includes('/home/') ||
    lower.includes('/tmp/') ||
    lower.includes('storage_key') ||
    lower.includes('storagekey') ||
    value.includes('..') ||
    value.includes('\\\\')
  );
}

/**
 * Validates optional evidence references while prohibiting raw filesystem paths
 * or internal storage keys.
 */
export function normalizeSafeEvidenceReferences(
  raw: unknown
): { ok: true; items: SafeEvidenceReference[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, items: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'evidenceReferences must be an array.' };
  }
  if (raw.length > 20) {
    return { ok: false, error: 'At most 20 evidenceReferences items are permitted.' };
  }

  const normalized: SafeEvidenceReference[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const label = item.trim();
      if (!label || label.length > 300 || containsUnsafePathTokens(label)) {
        return { ok: false, error: 'Evidence reference strings must be non-empty safe labels under 300 characters without filesystem paths.' };
      }
      normalized.push({ kind: 'REFERENCE', label });
      continue;
    }

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: 'Each evidence reference must be a safe string or { kind, label, referenceId? } object.' };
    }
    const obj = item as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind.trim().toUpperCase() : 'DOCUMENT_REF';
    const label = typeof obj.label === 'string' ? obj.label.trim() : '';
    const refId = typeof obj.referenceId === 'string' ? obj.referenceId.trim() : undefined;

    if (!kind || kind.length > 50 || !label || label.length > 300) {
      return { ok: false, error: 'Evidence reference object requires non-empty kind and label.' };
    }
    if (containsUnsafePathTokens(label) || (refId && containsUnsafePathTokens(refId))) {
      return { ok: false, error: 'Evidence references must not contain filesystem paths or storage keys.' };
    }
    normalized.push(refId ? { kind, referenceId: refId.slice(0, 120), label } : { kind, label });
  }

  return { ok: true, items: normalized };
}

export function deriveIsOverdue(status: string, deadlineIso: string | null, nowMs = Date.now()): boolean {
  if (status !== 'OPEN' || !deadlineIso) return false;
  const ts = new Date(deadlineIso).getTime();
  return Number.isFinite(ts) && ts < nowMs;
}

function mapWarningRow(
  row: Record<string, unknown>,
  responses: WarningResponseRecord[],
  nowMs = Date.now()
): StoreComplianceWarningSummary {
  const status = String(row.status) === 'RESOLVED' ? 'RESOLVED' : 'OPEN';
  const correctiveDeadline = toIsoNullable(row.corrective_deadline);
  const evidenceRefs = Array.isArray(row.evidence_references)
    ? (row.evidence_references as SafeEvidenceReference[])
    : [];

  return {
    id: String(row.id),
    storeId: String(row.merchant_id),
    warningNumber: Number(row.warning_number),
    violationCategory: String(row.violation_category),
    severity: String(row.severity),
    isFormalOrdinary: Boolean(row.is_formal_ordinary),
    reason: String(row.reason),
    requiredCorrectiveAction: String(row.required_corrective_action),
    issuedByAdminId: String(row.issued_by_admin_id),
    issuedAt: toIsoRequired(row.issued_at),
    correctiveDeadline,
    status,
    isOverdue: deriveIsOverdue(status, correctiveDeadline, nowMs),
    escalatedAt: toIsoNullable(row.escalated_at),
    escalatedByAdminId: row.escalated_by_admin_id ? String(row.escalated_by_admin_id) : null,
    escalationNotes: row.escalation_notes ? String(row.escalation_notes) : null,
    resolvedByAdminId: row.resolved_by_admin_id ? String(row.resolved_by_admin_id) : null,
    resolvedAt: toIsoNullable(row.resolved_at),
    resolutionReason: row.resolution_reason ? String(row.resolution_reason) : null,
    resolutionEvidenceChecked: Boolean(row.resolution_evidence_checked),
    evidenceReferences: evidenceRefs,
    responses,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at)
  };
}

function computeCountsFromWarnings(warnings: ReadonlyArray<{
  status: 'OPEN' | 'RESOLVED';
  isFormalOrdinary: boolean;
  isOverdue: boolean;
}>): StoreWarningCounts {
  let openOrdinaryWarnings = 0;
  let openSeriousWarnings = 0;
  let overdueOpenWarnings = 0;
  let resolvedWarnings = 0;

  for (const w of warnings) {
    if (w.status === 'RESOLVED') {
      resolvedWarnings++;
    } else {
      if (w.isFormalOrdinary) {
        openOrdinaryWarnings++;
      } else {
        openSeriousWarnings++;
      }
      if (w.isOverdue) {
        overdueOpenWarnings++;
      }
    }
  }

  return {
    openOrdinaryWarnings,
    openSeriousWarnings,
    totalOpenWarnings: openOrdinaryWarnings + openSeriousWarnings,
    overdueOpenWarnings,
    resolvedWarnings,
    totalWarningsIssued: warnings.length
  };
}

async function resolveOwnerSellerAccountIdForStore(
  client: StrictPgClient | Pick<StrictPgPool, 'query'>,
  merchantId: string
): Promise<string | null> {
  const ownerRes = await client.query(
    `SELECT sm.seller_account_id
     FROM store_memberships sm
     JOIN seller_accounts sa ON sa.id = sm.seller_account_id
     WHERE sm.merchant_id = $1
       AND sm.role = 'OWNER'
       AND sm.status = 'ACTIVE'
     ORDER BY CASE sa.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, sm.created_at ASC
     LIMIT 1`,
    [merchantId]
  );
  if (ownerRes.rows.length > 0 && ownerRes.rows[0].seller_account_id) {
    return String(ownerRes.rows[0].seller_account_id);
  }
  return null;
}

/**
 * Canonical store-level parent lock shared by ALL compliance mutations.
 * Lock acquisition order:
 *   1. `merchants` row (`FOR UPDATE`) — prevents phantom warning inserts/count drift
 *   2. `store_onboarding_profiles` row (`FOR UPDATE`)
 *   3. `store_compliance_warnings` rows (locked downstream by callers when mutating warnings)
 */
async function ensureAndLockStoreProfile(
  client: StrictPgClient,
  merchantId: string
): Promise<
  | { ok: true; merchant: Record<string, unknown>; profile: Record<string, unknown> }
  | { ok: false; status: 404; code: string; error: string }
> {
  const merchRes = await client.query(
    `SELECT id, business_name, category, is_open
     FROM merchants
     WHERE id = $1
     FOR UPDATE`,
    [merchantId]
  );
  if (merchRes.rows.length === 0) {
    return { ok: false, status: 404, code: 'STORE_NOT_FOUND', error: 'Merchant store not found.' };
  }
  const merchant = merchRes.rows[0] as Record<string, unknown>;

  let profRes = await client.query(
    `SELECT * FROM store_onboarding_profiles WHERE merchant_id = $1 FOR UPDATE`,
    [merchantId]
  );
  if (profRes.rows.length === 0) {
    profRes = await client.query(
      `INSERT INTO store_onboarding_profiles (merchant_id, business_name, category, status)
       VALUES ($1, $2, $3, 'PENDING_SUBMISSION')
       RETURNING *`,
      [merchantId, String(merchant.business_name), String(merchant.category).toUpperCase()]
    );
  }

  return { ok: true, merchant, profile: profRes.rows[0] as Record<string, unknown> };
}

async function appendComplianceAuditEvent(
  client: StrictPgClient,
  params: {
    merchantId: string;
    actorType: 'ADMIN' | 'SELLER';
    actorId: string;
    eventType: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO store_onboarding_audit_events
       (merchant_id, actor_type, actor_id, event_type, event_metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [params.merchantId, params.actorType, params.actorId, params.eventType, JSON.stringify(params.metadata)]
  );
}

async function appendComplianceNotificationEvent(
  client: StrictPgClient,
  params: {
    merchantId: string;
    warningId?: string | null;
    ownerSellerAccountId: string;
    recipientRole: 'OWNER' | 'ADMIN';
    eventType:
      | 'COMPLIANCE_WARNING_ISSUED'
      | 'COMPLIANCE_WARNING_RESPONSE_SUBMITTED'
      | 'COMPLIANCE_WARNING_RESOLVED'
      | 'COMPLIANCE_WARNING_ESCALATED'
      | 'COMPLIANCE_STORE_SUSPENDED'
      | 'COMPLIANCE_SUSPENSION_RESPONSE_SUBMITTED'
      | 'COMPLIANCE_STORE_REACTIVATED';
    payload: Record<string, unknown>;
  }
): Promise<string> {
  const res = await client.query(
    `INSERT INTO owner_notification_events
       (merchant_id, warning_id, owner_seller_account_id, recipient_role, event_type, payload, delivery_status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PENDING')
     RETURNING id`,
    [
      params.merchantId,
      params.warningId ?? null,
      params.ownerSellerAccountId,
      params.recipientRole,
      params.eventType,
      JSON.stringify(params.payload)
    ]
  );
  return String(res.rows[0].id);
}

function mapComplianceTxError<T>(err: unknown, context: string): AdminServiceResult<T> {
  const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
  if (mapped.status === 503 || mapped.status === 400 || mapped.status === 409) {
    return { ok: false, status: mapped.status as 400 | 409 | 503, code: mapped.code, error: mapped.message };
  }
  console.error(`[AdminCompliance:${context}] Unexpected error: ${sanitizeErrorForLog(err)}`);
  return { ok: false, status: 503, code: 'INTERNAL_ERROR', error: 'Unable to complete compliance operation.' };
}

// -------------------------------------------------------------------------
// 1. Issue Formal Store Compliance Warning (`POST .../compliance/warnings`)
// -------------------------------------------------------------------------

export async function issueStoreComplianceWarning(
  merchantPool: StrictPgPool,
  params: {
    storeId: string;
    adminId: string;
    violationCategory: unknown;
    severity: unknown;
    reason: unknown;
    requiredCorrectiveAction: unknown;
    correctiveDeadline?: unknown;
    evidenceReferences?: unknown;
  }
): Promise<
  AdminServiceResult<{
    warning: StoreComplianceWarningSummary;
    warningCounts: StoreWarningCounts;
    notificationEventId: string | null;
  }>
> {
  const storeId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  if (!STORE_UUID_REGEX.test(storeId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid store UUID is required.' };
  }

  const violationCategory =
    typeof params.violationCategory === 'string' ? params.violationCategory.trim().toUpperCase() : '';
  if (!ALL_VIOLATION_CATEGORIES.has(violationCategory)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_VIOLATION_CATEGORY',
      error: `Valid violationCategory required (${Array.from(ALL_VIOLATION_CATEGORIES).join(', ')}).`
    };
  }

  const severity = typeof params.severity === 'string' ? params.severity.trim().toUpperCase() : '';
  if (!WARNING_SEVERITIES.has(severity)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SEVERITY',
      error: 'severity must be LOW, MODERATE, HIGH, or CRITICAL.'
    };
  }

  const isSeriousCategory = SERIOUS_VIOLATION_CATEGORIES.has(violationCategory);
  if (isSeriousCategory && severity !== 'HIGH' && severity !== 'CRITICAL') {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SEVERITY_FOR_CATEGORY',
      error: `Serious violation category '${violationCategory}' requires HIGH or CRITICAL severity.`
    };
  }
  if (!isSeriousCategory && severity === 'CRITICAL') {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SEVERITY_FOR_CATEGORY',
      error: 'CRITICAL severity is reserved for serious fraud, immediate safety, or major legal risks.'
    };
  }

  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length < 5 || reason.length > 2000) {
    return {
      ok: false,
      status: 400,
      code: 'REASON_REQUIRED',
      error: 'A detailed warning reason (5-2000 characters) is required.'
    };
  }

  const requiredCorrectiveAction =
    typeof params.requiredCorrectiveAction === 'string' ? params.requiredCorrectiveAction.trim() : '';
  if (requiredCorrectiveAction.length < 5 || requiredCorrectiveAction.length > 2000) {
    return {
      ok: false,
      status: 400,
      code: 'CORRECTIVE_ACTION_REQUIRED',
      error: 'Non-empty requiredCorrectiveAction (5-2000 characters) is required.'
    };
  }

  let correctiveDeadlineIso: string | null = null;
  if (params.correctiveDeadline !== undefined && params.correctiveDeadline !== null && params.correctiveDeadline !== '') {
    if (typeof params.correctiveDeadline !== 'string') {
      return { ok: false, status: 400, code: 'INVALID_DEADLINE', error: 'correctiveDeadline must be an ISO-8601 timestamp string.' };
    }
    const parsedDeadline = new Date(params.correctiveDeadline.trim());
    if (Number.isNaN(parsedDeadline.getTime()) || parsedDeadline.getTime() <= Date.now()) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_DEADLINE',
        error: 'correctiveDeadline must be a valid future timestamp.'
      };
    }
    correctiveDeadlineIso = parsedDeadline.toISOString();
  }

  const evidenceCheck = normalizeSafeEvidenceReferences(params.evidenceReferences);
  if (!evidenceCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_EVIDENCE_REFERENCES', error: evidenceCheck.error };
  }

  const isFormalOrdinary = !isSeriousCategory;

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await ensureAndLockStoreProfile(client, storeId);
      if (!lockRes.ok) return lockRes;

      const statsRes = await client.query(
        `SELECT
           COALESCE(MAX(warning_number), 0) + 1 AS next_number,
           COUNT(*) FILTER (WHERE status = 'OPEN' AND is_formal_ordinary = true)::int AS open_ordinary,
           COUNT(*) FILTER (WHERE status = 'OPEN' AND is_formal_ordinary = false)::int AS open_serious,
           COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved_count,
           COUNT(*)::int AS total_count,
           COUNT(*) FILTER (WHERE status = 'OPEN' AND corrective_deadline IS NOT NULL AND corrective_deadline < CURRENT_TIMESTAMP)::int AS overdue_count
         FROM store_compliance_warnings
         WHERE merchant_id = $1`,
        [storeId]
      );
      const stats = statsRes.rows[0];
      const nextWarningNumber = Number(stats.next_number);

      const insRes = await client.query(
        `INSERT INTO store_compliance_warnings
           (merchant_id, warning_number, violation_category, severity, is_formal_ordinary,
            reason, required_corrective_action, issued_by_admin_id, corrective_deadline,
            status, evidence_references)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, 'OPEN', $10::jsonb)
         RETURNING *`,
        [
          storeId,
          nextWarningNumber,
          violationCategory,
          severity,
          isFormalOrdinary,
          reason,
          requiredCorrectiveAction,
          params.adminId,
          correctiveDeadlineIso,
          JSON.stringify(evidenceCheck.items)
        ]
      );
      const warning = mapWarningRow(insRes.rows[0] as Record<string, unknown>, []);

      const newOpenOrdinary = Number(stats.open_ordinary) + (isFormalOrdinary ? 1 : 0);
      const newOpenSerious = Number(stats.open_serious) + (isFormalOrdinary ? 0 : 1);
      const warningCounts: StoreWarningCounts = {
        openOrdinaryWarnings: newOpenOrdinary,
        openSeriousWarnings: newOpenSerious,
        totalOpenWarnings: newOpenOrdinary + newOpenSerious,
        overdueOpenWarnings: Number(stats.overdue_count),
        resolvedWarnings: Number(stats.resolved_count),
        totalWarningsIssued: Number(stats.total_count) + 1
      };

      await appendComplianceAuditEvent(client, {
        merchantId: storeId,
        actorType: 'ADMIN',
        actorId: params.adminId,
        eventType: 'COMPLIANCE_WARNING_ISSUED',
        metadata: {
          actorType: 'ADMIN',
          actorId: params.adminId,
          storeId,
          warningId: warning.id,
          warningNumber: warning.warningNumber,
          action: 'ISSUE_WARNING',
          violationCategory,
          severity,
          isFormalOrdinary,
          reason,
          requiredCorrectiveAction,
          correctiveDeadline: correctiveDeadlineIso,
          openOrdinaryWarningsAfterIssue: newOpenOrdinary,
          evidenceReferences: evidenceCheck.items,
          timestamp: warning.issuedAt
        }
      });

      const ownerAccountId = await resolveOwnerSellerAccountIdForStore(client, storeId);
      let notificationEventId: string | null = null;
      if (ownerAccountId) {
        notificationEventId = await appendComplianceNotificationEvent(client, {
          merchantId: storeId,
          warningId: warning.id,
          ownerSellerAccountId: ownerAccountId,
          recipientRole: 'OWNER',
          eventType: 'COMPLIANCE_WARNING_ISSUED',
          payload: {
            storeId,
            businessName: String(lockRes.merchant.business_name),
            warningId: warning.id,
            warningNumber: warning.warningNumber,
            violationCategory,
            severity,
            reason,
            requiredCorrectiveAction,
            correctiveDeadline: correctiveDeadlineIso,
            issuedAt: warning.issuedAt
          }
        });
      }

      return {
        ok: true as const,
        data: { warning, warningCounts, notificationEventId }
      };
    });
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'issueStoreComplianceWarning');
  }
}

// -------------------------------------------------------------------------
// 2. Owner Corrective Response (`POST /seller/.../warnings/:warningId/respond`)
// -------------------------------------------------------------------------

export async function submitOwnerWarningResponse(
  merchantPool: StrictPgPool,
  params: {
    storeId: string;
    warningId: string;
    sellerAccountId: string;
    responseMessage: unknown;
    evidenceReferences?: unknown;
  }
): Promise<
  AdminServiceResult<{
    response: WarningResponseRecord;
    warningStatus: 'OPEN';
    notificationEventId: string;
  }>
> {
  const storeId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  const warningId = typeof params.warningId === 'string' ? params.warningId.trim() : '';
  if (!STORE_UUID_REGEX.test(storeId) || !STORE_UUID_REGEX.test(warningId)) {
    return { ok: false, status: 400, code: 'INVALID_IDENTIFIER', error: 'Valid storeId and warningId UUIDs are required.' };
  }

  const message = typeof params.responseMessage === 'string' ? params.responseMessage.trim() : '';
  if (message.length < 5 || message.length > 2000) {
    return {
      ok: false,
      status: 400,
      code: 'RESPONSE_MESSAGE_REQUIRED',
      error: 'A corrective response message (5-2000 characters) is required.'
    };
  }

  const evidenceCheck = normalizeSafeEvidenceReferences(params.evidenceReferences);
  if (!evidenceCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_EVIDENCE_REFERENCES', error: evidenceCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await ensureAndLockStoreProfile(client, storeId);
      if (!lockRes.ok) return lockRes;

      const warnLock = await client.query(
        `SELECT *
         FROM store_compliance_warnings
         WHERE id = $1 AND merchant_id = $2
         FOR UPDATE`,
        [warningId, storeId]
      );
      if (warnLock.rows.length === 0) {
        return {
          ok: false as const,
          status: 404 as const,
          code: 'WARNING_NOT_FOUND',
          error: 'Compliance warning not found for this store.'
        };
      }
      const warnRow = warnLock.rows[0] as Record<string, unknown>;
      if (String(warnRow.status) !== 'OPEN') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'WARNING_ALREADY_RESOLVED',
          error: 'This warning has already been resolved by an administrator.'
        };
      }

      const insResp = await client.query(
        `INSERT INTO store_compliance_warning_responses
           (warning_id, merchant_id, responded_by_seller_account_id, response_message, evidence_references)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING *`,
        [warningId, storeId, params.sellerAccountId, message, JSON.stringify(evidenceCheck.items)]
      );
      const rRow = insResp.rows[0] as Record<string, unknown>;

      // Touch updated_at only — Owner response NEVER resolves the warning or changes counts
      await client.query(
        `UPDATE store_compliance_warnings SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [warningId]
      );

      const createdAt = toIsoRequired(rRow.created_at);
      await appendComplianceAuditEvent(client, {
        merchantId: storeId,
        actorType: 'SELLER',
        actorId: params.sellerAccountId,
        eventType: 'COMPLIANCE_WARNING_RESPONSE_SUBMITTED',
        metadata: {
          actorType: 'SELLER',
          actorId: params.sellerAccountId,
          storeId,
          warningId,
          warningNumber: Number(warnRow.warning_number),
          responseId: String(rRow.id),
          action: 'OWNER_WARNING_RESPONSE',
          previousStatus: 'OPEN',
          newStatus: 'OPEN',
          evidenceReferences: evidenceCheck.items,
          timestamp: createdAt
        }
      });

      const notificationEventId = await appendComplianceNotificationEvent(client, {
        merchantId: storeId,
        warningId,
        ownerSellerAccountId: params.sellerAccountId,
        recipientRole: 'ADMIN',
        eventType: 'COMPLIANCE_WARNING_RESPONSE_SUBMITTED',
        payload: {
          storeId,
          warningId,
          warningNumber: Number(warnRow.warning_number),
          responseId: String(rRow.id),
          respondedBySellerAccountId: params.sellerAccountId,
          evidenceCount: evidenceCheck.items.length,
          submittedAt: createdAt
        }
      });

      return {
        ok: true as const,
        data: {
          response: {
            id: String(rRow.id),
            warningId,
            respondedBySellerAccountId: params.sellerAccountId,
            responseMessage: message,
            evidenceReferences: evidenceCheck.items,
            createdAt
          },
          warningStatus: 'OPEN',
          notificationEventId
        }
      };
    });
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'submitOwnerWarningResponse');
  }
}

// -------------------------------------------------------------------------
// 3. Admin Escalation Review (`POST .../warnings/:warningId/escalate`)
// -------------------------------------------------------------------------

export async function escalateStoreComplianceWarning(
  merchantPool: StrictPgPool,
  params: {
    storeId: string;
    warningId: string;
    adminId: string;
    notes: unknown;
    evidenceReferences?: unknown;
  }
): Promise<AdminServiceResult<{ warning: StoreComplianceWarningSummary; notificationEventId: string | null }>> {
  const storeId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  const warningId = typeof params.warningId === 'string' ? params.warningId.trim() : '';
  if (!STORE_UUID_REGEX.test(storeId) || !STORE_UUID_REGEX.test(warningId)) {
    return { ok: false, status: 400, code: 'INVALID_IDENTIFIER', error: 'Valid storeId and warningId UUIDs are required.' };
  }

  const notes = typeof params.notes === 'string' ? params.notes.trim() : '';
  if (notes.length < 5 || notes.length > 1000) {
    return {
      ok: false,
      status: 400,
      code: 'ESCALATION_NOTES_REQUIRED',
      error: 'Escalation notes (5-1000 characters) are required.'
    };
  }

  const evidenceCheck = normalizeSafeEvidenceReferences(params.evidenceReferences);
  if (!evidenceCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_EVIDENCE_REFERENCES', error: evidenceCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await ensureAndLockStoreProfile(client, storeId);
      if (!lockRes.ok) return lockRes;

      const warnLock = await client.query(
        `SELECT * FROM store_compliance_warnings WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
        [warningId, storeId]
      );
      if (warnLock.rows.length === 0) {
        return { ok: false as const, status: 404 as const, code: 'WARNING_NOT_FOUND', error: 'Warning not found for this store.' };
      }
      const existing = warnLock.rows[0] as Record<string, unknown>;
      if (String(existing.status) !== 'OPEN') {
        return { ok: false as const, status: 409 as const, code: 'WARNING_ALREADY_RESOLVED', error: 'Cannot escalate an already RESOLVED warning.' };
      }

      const upd = await client.query(
        `UPDATE store_compliance_warnings
         SET escalated_at = CURRENT_TIMESTAMP,
             escalated_by_admin_id = $1,
             escalation_notes = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING *`,
        [params.adminId, notes, warningId]
      );

      const respRes = await client.query(
        `SELECT * FROM store_compliance_warning_responses WHERE warning_id = $1 ORDER BY created_at ASC`,
        [warningId]
      );
      const responses: WarningResponseRecord[] = respRes.rows.map((r) => ({
        id: String(r.id),
        warningId,
        respondedBySellerAccountId: String(r.responded_by_seller_account_id),
        responseMessage: String(r.response_message),
        evidenceReferences: Array.isArray(r.evidence_references) ? r.evidence_references : [],
        createdAt: toIsoRequired(r.created_at)
      }));

      const warning = mapWarningRow(upd.rows[0] as Record<string, unknown>, responses);

      await appendComplianceAuditEvent(client, {
        merchantId: storeId,
        actorType: 'ADMIN',
        actorId: params.adminId,
        eventType: 'COMPLIANCE_WARNING_ESCALATED',
        metadata: {
          actorType: 'ADMIN',
          actorId: params.adminId,
          storeId,
          warningId,
          warningNumber: warning.warningNumber,
          action: 'ESCALATE_WARNING',
          previousStatus: 'OPEN',
          newStatus: 'OPEN',
          isOverdue: warning.isOverdue,
          reason: notes,
          evidenceReferences: evidenceCheck.items,
          timestamp: warning.escalatedAt
        }
      });

      const ownerAccountId = await resolveOwnerSellerAccountIdForStore(client, storeId);
      let notificationEventId: string | null = null;
      if (ownerAccountId) {
        notificationEventId = await appendComplianceNotificationEvent(client, {
          merchantId: storeId,
          warningId,
          ownerSellerAccountId: ownerAccountId,
          recipientRole: 'OWNER',
          eventType: 'COMPLIANCE_WARNING_ESCALATED',
          payload: {
            storeId,
            warningId,
            warningNumber: warning.warningNumber,
            isOverdue: warning.isOverdue,
            escalatedAt: warning.escalatedAt
          }
        });
      }

      return { ok: true as const, data: { warning, notificationEventId } };
    });
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'escalateStoreComplianceWarning');
  }
}

// -------------------------------------------------------------------------
// 4. Resolve Store Warning (`POST .../warnings/:warningId/resolve`)
// -------------------------------------------------------------------------

interface ResolveWarningWithinTxInput {
  storeId: string;
  merchantBusinessName: string;
  warningRow: Record<string, unknown>;
  adminId: string;
  reason: string;
  allowResolutionWithoutOwnerResponse: boolean;
  evidenceReferences: SafeEvidenceReference[];
}

async function resolveWarningWithinTx(
  client: StrictPgClient,
  input: ResolveWarningWithinTxInput
): Promise<
  AdminServiceResult<{
    warning: StoreComplianceWarningSummary;
    warningCounts: StoreWarningCounts;
    notificationEventId: string | null;
  }>
> {
  const warningId = String(input.warningRow.id);
  if (String(input.warningRow.status) === 'RESOLVED') {
    return {
      ok: false,
      status: 409,
      code: 'WARNING_ALREADY_RESOLVED',
      error: 'This compliance warning has already been resolved.'
    };
  }

  const respRes = await client.query(
    `SELECT * FROM store_compliance_warning_responses WHERE warning_id = $1 ORDER BY created_at ASC`,
    [warningId]
  );
  if (respRes.rows.length === 0 && !input.allowResolutionWithoutOwnerResponse) {
    return {
      ok: false,
      status: 409,
      code: 'OWNER_RESPONSE_REQUIRED',
      error: `Owner corrective response must be recorded before resolving warning #${Number(input.warningRow.warning_number)}.`
    };
  }

  const upd = await client.query(
    `UPDATE store_compliance_warnings
     SET status = 'RESOLVED',
         resolved_by_admin_id = $1,
         resolved_at = CURRENT_TIMESTAMP,
         resolution_reason = $2,
         resolution_evidence_checked = true,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND status = 'OPEN'
     RETURNING *`,
    [input.adminId, input.reason, warningId]
  );
  if (upd.rows.length === 0) {
    return { ok: false, status: 409, code: 'WARNING_ALREADY_RESOLVED', error: 'Warning state changed concurrently.' };
  }

  const responses: WarningResponseRecord[] = respRes.rows.map((r) => ({
    id: String(r.id),
    warningId,
    respondedBySellerAccountId: String(r.responded_by_seller_account_id),
    responseMessage: String(r.response_message),
    evidenceReferences: Array.isArray(r.evidence_references) ? r.evidence_references : [],
    createdAt: toIsoRequired(r.created_at)
  }));
  const warning = mapWarningRow(upd.rows[0] as Record<string, unknown>, responses);

  // Recompute store counts cleanly (resolved warning no longer counts)
  const allWarnRes = await client.query(
    `SELECT id, status, is_formal_ordinary, corrective_deadline
     FROM store_compliance_warnings
     WHERE merchant_id = $1`,
    [input.storeId]
  );
  const warningCounts = computeCountsFromWarnings(
    allWarnRes.rows.map((w) => {
      const st = String(w.status) === 'RESOLVED' ? ('RESOLVED' as const) : ('OPEN' as const);
      return {
        status: st,
        isFormalOrdinary: Boolean(w.is_formal_ordinary),
        isOverdue: deriveIsOverdue(st, toIsoNullable(w.corrective_deadline))
      };
    })
  );

  await appendComplianceAuditEvent(client, {
    merchantId: input.storeId,
    actorType: 'ADMIN',
    actorId: input.adminId,
    eventType: 'COMPLIANCE_WARNING_RESOLVED',
    metadata: {
      actorType: 'ADMIN',
      actorId: input.adminId,
      storeId: input.storeId,
      warningId,
      warningNumber: warning.warningNumber,
      action: 'RESOLVE_WARNING',
      previousStatus: 'OPEN',
      newStatus: 'RESOLVED',
      reason: input.reason,
      evidenceReferences: input.evidenceReferences,
      openOrdinaryWarningsAfterResolve: warningCounts.openOrdinaryWarnings,
      timestamp: warning.resolvedAt
    }
  });

  const ownerAccountId = await resolveOwnerSellerAccountIdForStore(client, input.storeId);
  let notificationEventId: string | null = null;
  if (ownerAccountId) {
    notificationEventId = await appendComplianceNotificationEvent(client, {
      merchantId: input.storeId,
      warningId,
      ownerSellerAccountId: ownerAccountId,
      recipientRole: 'OWNER',
      eventType: 'COMPLIANCE_WARNING_RESOLVED',
      payload: {
        storeId: input.storeId,
        businessName: input.merchantBusinessName,
        warningId,
        warningNumber: warning.warningNumber,
        resolutionReason: input.reason,
        resolvedAt: warning.resolvedAt
      }
    });
  }

  return {
    ok: true,
    data: { warning, warningCounts, notificationEventId }
  };
}

export async function resolveStoreComplianceWarning(
  merchantPool: StrictPgPool,
  params: {
    storeId: string;
    warningId: string;
    adminId: string;
    reason: unknown;
    correctiveEvidenceChecked: unknown;
    allowResolutionWithoutOwnerResponse?: unknown;
    evidenceReferences?: unknown;
  }
): Promise<
  AdminServiceResult<{
    warning: StoreComplianceWarningSummary;
    warningCounts: StoreWarningCounts;
    notificationEventId: string | null;
  }>
> {
  const storeId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  const warningId = typeof params.warningId === 'string' ? params.warningId.trim() : '';
  if (!STORE_UUID_REGEX.test(storeId) || !STORE_UUID_REGEX.test(warningId)) {
    return { ok: false, status: 400, code: 'INVALID_IDENTIFIER', error: 'Valid storeId and warningId UUIDs are required.' };
  }

  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length < 5 || reason.length > 2000) {
    return {
      ok: false,
      status: 400,
      code: 'RESOLUTION_REASON_REQUIRED',
      error: 'A non-empty resolution reason (5-2000 characters) is required.'
    };
  }

  if (params.correctiveEvidenceChecked !== true) {
    return {
      ok: false,
      status: 400,
      code: 'CORRECTIVE_EVIDENCE_CHECK_REQUIRED',
      error: 'correctiveEvidenceChecked must be explicitly confirmed true before resolving a warning.'
    };
  }

  const evidenceCheck = normalizeSafeEvidenceReferences(params.evidenceReferences);
  if (!evidenceCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_EVIDENCE_REFERENCES', error: evidenceCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await ensureAndLockStoreProfile(client, storeId);
      if (!lockRes.ok) return lockRes;

      const warnLock = await client.query(
        `SELECT * FROM store_compliance_warnings WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
        [warningId, storeId]
      );
      if (warnLock.rows.length === 0) {
        return { ok: false as const, status: 404 as const, code: 'WARNING_NOT_FOUND', error: 'Warning not found for this store.' };
      }

      return resolveWarningWithinTx(client, {
        storeId,
        merchantBusinessName: String(lockRes.merchant.business_name),
        warningRow: warnLock.rows[0] as Record<string, unknown>,
        adminId: params.adminId,
        reason,
        allowResolutionWithoutOwnerResponse: params.allowResolutionWithoutOwnerResponse === true,
        evidenceReferences: evidenceCheck.items
      });
    });
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'resolveStoreComplianceWarning');
  }
}

// -------------------------------------------------------------------------
// 5. Store Suspension (`POST /api/v1/admin/stores/:storeId/compliance/suspend`)
// -------------------------------------------------------------------------

export async function suspendMerchantStore(
  merchantPool: StrictPgPool,
  params: {
    storeId: string;
    adminId: string;
    suspensionType: unknown;
    violationCategory: unknown;
    reason: unknown;
    evidenceReferences?: unknown;
  }
): Promise<
  AdminServiceResult<{
    storeId: string;
    previousStatus: string;
    newStatus: 'SUSPENDED';
    suspensionType: string;
    isOpen: boolean;
    suspendedAt: string;
    suspendedByAdminId: string;
    notificationEventId: string | null;
  }>
> {
  const storeId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  if (!STORE_UUID_REGEX.test(storeId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid store UUID is required.' };
  }

  const suspensionType =
    typeof params.suspensionType === 'string' ? params.suspensionType.trim().toUpperCase() : '';
  if (!SUSPENSION_TYPES.has(suspensionType)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SUSPENSION_TYPE',
      error: "suspensionType must be 'ORDINARY_VIOLATION' or 'PROTECTIVE_SERIOUS_RISK'."
    };
  }

  const violationCategory =
    typeof params.violationCategory === 'string' ? params.violationCategory.trim().toUpperCase() : '';
  if (!ALL_VIOLATION_CATEGORIES.has(violationCategory)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_VIOLATION_CATEGORY',
      error: `Valid violationCategory required (${Array.from(ALL_VIOLATION_CATEGORIES).join(', ')}).`
    };
  }

  if (suspensionType === 'PROTECTIVE_SERIOUS_RISK' && !SERIOUS_VIOLATION_CATEGORIES.has(violationCategory)) {
    return {
      ok: false,
      status: 400,
      code: 'SERIOUS_CATEGORY_REQUIRED',
      error: 'Immediate protective suspension requires a serious risk category (SUSPECTED_FRAUD, IMMEDIATE_SAFETY_RISK, MAJOR_LEGAL_COMPLIANCE).'
    };
  }

  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length < 10 || reason.length > 2000) {
    return {
      ok: false,
      status: 400,
      code: 'SUSPENSION_REASON_REQUIRED',
      error: 'A detailed suspension reason (10-2000 characters) is required.'
    };
  }

  const evidenceCheck = normalizeSafeEvidenceReferences(params.evidenceReferences);
  if (!evidenceCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_EVIDENCE_REFERENCES', error: evidenceCheck.error };
  }

  if (suspensionType === 'PROTECTIVE_SERIOUS_RISK' && evidenceCheck.items.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'EVIDENCE_REQUIRED',
      error: 'Supporting evidence references are required for immediate protective suspension.'
    };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await ensureAndLockStoreProfile(client, storeId);
      if (!lockRes.ok) return lockRes;
      const previousStatus = String(lockRes.profile.status);

      if (previousStatus === 'SUSPENDED') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'STORE_ALREADY_SUSPENDED',
          error: 'Store is already suspended.'
        };
      }

      // Ordinary suspension strictly requires at least TWO currently OPEN formal ordinary warnings on THIS store.
      // Resolved warnings, historical warning counts, warnings on other stores, and overdue status never bypass this threshold.
      if (suspensionType === 'ORDINARY_VIOLATION') {
        const warnCheckRes = await client.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'OPEN' AND is_formal_ordinary = true)::int AS open_ordinary
           FROM store_compliance_warnings
           WHERE merchant_id = $1`,
          [storeId]
        );
        const openOrd = Number(warnCheckRes.rows[0]?.open_ordinary ?? 0);

        if (openOrd < 2) {
          return {
            ok: false as const,
            status: 409 as const,
            code: 'PRIOR_WARNINGS_REQUIRED',
            error:
              'Ordinary compliance suspension requires at least two currently OPEN formal ordinary warnings on this store. Resolved warnings and overdue status alone do not bypass this threshold; use PROTECTIVE_SERIOUS_RISK for immediate serious risks.'
          };
        }
      }

      const updProf = await client.query(
        `UPDATE store_onboarding_profiles
         SET status = 'SUSPENDED',
             pre_suspension_status = $1,
             suspended_at = CURRENT_TIMESTAMP,
             suspended_by_admin_id = $2,
             suspension_reason = $3,
             suspension_type = $4,
             suspension_evidence = $5::jsonb,
             owner_suspension_response = NULL,
             owner_suspension_evidence = NULL,
             owner_suspension_responded_at = NULL,
             owner_suspension_responded_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = $6
         RETURNING suspended_at`,
        [
          previousStatus,
          params.adminId,
          reason,
          suspensionType,
          JSON.stringify(evidenceCheck.items),
          storeId
        ]
      );

      // Force store closed; preserve all approved_* history and submissions
      await client.query(`UPDATE merchants SET is_open = false WHERE id = $1`, [storeId]);

      const suspendedAt = toIsoRequired(updProf.rows[0].suspended_at);

      await appendComplianceAuditEvent(client, {
        merchantId: storeId,
        actorType: 'ADMIN',
        actorId: params.adminId,
        eventType: 'COMPLIANCE_STORE_SUSPENDED',
        metadata: {
          actorType: 'ADMIN',
          actorId: params.adminId,
          storeId,
          action: 'SUSPEND_STORE',
          suspensionType,
          violationCategory,
          previousStatus,
          newStatus: 'SUSPENDED',
          reason,
          evidenceReferences: evidenceCheck.items,
          timestamp: suspendedAt
        }
      });

      const ownerAccountId = await resolveOwnerSellerAccountIdForStore(client, storeId);
      let notificationEventId: string | null = null;
      if (ownerAccountId) {
        notificationEventId = await appendComplianceNotificationEvent(client, {
          merchantId: storeId,
          ownerSellerAccountId: ownerAccountId,
          recipientRole: 'OWNER',
          eventType: 'COMPLIANCE_STORE_SUSPENDED',
          payload: {
            storeId,
            businessName: String(lockRes.merchant.business_name),
            suspensionType,
            violationCategory,
            reason,
            suspendedAt
          }
        });
      }

      return {
        ok: true as const,
        data: {
          storeId,
          previousStatus,
          newStatus: 'SUSPENDED',
          suspensionType,
          isOpen: false,
          suspendedAt,
          suspendedByAdminId: params.adminId,
          notificationEventId
        }
      };
    });
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'suspendMerchantStore');
  }
}

// -------------------------------------------------------------------------
// 6. Owner Suspension Corrective Response (`POST /seller/.../suspension/respond`)
// -------------------------------------------------------------------------

export async function submitOwnerSuspensionResponse(
  merchantPool: StrictPgPool,
  params: {
    storeId: string;
    sellerAccountId: string;
    responseMessage: unknown;
    evidenceReferences?: unknown;
  }
): Promise<
  AdminServiceResult<{
    storeId: string;
    status: 'SUSPENDED';
    respondedAt: string;
    notificationEventId: string;
  }>
> {
  const storeId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  if (!STORE_UUID_REGEX.test(storeId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid storeId UUID is required.' };
  }

  const message = typeof params.responseMessage === 'string' ? params.responseMessage.trim() : '';
  if (message.length < 5 || message.length > 2000) {
    return {
      ok: false,
      status: 400,
      code: 'RESPONSE_MESSAGE_REQUIRED',
      error: 'A corrective response message (5-2000 characters) is required.'
    };
  }

  const evidenceCheck = normalizeSafeEvidenceReferences(params.evidenceReferences);
  if (!evidenceCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_EVIDENCE_REFERENCES', error: evidenceCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await ensureAndLockStoreProfile(client, storeId);
      if (!lockRes.ok) return lockRes;
      if (String(lockRes.profile.status) !== 'SUSPENDED') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'STORE_NOT_SUSPENDED',
          error: 'Suspension corrective response is only accepted while store is SUSPENDED.'
        };
      }

      const upd = await client.query(
        `UPDATE store_onboarding_profiles
         SET owner_suspension_response = $1,
             owner_suspension_evidence = $2::jsonb,
             owner_suspension_responded_at = CURRENT_TIMESTAMP,
             owner_suspension_responded_by = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = $4
         RETURNING owner_suspension_responded_at`,
        [message, JSON.stringify(evidenceCheck.items), params.sellerAccountId, storeId]
      );

      const respondedAt = toIsoRequired(upd.rows[0].owner_suspension_responded_at);

      await appendComplianceAuditEvent(client, {
        merchantId: storeId,
        actorType: 'SELLER',
        actorId: params.sellerAccountId,
        eventType: 'COMPLIANCE_SUSPENSION_RESPONSE_SUBMITTED',
        metadata: {
          actorType: 'SELLER',
          actorId: params.sellerAccountId,
          storeId,
          action: 'OWNER_SUSPENSION_RESPONSE',
          previousStatus: 'SUSPENDED',
          newStatus: 'SUSPENDED',
          evidenceReferences: evidenceCheck.items,
          timestamp: respondedAt
        }
      });

      const notificationEventId = await appendComplianceNotificationEvent(client, {
        merchantId: storeId,
        ownerSellerAccountId: params.sellerAccountId,
        recipientRole: 'ADMIN',
        eventType: 'COMPLIANCE_SUSPENSION_RESPONSE_SUBMITTED',
        payload: {
          storeId,
          respondedBySellerAccountId: params.sellerAccountId,
          evidenceCount: evidenceCheck.items.length,
          submittedAt: respondedAt
        }
      });

      return {
        ok: true as const,
        data: {
          storeId,
          status: 'SUSPENDED',
          respondedAt,
          notificationEventId
        }
      };
    });
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'submitOwnerSuspensionResponse');
  }
}

// -------------------------------------------------------------------------
// 7. Admin Reactivation (`POST /api/v1/admin/stores/:storeId/compliance/reactivate`)
// -------------------------------------------------------------------------

interface NormalizedReactivationWarningResolution {
  warningId: string;
  reason: string;
  allowResolutionWithoutOwnerResponse: boolean;
  evidenceReferences: SafeEvidenceReference[];
}

function normalizeReactivationWarningResolutions(
  raw: unknown
): { ok: true; items: NormalizedReactivationWarningResolution[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, items: [] };
  }
  if (!Array.isArray(raw) || raw.length > 50) {
    return { ok: false, error: 'warningResolutions must be an array of at most 50 entries.' };
  }

  const seenIds = new Set<string>();
  const items: NormalizedReactivationWarningResolution[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'Each warningResolutions entry must be an object.' };
    }
    const obj = entry as Record<string, unknown>;
    const warningId = typeof obj.warningId === 'string' ? obj.warningId.trim() : '';
    if (!STORE_UUID_REGEX.test(warningId) || seenIds.has(warningId)) {
      return { ok: false, error: 'Each warningResolutions entry requires a unique valid warningId UUID.' };
    }
    seenIds.add(warningId);

    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (reason.length < 5 || reason.length > 2000) {
      return { ok: false, error: `Warning ${warningId} resolution requires a non-empty reason (5-2000 characters).` };
    }
    if (obj.correctiveEvidenceChecked !== true) {
      return { ok: false, error: `Warning ${warningId} resolution requires correctiveEvidenceChecked=true.` };
    }

    const evCheck = normalizeSafeEvidenceReferences(obj.evidenceReferences);
    if (!evCheck.ok) {
      return { ok: false, error: `Warning ${warningId}: ${evCheck.error}` };
    }

    items.push({
      warningId,
      reason,
      allowResolutionWithoutOwnerResponse: obj.allowResolutionWithoutOwnerResponse === true,
      evidenceReferences: evCheck.items
    });
  }

  return { ok: true, items };
}

class ComplianceTxAbortError extends Error {
  constructor(public readonly outcome: AdminServiceResult<any>) {
    super('COMPLIANCE_TX_ABORT');
  }
}

export async function reactivateMerchantStore(
  merchantPool: StrictPgPool,
  params: {
    storeId: string;
    adminId: string;
    reason: unknown;
    correctiveEvidenceReviewed: unknown;
    evidenceReferences?: unknown;
    warningResolutions?: unknown;
  }
): Promise<
  AdminServiceResult<{
    storeId: string;
    previousStatus: 'SUSPENDED';
    restoredStatus: string;
    isOpen: boolean;
    reactivatedAt: string;
    reactivatedByAdminId: string;
    resolvedWarningIds: string[];
    notificationEventId: string | null;
  }>
> {
  const storeId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  if (!STORE_UUID_REGEX.test(storeId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid store UUID is required.' };
  }

  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length < 5 || reason.length > 2000) {
    return {
      ok: false,
      status: 400,
      code: 'REACTIVATION_REASON_REQUIRED',
      error: 'A detailed reactivation reason (5-2000 characters) is required.'
    };
  }

  if (params.correctiveEvidenceReviewed !== true) {
    return {
      ok: false,
      status: 400,
      code: 'CORRECTIVE_EVIDENCE_REVIEW_REQUIRED',
      error: 'correctiveEvidenceReviewed must be explicitly confirmed true before reactivating a suspended store.'
    };
  }

  const evidenceCheck = normalizeSafeEvidenceReferences(params.evidenceReferences);
  if (!evidenceCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_EVIDENCE_REFERENCES', error: evidenceCheck.error };
  }

  const resolutionsCheck = normalizeReactivationWarningResolutions(params.warningResolutions);
  if (!resolutionsCheck.ok) {
    return { ok: false, status: 400, code: 'INVALID_WARNING_RESOLUTIONS', error: resolutionsCheck.error };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await ensureAndLockStoreProfile(client, storeId);
      if (!lockRes.ok) return lockRes;
      const profile = lockRes.profile;

      if (String(profile.status) !== 'SUSPENDED') {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'STORE_NOT_SUSPENDED',
          error: `Only SUSPENDED stores can be reactivated (current status: '${String(profile.status)}').`
        };
      }

      // Lock all warnings on this store: NO OPEN warning may remain unresolved after reactivation,
      // regardless of top-level Admin evidenceReferences.
      const warnLockRes = await client.query(
        `SELECT * FROM store_compliance_warnings WHERE merchant_id = $1 ORDER BY warning_number ASC FOR UPDATE`,
        [storeId]
      );
      const warningsById = new Map<string, Record<string, unknown>>();
      const openWarnings: Record<string, unknown>[] = [];
      for (const row of warnLockRes.rows) {
        const rec = row as Record<string, unknown>;
        warningsById.set(String(rec.id), rec);
        if (String(rec.status) === 'OPEN') {
          openWarnings.push(rec);
        }
      }

      const resolutionMap = new Map<string, NormalizedReactivationWarningResolution>();
      for (const resItem of resolutionsCheck.items) {
        const target = warningsById.get(resItem.warningId);
        if (!target) {
          return {
            ok: false as const,
            status: 404 as const,
            code: 'WARNING_NOT_FOUND',
            error: `Warning '${resItem.warningId}' does not belong to this store.`
          };
        }
        if (String(target.status) !== 'OPEN') {
          return {
            ok: false as const,
            status: 409 as const,
            code: 'WARNING_ALREADY_RESOLVED',
            error: `Warning #${Number(target.warning_number)} is already RESOLVED.`
          };
        }
        resolutionMap.set(resItem.warningId, resItem);
      }

      const unaddressedOpen = openWarnings.filter((w) => !resolutionMap.has(String(w.id)));
      if (unaddressedOpen.length > 0) {
        const numbers = unaddressedOpen.map((w) => `#${Number(w.warning_number)}`).join(', ');
        return {
          ok: false as const,
          status: 409 as const,
          code: 'UNRESOLVED_WARNINGS_REMAIN',
          error: `Cannot reactivate store while OPEN compliance warning(s) (${numbers}) remain unresolved. Resolve each warning formally first or supply explicit warningResolutions.`
        };
      }

      // Check corrective evidence exists BEFORE writing any warning resolutions or profile changes
      const respCountRes = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM store_compliance_warning_responses WHERE merchant_id = $1`,
        [storeId]
      );
      const hasWarningResponse = Number(respCountRes.rows[0]?.cnt ?? 0) > 0;
      const hasSuspensionResponse = Boolean(profile.owner_suspension_responded_at);
      const hasAdminEvidenceRefs =
        evidenceCheck.items.length > 0 ||
        resolutionsCheck.items.some((r) => r.evidenceReferences.length > 0);

      if (!hasWarningResponse && !hasSuspensionResponse && !hasAdminEvidenceRefs) {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'CORRECTIVE_EVIDENCE_REQUIRED',
          error: 'Corrective Owner response or verified corrective evidence references are required prior to reactivation.'
        };
      }

      const resolvedWarningIds: string[] = [];
      for (const openWarn of openWarnings) {
        const resInput = resolutionMap.get(String(openWarn.id))!;
        const resolved = await resolveWarningWithinTx(client, {
          storeId,
          merchantBusinessName: String(lockRes.merchant.business_name),
          warningRow: openWarn,
          adminId: params.adminId,
          reason: resInput.reason,
          allowResolutionWithoutOwnerResponse: resInput.allowResolutionWithoutOwnerResponse,
          evidenceReferences: resInput.evidenceReferences
        });
        if (!resolved.ok) {
          // Force full ROLLBACK of any earlier warning resolutions in this transaction
          throw new ComplianceTxAbortError(resolved);
        }
        resolvedWarningIds.push(resolved.data.warning.id);
      }

      // Determine exact eligible status to restore without auto-approving unapproved stores
      let restoredStatus = profile.pre_suspension_status ? String(profile.pre_suspension_status) : 'PENDING_SUBMISSION';
      if (Boolean(profile.reverification_required)) {
        restoredStatus = 'REVERIFICATION_REQUIRED';
      } else if (restoredStatus === 'APPROVED' && !profile.approved_submission_id) {
        restoredStatus = 'PENDING_SUBMISSION';
      } else if (restoredStatus === 'SUSPENDED') {
        restoredStatus = profile.approved_submission_id ? 'APPROVED' : 'PENDING_SUBMISSION';
      }

      // Preserve suspension history & all historical warnings; never auto-open merchants.is_open
      const updProf = await client.query(
        `UPDATE store_onboarding_profiles
         SET status = $1,
             last_reactivated_at = CURRENT_TIMESTAMP,
             last_reactivated_by_admin_id = $2,
             last_reactivation_reason = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE merchant_id = $4
         RETURNING last_reactivated_at`,
        [restoredStatus, params.adminId, reason, storeId]
      );

      await client.query(`UPDATE merchants SET is_open = false WHERE id = $1`, [storeId]);

      const reactivatedAt = toIsoRequired(updProf.rows[0].last_reactivated_at);

      await appendComplianceAuditEvent(client, {
        merchantId: storeId,
        actorType: 'ADMIN',
        actorId: params.adminId,
        eventType: 'COMPLIANCE_STORE_REACTIVATED',
        metadata: {
          actorType: 'ADMIN',
          actorId: params.adminId,
          storeId,
          action: 'REACTIVATE_STORE',
          previousStatus: 'SUSPENDED',
          newStatus: restoredStatus,
          resolvedWarningIds,
          reason,
          evidenceReferences: evidenceCheck.items,
          timestamp: reactivatedAt
        }
      });

      const ownerAccountId = await resolveOwnerSellerAccountIdForStore(client, storeId);
      let notificationEventId: string | null = null;
      if (ownerAccountId) {
        notificationEventId = await appendComplianceNotificationEvent(client, {
          merchantId: storeId,
          ownerSellerAccountId: ownerAccountId,
          recipientRole: 'OWNER',
          eventType: 'COMPLIANCE_STORE_REACTIVATED',
          payload: {
            storeId,
            businessName: String(lockRes.merchant.business_name),
            restoredStatus,
            isOpen: false,
            resolvedWarningIds,
            reason,
            reactivatedAt
          }
        });
      }

      return {
        ok: true as const,
        data: {
          storeId,
          previousStatus: 'SUSPENDED',
          restoredStatus,
          isOpen: false,
          reactivatedAt,
          reactivatedByAdminId: params.adminId,
          resolvedWarningIds,
          notificationEventId
        }
      };
    });
  } catch (err: unknown) {
    if (err instanceof ComplianceTxAbortError) {
      return err.outcome;
    }
    return mapComplianceTxError(err, 'reactivateMerchantStore');
  }
}

// -------------------------------------------------------------------------
// 8. Admin & Owner Compliance Read Queries
// -------------------------------------------------------------------------

async function fetchStoreWarningsWithResponses(
  merchantPool: Pick<StrictPgPool, 'query'>,
  storeId: string
): Promise<StoreComplianceWarningSummary[]> {
  const [warnRes, respRes] = await Promise.all([
    merchantPool.query(
      `SELECT *
       FROM store_compliance_warnings
       WHERE merchant_id = $1
       ORDER BY warning_number ASC`,
      [storeId]
    ),
    merchantPool.query(
      `SELECT *
       FROM store_compliance_warning_responses
       WHERE merchant_id = $1
       ORDER BY created_at ASC`,
      [storeId]
    )
  ]);

  const respMap = new Map<string, WarningResponseRecord[]>();
  for (const r of respRes.rows) {
    const wid = String(r.warning_id);
    const list = respMap.get(wid) ?? [];
    list.push({
      id: String(r.id),
      warningId: wid,
      respondedBySellerAccountId: String(r.responded_by_seller_account_id),
      responseMessage: String(r.response_message),
      evidenceReferences: Array.isArray(r.evidence_references) ? r.evidence_references : [],
      createdAt: toIsoRequired(r.created_at)
    });
    respMap.set(wid, list);
  }

  const nowMs = Date.now();
  return warnRes.rows.map((w) =>
    mapWarningRow(w as Record<string, unknown>, respMap.get(String(w.id)) ?? [], nowMs)
  );
}

export async function getAdminStoreCompliance(
  merchantPool: Pick<StrictPgPool, 'query'>,
  storeId: string
): Promise<AdminServiceResult<AdminStoreComplianceView>> {
  const normalizedStoreId = typeof storeId === 'string' ? storeId.trim() : '';
  if (!STORE_UUID_REGEX.test(normalizedStoreId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid store UUID is required.' };
  }

  try {
    const storeRes = await merchantPool.query(
      `SELECT id, business_name, category, is_open
       FROM merchants WHERE id = $1 LIMIT 1`,
      [normalizedStoreId]
    );
    if (storeRes.rows.length === 0) {
      return { ok: false, status: 404, code: 'STORE_NOT_FOUND', error: 'Merchant store not found.' };
    }
    const storeRow = storeRes.rows[0] as Record<string, unknown>;

    const profRes = await merchantPool.query(
      `SELECT status, pre_suspension_status, suspended_at, suspended_by_admin_id,
              suspension_reason, suspension_type, suspension_evidence,
              owner_suspension_response, owner_suspension_evidence,
              owner_suspension_responded_at, last_reactivated_at,
              last_reactivated_by_admin_id, last_reactivation_reason
       FROM store_onboarding_profiles
       WHERE merchant_id = $1
       LIMIT 1`,
      [normalizedStoreId]
    );
    const pRow = (profRes.rows[0] ?? null) as Record<string, unknown> | null;

    const [warnings, auditRes, notifRes] = await Promise.all([
      fetchStoreWarningsWithResponses(merchantPool, normalizedStoreId),
      merchantPool.query(
        `SELECT id, actor_type, actor_id, event_type, event_metadata, created_at
         FROM store_onboarding_audit_events
         WHERE merchant_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [normalizedStoreId]
      ),
      merchantPool.query(
        `SELECT id, warning_id, recipient_role, event_type, delivery_status, created_at
         FROM owner_notification_events
         WHERE merchant_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [normalizedStoreId]
      )
    ]);

    const warningCounts = computeCountsFromWarnings(warnings);
    const status = pRow ? String(pRow.status) : 'PENDING_SUBMISSION';

    return {
      ok: true,
      data: {
        store: {
          id: String(storeRow.id),
          businessName: String(storeRow.business_name),
          category: String(storeRow.category).toUpperCase(),
          isOpen: Boolean(storeRow.is_open)
        },
        complianceState: {
          onboardingStatus: status,
          preSuspensionStatus: pRow?.pre_suspension_status ? String(pRow.pre_suspension_status) : null,
          isSuspended: status === 'SUSPENDED',
          suspendedAt: toIsoNullable(pRow?.suspended_at),
          suspendedByAdminId: pRow?.suspended_by_admin_id ? String(pRow.suspended_by_admin_id) : null,
          suspensionType: pRow?.suspension_type ? String(pRow.suspension_type) : null,
          suspensionReason: pRow?.suspension_reason ? String(pRow.suspension_reason) : null,
          suspensionEvidence: Array.isArray(pRow?.suspension_evidence)
            ? (pRow.suspension_evidence as SafeEvidenceReference[])
            : null,
          ownerSuspensionResponse: pRow?.owner_suspension_response
            ? String(pRow.owner_suspension_response)
            : null,
          ownerSuspensionEvidence: Array.isArray(pRow?.owner_suspension_evidence)
            ? (pRow.owner_suspension_evidence as SafeEvidenceReference[])
            : null,
          ownerSuspensionRespondedAt: toIsoNullable(pRow?.owner_suspension_responded_at),
          lastReactivatedAt: toIsoNullable(pRow?.last_reactivated_at),
          lastReactivatedByAdminId: pRow?.last_reactivated_by_admin_id
            ? String(pRow.last_reactivated_by_admin_id)
            : null,
          lastReactivationReason: pRow?.last_reactivation_reason
            ? String(pRow.last_reactivation_reason)
            : null
        },
        warningCounts,
        warnings,
        auditEvents: auditRes.rows.map((a) => ({
          id: String(a.id),
          actorType: String(a.actor_type),
          actorId: a.actor_id ? String(a.actor_id) : null,
          eventType: String(a.event_type),
          eventMetadata: a.event_metadata ?? null,
          createdAt: toIsoRequired(a.created_at)
        })),
        notificationEvents: notifRes.rows.map((n) => ({
          id: String(n.id),
          warningId: n.warning_id ? String(n.warning_id) : null,
          recipientRole: String(n.recipient_role),
          eventType: String(n.event_type),
          deliveryStatus: String(n.delivery_status),
          createdAt: toIsoRequired(n.created_at)
        }))
      }
    };
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'getAdminStoreCompliance');
  }
}

export async function listAdminComplianceWarnings(
  merchantPool: Pick<StrictPgPool, 'query'>,
  options: {
    status?: string;
    overdueOnly?: boolean;
    escalatedOnly?: boolean;
    storeId?: string;
    severity?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<
  AdminServiceResult<{
    totalCount: number;
    limit: number;
    offset: number;
    warnings: Array<StoreComplianceWarningSummary & { businessName: string; category: string }>;
  }>
> {
  const rawStatus = options.status?.trim().toUpperCase();
  if (rawStatus && rawStatus !== 'OPEN' && rawStatus !== 'RESOLVED' && rawStatus !== 'ALL') {
    return { ok: false, status: 400, code: 'INVALID_STATUS_FILTER', error: 'status must be OPEN, RESOLVED, or ALL.' };
  }

  const rawStoreId = options.storeId?.trim();
  if (rawStoreId && !STORE_UUID_REGEX.test(rawStoreId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid storeId UUID is required.' };
  }

  const rawSeverity = options.severity?.trim().toUpperCase();
  if (rawSeverity && !WARNING_SEVERITIES.has(rawSeverity)) {
    return { ok: false, status: 400, code: 'INVALID_SEVERITY', error: 'Invalid severity filter.' };
  }

  const parsedLimit = Number(options.limit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 100 ? parsedLimit : 50;
  const parsedOffset = Number(options.offset);
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

  try {
    const conds: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (rawStatus && rawStatus !== 'ALL') {
      conds.push(`w.status = $${idx++}`);
      params.push(rawStatus);
    } else if (!rawStatus && !options.overdueOnly) {
      conds.push(`w.status = 'OPEN'`);
    }

    if (options.overdueOnly) {
      conds.push(`w.status = 'OPEN' AND w.corrective_deadline IS NOT NULL AND w.corrective_deadline < CURRENT_TIMESTAMP`);
    }

    if (options.escalatedOnly) {
      conds.push(`w.escalated_at IS NOT NULL`);
    }

    if (rawStoreId) {
      conds.push(`w.merchant_id = $${idx++}`);
      params.push(rawStoreId);
    }

    if (rawSeverity) {
      conds.push(`w.severity = $${idx++}`);
      params.push(rawSeverity);
    }

    const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const countRes = await merchantPool.query(
      `SELECT COUNT(*)::int AS total FROM store_compliance_warnings w ${whereSql}`,
      params
    );
    const totalCount = Number(countRes.rows[0]?.total ?? 0);

    const rowsRes = await merchantPool.query(
      `SELECT w.*, m.business_name, m.category
       FROM store_compliance_warnings w
       JOIN merchants m ON m.id = w.merchant_id
       ${whereSql}
       ORDER BY
         CASE WHEN w.status = 'OPEN' THEN 0 ELSE 1 END,
         w.corrective_deadline ASC NULLS LAST,
         w.issued_at ASC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    const warningIds = rowsRes.rows.map((r) => String(r.id));
    const respMap = new Map<string, WarningResponseRecord[]>();
    if (warningIds.length > 0) {
      const respRes = await merchantPool.query(
        `SELECT * FROM store_compliance_warning_responses WHERE warning_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
        [warningIds]
      );
      for (const r of respRes.rows) {
        const wid = String(r.warning_id);
        const list = respMap.get(wid) ?? [];
        list.push({
          id: String(r.id),
          warningId: wid,
          respondedBySellerAccountId: String(r.responded_by_seller_account_id),
          responseMessage: String(r.response_message),
          evidenceReferences: Array.isArray(r.evidence_references) ? r.evidence_references : [],
          createdAt: toIsoRequired(r.created_at)
        });
        respMap.set(wid, list);
      }
    }

    const nowMs = Date.now();
    const warnings = rowsRes.rows.map((r) => ({
      ...mapWarningRow(r as Record<string, unknown>, respMap.get(String(r.id)) ?? [], nowMs),
      businessName: String(r.business_name),
      category: String(r.category).toUpperCase()
    }));

    return {
      ok: true,
      data: { totalCount, limit, offset, warnings }
    };
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'listAdminComplianceWarnings');
  }
}

export async function getOwnerStoreCompliance(
  merchantPool: Pick<StrictPgPool, 'query'>,
  storeId: string
): Promise<AdminServiceResult<OwnerStoreComplianceView>> {
  const normalizedStoreId = typeof storeId === 'string' ? storeId.trim() : '';
  if (!STORE_UUID_REGEX.test(normalizedStoreId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid store UUID is required.' };
  }

  try {
    const storeRes = await merchantPool.query(
      `SELECT id, business_name, category, is_open FROM merchants WHERE id = $1 LIMIT 1`,
      [normalizedStoreId]
    );
    if (storeRes.rows.length === 0) {
      return { ok: false, status: 404, code: 'STORE_NOT_FOUND', error: 'Merchant store not found.' };
    }
    const storeRow = storeRes.rows[0] as Record<string, unknown>;

    const profRes = await merchantPool.query(
      `SELECT status, suspended_at, suspension_reason, suspension_type,
              owner_suspension_response, owner_suspension_evidence,
              owner_suspension_responded_at, last_reactivated_at, last_reactivation_reason
       FROM store_onboarding_profiles
       WHERE merchant_id = $1 LIMIT 1`,
      [normalizedStoreId]
    );
    const pRow = (profRes.rows[0] ?? null) as Record<string, unknown> | null;
    const adminWarnings = await fetchStoreWarningsWithResponses(merchantPool, normalizedStoreId);
    const warningCounts = computeCountsFromWarnings(adminWarnings);
    const status = pRow ? String(pRow.status) : 'PENDING_SUBMISSION';

    // Omit internal escalation notes and Admin account IDs from Owner view
    const warnings: OwnerComplianceWarningSummary[] = adminWarnings.map((w) => ({
      id: w.id,
      storeId: w.storeId,
      warningNumber: w.warningNumber,
      violationCategory: w.violationCategory,
      severity: w.severity,
      isFormalOrdinary: w.isFormalOrdinary,
      reason: w.reason,
      requiredCorrectiveAction: w.requiredCorrectiveAction,
      issuedAt: w.issuedAt,
      correctiveDeadline: w.correctiveDeadline,
      status: w.status,
      isOverdue: w.isOverdue,
      isEscalated: Boolean(w.escalatedAt),
      escalatedAt: w.escalatedAt,
      resolvedAt: w.resolvedAt,
      resolutionReason: w.resolutionReason,
      evidenceReferences: w.evidenceReferences,
      responses: w.responses
    }));

    return {
      ok: true,
      data: {
        store: {
          id: String(storeRow.id),
          businessName: String(storeRow.business_name),
          category: String(storeRow.category).toUpperCase(),
          isOpen: Boolean(storeRow.is_open)
        },
        complianceState: {
          onboardingStatus: status,
          isSuspended: status === 'SUSPENDED',
          suspendedAt: toIsoNullable(pRow?.suspended_at),
          suspensionType: pRow?.suspension_type ? String(pRow.suspension_type) : null,
          suspensionReason: pRow?.suspension_reason ? String(pRow.suspension_reason) : null,
          ownerSuspensionResponse: pRow?.owner_suspension_response
            ? String(pRow.owner_suspension_response)
            : null,
          ownerSuspensionEvidence: Array.isArray(pRow?.owner_suspension_evidence)
            ? (pRow.owner_suspension_evidence as SafeEvidenceReference[])
            : null,
          ownerSuspensionRespondedAt: toIsoNullable(pRow?.owner_suspension_responded_at),
          lastReactivatedAt: toIsoNullable(pRow?.last_reactivated_at),
          lastReactivationReason: pRow?.last_reactivation_reason
            ? String(pRow.last_reactivation_reason)
            : null
        },
        warningCounts,
        warnings
      }
    };
  } catch (err: unknown) {
    return mapComplianceTxError(err, 'getOwnerStoreCompliance');
  }
}
