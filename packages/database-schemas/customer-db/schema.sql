-- ========================================================
-- StreetVerse: Customer DB (Database 1 - Isolated)
-- Purpose: Customer profiles, customer-side order receipts,
--          and appointment booking confirmation vouchers.
-- SECURITY: Zero vendor internal metrics, banking credentials,
--           or wholesale costs stored here.
-- ========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Customer User Profiles
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone VARCHAR(15) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE,
    preferred_language VARCHAR(10) DEFAULT 'en',
    home_address TEXT,
    password_hash VARCHAR(255),
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Customer Order Receipts
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL, -- Logical foreign key to Merchant DB
    total_amount NUMERIC(10, 2) NOT NULL,
    payment_status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, PAID, FAILED, REFUNDED
    upi_transaction_ref VARCHAR(100),
    delivery_type VARCHAR(20) NOT NULL, -- STORE_PICKUP, LOCAL_DELIVERY
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Customer Booking Receipts (Service Appointments)
CREATE TABLE IF NOT EXISTS booking_receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL, -- Logical foreign key to Merchant DB
    service_slot_id UUID NOT NULL, -- Logical foreign key to Merchant DB
    service_name VARCHAR(150) NOT NULL,
    appointment_time TIMESTAMP WITH TIME ZONE NOT NULL,
    token_number INT NOT NULL,
    qr_verification_code VARCHAR(255) NOT NULL,
    booking_status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED', -- CONFIRMED, COMPLETED, CANCELLED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_booking_receipts_user_id ON booking_receipts(user_id);
