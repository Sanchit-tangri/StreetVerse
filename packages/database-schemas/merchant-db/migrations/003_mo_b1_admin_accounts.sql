-- ========================================================
-- StreetVerse Migration 003 (MO-B1):
-- Dedicated Administrative Identity Foundation in Merchant DB
--
-- Additive & idempotent.
-- Keeps admin_accounts strictly isolated from Seller Accounts,
-- Buyer Users, and Merchant Store records.
-- No public self-registration path exists for Admin accounts.
-- ========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS admin_accounts (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) NOT NULL,
    full_name       VARCHAR(150) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    -- Initial single administrative role; structured CHECK allows clean future expansion
    role            VARCHAR(40)  NOT NULL DEFAULT 'ADMIN'
                    CHECK (role IN ('ADMIN')),
    status          VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
    last_login_at   TIMESTAMP WITH TIME ZONE NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_accounts_lower_email
    ON admin_accounts (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_admin_accounts_status
    ON admin_accounts (status);

-- Link store_kyc_submissions.reviewed_by_admin_id -> admin_accounts(id) safely.
-- Uses ON DELETE RESTRICT to preserve permanent administrative review history
-- (Admin accounts must be SUSPENDED or DISABLED rather than hard-deleted).
DO $$
DECLARE
    existing_deltype "char";
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'store_kyc_submissions') THEN
        SELECT c.confdeltype INTO existing_deltype
        FROM pg_constraint c
        WHERE c.conname = 'fk_submission_reviewed_by_admin';

        IF existing_deltype IS NULL THEN
            ALTER TABLE store_kyc_submissions
                ADD CONSTRAINT fk_submission_reviewed_by_admin
                FOREIGN KEY (reviewed_by_admin_id)
                REFERENCES admin_accounts(id)
                ON DELETE RESTRICT;
        ELSIF existing_deltype <> 'r' THEN
            ALTER TABLE store_kyc_submissions
                DROP CONSTRAINT fk_submission_reviewed_by_admin;
            ALTER TABLE store_kyc_submissions
                ADD CONSTRAINT fk_submission_reviewed_by_admin
                FOREIGN KEY (reviewed_by_admin_id)
                REFERENCES admin_accounts(id)
                ON DELETE RESTRICT;
        END IF;
    END IF;
END $$;

-- Preserve Admin actor attribution in append-only store_onboarding_audit_events
CREATE OR REPLACE FUNCTION prevent_audited_admin_account_delete()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM store_onboarding_audit_events
        WHERE actor_type = 'ADMIN'
          AND actor_id = OLD.id
    ) THEN
        RAISE EXCEPTION 'Admin account % has permanent audit history and must be SUSPENDED or DISABLED rather than deleted.', OLD.id
            USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_accounts_preserve_audit ON admin_accounts;
CREATE TRIGGER trg_admin_accounts_preserve_audit
    BEFORE DELETE ON admin_accounts
    FOR EACH ROW EXECUTE FUNCTION prevent_audited_admin_account_delete();
