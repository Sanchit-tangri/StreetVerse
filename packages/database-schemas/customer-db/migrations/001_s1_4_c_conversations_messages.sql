-- ========================================================
-- StreetVerse Migration 001 (S1.4-C):
-- PostgreSQL-backed Conversations, Participants & Messages in Customer DB
-- Additive & idempotent.
-- ========================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Conversations (One OPEN conversation per Buyer-Merchant Store pair)
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

-- 2. Conversation Participants (BUYER or S1.4-A SELLER_ACCOUNT UUIDs)
-- NOTE: Seller access is always revalidated against Merchant DB active store memberships.
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

-- 3. Persistent Chat Messages (technical length limit: 2000 chars)
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
