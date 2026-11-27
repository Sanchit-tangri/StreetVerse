-- ========================================================
-- StreetVerse Migration 005 (MO-B3):
-- Store Compliance Warnings, Corrective Actions, Escalations,
-- Suspension & Reactivation, Outbox Extension & DB Guards
--
-- Additive & idempotent.
-- Preserves all historical KYC submissions, documents, reviews,
-- and existing approved store snapshots.
-- ========================================================

-- 1. Compliance & suspension metadata on store_onboarding_profiles (one per store)
ALTER TABLE store_onboarding_profiles
    ADD COLUMN IF NOT EXISTS pre_suspension_status VARCHAR(30) NULL
        CHECK (pre_suspension_status IS NULL OR pre_suspension_status IN (
            'PENDING_SUBMISSION','DRAFT','SUBMITTED','UNDER_REVIEW',
            'MORE_INFO_REQUIRED','APPROVED','REJECTED',
            'SUSPENDED','REVERIFICATION_REQUIRED'
        )),
    ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS suspended_by_admin_id UUID NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS suspension_reason TEXT NULL,
    ADD COLUMN IF NOT EXISTS suspension_type VARCHAR(30) NULL
        CHECK (suspension_type IS NULL OR suspension_type IN ('ORDINARY_VIOLATION', 'PROTECTIVE_SERIOUS_RISK')),
    ADD COLUMN IF NOT EXISTS suspension_evidence JSONB NULL,
    ADD COLUMN IF NOT EXISTS owner_suspension_response TEXT NULL,
    ADD COLUMN IF NOT EXISTS owner_suspension_evidence JSONB NULL,
    ADD COLUMN IF NOT EXISTS owner_suspension_responded_at TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS owner_suspension_responded_by UUID NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS last_reactivated_at TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS last_reactivated_by_admin_id UUID NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS last_reactivation_reason TEXT NULL;

