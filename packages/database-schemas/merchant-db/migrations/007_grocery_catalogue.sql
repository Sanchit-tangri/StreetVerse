-- Phase 2.1: product identity is global; price/availability remain store-local.
CREATE TABLE IF NOT EXISTS catalogue_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(200) NOT NULL,
  normalized_name VARCHAR(200) NOT NULL,
  brand VARCHAR(120), category VARCHAR(80) NOT NULL,
  description TEXT, barcode VARCHAR(80), attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED','MERGED')),
  created_by_type VARCHAR(20) NOT NULL DEFAULT 'ADMIN' CHECK (created_by_type IN ('ADMIN','SELLER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_products_barcode ON catalogue_products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_catalogue_products_search ON catalogue_products(category, status, normalized_name);
CREATE TABLE IF NOT EXISTS catalogue_product_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID NOT NULL REFERENCES catalogue_products(id) ON DELETE RESTRICT,
  name VARCHAR(160) NOT NULL, normalized_name VARCHAR(160) NOT NULL, barcode VARCHAR(80), attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, normalized_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_variants_barcode ON catalogue_product_variants(barcode) WHERE barcode IS NOT NULL;
CREATE TABLE IF NOT EXISTS store_product_listings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  catalogue_product_id UUID REFERENCES catalogue_products(id) ON DELETE RESTRICT,
  catalogue_variant_id UUID REFERENCES catalogue_product_variants(id) ON DELETE RESTRICT,
  title VARCHAR(200) NOT NULL, description_override TEXT, price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  images JSONB NOT NULL DEFAULT '[]'::jsonb, is_available BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by_seller_account_id UUID NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_global_listing ON store_product_listings(merchant_id, catalogue_product_id, catalogue_variant_id) WHERE status='ACTIVE' AND catalogue_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_store_product_listings_store ON store_product_listings(merchant_id, status, is_available);
CREATE TABLE IF NOT EXISTS catalogue_admin_audit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), admin_id UUID NOT NULL REFERENCES admin_accounts(id) ON DELETE RESTRICT,
  event_type VARCHAR(50) NOT NULL, source_product_id UUID REFERENCES catalogue_products(id) ON DELETE RESTRICT,
  target_product_id UUID REFERENCES catalogue_products(id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Merchant-authored identity is deliberately separate from global catalogue identity.
CREATE TABLE IF NOT EXISTS store_specific_products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  name VARCHAR(200) NOT NULL, normalized_name VARCHAR(200) NOT NULL, description TEXT, category VARCHAR(80) NOT NULL,
  barcode VARCHAR(80), attributes JSONB NOT NULL DEFAULT '{}'::jsonb, images JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
  created_by_seller_account_id UUID NOT NULL REFERENCES seller_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(merchant_id, normalized_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_specific_barcode ON store_specific_products(merchant_id,barcode) WHERE barcode IS NOT NULL;
CREATE TABLE IF NOT EXISTS store_specific_product_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), store_product_id UUID NOT NULL REFERENCES store_specific_products(id) ON DELETE RESTRICT,
  name VARCHAR(160) NOT NULL, normalized_name VARCHAR(160) NOT NULL, barcode VARCHAR(80), attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(store_product_id,normalized_name)
);
ALTER TABLE store_product_listings ADD COLUMN IF NOT EXISTS store_specific_product_id UUID REFERENCES store_specific_products(id) ON DELETE RESTRICT;
ALTER TABLE store_product_listings ADD COLUMN IF NOT EXISTS store_specific_variant_id UUID REFERENCES store_specific_product_variants(id) ON DELETE RESTRICT;
ALTER TABLE store_product_listings DROP CONSTRAINT IF EXISTS chk_listing_one_product_source;
ALTER TABLE store_product_listings ADD CONSTRAINT chk_listing_one_product_source CHECK ((catalogue_product_id IS NOT NULL AND store_specific_product_id IS NULL) OR (catalogue_product_id IS NULL AND store_specific_product_id IS NOT NULL));
