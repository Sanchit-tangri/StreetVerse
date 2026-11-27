-- ========================================================
-- StreetVerse Migration 004 (MO-B2):
-- Admin Verification Checklist, Decision Attribution,
-- Trigger Hardening & Durable Owner Notification Outbox
--
-- Additive & idempotent.
-- Reuses store_kyc_submissions, store_onboarding_profiles,
-- kyc_documents, and store_onboarding_audit_events.
-- ========================================================

-- 1. Structured Admin review fields on store_kyc_submissions
ALTER TABLE store_kyc_submissions
    ADD COLUMN IF NOT EXISTS review_started_at TIMESTAMP WITH TIME ZONE NULL,
    ADD COLUMN IF NOT EXISTS review_checklist JSONB NULL,
    ADD COLUMN IF NOT EXISTS owner_feedback_reason TEXT NULL,
    ADD COLUMN IF NOT EXISTS requested_requirements JSONB NULL,
    ADD COLUMN IF NOT EXISTS rejection_category VARCHAR(60) NULL;

-- Helpful index for priority-neutral chronological queue ordering
CREATE INDEX IF NOT EXISTS idx_kyc_sub_submitted_at
    ON store_kyc_submissions (submitted_at ASC NULLS LAST, id ASC);

-- 2. Harden submission immutability trigger:
--    - Snapshot columns remain immutable once status leaves DRAFT (MO-A).
--    - Once UNDER_REVIEW begins, another Admin cannot silently overwrite
--      reviewed_by_admin_id or review_started_at.
--    - Once a decision is finalized (APPROVED, REJECTED, MORE_INFO_REQUIRED,
--      SUSPENDED), submission status and review outcome fields are permanently locked.
CREATE OR REPLACE FUNCTION prevent_submitted_kyc_submission_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IS DISTINCT FROM 'DRAFT' THEN
            RAISE EXCEPTION 'Submitted KYC versions are immutable and cannot be deleted.' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status IS DISTINCT FROM 'DRAFT' THEN
        IF NEW.status = 'DRAFT'
           OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
           OR NEW.submission_version IS DISTINCT FROM OLD.submission_version
           OR NEW.submitted_by_seller_account_id IS DISTINCT FROM OLD.submitted_by_seller_account_id
           OR NEW.business_name_snapshot IS DISTINCT FROM OLD.business_name_snapshot
           OR NEW.category_snapshot IS DISTINCT FROM OLD.category_snapshot
           OR NEW.business_type_snapshot IS DISTINCT FROM OLD.business_type_snapshot
           OR NEW.fixed_premises_confirmed_snapshot IS DISTINCT FROM OLD.fixed_premises_confirmed_snapshot
           OR NEW.address_snapshot IS DISTINCT FROM OLD.address_snapshot
           OR NEW.pincode_snapshot IS DISTINCT FROM OLD.pincode_snapshot
           OR NEW.latitude_snapshot IS DISTINCT FROM OLD.latitude_snapshot
           OR NEW.longitude_snapshot IS DISTINCT FROM OLD.longitude_snapshot
           OR NEW.gps_captured_at_snapshot IS DISTINCT FROM OLD.gps_captured_at_snapshot
           OR NEW.gps_accuracy_meters_snapshot IS DISTINCT FROM OLD.gps_accuracy_meters_snapshot
           OR NEW.submitted_requirements_version IS DISTINCT FROM OLD.submitted_requirements_version
           OR NEW.requirements_snapshot IS DISTINCT FROM OLD.requirements_snapshot
           OR NEW.seller_contact_snapshot IS DISTINCT FROM OLD.seller_contact_snapshot
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
            RAISE EXCEPTION 'Submitted KYC snapshot fields are immutable.' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF OLD.status = 'UNDER_REVIEW' THEN
        IF (OLD.reviewed_by_admin_id IS NOT NULL AND NEW.reviewed_by_admin_id IS DISTINCT FROM OLD.reviewed_by_admin_id)
           OR (OLD.review_started_at IS NOT NULL AND NEW.review_started_at IS DISTINCT FROM OLD.review_started_at) THEN
            RAISE EXCEPTION 'Active review assignment cannot be silently reassigned.' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF OLD.status IN ('APPROVED', 'REJECTED', 'MORE_INFO_REQUIRED', 'SUSPENDED') THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.reviewed_by_admin_id IS DISTINCT FROM OLD.reviewed_by_admin_id
           OR NEW.review_started_at IS DISTINCT FROM OLD.review_started_at
           OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
           OR NEW.review_notes IS DISTINCT FROM OLD.review_notes
           OR NEW.review_checklist IS DISTINCT FROM OLD.review_checklist
           OR NEW.owner_feedback_reason IS DISTINCT FROM OLD.owner_feedback_reason
           OR NEW.requested_requirements IS DISTINCT FROM OLD.requested_requirements
           OR NEW.rejection_category IS DISTINCT FROM OLD.rejection_category THEN
            RAISE EXCEPTION 'Decided KYC submission (%) is permanently immutable.', OLD.status USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kyc_submissions_immutable ON store_kyc_submissions;
CREATE TRIGGER trg_kyc_submissions_immutable
    BEFORE UPDATE OR DELETE ON store_kyc_submissions
    FOR EACH ROW EXECUTE FUNCTION prevent_submitted_kyc_submission_mutation();

-- 3. Durable Owner Notification Outbox (written transactionally with decision; delivered in MO-B4)
CREATE TABLE IF NOT EXISTS owner_notification_events (
    id                      UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id             UUID         NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    submission_id           UUID         NOT NULL REFERENCES store_kyc_submissions(id) ON DELETE RESTRICT,
    submission_version      INT          NOT NULL,
    owner_seller_account_id UUID         NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    event_type              VARCHAR(60)  NOT NULL
                            CHECK (event_type IN (
                                'ONBOARDING_APPROVED',
                                'ONBOARDING_MORE_INFO_REQUIRED',
                                'ONBOARDING_REJECTED'
                            )),
    payload                 JSONB        NOT NULL,
    delivery_status         VARCHAR(24)  NOT NULL DEFAULT 'PENDING'
                            CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
    delivery_attempts       INT          NOT NULL DEFAULT 0,
    last_error              TEXT         NULL,
    created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dispatched_at           TIMESTAMP WITH TIME ZONE NULL
);

CREATE INDEX IF NOT EXISTS idx_owner_notif_pending
    ON owner_notification_events (delivery_status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_owner_notif_merchant
    ON owner_notification_events (merchant_id, created_at DESC);
