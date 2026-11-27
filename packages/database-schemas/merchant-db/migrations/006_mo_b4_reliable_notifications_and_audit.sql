-- ========================================================
-- StreetVerse Migration 006 (MO-B4):
-- Reliable Outbox Worker State, Exponential Backoff,
-- Stale Lease Recovery, Terminal Replay & Durable Owner
-- In-App Notifications
--
-- Additive & idempotent.
-- Extends existing `owner_notification_events` (no duplicate
-- outbox) and adds durable `owner_notifications`.
-- ========================================================

-- 1. Extend existing owner_notification_events outbox for reliable delivery
ALTER TABLE owner_notification_events
    ADD COLUMN IF NOT EXISTS max_attempts                        INT                      NOT NULL DEFAULT 5
        CHECK (max_attempts >= 1 AND max_attempts <= 25),
    ADD COLUMN IF NOT EXISTS next_attempt_at                     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS locked_by                           VARCHAR(120)             NULL,
    ADD COLUMN IF NOT EXISTS lease_expires_at                    TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS processing_started_at               TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS last_attempted_at                   TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS failed_at                           TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS replayed_at                         TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS replayed_by_admin_id                UUID                     NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS resolved_recipient_seller_account_id UUID                    NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS in_app_status                       VARCHAR(30)              NOT NULL DEFAULT 'PENDING'
        CHECK (in_app_status IN ('PENDING', 'DELIVERED', 'SKIPPED_ADMIN_EVENT', 'FAILED')),
    ADD COLUMN IF NOT EXISTS email_status                        VARCHAR(30)              NOT NULL DEFAULT 'PENDING'
        CHECK (email_status IN ('PENDING', 'SENT', 'UNCONFIGURED', 'NO_RECIPIENT_EMAIL', 'FAILED', 'SKIPPED_ADMIN_EVENT')),
    ADD COLUMN IF NOT EXISTS email_error                         TEXT                     NULL,
    ADD COLUMN IF NOT EXISTS email_sent_at                       TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS updated_at                          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
DECLARE
    chk_name TEXT;
BEGIN
    SELECT c.conname INTO chk_name
    FROM pg_constraint c
    WHERE c.conrelid = 'owner_notification_events'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%delivery_status%'
      AND pg_get_constraintdef(c.oid) LIKE '%PENDING%'
      AND c.conname <> 'chk_owner_notification_delivery_status'
    LIMIT 1;

    IF chk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE owner_notification_events DROP CONSTRAINT %I', chk_name);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'owner_notification_events'::regclass
          AND conname = 'chk_owner_notification_delivery_status'
    ) THEN
        ALTER TABLE owner_notification_events
            ADD CONSTRAINT chk_owner_notification_delivery_status
            CHECK (delivery_status IN (
                'PENDING',
                'PROCESSING',
                'RETRYING',
                'DELIVERED',
                'SENT',
                'TERMINAL_FAILED',
                'FAILED',
                'CANCELLED'
            ));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_owner_notif_claimable
    ON owner_notification_events (delivery_status, next_attempt_at ASC, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_owner_notif_stream_order
    ON owner_notification_events (merchant_id, recipient_role, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_owner_notif_lease
    ON owner_notification_events (delivery_status, lease_expires_at ASC);

-- 2. Durable Owner-facing in-app notification inbox (idempotent per outbox event)
CREATE TABLE IF NOT EXISTS owner_notifications (
    id                          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    outbox_event_id             UUID         NOT NULL UNIQUE REFERENCES owner_notification_events(id) ON DELETE RESTRICT,
    merchant_id                 UUID         NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    recipient_seller_account_id UUID         NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    event_type                  VARCHAR(60)  NOT NULL,
    title                       VARCHAR(200) NOT NULL,
    message                     TEXT         NOT NULL,
    submission_id               UUID         NULL REFERENCES store_kyc_submissions(id) ON DELETE RESTRICT,
    submission_version          INT          NULL,
    warning_id                  UUID         NULL REFERENCES store_compliance_warnings(id) ON DELETE RESTRICT,
    metadata                    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    is_read                     BOOLEAN      NOT NULL DEFAULT false,
    read_at                     TIMESTAMP WITH TIME ZONE NULL,
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_owner_notifications_recipient_created
    ON owner_notifications (recipient_seller_account_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_owner_notifications_store_recipient_unread
    ON owner_notifications (merchant_id, recipient_seller_account_id, is_read, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION guard_owner_notification_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Owner notifications cannot be deleted and must remain in permanent store history.'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id
       OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
       OR NEW.recipient_seller_account_id IS DISTINCT FROM OLD.recipient_seller_account_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.message IS DISTINCT FROM OLD.message
       OR NEW.submission_id IS DISTINCT FROM OLD.submission_id
       OR NEW.submission_version IS DISTINCT FROM OLD.submission_version
       OR NEW.warning_id IS DISTINCT FROM OLD.warning_id
       OR NEW.metadata IS DISTINCT FROM OLD.metadata
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Owner notification content and attribution fields are immutable.'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.is_read = true AND NEW.is_read IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Read notifications cannot be marked unread.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_owner_notifications_immutable ON owner_notifications;
CREATE TRIGGER trg_owner_notifications_immutable
    BEFORE UPDATE OR DELETE ON owner_notifications
    FOR EACH ROW EXECUTE FUNCTION guard_owner_notification_immutability();
