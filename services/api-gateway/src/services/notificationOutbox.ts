import crypto from 'crypto';
import { StrictPgClient, StrictPgPool, withPgTransaction } from '../db/postgres';
import { STORE_UUID_REGEX } from './sellerRbac';
import { AdminServiceResult } from './adminAuth';
import { EmailService, TransactionalEmailResult } from './email';
import { classifyHttpError, sanitizeErrorForLog } from '../utils/infraErrors';

// =========================================================================
// MO-B4: Reliable PostgreSQL Outbox Worker, Idempotent Owner Notifications,
//        Exponential Backoff, Terminal Dead-Letter Replay & Transactional
//        Audit Attribution
//
// Invariants:
//   - Single PostgreSQL outbox (`owner_notification_events`) — Redis is NEVER
//     used for delivery state, leases, retries, or coordination.
//   - Safe multi-worker claiming via `FOR UPDATE OF e SKIP LOCKED` combined
//     with per-(merchant_id, recipient_role) FIFO stream ordering.
//   - Stale-lease recovery: abandoned `PROCESSING` rows whose `lease_expires_at`
//     has elapsed are automatically reclaimed on worker restart / other workers.
//   - Owner recipient safety: verifies `owner_seller_account_id` STILL holds
//     an ACTIVE `OWNER` membership on `merchant_id` (and `seller_accounts.status = 'ACTIVE'`)
//     before delivering. Ownership changes/revocations withhold delivery into
//     `TERMINAL_FAILED` instead of silently notifying a revoked or unintended account.
//   - In-app notifications use `UNIQUE (outbox_event_id)` + `ON CONFLICT DO NOTHING`
//     for database-enforced idempotency; history cannot be deleted.
//   - Distinguishes `in_app_status` vs `email_status`; absent SMTP credentials
//     report `'UNCONFIGURED'` honestly without faking delivery, while preserving
//     supported in-app delivery (`delivery_status = 'DELIVERED'`).
//   - Transient email/processing failures retry with bounded exponential backoff;
//     reaching `max_attempts` transitions explicitly to `TERMINAL_FAILED`.
//   - Admin operational replay resets `TERMINAL_FAILED` events with audit trail
//     without duplicating already-created in-app notifications.
// =========================================================================

export const OUTBOX_TERMINAL_STATES = new Set<string>(['DELIVERED', 'SENT', 'TERMINAL_FAILED', 'CANCELLED']);
export const OUTBOX_REPLAYABLE_STATES = new Set<string>(['TERMINAL_FAILED', 'FAILED']);

export interface OutboxWorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  onDeliverFailureInject?: (event: ClaimedOutboxEvent) => Promise<void> | void;
}

export interface ClaimedOutboxEvent {
  id: string;
  merchantId: string;
  storeBusinessName: string;
  submissionId: string | null;
  submissionVersion: number | null;
  warningId: string | null;
  ownerSellerAccountId: string;
  recipientRole: 'OWNER' | 'ADMIN';
  eventType: string;
  payload: Record<string, unknown>;
  deliveryAttempts: number;
  maxAttempts: number;
  inAppStatus: string;
  emailStatus: string;
}

export interface RenderedOwnerNotification {
  title: string;
  message: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
  safeMetadata: Record<string, unknown>;
}

export interface OutboxBatchStats {
  claimedCount: number;
  deliveredCount: number;
  retryingCount: number;
  terminalFailedCount: number;
  skippedAdminCount: number;
}

export interface OutboxWorkerTelemetry {
  workerId: string;
  enabled: boolean;
  running: boolean;
  stopping: boolean;
  activeCount: number;
  totalTicks: number;
  totalClaimed: number;
  totalDelivered: number;
  totalRetried: number;
  totalTerminalFailed: number;
  lastTickAt: string | null;
  lastError: string | null;
}