-- 2. Store Compliance Warnings (strictly store-scoped, sequential per store, never auto-deleted/expired)
CREATE TABLE IF NOT EXISTS store_compliance_warnings (
    id                          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id                 UUID         NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    warning_number              INT          NOT NULL CHECK (warning_number >= 1),
    violation_category          VARCHAR(60)  NOT NULL,
    severity                    VARCHAR(20)  NOT NULL
                                CHECK (severity IN ('LOW', 'MODERATE', 'HIGH', 'CRITICAL')),
    is_formal_ordinary          BOOLEAN      NOT NULL DEFAULT true,
    reason                      TEXT         NOT NULL,
    required_corrective_action  TEXT         NOT NULL,
    issued_by_admin_id          UUID         NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
    issued_at                   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    corrective_deadline         TIMESTAMP WITH TIME ZONE NULL,
    status                      VARCHAR(20)  NOT NULL DEFAULT 'OPEN'
                                CHECK (status IN ('OPEN', 'RESOLVED')),
    escalated_at                TIMESTAMP WITH TIME ZONE NULL,
    escalated_by_admin_id       UUID         NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
    escalation_notes            TEXT         NULL,
    resolved_by_admin_id        UUID         NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
    resolved_at                 TIMESTAMP WITH TIME ZONE NULL,
    resolution_reason           TEXT         NULL,
    resolution_evidence_checked BOOLEAN      NOT NULL DEFAULT false,
    evidence_references         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, warning_number),
    CHECK (
        status = 'OPEN' OR (
            resolved_by_admin_id IS NOT NULL
            AND resolved_at IS NOT NULL
            AND resolution_reason IS NOT NULL
            AND LENGTH(TRIM(resolution_reason)) > 0
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_compliance_warnings_store_status
    ON store_compliance_warnings (merchant_id, status, warning_number ASC);
CREATE INDEX IF NOT EXISTS idx_compliance_warnings_open_deadline
    ON store_compliance_warnings (status, corrective_deadline ASC NULLS LAST);

-- Protect resolved warnings & prohibit deleting any warning record
CREATE OR REPLACE FUNCTION guard_compliance_warning_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Compliance warnings cannot be deleted and must remain in permanent store history.' USING ERRCODE = '23514';
    END IF;

    IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
       OR NEW.warning_number IS DISTINCT FROM OLD.warning_number
       OR NEW.issued_by_admin_id IS DISTINCT FROM OLD.issued_by_admin_id
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.required_corrective_action IS DISTINCT FROM OLD.required_corrective_action THEN
        RAISE EXCEPTION 'Original compliance warning issuance fields are immutable.' USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'RESOLVED' THEN
        IF NEW.status IS DISTINCT FROM 'RESOLVED'
           OR NEW.resolved_by_admin_id IS DISTINCT FROM OLD.resolved_by_admin_id
           OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
           OR NEW.resolution_reason IS DISTINCT FROM OLD.resolution_reason THEN
            RAISE EXCEPTION 'Resolved compliance warning cannot be reopened or altered.' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_compliance_warnings_immutable ON store_compliance_warnings;
CREATE TRIGGER trg_compliance_warnings_immutable
    BEFORE UPDATE OR DELETE ON store_compliance_warnings
    FOR EACH ROW EXECUTE FUNCTION guard_compliance_warning_immutability();

-- 3. Append-only Owner Corrective Responses to Warnings
CREATE TABLE IF NOT EXISTS store_compliance_warning_responses (
    id                               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    warning_id                       UUID         NOT NULL REFERENCES store_compliance_warnings(id) ON DELETE RESTRICT,
    merchant_id                      UUID         NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    responded_by_seller_account_id   UUID         NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    response_message                 TEXT         NOT NULL,
    evidence_references              JSONB        NOT NULL DEFAULT '[]'::jsonb,
    created_at                       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_compliance_responses_warning
    ON store_compliance_warning_responses (warning_id, created_at ASC);

CREATE OR REPLACE RULE no_update_compliance_responses AS
    ON UPDATE TO store_compliance_warning_responses DO INSTEAD NOTHING;
CREATE OR REPLACE RULE no_delete_compliance_responses AS
    ON DELETE TO store_compliance_warning_responses DO INSTEAD NOTHING;

-- 4. Guard merchants.is_open against opening a SUSPENDED store
CREATE OR REPLACE FUNCTION prevent_opening_suspended_store()
RETURNS TRIGGER AS $$
DECLARE
    prof_status VARCHAR(30);
BEGIN
    IF NEW.is_open = true THEN
        SELECT status INTO prof_status
        FROM store_onboarding_profiles
        WHERE merchant_id = NEW.id;

        IF prof_status = 'SUSPENDED' THEN
            RAISE EXCEPTION 'Suspended store (%) cannot be opened until explicitly reactivated by Admin.', NEW.id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_merchants_block_open_when_suspended ON merchants;
CREATE TRIGGER trg_merchants_block_open_when_suspended
    BEFORE INSERT OR UPDATE OF is_open ON merchants
    FOR EACH ROW EXECUTE FUNCTION prevent_opening_suspended_store();

-- 5. Extend owner_notification_events cleanly to support store-level compliance & Admin review notifications
ALTER TABLE owner_notification_events
    ALTER COLUMN submission_id DROP NOT NULL,
    ALTER COLUMN submission_version DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS recipient_role VARCHAR(20) NOT NULL DEFAULT 'OWNER'
        CHECK (recipient_role IN ('OWNER', 'ADMIN')),
    ADD COLUMN IF NOT EXISTS warning_id UUID NULL REFERENCES store_compliance_warnings(id) ON DELETE RESTRICT;

DO $$
DECLARE
    chk_name TEXT;
BEGIN
    SELECT c.conname INTO chk_name
    FROM pg_constraint c
    WHERE c.conrelid = 'owner_notification_events'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%ONBOARDING_APPROVED%'
    LIMIT 1;

    IF chk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE owner_notification_events DROP CONSTRAINT %I', chk_name);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'owner_notification_events'::regclass
          AND conname = 'chk_owner_notification_event_type'
    ) THEN
        ALTER TABLE owner_notification_events
            ADD CONSTRAINT chk_owner_notification_event_type
            CHECK (event_type IN (
                'ONBOARDING_APPROVED',
                'ONBOARDING_MORE_INFO_REQUIRED',
                'ONBOARDING_REJECTED',
                'COMPLIANCE_WARNING_ISSUED',
                'COMPLIANCE_WARNING_RESPONSE_SUBMITTED',
                'COMPLIANCE_WARNING_RESOLVED',
                'COMPLIANCE_WARNING_ESCALATED',
                'COMPLIANCE_STORE_SUSPENDED',
                'COMPLIANCE_SUSPENSION_RESPONSE_SUBMITTED',
                'COMPLIANCE_STORE_REACTIVATED'
            ));
    END IF;
END $$;
