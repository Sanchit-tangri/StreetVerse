-- ========================================================
-- StreetVerse: Merchant DB (Database 2 - Isolated)
-- Purpose: Business profiles with Geospatial coordinates, product
--          inventories with vector embeddings for RAG, service
--          slots, vendor UPI VPAs, and sales data.
-- SECURITY: Zero customer PII stored here.
--
-- Fresh-install schema: synchronised with migrations up to 005.
-- ========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "cube";
CREATE EXTENSION IF NOT EXISTS "earthdistance";
CREATE EXTENSION IF NOT EXISTS "vector";

-- 1. Merchant Business Profiles with Geospatial Coordinates
CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_name VARCHAR(150) NOT NULL,
    category VARCHAR(50) NOT NULL, -- GROCERY, SALON, PHARMACY, RESTAURANT, FLORIST, PET_SHOP, HARDWARE
    owner_phone VARCHAR(15) UNIQUE NOT NULL,
    owner_email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    is_verified BOOLEAN DEFAULT false,
    upi_vpa VARCHAR(100) NOT NULL, -- Vendor's UPI ID for direct customer dynamic QR payments
    address TEXT NOT NULL,
    pincode VARCHAR(10) NOT NULL,
    latitude NUMERIC(10, 7) NOT NULL,
    longitude NUMERIC(10, 7) NOT NULL,
    -- New stores default to CLOSED; must be explicitly opened after Admin KYC approval
    is_open BOOLEAN DEFAULT false,
    rating NUMERIC(2, 1) DEFAULT 5.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_merchants_earth ON merchants USING gist (ll_to_earth(latitude, longitude));

-- 2. Inventory Items with pgvector Embeddings for Semantic RAG Search
CREATE TABLE IF NOT EXISTS inventory_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    item_name VARCHAR(200) NOT NULL,
    category VARCHAR(50) NOT NULL,
    description TEXT,
    price NUMERIC(10, 2) NOT NULL,
    stock_quantity INT NOT NULL DEFAULT 0,
    unit VARCHAR(20) DEFAULT 'pcs',
    is_available BOOLEAN DEFAULT true,
    embedding VECTOR(1536),
    last_restocked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inventory_embedding ON inventory_items USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_inventory_merchant_id ON inventory_items(merchant_id);

-- 3. Service Appointment Slots (5-minute atomic holding locks)
CREATE TABLE IF NOT EXISTS service_slots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    service_name VARCHAR(150) NOT NULL,
    slot_start TIMESTAMP WITH TIME ZONE NOT NULL,
    slot_end TIMESTAMP WITH TIME ZONE NOT NULL,
    capacity INT DEFAULT 1,
    booked_count INT DEFAULT 0,
    price NUMERIC(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'AVAILABLE', -- AVAILABLE, LOCKED, BOOKED
    locked_until TIMESTAMP WITH TIME ZONE,
    locked_by_user_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_slots_merchant_time ON service_slots(merchant_id, slot_start);

-- 4. Seller Accounts (Human login principals separated from Merchant Store records)
CREATE TABLE IF NOT EXISTS seller_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255),
    is_email_verified BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_accounts_lower_email
    ON seller_accounts (LOWER(email));

-- 5. Store Memberships (Seller Account <-> Merchant Store RBAC mapping)
CREATE TABLE IF NOT EXISTS store_memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seller_account_id UUID NOT NULL REFERENCES seller_accounts(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('OWNER', 'STAFF')),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INVITED', 'SUSPENDED', 'REVOKED')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (seller_account_id, merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_store_memberships_seller
    ON store_memberships (seller_account_id, status);

CREATE INDEX IF NOT EXISTS idx_store_memberships_merchant
    ON store_memberships (merchant_id, status);

-- ========================================================
-- MO-A: Merchant Onboarding & KYC Schema (Migration 002)
-- ========================================================