export interface OwnerNotificationRecord {
  id: string;
  outboxEventId: string;
  storeId: string;
  storeBusinessName: string;
  eventType: string;
  title: string;
  message: string;
  submissionId: string | null;
  submissionVersion: number | null;
  warningId: string | null;
  metadata: Record<string, unknown>;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strips any accidental filesystem path or internal storage-key patterns from notification strings.
 */
export function scrubSensitiveNotificationText(raw: unknown, maxLen = 500): string {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';
  text = text
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[redacted-path]')
    .replace(/\/(?:var|home|tmp|etc|usr|opt)\/[^\s"'<>]+/gi, '[redacted-path]')
    .replace(/storage_?key\s*[:=]\s*[^\s,;]+/gi, '[redacted-ref]')
    .replace(/(bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[redacted]');
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

export function computeRetryBackoffMs(
  attempt: number,
  baseRetryDelayMs = 2000,
  maxRetryDelayMs = 60000
): number {
  const safeBase = Math.max(10, baseRetryDelayMs);
  const safeMax = Math.max(safeBase, maxRetryDelayMs);
  const exp = Math.min(20, Math.max(0, attempt - 1));
  return Math.min(safeMax, safeBase * Math.pow(2, exp));
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

/**
 * Renders safe, minimal Owner in-app + transactional email content for MO-B2 and MO-B3 events.
 * Strictly omits KYC document contents, raw storage keys, filesystem paths, internal escalation notes,
 * review notes, tokens, and Admin actor IDs.
 */
export function renderOwnerNotificationContent(event: ClaimedOutboxEvent): RenderedOwnerNotification {
  const payload = event.payload ?? {};
  const rawStoreName =
    typeof payload.businessName === 'string' && payload.businessName.trim()
      ? payload.businessName
      : event.storeBusinessName;
  const storeName = scrubSensitiveNotificationText(rawStoreName, 120) || 'Your Store';

  const versionLabel =
    event.submissionVersion !== null && event.submissionVersion !== undefined
      ? `v${event.submissionVersion}`
      : typeof payload.submissionVersion === 'number'
        ? `v${payload.submissionVersion}`
        : null;

  const warningNum =
    typeof payload.warningNumber === 'number'
      ? payload.warningNumber
      : typeof payload.warningNumber === 'string' && /^\d+$/.test(payload.warningNumber)
        ? Number(payload.warningNumber)
        : null;

  const reason = scrubSensitiveNotificationText(payload.reason ?? payload.resolutionReason, 400);
  const correctiveAction = scrubSensitiveNotificationText(payload.requiredCorrectiveAction, 400);
  const violationCategory = scrubSensitiveNotificationText(payload.violationCategory, 60);
  const severity = scrubSensitiveNotificationText(payload.severity, 30);
  const rejectionCategory = scrubSensitiveNotificationText(payload.rejectionCategory, 60);
  const restoredStatus = scrubSensitiveNotificationText(payload.restoredStatus, 40);
  const suspensionType = scrubSensitiveNotificationText(payload.suspensionType, 40);
  const deadline = typeof payload.correctiveDeadline === 'string' ? payload.correctiveDeadline : null;
  const requestedRequirements = Array.isArray(payload.requestedRequirements)
    ? payload.requestedRequirements
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => scrubSensitiveNotificationText(x, 60))
        .slice(0, 15)
    : [];

  let title = `Store Update: ${storeName}`;
  let message = `There is an update for store "${storeName}". Sign in to your Seller portal to view full details.`;

  switch (event.eventType) {
    case 'ONBOARDING_APPROVED':
      title = `Onboarding Approved — ${storeName}`;
      message = `Your KYC submission${versionLabel ? ` (${versionLabel})` : ''} for "${storeName}" has been approved. Your store remains closed until operational opening steps are completed.`;
      break;

    case 'ONBOARDING_MORE_INFO_REQUIRED':
      title = `Action Required: More Information Needed — ${storeName}`;
      message = `Additional information is required for "${storeName}"${versionLabel ? ` (${versionLabel})` : ''}.${reason ? ` Summary: ${reason}` : ''}${requestedRequirements.length > 0 ? ` Requested items: ${requestedRequirements.join(', ')}.` : ''}`;
      break;

    case 'ONBOARDING_REJECTED':
      title = `Onboarding Application Rejected — ${storeName}`;
      message = `Your KYC submission${versionLabel ? ` (${versionLabel})` : ''} for "${storeName}" was rejected.${rejectionCategory ? ` Category: ${rejectionCategory}.` : ''}${reason ? ` Reason: ${reason}` : ''}`;
      break;

    case 'COMPLIANCE_WARNING_ISSUED':
      title = `Compliance Warning${warningNum ? ` #${warningNum}` : ''} Issued — ${storeName}`;
      message = `A formal compliance warning${warningNum ? ` (#${warningNum})` : ''} was issued for "${storeName}".${violationCategory ? ` Category: ${violationCategory}.` : ''}${severity ? ` Severity: ${severity}.` : ''}${reason ? ` Reason: ${reason}` : ''}${correctiveAction ? ` Required action: ${correctiveAction}` : ''}${deadline ? ` Corrective deadline: ${deadline}.` : ''}`;
      break;

    case 'COMPLIANCE_WARNING_ESCALATED':
      title = `Compliance Warning${warningNum ? ` #${warningNum}` : ''} Escalated — ${storeName}`;
      message = `Open compliance warning${warningNum ? ` #${warningNum}` : ''} for "${storeName}" has been escalated for administrative review. Sign in to submit any outstanding corrective response.`;
      break;

    case 'COMPLIANCE_WARNING_RESOLVED':
      title = `Compliance Warning${warningNum ? ` #${warningNum}` : ''} Resolved — ${storeName}`;
      message = `Compliance warning${warningNum ? ` #${warningNum}` : ''} for "${storeName}" has been marked RESOLVED.${reason ? ` Resolution summary: ${reason}` : ''}`;
      break;

    case 'COMPLIANCE_STORE_SUSPENDED':
      title = `Store Suspended — ${storeName}`;
      message = `Store "${storeName}" has been suspended (${suspensionType || 'COMPLIANCE'}) and closed from public discovery.${violationCategory ? ` Category: ${violationCategory}.` : ''}${reason ? ` Reason: ${reason}` : ''}`;
      break;

    case 'COMPLIANCE_STORE_REACTIVATED':
      title = `Store Reactivated — ${storeName}`;
      message = `Compliance suspension on "${storeName}" has been lifted${restoredStatus ? ` (restored status: ${restoredStatus})` : ''}. The store remains closed (isOpen=false) until explicitly opened when permitted.${reason ? ` Summary: ${reason}` : ''}`;
      break;

    default:
      title = `Store Notification — ${storeName}`;
      message = `An account/compliance update was recorded for "${storeName}". Please check your Seller dashboard.`;
      break;
  }

  const emailSubject = `[StreetVerse] ${title}`;
  const emailText = `${title}\n\n${message}\n\nStore ID: ${event.merchantId}\nEvent Type: ${event.eventType}\n\nPlease sign in to your StreetVerse Seller portal to view store status and respond cleanly. Never share credentials or private verification documents via email.\n`;
  const emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, sans-serif; max-width: 560px; margin: 0 auto; background: #FFFDF9; border: 1px solid #E6DFD5; border-radius: 10px; padding: 24px; color: #2C241B;">
      <h2 style="margin-top: 0; color: #7A3E1D; font-size: 18px;">${escapeHtml(title)}</h2>
      <p style="font-size: 14px; line-height: 1.55; color: #3E342A;">${escapeHtml(message)}</p>
      <hr style="border: none; border-top: 1px solid #E6DFD5; margin: 20px 0;" />
      <p style="font-size: 12px; color: #7A6E61;">
        Store: <strong>${escapeHtml(storeName)}</strong><br />
        Event: <code>${escapeHtml(event.eventType)}</code>
      </p>
      <p style="font-size: 12px; color: #8C7D6B;">
        Sign in to the official StreetVerse Seller portal to review details. For security, document files and private links are never included in emails.
      </p>
    </div>
  `.trim();

  const safeMetadata: Record<string, unknown> = {
    storeBusinessName: storeName,
    eventType: event.eventType,
    ...(versionLabel ? { submissionVersionLabel: versionLabel } : {}),
    ...(warningNum !== null ? { warningNumber: warningNum } : {}),
    ...(violationCategory ? { violationCategory } : {}),
    ...(severity ? { severity } : {}),
    ...(rejectionCategory ? { rejectionCategory } : {}),
    ...(restoredStatus ? { restoredStatus } : {}),
    ...(suspensionType ? { suspensionType } : {}),
    ...(deadline ? { correctiveDeadline: deadline } : {}),
    ...(requestedRequirements.length > 0 ? { requestedRequirements } : {})
  };

  return {
    title: title.slice(0, 200),
    message,
    emailSubject,
    emailText,
    emailHtml,
    safeMetadata
  };
}

class OutboxTxAbortError extends Error {
  constructor(public readonly outcome: AdminServiceResult<any>) {
    super('OUTBOX_TX_ABORT');
  }
}

/**
 * Resolves and verifies the recipient Seller Account for an Owner-targeted event.
 * Enforces consistency if ownership changed between event creation and delivery:
 * only delivers to `owner_seller_account_id` when that account STILL holds an
 * ACTIVE `OWNER` membership on `merchant_id` (and the seller account is ACTIVE).
 */
async function verifyActiveOwnerRecipientForEvent(
  client: StrictPgClient,
  merchantId: string,
  targetSellerAccountId: string
): Promise<
  | { ok: true; sellerAccountId: string; email: string | null; isEmailVerified: boolean }
  | { ok: false; code: string; reason: string }
> {
  const res = await client.query(
    `SELECT sa.id, sa.email, sa.is_email_verified, sa.status AS account_status,
            sm.role AS membership_role, sm.status AS membership_status
     FROM seller_accounts sa
     LEFT JOIN store_memberships sm
       ON sm.seller_account_id = sa.id AND sm.merchant_id = $2
     WHERE sa.id = $1
     LIMIT 1`,
    [targetSellerAccountId, merchantId]
  );

  if (res.rows.length === 0) {
    return {
      ok: false,
      code: 'RECIPIENT_ACCOUNT_MISSING',
      reason: 'Target Owner Seller account no longer exists.'
    };
  }
  const row = res.rows[0] as Record<string, unknown>;
  if (String(row.account_status) !== 'ACTIVE') {
    return {
      ok: false,
      code: 'RECIPIENT_ACCOUNT_INACTIVE',
      reason: `Target Seller account is not ACTIVE (status=${String(row.account_status)}).`
    };
  }
  if (String(row.membership_role) !== 'OWNER' || String(row.membership_status) !== 'ACTIVE') {
    return {
      ok: false,
      code: 'RECIPIENT_NO_LONGER_STORE_OWNER',
      reason: 'Target Seller account is no longer an ACTIVE OWNER of this store; withheld to prevent unauthorized disclosure.'
    };
  }

  return {
    ok: true,
    sellerAccountId: String(row.id),
    email: typeof row.email === 'string' && row.email.trim() ? row.email.trim().toLowerCase() : null,
    isEmailVerified: Boolean(row.is_email_verified)
  };
}

/**
 * Claims up to `batchSize` eligible events atomically using `FOR UPDATE OF e SKIP LOCKED`
 * while preserving FIFO delivery ordering within each `(merchant_id, recipient_role)` stream.
 * Also automatically reclaims abandoned `PROCESSING` leases after `lease_expires_at`.
 */
export async function claimOutboxEventsBatch(
  merchantPool: StrictPgPool,
  params: {
    workerId: string;
    batchSize: number;
    leaseDurationMs: number;
  }
): Promise<ClaimedOutboxEvent[]> {
  return withPgTransaction(merchantPool, async (client) => {
    const selectRes = await client.query(
      `SELECT e.id
       FROM owner_notification_events e
       WHERE (
         (e.delivery_status IN ('PENDING', 'RETRYING') AND e.next_attempt_at <= CURRENT_TIMESTAMP)
         OR (e.delivery_status = 'PROCESSING' AND e.lease_expires_at IS NOT NULL AND e.lease_expires_at <= CURRENT_TIMESTAMP)
       )
       AND NOT EXISTS (
         SELECT 1
         FROM owner_notification_events earlier
         WHERE earlier.merchant_id = e.merchant_id
           AND earlier.recipient_role = e.recipient_role
           AND (earlier.created_at, earlier.id) < (e.created_at, e.id)
           AND earlier.delivery_status IN ('PENDING', 'PROCESSING', 'RETRYING')
       )
       ORDER BY e.created_at ASC, e.id ASC
       LIMIT $1
       FOR UPDATE OF e SKIP LOCKED`,
      [Math.max(1, Math.min(100, params.batchSize))]
    );

    if (selectRes.rows.length === 0) {
      return [];
    }

    const claimedIds = selectRes.rows.map((r) => String(r.id));
    const updRes = await client.query(
      `UPDATE owner_notification_events e
       SET delivery_status = 'PROCESSING',
           locked_by = $1,
           processing_started_at = CURRENT_TIMESTAMP,
           last_attempted_at = CURRENT_TIMESTAMP,
           lease_expires_at = CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond'),
           delivery_attempts = e.delivery_attempts + 1,
           updated_at = CURRENT_TIMESTAMP
       FROM merchants m
       WHERE e.id = ANY($3::uuid[])
         AND m.id = e.merchant_id
       RETURNING e.*, m.business_name AS store_business_name`,
      [params.workerId, Math.max(1000, params.leaseDurationMs), claimedIds]
    );

    const byId = new Map<string, ClaimedOutboxEvent>();
    for (const r of updRes.rows) {
      byId.set(String(r.id), {
        id: String(r.id),
        merchantId: String(r.merchant_id),
        storeBusinessName: String(r.store_business_name || 'Your Store'),
        submissionId: r.submission_id ? String(r.submission_id) : null,
        submissionVersion:
          r.submission_version !== null && r.submission_version !== undefined
            ? Number(r.submission_version)
            : null,
        warningId: r.warning_id ? String(r.warning_id) : null,
        ownerSellerAccountId: String(r.owner_seller_account_id),
        recipientRole: String(r.recipient_role) === 'ADMIN' ? 'ADMIN' : 'OWNER',
        eventType: String(r.event_type),
        payload: (r.payload ?? {}) as Record<string, unknown>,
        deliveryAttempts: Number(r.delivery_attempts ?? 1),
        maxAttempts: Number(r.max_attempts ?? 5),
        inAppStatus: String(r.in_app_status ?? 'PENDING'),
        emailStatus: String(r.email_status ?? 'PENDING')
      });
    }

    return claimedIds.map((id) => byId.get(id)).filter((x): x is ClaimedOutboxEvent => Boolean(x));
  });
}

/**
 * Processes a single already-claimed outbox event cleanly with idempotent in-app persistence,
 * transactional email handling, and explicit retry/terminal transitions guarded by `locked_by = workerId`.
 */
async function processClaimedOutboxEvent(
  merchantPool: StrictPgPool,
  emailService: Pick<EmailService, 'sendTransactionalEmail'>,
  workerId: string,
  event: ClaimedOutboxEvent,
  options: {
    maxAttemptsDefault: number;
    baseRetryDelayMs: number;
    maxRetryDelayMs: number;
    onDeliverFailureInject?: (event: ClaimedOutboxEvent) => Promise<void> | void;
  }
): Promise<'DELIVERED' | 'RETRYING' | 'TERMINAL_FAILED' | 'SKIPPED_ADMIN'> {
  const effectiveMaxAttempts = Math.max(1, event.maxAttempts || options.maxAttemptsDefault);

  const scheduleFailureOrTerminal = async (params: {
    errorMessage: string;
    inAppStatus?: 'PENDING' | 'DELIVERED' | 'FAILED';
    emailStatus?: 'PENDING' | 'SENT' | 'UNCONFIGURED' | 'NO_RECIPIENT_EMAIL' | 'FAILED';
    emailError?: string | null;
    forceTerminal?: boolean;
  }): Promise<'RETRYING' | 'TERMINAL_FAILED'> => {
    const hitTerminal = Boolean(params.forceTerminal) || event.deliveryAttempts >= effectiveMaxAttempts;
    const nextStatus = hitTerminal ? 'TERMINAL_FAILED' : 'RETRYING';
    const backoffMs = computeRetryBackoffMs(
      event.deliveryAttempts,
      options.baseRetryDelayMs,
      options.maxRetryDelayMs
    );

    await withPgTransaction(merchantPool, async (client) => {
      await client.query(
        `UPDATE owner_notification_events
         SET delivery_status = $1::varchar,
             in_app_status = COALESCE($2::varchar, in_app_status),
             email_status = COALESCE($3::varchar, email_status),
             email_error = COALESCE($4::text, email_error),
             last_error = $5::text,
             locked_by = NULL,
             lease_expires_at = NULL,
             failed_at = CASE WHEN $6::boolean THEN CURRENT_TIMESTAMP ELSE failed_at END,
             next_attempt_at = CASE
               WHEN NOT $6::boolean THEN CURRENT_TIMESTAMP + ($7::bigint * INTERVAL '1 millisecond')
               ELSE next_attempt_at
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $8::uuid AND locked_by = $9::varchar AND delivery_status = 'PROCESSING'`,
        [
          nextStatus,
          params.inAppStatus ?? null,
          params.emailStatus ?? null,
          params.emailError ?? null,
          scrubSensitiveNotificationText(params.errorMessage, 500) || 'Delivery failed.',
          hitTerminal,
          hitTerminal ? 0 : backoffMs,
          event.id,
          workerId
        ]
      );
    });

    return nextStatus;
  };

  try {
    if (options.onDeliverFailureInject) {
      await options.onDeliverFailureInject(event);
    }

    // 1. Admin-targeted events (owner warning/suspension responses) are reviewed via Admin endpoints,
    //    NOT pushed into Seller Owner inboxes or emailed to Sellers.
    if (event.recipientRole === 'ADMIN') {
      await withPgTransaction(merchantPool, async (client) => {
        await client.query(
          `UPDATE owner_notification_events
           SET delivery_status = 'DELIVERED',
               in_app_status = 'SKIPPED_ADMIN_EVENT',
               email_status = 'SKIPPED_ADMIN_EVENT',
               last_error = NULL,
               locked_by = NULL,
               lease_expires_at = NULL,
               dispatched_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND locked_by = $2 AND delivery_status = 'PROCESSING'`,
          [event.id, workerId]
        );
      });
      return 'SKIPPED_ADMIN';
    }

    // 2. Verify active Owner relationship + persist idempotent in-app notification cleanly inside DB tx
    const prepTx = await withPgTransaction(merchantPool, async (client) => {
      const checkRes = await verifyActiveOwnerRecipientForEvent(
        client,
        event.merchantId,
        event.ownerSellerAccountId
      );
      if (!checkRes.ok) {
        return { ok: false as const, code: checkRes.code, reason: checkRes.reason };
      }

      const rendered = renderOwnerNotificationContent(event);

      // Idempotent in-app insert keyed strictly by UNIQUE(outbox_event_id)
      await client.query(
        `INSERT INTO owner_notifications
           (outbox_event_id, merchant_id, recipient_seller_account_id, event_type,
            title, message, submission_id, submission_version, warning_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (outbox_event_id) DO NOTHING`,
        [
          event.id,
          event.merchantId,
          checkRes.sellerAccountId,
          event.eventType,
          rendered.title,
          rendered.message,
          event.submissionId,
          event.submissionVersion,
          event.warningId,
          JSON.stringify(rendered.safeMetadata)
        ]
      );

      await client.query(
        `UPDATE owner_notification_events
         SET resolved_recipient_seller_account_id = $1,
             in_app_status = 'DELIVERED',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND locked_by = $3 AND delivery_status = 'PROCESSING'`,
        [checkRes.sellerAccountId, event.id, workerId]
      );

      return {
        ok: true as const,
        recipientEmail: checkRes.email,
        isEmailVerified: checkRes.isEmailVerified,
        rendered
      };
    });

    if (!prepTx.ok) {
      await scheduleFailureOrTerminal({
        errorMessage: `[${prepTx.code}] ${prepTx.reason}`,
        inAppStatus: 'FAILED',
        forceTerminal: true
      });
      return 'TERMINAL_FAILED';
    }

    // 3. Dispatch email outside lock-heavy DB tx if not already SENT cleanly
    let finalEmailStatus: 'SENT' | 'UNCONFIGURED' | 'NO_RECIPIENT_EMAIL' | 'FAILED' = 'SENT';
    let finalEmailError: string | null = null;

    if (event.emailStatus === 'SENT') {
      finalEmailStatus = 'SENT';
    } else if (!prepTx.recipientEmail || !prepTx.isEmailVerified) {
      finalEmailStatus = 'NO_RECIPIENT_EMAIL';
      finalEmailError = !prepTx.recipientEmail
        ? 'Recipient Seller account has no email address.'
        : 'Recipient Seller account email is not verified.';
    } else if (!emailService.sendTransactionalEmail) {
      finalEmailStatus = 'UNCONFIGURED';
      finalEmailError = 'Transactional email sender is unavailable.';
    } else {
      const sendRes: TransactionalEmailResult = await emailService.sendTransactionalEmail({
        to: prepTx.recipientEmail,
        subject: prepTx.rendered.emailSubject,
        text: prepTx.rendered.emailText,
        html: prepTx.rendered.emailHtml,
        idempotencyKey: event.id
      });

      if (sendRes.status === 'SENT') {
        finalEmailStatus = 'SENT';
        finalEmailError = null;
      } else if (sendRes.status === 'UNCONFIGURED') {
        finalEmailStatus = 'UNCONFIGURED';
        finalEmailError = sendRes.reason;
      } else {
        // Explicit provider failure: retry with exponential backoff up to maxAttempts,
        // without re-creating duplicate in-app notification!
        return await scheduleFailureOrTerminal({
          errorMessage: sendRes.error,
          inAppStatus: 'DELIVERED',
          emailStatus: 'FAILED',
          emailError: sendRes.error,
          forceTerminal: !sendRes.transient && event.deliveryAttempts >= effectiveMaxAttempts
        });
      }
    }

    // 4. Commit final outbox outcome (`DELIVERED`), preserving explicit `email_status`
    const isEmailSent = finalEmailStatus === 'SENT';
    await withPgTransaction(merchantPool, async (client) => {
      await client.query(
        `UPDATE owner_notification_events
         SET delivery_status = 'DELIVERED',
             in_app_status = 'DELIVERED',
             email_status = $1::varchar,
             email_error = $2::text,
             email_sent_at = CASE WHEN $3::boolean THEN CURRENT_TIMESTAMP ELSE email_sent_at END,
             last_error = NULL,
             locked_by = NULL,
             lease_expires_at = NULL,
             dispatched_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4::uuid AND locked_by = $5::varchar AND delivery_status = 'PROCESSING'`,
        [finalEmailStatus, finalEmailError, isEmailSent, event.id, workerId]
      );
    });

    return 'DELIVERED';
  } catch (err: unknown) {
    const errMsg = sanitizeErrorForLog(err) || 'Outbox event processing failure.';
    try {
      return await scheduleFailureOrTerminal({
        errorMessage: errMsg
      });
    } catch (fallbackErr: unknown) {
      console.error(
        `[NotificationOutbox] Failed to record retry/terminal state for event ${event.id}: ${sanitizeErrorForLog(fallbackErr)} (original=${errMsg})`
      );
      return 'RETRYING';
    }
  }
}

/**
 * Runs one bounded worker batch safely against PostgreSQL. Safe to run directly in tests
 * or from multiple concurrent worker instances.
 */
export async function processNotificationOutboxBatch(
  merchantPool: StrictPgPool,
  emailService: Pick<EmailService, 'sendTransactionalEmail'>,
  options: OutboxWorkerOptions = {}
): Promise<OutboxBatchStats> {
  const workerId = options.workerId || `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const batchSize = options.batchSize ?? 20;
  const leaseDurationMs = options.leaseDurationMs ?? 30000;
  const maxAttemptsDefault = options.maxAttempts ?? 5;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 2000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 60000;

  const claimed = await claimOutboxEventsBatch(merchantPool, {
    workerId,
    batchSize,
    leaseDurationMs
  });

  const stats: OutboxBatchStats = {
    claimedCount: claimed.length,
    deliveredCount: 0,
    retryingCount: 0,
    terminalFailedCount: 0,
    skippedAdminCount: 0
  };

  for (const event of claimed) {
    const outcome = await processClaimedOutboxEvent(merchantPool, emailService, workerId, event, {
      maxAttemptsDefault,
      baseRetryDelayMs,
      maxRetryDelayMs,
      onDeliverFailureInject: options.onDeliverFailureInject
    });
    if (outcome === 'DELIVERED') stats.deliveredCount++;
    else if (outcome === 'SKIPPED_ADMIN') stats.skippedAdminCount++;
    else if (outcome === 'RETRYING') stats.retryingCount++;
    else stats.terminalFailedCount++;
  }

  return stats;
}

export interface NotificationOutboxWorker {
  start: () => void;
  stop: (timeoutMs?: number) => Promise<{ timedOut: boolean }>;
  runOnce: () => Promise<OutboxBatchStats>;
  getTelemetry: () => OutboxWorkerTelemetry;
}

/**
 * Creates a lifecycle-managed background worker polling the PostgreSQL outbox cleanly
 * with graceful bounded draining during gateway shutdown.
 */
export function createNotificationOutboxWorker(
  merchantPool: StrictPgPool,
  emailService: Pick<EmailService, 'sendTransactionalEmail'>,
  options: OutboxWorkerOptions & { enabled?: boolean } = {}
): NotificationOutboxWorker {
  const workerId = options.workerId || `gw-notif-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const enabled = options.enabled !== false;
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 5000);

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let activeBatchPromise: Promise<OutboxBatchStats> | null = null;

  const telemetry: OutboxWorkerTelemetry = {
    workerId,
    enabled,
    running: false,
    stopping: false,
    activeCount: 0,
    totalTicks: 0,
    totalClaimed: 0,
    totalDelivered: 0,
    totalRetried: 0,
    totalTerminalFailed: 0,
    lastTickAt: null,
    lastError: null
  };

  const executeTick = async (): Promise<OutboxBatchStats> => {
    if (activeBatchPromise) {
      return activeBatchPromise;
    }

    telemetry.totalTicks++;
    telemetry.activeCount = 1;
    telemetry.lastTickAt = new Date().toISOString();

    const p = processNotificationOutboxBatch(merchantPool, emailService, {
      ...options,
      workerId
    })
      .then((res) => {
        telemetry.totalClaimed += res.claimedCount;
        telemetry.totalDelivered += res.deliveredCount + res.skippedAdminCount;
        telemetry.totalRetried += res.retryingCount;
        telemetry.totalTerminalFailed += res.terminalFailedCount;
        telemetry.lastError = null;
        return res;
      })
      .catch((err: unknown) => {
        const safeErr = sanitizeErrorForLog(err) || 'Outbox worker poll failed.';
        telemetry.lastError = safeErr;
        console.warn(`[NotificationWorker:${workerId}] Tick error: ${safeErr}`);
        return {
          claimedCount: 0,
          deliveredCount: 0,
          retryingCount: 0,
          terminalFailedCount: 0,
          skippedAdminCount: 0
        };
      })
      .finally(() => {
        telemetry.activeCount = 0;
        activeBatchPromise = null;
      });

    activeBatchPromise = p;
    return p;
  };

  const scheduleNext = () => {
    if (!running || stopping) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!running || stopping) return;
      await executeTick();
      scheduleNext();
    }, pollIntervalMs);
    timer.unref?.();
  };

  const start = () => {
    if (!enabled || running) return;
    stopping = false;
    running = true;
    telemetry.running = true;
    telemetry.stopping = false;
    // Schedule near-immediately without blocking HTTP server startup
    timer = setTimeout(async () => {
      timer = null;
      if (!running || stopping) return;
      await executeTick();
      scheduleNext();
    }, 50);
    timer.unref?.();
  };

  const stop = async (timeoutMs = 5000): Promise<{ timedOut: boolean }> => {
    stopping = true;
    telemetry.stopping = true;
    running = false;
    telemetry.running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (!activeBatchPromise) {
      return { timedOut: false };
    }

    let timedOut = false;
    await Promise.race([
      activeBatchPromise.catch(() => {}),
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timedOut = true;
          resolve();
        }, Math.max(100, timeoutMs));
        t.unref?.();
      })
    ]);

    return { timedOut };
  };

  return {
    start,
    stop,
    runOnce: executeTick,
    getTelemetry: () => ({ ...telemetry })
  };
}

// =========================================================================
// Owner-Facing In-App Notification APIs (Strictly Authenticated & Scoped)
// =========================================================================

function mapNotificationRow(r: Record<string, unknown>): OwnerNotificationRecord {
  return {
    id: String(r.id),
    outboxEventId: String(r.outbox_event_id),
    storeId: String(r.merchant_id),
    storeBusinessName: String(r.store_business_name ?? ''),
    eventType: String(r.event_type),
    title: String(r.title),
    message: String(r.message),
    submissionId: r.submission_id ? String(r.submission_id) : null,
    submissionVersion:
      r.submission_version !== null && r.submission_version !== undefined
        ? Number(r.submission_version)
        : null,
    warningId: r.warning_id ? String(r.warning_id) : null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    isRead: Boolean(r.is_read),
    readAt: toIsoNullable(r.read_at),
    createdAt: toIsoRequired(r.created_at)
  };
}

function mapNotificationInfraError<T>(err: unknown, context: string): AdminServiceResult<T> {
  const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
  if (mapped.status === 503 || mapped.status === 400 || mapped.status === 409) {
    return { ok: false, status: mapped.status as 400 | 409 | 503, code: mapped.code, error: mapped.message };
  }
  console.error(`[NotificationOutbox:${context}] Error: ${sanitizeErrorForLog(err)}`);
  return { ok: false, status: 503, code: 'INTERNAL_ERROR', error: 'Unable to complete notification operation.' };
}

export async function listOwnerNotifications(
  merchantPool: Pick<StrictPgPool, 'query'>,
  params: {
    sellerAccountId: string;
    storeId?: string;
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  }
): Promise<
  AdminServiceResult<{
    totalCount: number;
    unreadCount: number;
    limit: number;
    offset: number;
    notifications: OwnerNotificationRecord[];
  }>
> {
  if (!STORE_UUID_REGEX.test(params.sellerAccountId)) {
    return { ok: false, status: 401, code: 'AUTH_REQUIRED', error: 'Valid authenticated Seller Account required.' };
  }

  let storeFilter: string | null = null;
  if (params.storeId !== undefined) {
    const trimmed = params.storeId.trim();
    if (!STORE_UUID_REGEX.test(trimmed)) {
      return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid storeId UUID is required.' };
    }
    storeFilter = trimmed;
  }

  const parsedLimit = Number(params.limit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 100 ? parsedLimit : 25;
  const parsedOffset = Number(params.offset);
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

  try {
    // Enforce live ACTIVE OWNER membership even on account-wide notifications list
    if (storeFilter) {
      const memCheck = await merchantPool.query(
        `SELECT 1 FROM store_memberships sm
         JOIN seller_accounts sa ON sa.id = sm.seller_account_id
         WHERE sm.seller_account_id = $1 AND sm.merchant_id = $2
           AND sm.role = 'OWNER' AND sm.status = 'ACTIVE' AND sa.status = 'ACTIVE'
         LIMIT 1`,
        [params.sellerAccountId, storeFilter]
      );
      if (memCheck.rows.length === 0) {
        return {
          ok: false,
          status: 403,
          code: 'STORE_ACCESS_DENIED',
          error: 'Only active store Owners may view store notifications.'
        };
      }
    }

    const conds: string[] = [
      `n.recipient_seller_account_id = $1`,
      `sm.role = 'OWNER'`,
      `sm.status = 'ACTIVE'`,
      `sa.status = 'ACTIVE'`
    ];
    const queryParams: unknown[] = [params.sellerAccountId];
    let idx = 2;

    if (storeFilter) {
      conds.push(`n.merchant_id = $${idx++}`);
      queryParams.push(storeFilter);
    }

    const baseWhere = `WHERE ${conds.join(' AND ')}`;
    const listWhere = params.unreadOnly ? `${baseWhere} AND n.is_read = false` : baseWhere;

    const [statsRes, rowsRes] = await Promise.all([
      merchantPool.query(
        `SELECT
           COUNT(*)::int AS total_count,
           COUNT(*) FILTER (WHERE n.is_read = false)::int AS unread_count
         FROM owner_notifications n
         JOIN store_memberships sm ON sm.merchant_id = n.merchant_id AND sm.seller_account_id = n.recipient_seller_account_id
         JOIN seller_accounts sa ON sa.id = sm.seller_account_id
         ${baseWhere}`,
        queryParams
      ),
      merchantPool.query(
        `SELECT n.*, m.business_name AS store_business_name
         FROM owner_notifications n
         JOIN merchants m ON m.id = n.merchant_id
         JOIN store_memberships sm ON sm.merchant_id = n.merchant_id AND sm.seller_account_id = n.recipient_seller_account_id
         JOIN seller_accounts sa ON sa.id = sm.seller_account_id
         ${listWhere}
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...queryParams, limit, offset]
      )
    ]);

    const totalAll = Number(statsRes.rows[0]?.total_count ?? 0);
    const unreadCount = Number(statsRes.rows[0]?.unread_count ?? 0);

    return {
      ok: true,
      data: {
        totalCount: params.unreadOnly ? unreadCount : totalAll,
        unreadCount,
        limit,
        offset,
        notifications: rowsRes.rows.map(mapNotificationRow)
      }
    };
  } catch (err: unknown) {
    return mapNotificationInfraError(err, 'listOwnerNotifications');
  }
}

export async function getOwnerUnreadNotificationSummary(
  merchantPool: Pick<StrictPgPool, 'query'>,
  params: { sellerAccountId: string; storeId?: string }
): Promise<
  AdminServiceResult<{
    unreadCount: number;
    byStore: Array<{ storeId: string; storeBusinessName: string; unreadCount: number }>;
  }>
> {
  if (!STORE_UUID_REGEX.test(params.sellerAccountId)) {
    return { ok: false, status: 401, code: 'AUTH_REQUIRED', error: 'Valid authenticated Seller Account required.' };
  }
  let storeFilter: string | null = null;
  if (params.storeId !== undefined) {
    const trimmed = params.storeId.trim();
    if (!STORE_UUID_REGEX.test(trimmed)) {
      return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid storeId UUID is required.' };
    }
    storeFilter = trimmed;
  }

  try {
    const queryParams: unknown[] = [params.sellerAccountId];
    let extraCond = '';
    if (storeFilter) {
      queryParams.push(storeFilter);
      extraCond = `AND n.merchant_id = $2`;
    }

    const res = await merchantPool.query(
      `SELECT n.merchant_id, m.business_name AS store_business_name, COUNT(*)::int AS unread_count
       FROM owner_notifications n
       JOIN merchants m ON m.id = n.merchant_id
       JOIN store_memberships sm ON sm.merchant_id = n.merchant_id AND sm.seller_account_id = n.recipient_seller_account_id
       JOIN seller_accounts sa ON sa.id = sm.seller_account_id
       WHERE n.recipient_seller_account_id = $1
         AND sm.role = 'OWNER'
         AND sm.status = 'ACTIVE'
         AND sa.status = 'ACTIVE'
         AND n.is_read = false
         ${extraCond}
       GROUP BY n.merchant_id, m.business_name
       ORDER BY m.business_name ASC`,
      queryParams
    );

    const byStore = res.rows.map((r) => ({
      storeId: String(r.merchant_id),
      storeBusinessName: String(r.store_business_name ?? ''),
      unreadCount: Number(r.unread_count ?? 0)
    }));
    const unreadCount = byStore.reduce((acc, s) => acc + s.unreadCount, 0);

    return { ok: true, data: { unreadCount, byStore } };
  } catch (err: unknown) {
    return mapNotificationInfraError(err, 'getOwnerUnreadNotificationSummary');
  }
}

export async function markOwnerNotificationRead(
  merchantPool: StrictPgPool,
  params: { sellerAccountId: string; notificationId: string; storeId?: string }
): Promise<AdminServiceResult<{ notification: OwnerNotificationRecord }>> {
  const notifId = typeof params.notificationId === 'string' ? params.notificationId.trim() : '';
  if (!STORE_UUID_REGEX.test(notifId)) {
    return { ok: false, status: 400, code: 'INVALID_NOTIFICATION_ID', error: 'Valid notification UUID is required.' };
  }

  let storeFilter: string | null = null;
  if (params.storeId !== undefined) {
    const trimmed = params.storeId.trim();
    if (!STORE_UUID_REGEX.test(trimmed)) {
      return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid storeId UUID is required.' };
    }
    storeFilter = trimmed;
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const checkRes = await client.query(
        `SELECT n.*, m.business_name AS store_business_name
         FROM owner_notifications n
         JOIN merchants m ON m.id = n.merchant_id
         JOIN store_memberships sm ON sm.merchant_id = n.merchant_id AND sm.seller_account_id = n.recipient_seller_account_id
         JOIN seller_accounts sa ON sa.id = sm.seller_account_id
         WHERE n.id = $1
           AND n.recipient_seller_account_id = $2
           AND sm.role = 'OWNER'
           AND sm.status = 'ACTIVE'
           AND sa.status = 'ACTIVE'
           ${storeFilter ? 'AND n.merchant_id = $3' : ''}
         FOR UPDATE OF n`,
        storeFilter ? [notifId, params.sellerAccountId, storeFilter] : [notifId, params.sellerAccountId]
      );

      if (checkRes.rows.length === 0) {
        return {
          ok: false as const,
          status: 404 as const,
          code: 'NOTIFICATION_NOT_FOUND',
          error: 'Notification not found for this Owner account.'
        };
      }

      const existing = checkRes.rows[0] as Record<string, unknown>;
      if (Boolean(existing.is_read)) {
        return { ok: true as const, data: { notification: mapNotificationRow(existing) } };
      }

      const updRes = await client.query(
        `UPDATE owner_notifications
         SET is_read = true,
             read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE id = $1
         RETURNING *`,
        [notifId]
      );

      const merged = {
        ...updRes.rows[0],
        store_business_name: existing.store_business_name
      };

      return {
        ok: true as const,
        data: { notification: mapNotificationRow(merged) }
      };
    });
  } catch (err: unknown) {
    return mapNotificationInfraError(err, 'markOwnerNotificationRead');
  }
}

export async function markAllOwnerStoreNotificationsRead(
  merchantPool: StrictPgPool,
  params: { sellerAccountId: string; storeId: string }
): Promise<AdminServiceResult<{ storeId: string; markedReadCount: number }>> {
  const storeId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  if (!STORE_UUID_REGEX.test(storeId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid storeId UUID is required.' };
  }

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const memRes = await client.query(
        `SELECT 1 FROM store_memberships sm
         JOIN seller_accounts sa ON sa.id = sm.seller_account_id
         WHERE sm.seller_account_id = $1 AND sm.merchant_id = $2
           AND sm.role = 'OWNER' AND sm.status = 'ACTIVE' AND sa.status = 'ACTIVE'
         LIMIT 1`,
        [params.sellerAccountId, storeId]
      );
      if (memRes.rows.length === 0) {
        return { ok: false as const, status: 403 as const, code: 'STORE_ACCESS_DENIED', error: 'Owner access required.' };
      }

      const updRes = await client.query(
        `UPDATE owner_notifications
         SET is_read = true,
             read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE merchant_id = $1
           AND recipient_seller_account_id = $2
           AND is_read = false
         RETURNING id`,
        [storeId, params.sellerAccountId]
      );

      return {
        ok: true as const,
        data: { storeId, markedReadCount: updRes.rows.length }
      };
    });
  } catch (err: unknown) {
    return mapNotificationInfraError(err, 'markAllOwnerStoreNotificationsRead');
  }
}

