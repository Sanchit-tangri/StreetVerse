-- ========================================================
-- StreetVerse Migration 002 (MO-A):
-- Merchant Onboarding Data Model, Physical Shop Verification
-- and Secure Document Persistence
--
-- Additive & idempotent (IF NOT EXISTS / DO $$ / CREATE OR REPLACE).
-- Does NOT approve any existing or new store automatically.
-- Does NOT use merchants.is_verified as an approval signal.
-- Preserves all existing merchants UUIDs, FKs, and data.
-- ========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- --------------------------------------------------------
-- 1. KYC Document Requirements Catalogue
--    Versioned requirement definitions; universal (category IS NULL)
--    and category-specific entries.
-- --------------------------------------------------------
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

-- --------------------------------------------------------
-- 2. Store Onboarding Profiles
--    One record per Merchant Store.
--    Fixed-shop premises only; supports re-verification when
--    an approved store changes physical address or GPS.
-- --------------------------------------------------------
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

    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_onboarding_status   ON store_onboarding_profiles (status);
CREATE INDEX IF NOT EXISTS idx_onboarding_merchant ON store_onboarding_profiles (merchant_id, status);

-- --------------------------------------------------------
-- 3. Store KYC Submissions
--    Versioned snapshots. A draft uses status='DRAFT'; once
--    explicitly submitted (`SUBMITTED`), snapshots and linked
--    documents become immutable and only forward Admin review
--    transitions (MO-B) are permitted.
-- --------------------------------------------------------
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
    review_notes                    TEXT         NULL,

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

-- --------------------------------------------------------
-- 4. KYC Documents
--    Uploaded document metadata. Raw bytes stored on private
--    storage; storage_key is an opaque CSPRNG handle.
-- --------------------------------------------------------
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

-- --------------------------------------------------------
-- 5. Immutability Triggers for Historical Submissions & Docs
-- --------------------------------------------------------
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

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kyc_submissions_immutable ON store_kyc_submissions;
CREATE TRIGGER trg_kyc_submissions_immutable
    BEFORE UPDATE OR DELETE ON store_kyc_submissions
    FOR EACH ROW EXECUTE FUNCTION prevent_submitted_kyc_submission_mutation();

-- --------------------------------------------------------
-- 6. Store Onboarding Audit Events (Append-Only Ledger)
-- --------------------------------------------------------
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

-- --------------------------------------------------------
-- 7. Seed Default Document Requirements Catalogue
--    Minimum necessary evidence; category-aware; no blanket GST.
-- --------------------------------------------------------
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

-- --------------------------------------------------------
-- 8. Default Closed Safety for New & Unapproved Legacy Stores
--    Ignores legacy merchants.is_verified (untrusted KYC signal).
-- --------------------------------------------------------
ALTER TABLE merchants ALTER COLUMN is_open SET DEFAULT false;

INSERT INTO store_onboarding_profiles (merchant_id, business_name, category, status)
SELECT id, business_name, category, 'PENDING_SUBMISSION'
FROM merchants
ON CONFLICT (merchant_id) DO NOTHING;

UPDATE merchants m
SET is_open = false
WHERE m.is_open = true
  AND NOT EXISTS (
      SELECT 1
      FROM store_onboarding_profiles p
      WHERE p.merchant_id = m.id
        AND p.status = 'APPROVED'
        AND p.reverification_required = false
  );
