-- ========================================================
-- StreetVerse Migration 001 (S1.4-A):
-- Separate Seller Accounts & Store Memberships in Merchant DB
-- Additive & idempotent; preserves existing `merchants` rows,
-- UUIDs, foreign keys, and legacy columns temporarily.
-- ========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Seller Account (Authenticated person / human login identity)
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

-- 2. Store Membership (Connects Seller Account -> Merchant Store with RBAC role)
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