// =========================================================================
// Operational Admin Outbox Visibility & Replay APIs
// =========================================================================

export interface AdminOutboxSummary {
  counts: {
    pending: number;
    processing: number;
    retrying: number;
    delivered: number;
    terminalFailed: number;
    cancelled: number;
    total: number;
    unconfiguredEmailCount: number;
    failedEmailCount: number;
    staleProcessingCount: number;
  };
  worker: OutboxWorkerTelemetry | null;
}

export async function getAdminOutboxSummary(
  merchantPool: Pick<StrictPgPool, 'query'>,
  workerTelemetry: OutboxWorkerTelemetry | null = null
): Promise<AdminServiceResult<AdminOutboxSummary>> {
  try {
    const res = await merchantPool.query(
      `SELECT
         COUNT(*) FILTER (WHERE delivery_status = 'PENDING')::int AS pending_count,
         COUNT(*) FILTER (WHERE delivery_status = 'PROCESSING')::int AS processing_count,
         COUNT(*) FILTER (WHERE delivery_status = 'RETRYING')::int AS retrying_count,
         COUNT(*) FILTER (WHERE delivery_status IN ('DELIVERED', 'SENT'))::int AS delivered_count,
         COUNT(*) FILTER (WHERE delivery_status IN ('TERMINAL_FAILED', 'FAILED'))::int AS terminal_failed_count,
         COUNT(*) FILTER (WHERE delivery_status = 'CANCELLED')::int AS cancelled_count,
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE email_status = 'UNCONFIGURED')::int AS unconfigured_email_count,
         COUNT(*) FILTER (WHERE email_status = 'FAILED')::int AS failed_email_count,
         COUNT(*) FILTER (
           WHERE delivery_status = 'PROCESSING'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= CURRENT_TIMESTAMP
         )::int AS stale_processing_count
       FROM owner_notification_events`
    );
    const r = res.rows[0] ?? {};
    return {
      ok: true,
      data: {
        counts: {
          pending: Number(r.pending_count ?? 0),
          processing: Number(r.processing_count ?? 0),
          retrying: Number(r.retrying_count ?? 0),
          delivered: Number(r.delivered_count ?? 0),
          terminalFailed: Number(r.terminal_failed_count ?? 0),
          cancelled: Number(r.cancelled_count ?? 0),
          total: Number(r.total_count ?? 0),
          unconfiguredEmailCount: Number(r.unconfigured_email_count ?? 0),
          failedEmailCount: Number(r.failed_email_count ?? 0),
          staleProcessingCount: Number(r.stale_processing_count ?? 0)
        },
        worker: workerTelemetry
      }
    };
  } catch (err: unknown) {
    return mapNotificationInfraError(err, 'getAdminOutboxSummary');
  }
}