-- 6. KYC Document Requirements Catalogue
CREATE TABLE IF NOT EXISTS kyc_document_requirements (
    id                  UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    requirement_key     VARCHAR(100) NOT NULL,
    category            VARCHAR(50)  NULL,
    is_mandatory        BOOLEAN      NOT NULL DEFAULT true,
    document_type       VARCHAR(100) NOT NULL,
    label               VARCHAR(200) NOT NULL,
    description         TEXT,
    sort_order          INT          NOT NULL DEFAULT 100,
    is_active           BOOLEAN      NOT NULL DEFAULT true,
    effective_version   INT          NOT NULL DEFAULT 1,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_req_key_cat
    ON kyc_document_requirements (requirement_key, COALESCE(category, '__UNIVERSAL__'));
CREATE INDEX IF NOT EXISTS idx_kyc_req_category ON kyc_document_requirements (category, is_active);
CREATE INDEX IF NOT EXISTS idx_kyc_req_active   ON kyc_document_requirements (is_active, sort_order);

-- 7. Store Onboarding Profiles (one per merchant)
CREATE TABLE IF NOT EXISTS store_onboarding_profiles (
    id                          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id                 UUID         NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE RESTRICT,
    business_name               VARCHAR(150) NULL,
    category                    VARCHAR(50)  NULL,
    business_type               VARCHAR(30)  NOT NULL DEFAULT 'FIXED_SHOP'
                                CHECK (business_type IN ('FIXED_SHOP')),
    business_type_confirmed     BOOLEAN      NOT NULL DEFAULT false,
    fixed_premises_confirmed    BOOLEAN      NOT NULL DEFAULT false,
    premises_ownership_type     VARCHAR(30)  NULL
                                CHECK (premises_ownership_type IS NULL OR premises_ownership_type IN ('OWNED','RENTED','LEASED')),
    address                     TEXT,
    pincode                     VARCHAR(10),
    latitude                    NUMERIC(10,7),
    longitude                   NUMERIC(10,7),
    gps_captured_at             TIMESTAMP WITH TIME ZONE,
    gps_accuracy_meters         NUMERIC(8,2),
    status                      VARCHAR(30)  NOT NULL DEFAULT 'PENDING_SUBMISSION'
                                CHECK (status IN (
                                    'PENDING_SUBMISSION','DRAFT','SUBMITTED','UNDER_REVIEW',
                                    'MORE_INFO_REQUIRED','APPROVED','REJECTED',
                                    'SUSPENDED','REVERIFICATION_REQUIRED'
                                )),
    current_submission_id       UUID         NULL,
    draft_submission_id         UUID         NULL,
    approved_submission_id      UUID         NULL,
    reverification_required     BOOLEAN      NOT NULL DEFAULT false,
    reverification_reason       TEXT         NULL,
    approved_address            TEXT         NULL,
    approved_pincode            VARCHAR(10)  NULL,
    approved_latitude           NUMERIC(10,7) NULL,
    approved_longitude          NUMERIC(10,7) NULL,
    approved_at                 TIMESTAMP WITH TIME ZONE NULL,
    supplementary_metadata      JSONB        NULL,
    pre_suspension_status       VARCHAR(30)  NULL
                                CHECK (pre_suspension_status IS NULL OR pre_suspension_status IN (
                                    'PENDING_SUBMISSION','DRAFT','SUBMITTED','UNDER_REVIEW',
                                    'MORE_INFO_REQUIRED','APPROVED','REJECTED',
                                    'SUSPENDED','REVERIFICATION_REQUIRED'
                                )),
    suspended_at                TIMESTAMP WITH TIME ZONE NULL,
    suspended_by_admin_id       UUID         NULL,
    suspension_reason           TEXT         NULL,
    suspension_type             VARCHAR(30)  NULL
                                CHECK (suspension_type IS NULL OR suspension_type IN ('ORDINARY_VIOLATION', 'PROTECTIVE_SERIOUS_RISK')),
    suspension_evidence         JSONB        NULL,
    owner_suspension_response   TEXT         NULL,
    owner_suspension_evidence   JSONB        NULL,
    owner_suspension_responded_at TIMESTAMP WITH TIME ZONE NULL,
    owner_suspension_responded_by UUID       NULL,
    last_reactivated_at         TIMESTAMP WITH TIME ZONE NULL,
    last_reactivated_by_admin_id UUID        NULL,
    last_reactivation_reason    TEXT         NULL,
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_onboarding_status   ON store_onboarding_profiles (status);
CREATE INDEX IF NOT EXISTS idx_onboarding_merchant ON store_onboarding_profiles (merchant_id, status);

-- 8. Store KYC Submissions (versioned draft & immutable submitted snapshots)
CREATE TABLE IF NOT EXISTS store_kyc_submissions (
    id                              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id                     UUID         NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    submission_version              INT          NOT NULL,
    submitted_by_seller_account_id  UUID         NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    status                          VARCHAR(30)  NOT NULL DEFAULT 'DRAFT'
                                    CHECK (status IN (
                                        'DRAFT','SUBMITTED','UNDER_REVIEW',
                                        'MORE_INFO_REQUIRED','APPROVED','REJECTED','SUSPENDED'
                                    )),
    business_name_snapshot          VARCHAR(150) NOT NULL,
    category_snapshot               VARCHAR(50)  NOT NULL,
    business_type_snapshot          VARCHAR(30)  NOT NULL DEFAULT 'FIXED_SHOP'
                                    CHECK (business_type_snapshot IN ('FIXED_SHOP')),
    fixed_premises_confirmed_snapshot BOOLEAN    NOT NULL DEFAULT false,
    address_snapshot                TEXT         NOT NULL,
    pincode_snapshot                VARCHAR(10)  NOT NULL,
    latitude_snapshot               NUMERIC(10,7) NULL,
    longitude_snapshot              NUMERIC(10,7) NULL,
    gps_captured_at_snapshot        TIMESTAMP WITH TIME ZONE NULL,
    gps_accuracy_meters_snapshot    NUMERIC(8,2) NULL,
    submitted_requirements_version  INT          NOT NULL DEFAULT 1,
    requirements_snapshot           JSONB        NULL,
    seller_contact_snapshot         JSONB        NULL,
    is_reverification               BOOLEAN      NOT NULL DEFAULT false,
    submitted_at                    TIMESTAMP WITH TIME ZONE NULL,
    reviewed_at                     TIMESTAMP WITH TIME ZONE NULL,
    reviewed_by_admin_id            UUID         NULL,
    review_started_at               TIMESTAMP WITH TIME ZONE NULL,
    review_notes                    TEXT         NULL,
    review_checklist                JSONB        NULL,
    owner_feedback_reason           TEXT         NULL,
    requested_requirements          JSONB        NULL,
    rejection_category              VARCHAR(60)  NULL,
    created_at                      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, submission_version),
    CHECK (
        status = 'DRAFT' OR (
            submitted_at IS NOT NULL
            AND fixed_premises_confirmed_snapshot = true
            AND latitude_snapshot IS NOT NULL
            AND longitude_snapshot IS NOT NULL
            AND LENGTH(TRIM(address_snapshot)) > 0
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_kyc_sub_merchant ON store_kyc_submissions (merchant_id, submission_version DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_sub_status   ON store_kyc_submissions (status);
CREATE INDEX IF NOT EXISTS idx_kyc_sub_submitted_at ON store_kyc_submissions (submitted_at ASC NULLS LAST, id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_sub_one_draft
    ON store_kyc_submissions (merchant_id) WHERE status = 'DRAFT';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_current_submission') THEN
        ALTER TABLE store_onboarding_profiles
            ADD CONSTRAINT fk_current_submission
            FOREIGN KEY (current_submission_id) REFERENCES store_kyc_submissions(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_draft_submission') THEN
        ALTER TABLE store_onboarding_profiles
            ADD CONSTRAINT fk_draft_submission
            FOREIGN KEY (draft_submission_id) REFERENCES store_kyc_submissions(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_approved_submission') THEN
        ALTER TABLE store_onboarding_profiles
            ADD CONSTRAINT fk_approved_submission
            FOREIGN KEY (approved_submission_id) REFERENCES store_kyc_submissions(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 9. KYC Documents (file metadata; bytes stored in private storage)
CREATE TABLE IF NOT EXISTS kyc_documents (
    id                              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    submission_id                   UUID         NOT NULL REFERENCES store_kyc_submissions(id) ON DELETE RESTRICT,
    merchant_id                     UUID         NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    requirement_key                 VARCHAR(100) NOT NULL,
    document_type                   VARCHAR(100) NOT NULL,
    original_filename_sanitized     VARCHAR(255) NOT NULL,
    storage_key                     VARCHAR(500) NOT NULL UNIQUE,
    mime_type                       VARCHAR(100) NOT NULL,
    file_size_bytes                 BIGINT       NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
    sha256_checksum                 VARCHAR(64)  NOT NULL,
    uploaded_by_seller_account_id   UUID         NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    uploaded_at                     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_storefront_photo             BOOLEAN      NOT NULL DEFAULT false,
    is_premises_proof               BOOLEAN      NOT NULL DEFAULT false,
    metadata                        JSONB        NULL,
    UNIQUE (submission_id, sha256_checksum)
);

CREATE INDEX IF NOT EXISTS idx_kyc_docs_submission ON kyc_documents (submission_id);
CREATE INDEX IF NOT EXISTS idx_kyc_docs_merchant   ON kyc_documents (merchant_id);
CREATE INDEX IF NOT EXISTS idx_kyc_docs_req_key    ON kyc_documents (merchant_id, requirement_key);

-- Immutability guards for historical KYC submissions and documents
CREATE OR REPLACE FUNCTION prevent_non_draft_kyc_document_mutation()
RETURNS TRIGGER AS $$
DECLARE
    sub_status VARCHAR(30);
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.submission_id IS DISTINCT FROM OLD.submission_id
           OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
           OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
           OR NEW.sha256_checksum IS DISTINCT FROM OLD.sha256_checksum THEN
            RAISE EXCEPTION 'KYC document identity and checksum fields are immutable.' USING ERRCODE = '23514';
        END IF;
    END IF;

    SELECT status INTO sub_status
    FROM store_kyc_submissions
    WHERE id = COALESCE(OLD.submission_id, NEW.submission_id);

    IF sub_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'Historical or submitted KYC documents are immutable and cannot be modified or deleted.' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kyc_documents_immutable ON kyc_documents;
CREATE TRIGGER trg_kyc_documents_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON kyc_documents
    FOR EACH ROW EXECUTE FUNCTION prevent_non_draft_kyc_document_mutation();

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

-- 10. Store Onboarding Audit Events (append-only ledger)
CREATE TABLE IF NOT EXISTS store_onboarding_audit_events (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id     UUID        NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    actor_type      VARCHAR(24) NOT NULL CHECK (actor_type IN ('SELLER','ADMIN','SYSTEM')),
    actor_id        UUID        NULL,
    event_type      VARCHAR(80) NOT NULL,
    event_metadata  JSONB       NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_merchant   ON store_onboarding_audit_events (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON store_onboarding_audit_events (event_type, created_at DESC);

CREATE OR REPLACE RULE no_update_audit_events AS
    ON UPDATE TO store_onboarding_audit_events DO INSTEAD NOTHING;
CREATE OR REPLACE RULE no_delete_audit_events AS
    ON DELETE TO store_onboarding_audit_events DO INSTEAD NOTHING;

-- 11. Seed default document requirements catalogue (idempotent)
INSERT INTO kyc_document_requirements
    (requirement_key, category, is_mandatory, document_type, label, description, sort_order)
VALUES
    ('STOREFRONT_PHOTO_1', NULL, true,  'STOREFRONT_PHOTO',
     'Storefront Photo (Front Signboard & Entrance)',
     'Clear photograph of the front of your physical shop showing the visible signboard and main entrance.',
     10),
    ('STOREFRONT_PHOTO_2', NULL, true,  'STOREFRONT_PHOTO',
     'Storefront Photo (Premises / Interior View)',
     'Second clear photograph showing the physical shop exterior from another angle or the shop premises interior.',
     20),
    ('PREMISES_PROOF',     NULL, true,  'PREMISES_PROOF',
     'Premises Proof Document',
     'Proof of lawful occupancy or ownership of the physical shop (utility bill, rent/lease agreement, or ownership deed).',
     30),
    ('ADDITIONAL_PREMISES_PHOTO', NULL, false, 'STOREFRONT_PHOTO',
     'Additional Storefront / Premises Photo (Optional)',
     'Optional supplementary photograph of your shop premises (up to 5 total storefront/premises photographs per submission).',
     35),
    ('SUPPORTING_PREMISES_DOC', NULL, false, 'PREMISES_PROOF',
     'Supporting Premises Document (Optional)',
     'Optional supplementary premises or municipal registration document.',
     38),
    ('DRUG_LICENSE', 'PHARMACY', true, 'DRUG_LICENSE',
     'Valid Drug License',
     'Retail or wholesale Drug License issued by the State Drugs Control Authority (e.g. Form 20/21).',
     40),
    ('FSSAI_LICENSE', 'RESTAURANT', true, 'FSSAI_LICENSE',
     'FSSAI Food Safety License / Registration (Food Service & Dining)',
     'Valid 14-digit FSSAI Registration or State/Central License Certificate covering food preparation, catering, or dine-in service.',
     40),
    ('FSSAI_FOOD_RETAIL_REGISTRATION', 'GROCERY', true, 'FSSAI_LICENSE',
     'FSSAI Food Business Registration / License (Grocery & Food Retail)',
     'Valid 14-digit FSSAI Basic Registration (eligible petty food retailers) or State/Central License Certificate for retail sale of food and grocery items.',
     40)
ON CONFLICT DO NOTHING;

-- ========================================================
-- MO-B1: Administrative Identity Foundation (Migration 003)
-- ========================================================

-- 12. Admin Accounts (isolated from seller_accounts and customer users)
CREATE TABLE IF NOT EXISTS admin_accounts (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) NOT NULL,
    full_name       VARCHAR(150) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
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

DO $$
DECLARE
    existing_deltype "char";
BEGIN
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
END $$;

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

-- ========================================================
-- MO-B3: Store Compliance Warnings & Enforcement (Migration 005)
-- ========================================================

-- 13. Store Compliance Warnings (per-store sequential numbering, permanent history)
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

-- 14. Append-only Owner Corrective Responses
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

-- Foreign keys for suspension/reactivation actors on store_onboarding_profiles
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_profile_suspended_by_admin') THEN
        ALTER TABLE store_onboarding_profiles
            ADD CONSTRAINT fk_profile_suspended_by_admin
            FOREIGN KEY (suspended_by_admin_id) REFERENCES admin_accounts(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_profile_reactivated_by_admin') THEN
        ALTER TABLE store_onboarding_profiles
            ADD CONSTRAINT fk_profile_reactivated_by_admin
            FOREIGN KEY (last_reactivated_by_admin_id) REFERENCES admin_accounts(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_profile_suspension_responded_by') THEN
        ALTER TABLE store_onboarding_profiles
            ADD CONSTRAINT fk_profile_suspension_responded_by
            FOREIGN KEY (owner_suspension_responded_by) REFERENCES seller_accounts(id) ON DELETE RESTRICT;
    END IF;
END $$;

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

-- ========================================================
-- MO-B2 / MO-B3 / MO-B4: Durable Notification Outbox &
-- Owner In-App Notifications (Migrations 004 + 005 + 006)
-- ========================================================

-- 15. Owner / Admin Notification Events (written transactionally; reliably delivered in MO-B4)
CREATE TABLE IF NOT EXISTS owner_notification_events (
    id                                   UUID                     PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id                          UUID                     NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    submission_id                        UUID                     NULL REFERENCES store_kyc_submissions(id) ON DELETE RESTRICT,
    submission_version                   INT                      NULL,
    warning_id                           UUID                     NULL REFERENCES store_compliance_warnings(id) ON DELETE RESTRICT,
    owner_seller_account_id              UUID                     NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    recipient_role                       VARCHAR(20)              NOT NULL DEFAULT 'OWNER'
                                         CHECK (recipient_role IN ('OWNER', 'ADMIN')),
    event_type                           VARCHAR(60)              NOT NULL,
    CONSTRAINT chk_owner_notification_event_type CHECK (event_type IN (
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
                                         )),
    payload                              JSONB                    NOT NULL,
    delivery_status                      VARCHAR(24)              NOT NULL DEFAULT 'PENDING'
                                         CONSTRAINT chk_owner_notification_delivery_status CHECK (delivery_status IN (
                                             'PENDING',
                                             'PROCESSING',
                                             'RETRYING',
                                             'DELIVERED',
                                             'SENT',
                                             'TERMINAL_FAILED',
                                             'FAILED',
                                             'CANCELLED'
                                         )),
    delivery_attempts                    INT                      NOT NULL DEFAULT 0,
    max_attempts                         INT                      NOT NULL DEFAULT 5
                                         CHECK (max_attempts >= 1 AND max_attempts <= 25),
    next_attempt_at                      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_by                            VARCHAR(120)             NULL,
    lease_expires_at                     TIMESTAMP WITH TIME ZONE NULL,
    processing_started_at                TIMESTAMP WITH TIME ZONE NULL,
    last_attempted_at                    TIMESTAMP WITH TIME ZONE NULL,
    last_error                           TEXT                     NULL,
    failed_at                            TIMESTAMP WITH TIME ZONE NULL,
    replayed_at                          TIMESTAMP WITH TIME ZONE NULL,
    replayed_by_admin_id                 UUID                     NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
    resolved_recipient_seller_account_id UUID                     NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    in_app_status                        VARCHAR(30)              NOT NULL DEFAULT 'PENDING'
                                         CHECK (in_app_status IN ('PENDING', 'DELIVERED', 'SKIPPED_ADMIN_EVENT', 'FAILED')),
    email_status                         VARCHAR(30)              NOT NULL DEFAULT 'PENDING'
                                         CHECK (email_status IN ('PENDING', 'SENT', 'UNCONFIGURED', 'NO_RECIPIENT_EMAIL', 'FAILED', 'SKIPPED_ADMIN_EVENT')),
    email_error                          TEXT                     NULL,
    email_sent_at                        TIMESTAMP WITH TIME ZONE NULL,
    created_at                           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dispatched_at                        TIMESTAMP WITH TIME ZONE NULL
);

CREATE INDEX IF NOT EXISTS idx_owner_notif_pending
    ON owner_notification_events (delivery_status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_owner_notif_merchant
    ON owner_notification_events (merchant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_owner_notif_claimable
    ON owner_notification_events (delivery_status, next_attempt_at ASC, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_owner_notif_stream_order
    ON owner_notification_events (merchant_id, recipient_role, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_owner_notif_lease
    ON owner_notification_events (delivery_status, lease_expires_at ASC);

-- 16. Durable Owner-facing in-app notification inbox (idempotent per outbox event)
CREATE TABLE IF NOT EXISTS owner_notifications (
    id                          UUID                     PRIMARY KEY DEFAULT uuid_generate_v4(),
    outbox_event_id             UUID                     NOT NULL UNIQUE REFERENCES owner_notification_events(id) ON DELETE RESTRICT,
    merchant_id                 UUID                     NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    recipient_seller_account_id UUID                     NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
    event_type                  VARCHAR(60)              NOT NULL,
    title                       VARCHAR(200)             NOT NULL,
    message                     TEXT                     NOT NULL,
    submission_id               UUID                     NULL REFERENCES store_kyc_submissions(id) ON DELETE RESTRICT,
    submission_version          INT                      NULL,
    warning_id                  UUID                     NULL REFERENCES store_compliance_warnings(id) ON DELETE RESTRICT,
    metadata                    JSONB                    NOT NULL DEFAULT '{}'::jsonb,
    is_read                     BOOLEAN                  NOT NULL DEFAULT false,
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

-- Phase 2.1 Grocery catalogue (mirrors migrations/007_grocery_catalogue.sql).
CREATE TABLE IF NOT EXISTS catalogue_products (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(200) NOT NULL, normalized_name VARCHAR(200) NOT NULL, brand VARCHAR(120), category VARCHAR(80) NOT NULL, description TEXT, barcode VARCHAR(80), attributes JSONB NOT NULL DEFAULT '{}'::jsonb, status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','ARCHIVED','MERGED')), created_by_type VARCHAR(20) NOT NULL DEFAULT 'ADMIN' CHECK(created_by_type IN('ADMIN','SELLER')), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_products_barcode ON catalogue_products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_catalogue_products_search ON catalogue_products(category,status,normalized_name);
CREATE TABLE IF NOT EXISTS catalogue_product_variants (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID NOT NULL REFERENCES catalogue_products(id) ON DELETE RESTRICT, name VARCHAR(160) NOT NULL, normalized_name VARCHAR(160) NOT NULL, barcode VARCHAR(80), attributes JSONB NOT NULL DEFAULT '{}'::jsonb, status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','ARCHIVED')), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id,normalized_name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_variants_barcode ON catalogue_product_variants(barcode) WHERE barcode IS NOT NULL;
CREATE TABLE IF NOT EXISTS store_product_listings (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT, catalogue_product_id UUID REFERENCES catalogue_products(id) ON DELETE RESTRICT, catalogue_variant_id UUID REFERENCES catalogue_product_variants(id) ON DELETE RESTRICT, title VARCHAR(200) NOT NULL, description_override TEXT, price NUMERIC(10,2) NOT NULL CHECK(price>=0), images JSONB NOT NULL DEFAULT '[]'::jsonb, is_available BOOLEAN NOT NULL DEFAULT true, status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','ARCHIVED')), created_by_seller_account_id UUID NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_global_listing ON store_product_listings(merchant_id,catalogue_product_id,catalogue_variant_id) WHERE status='ACTIVE' AND catalogue_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_store_product_listings_store ON store_product_listings(merchant_id,status,is_available);
CREATE TABLE IF NOT EXISTS catalogue_admin_audit_events (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), admin_id UUID NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT, event_type VARCHAR(50) NOT NULL, source_product_id UUID REFERENCES catalogue_products(id) ON DELETE RESTRICT, target_product_id UUID REFERENCES catalogue_products(id) ON DELETE RESTRICT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
