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

-- 4. Buyer-Store Conversations (One OPEN conversation per Buyer-Merchant Store pair)
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    buyer_user_id UUID NOT NULL REFERENCES users(id),
    merchant_id UUID NOT NULL, -- Logical cross-DB reference to Merchant DB merchants(id)
    status VARCHAR(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_open_per_pair
    ON conversations (buyer_user_id, merchant_id)
    WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_conversations_buyer_updated
    ON conversations (buyer_user_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_merchant_updated
    ON conversations (merchant_id, updated_at DESC, id DESC);

-- 5. Conversation Participants (BUYER or SELLER_ACCOUNT identities)
CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    participant_type VARCHAR(24) NOT NULL CHECK (participant_type IN ('BUYER', 'SELLER_ACCOUNT')),
    participant_id UUID NOT NULL,
    can_read BOOLEAN NOT NULL DEFAULT true,
    can_send BOOLEAN NOT NULL DEFAULT true,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, participant_type, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_participants_inbox_lookup
    ON conversation_participants (participant_type, participant_id, can_read, conversation_id);

-- 6. Persistent Messages (technical length limit: 2000 chars)
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_type VARCHAR(24) NOT NULL CHECK (sender_type IN ('BUYER', 'SELLER_ACCOUNT')),
    sender_id UUID NOT NULL,
    client_message_id UUID,
    body TEXT NOT NULL CHECK (char_length(btrim(body)) >= 1 AND char_length(body) <= 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_messages_participant
        FOREIGN KEY (conversation_id, sender_type, sender_id)
        REFERENCES conversation_participants (conversation_id, participant_type, participant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_idempotency
    ON messages (conversation_id, sender_type, sender_id, client_message_id)
    WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_history
    ON messages (conversation_id, created_at DESC, id DESC);