export async function listAdminOutboxEvents(
  merchantPool: Pick<StrictPgPool, 'query'>,
  options: {
    status?: string;
    storeId?: string;
    eventType?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<
  AdminServiceResult<{
    totalCount: number;
    limit: number;
    offset: number;
    events: Array<{
      id: string;
      storeId: string;
      storeBusinessName: string;
      recipientRole: string;
      ownerSellerAccountId: string;
      resolvedRecipientSellerAccountId: string | null;
      eventType: string;
      deliveryStatus: string;
      inAppStatus: string;
      emailStatus: string;
      emailError: string | null;
      deliveryAttempts: number;
      maxAttempts: number;
      lastError: string | null;
      nextAttemptAt: string | null;
      leaseExpiresAt: string | null;
      failedAt: string | null;
      replayedAt: string | null;
      replayedByAdminId: string | null;
      dispatchedAt: string | null;
      createdAt: string;
    }>;
  }>
> {
  const ALLOWED_FILTER_STATUSES = new Set([
    'PENDING',
    'PROCESSING',
    'RETRYING',
    'DELIVERED',
    'SENT',
    'TERMINAL_FAILED',
    'FAILED',
    'CANCELLED',
    'ALL'
  ]);
  const rawStatus = options.status?.trim().toUpperCase();
  if (rawStatus && !ALLOWED_FILTER_STATUSES.has(rawStatus)) {
    return { ok: false, status: 400, code: 'INVALID_STATUS_FILTER', error: 'Invalid outbox delivery status filter.' };
  }
  const rawStoreId = options.storeId?.trim();
  if (rawStoreId && !STORE_UUID_REGEX.test(rawStoreId)) {
    return { ok: false, status: 400, code: 'INVALID_STORE_ID', error: 'Valid storeId UUID is required.' };
  }

  const parsedLimit = Number(options.limit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 100 ? parsedLimit : 50;
  const parsedOffset = Number(options.offset);
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

  try {
    const conds: string[] = [];
    const queryParams: unknown[] = [];
    let idx = 1;

    if (rawStatus && rawStatus !== 'ALL') {
      conds.push(`e.delivery_status = $${idx++}`);
      queryParams.push(rawStatus);
    }
    if (rawStoreId) {
      conds.push(`e.merchant_id = $${idx++}`);
      queryParams.push(rawStoreId);
    }
    if (options.eventType?.trim()) {
      conds.push(`e.event_type = $${idx++}`);
      queryParams.push(options.eventType.trim().toUpperCase());
    }

    const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const [cntRes, rowsRes] = await Promise.all([
      merchantPool.query(
        `SELECT COUNT(*)::int AS total FROM owner_notification_events e ${whereSql}`,
        queryParams
      ),
      merchantPool.query(
        `SELECT e.*, m.business_name AS store_business_name
         FROM owner_notification_events e
         JOIN merchants m ON m.id = e.merchant_id
         ${whereSql}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...queryParams, limit, offset]
      )
    ]);

    return {
      ok: true,
      data: {
        totalCount: Number(cntRes.rows[0]?.total ?? 0),
        limit,
        offset,
        events: rowsRes.rows.map((r) => ({
          id: String(r.id),
          storeId: String(r.merchant_id),
          storeBusinessName: String(r.store_business_name ?? ''),
          recipientRole: String(r.recipient_role),
          ownerSellerAccountId: String(r.owner_seller_account_id),
          resolvedRecipientSellerAccountId: r.resolved_recipient_seller_account_id
            ? String(r.resolved_recipient_seller_account_id)
            : null,
          eventType: String(r.event_type),
          deliveryStatus: String(r.delivery_status),
          inAppStatus: String(r.in_app_status),
          emailStatus: String(r.email_status),
          emailError: r.email_error ? String(r.email_error) : null,
          deliveryAttempts: Number(r.delivery_attempts ?? 0),
          maxAttempts: Number(r.max_attempts ?? 5),
          lastError: r.last_error ? String(r.last_error) : null,
          nextAttemptAt: toIsoNullable(r.next_attempt_at),
          leaseExpiresAt: toIsoNullable(r.lease_expires_at),
          failedAt: toIsoNullable(r.failed_at),
          replayedAt: toIsoNullable(r.replayed_at),
          replayedByAdminId: r.replayed_by_admin_id ? String(r.replayed_by_admin_id) : null,
          dispatchedAt: toIsoNullable(r.dispatched_at),
          createdAt: toIsoRequired(r.created_at)
        }))
      }
    };
  } catch (err: unknown) {
    return mapNotificationInfraError(err, 'listAdminOutboxEvents');
  }
}

export async function replayAdminOutboxEvent(
  merchantPool: StrictPgPool,
  params: { eventId: string; adminId: string; reason?: unknown }
): Promise<
  AdminServiceResult<{
    eventId: string;
    storeId: string;
    previousStatus: string;
    newStatus: 'PENDING';
    replayedAt: string;
    replayedByAdminId: string;
  }>
> {
  const eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
  if (!STORE_UUID_REGEX.test(eventId)) {
    return { ok: false, status: 400, code: 'INVALID_EVENT_ID', error: 'Valid outbox event UUID is required.' };
  }

  const reason =
    typeof params.reason === 'string' && params.reason.trim().length > 0
      ? scrubSensitiveNotificationText(params.reason.trim(), 500)
      : 'Operational admin replay requested.';

  try {
    return await withPgTransaction(merchantPool, async (client) => {
      const lockRes = await client.query(
        `SELECT * FROM owner_notification_events WHERE id = $1 FOR UPDATE`,
        [eventId]
      );
      if (lockRes.rows.length === 0) {
        return {
          ok: false as const,
          status: 404 as const,
          code: 'OUTBOX_EVENT_NOT_FOUND',
          error: 'Notification outbox event not found.'
        };
      }

      const row = lockRes.rows[0] as Record<string, unknown>;
      const prevStatus = String(row.delivery_status);
      if (!OUTBOX_REPLAYABLE_STATES.has(prevStatus)) {
        return {
          ok: false as const,
          status: 409 as const,
          code: 'EVENT_NOT_REPLAYABLE',
          error: `Only TERMINAL_FAILED or FAILED outbox events can be replayed (current status: '${prevStatus}').`
        };
      }

      const updRes = await client.query(
        `UPDATE owner_notification_events
         SET delivery_status = 'PENDING',
             delivery_attempts = 0,
             next_attempt_at = CURRENT_TIMESTAMP,
             locked_by = NULL,
             lease_expires_at = NULL,
             failed_at = NULL,
             last_error = NULL,
             email_error = NULL,
             replayed_at = CURRENT_TIMESTAMP,
             replayed_by_admin_id = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING merchant_id, replayed_at`,
        [params.adminId, eventId]
      );

      const storeId = String(updRes.rows[0].merchant_id);
      const replayedAt = toIsoRequired(updRes.rows[0].replayed_at);

      await client.query(
        `INSERT INTO store_onboarding_audit_events
           (merchant_id, actor_type, actor_id, event_type, event_metadata)
         VALUES ($1, 'ADMIN', $2, 'ADMIN_NOTIFICATION_OUTBOX_REPLAYED', $3::jsonb)`,
        [
          storeId,
          params.adminId,
          JSON.stringify({
            actorType: 'ADMIN',
            actorId: params.adminId,
            storeId,
            action: 'REPLAY_NOTIFICATION_OUTBOX_EVENT',
            outboxEventId: eventId,
            eventType: String(row.event_type),
            previousStatus: prevStatus,
            newStatus: 'PENDING',
            reason,
            timestamp: replayedAt
          })
        ]
      );

      return {
        ok: true as const,
        data: {
          eventId,
          storeId,
          previousStatus: prevStatus,
          newStatus: 'PENDING' as const,
          replayedAt,
          replayedByAdminId: params.adminId
        }
      };
    });
  } catch (err: unknown) {
    if (err instanceof OutboxTxAbortError) return err.outcome;
    return mapNotificationInfraError(err, 'replayAdminOutboxEvent');
  }
}
