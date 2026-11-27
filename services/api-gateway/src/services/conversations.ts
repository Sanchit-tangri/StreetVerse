import { StrictPgClient, StrictPgPool, withPgTransaction } from '../db/postgres';
import {
  listSellerAccountWithMemberships,
  StoreAccessContext,
  verifySellerStorePermission
} from './sellerRbac';
import { classifyHttpError } from '../utils/infraErrors';
import { AuthenticatedPrincipal, SELLER_ACCOUNT_PRINCIPAL_TYPE } from '../middleware/authJwt';

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Technical single-message limit enforced both at API/socket validation and PostgreSQL CHECK constraint.
 */
export const MAX_CHAT_MESSAGE_LENGTH = 2000;
export const DEFAULT_MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_PAGE_SIZE = 100;

export type ConversationStatus = 'OPEN' | 'CLOSED';
export type ParticipantType = 'BUYER' | 'SELLER_ACCOUNT';

export interface ImmutableSocketPrincipal {
  readonly participantType: ParticipantType;
  readonly participantId: string;
}

export interface ConversationStoreSummary {
  id: string;
  businessName: string;
  category: string;
  isOpen: boolean;
}

export interface ConversationRecord {
  id: string;
  buyerUserId: string;
  merchantId: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  store?: ConversationStoreSummary;
  membership?: {
    membershipId: string;
    role: 'OWNER' | 'STAFF';
    permissions: string[];
  };
  lastMessage?: {
    id: string;
    senderType: ParticipantType;
    senderId: string;
    body: string;
    createdAt: string;
  } | null;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  senderType: ParticipantType;
  senderId: string;
  clientMessageId: string | null;
  body: string;
  createdAt: string;
}

export type ServiceErrorResult = {
  ok: false;
  status: number;
  code: string;
  error: string;
};

export type VerifySocketPrincipalResult =
  | { ok: true; principal: ImmutableSocketPrincipal }
  | ServiceErrorResult;

export type CreateOrGetConversationResult =
  | { ok: true; created: boolean; conversation: ConversationRecord }
  | ServiceErrorResult;

export type ListConversationsResult =
  | { ok: true; conversations: ConversationRecord[] }
  | ServiceErrorResult;

export type AuthorizeConversationAccessResult =
  | {
      ok: true;
      conversation: ConversationRecord;
      roomName: string;
      canRead: boolean;
      canSend: boolean;
      storeAccess?: StoreAccessContext;
    }
  | ServiceErrorResult;

export type ListMessagesResult =
  | {
      ok: true;
      conversationId: string;
      messages: ChatMessageRecord[];
      pageInfo: {
        limit: number;
        hasMore: boolean;
        nextCursor: string | null;
      };
    }
  | ServiceErrorResult;

export type SendMessageResult =
  | {
      ok: true;
      deduplicated: boolean;
      roomName: string;
      message: ChatMessageRecord;
    }
  | ServiceErrorResult;

export function getConversationRoomName(conversationId: string): string {
  return `conversation:${conversationId.trim().toLowerCase()}`;
}

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date().toISOString();
}

function mapConversationRow(row: any): ConversationRecord {
  return {
    id: String(row.id),
    buyerUserId: String(row.buyer_user_id),
    merchantId: String(row.merchant_id),
    status: row.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function mapMessageRow(row: any): ChatMessageRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    senderType: row.sender_type === 'SELLER_ACCOUNT' ? 'SELLER_ACCOUNT' : 'BUYER',
    senderId: String(row.sender_id),
    clientMessageId: row.client_message_id ? String(row.client_message_id) : null,
    body: String(row.body),
    createdAt: toIsoString(row.created_at)
  };
}

interface MessageCursor {
  createdAt: string;
  id: string;
}

export function encodeMessageCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

export function decodeMessageCursor(rawCursor: unknown): MessageCursor | null {
  if (typeof rawCursor !== 'string' || !rawCursor.trim()) {
    return null;
  }
  try {
    const decoded = Buffer.from(rawCursor.trim(), 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (
      !parsed ||
      typeof parsed.createdAt !== 'string' ||
      !isValidUuid(parsed.id) ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return null;
    }
    return {
      createdAt: new Date(parsed.createdAt).toISOString(),
      id: parsed.id.trim().toLowerCase()
    };
  } catch {
    return null;
  }
}

export function mapAuthPrincipalToParticipant(
  auth: AuthenticatedPrincipal
): { participantType: ParticipantType; participantId: string } | null {
  if (!auth || !isValidUuid(auth.sub)) {
    return null;
  }
  if (auth.role === 'BUYER') {
    return {
      participantType: 'BUYER',
      participantId: auth.sub.trim().toLowerCase()
    };
  }
  if (auth.role === 'SELLER' && auth.principalType === SELLER_ACCOUNT_PRINCIPAL_TYPE) {
    return {
      participantType: 'SELLER_ACCOUNT',
      participantId: auth.sub.trim().toLowerCase()
    };
  }
  return null;
}

function mapUnexpectedDbFailure(err: unknown): ServiceErrorResult {
  const mapped = classifyHttpError(err, { treatInvalidInputAs400: true });
  if (mapped.status === 503) {
    return {
      ok: false,
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      error: 'Messaging database service is temporarily unavailable.'
    };
  }
  if (mapped.status === 400) {
    return {
      ok: false,
      status: 400,
      code: mapped.code,
      error: mapped.message
    };
  }
  return {
    ok: false,
    status: 500,
    code: 'INTERNAL_ERROR',
    error: 'Internal server error.'
  };
}

/**
 * Verifies an authenticated JWT principal against authoritative PostgreSQL tables
 * during Socket.IO handshake so deleted Buyers or suspended Seller Accounts fail closed.
 */
export async function verifySocketPrincipalInDb(params: {
  customerPool: Pick<StrictPgPool, 'query'>;
  merchantPool: Pick<StrictPgPool, 'query'>;
  auth: AuthenticatedPrincipal;
}): Promise<VerifySocketPrincipalResult> {
  if (!isValidUuid(params.auth.sub)) {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_SUBJECT',
      error: 'Authentication token subject must be a valid UUID.'
    };
  }

  const normalizedSub = params.auth.sub.trim().toLowerCase();

  try {
    if (params.auth.role === 'BUYER') {
      const userRes = await params.customerPool.query(
        'SELECT id FROM users WHERE id = $1 LIMIT 1',
        [normalizedSub]
      );
      if (userRes.rows.length === 0) {
        return {
          ok: false,
          status: 401,
          code: 'USER_NOT_FOUND',
          error: 'Authenticated buyer account not found.'
        };
      }
      return {
        ok: true,
        principal: Object.freeze({
          participantType: 'BUYER',
          participantId: String(userRes.rows[0].id).toLowerCase()
        })
      };
    }

    if (params.auth.principalType !== SELLER_ACCOUNT_PRINCIPAL_TYPE) {
      return {
        ok: false,
        status: 401,
        code: 'LEGACY_SELLER_TOKEN_UNSUPPORTED',
        error: 'Legacy or invalid seller token. Please sign in again.'
      };
    }

    const acctRes = await params.merchantPool.query(
      'SELECT id, status FROM seller_accounts WHERE id = $1 LIMIT 1',
      [normalizedSub]
    );
    if (acctRes.rows.length === 0) {
      return {
        ok: false,
        status: 401,
        code: 'SELLER_ACCOUNT_NOT_FOUND',
        error: 'Authenticated seller account not found.'
      };
    }
    if (acctRes.rows[0].status !== 'ACTIVE') {
      return {
        ok: false,
        status: 403,
        code: 'SELLER_ACCOUNT_INACTIVE',
        error: 'Seller account is not active.'
      };
    }

    return {
      ok: true,
      principal: Object.freeze({
        participantType: 'SELLER_ACCOUNT',
        participantId: String(acctRes.rows[0].id).toLowerCase()
      })
    };
  } catch (err: unknown) {
    return mapUnexpectedDbFailure(err);
  }
}

async function ensureBuyerParticipantInTx(
  client: StrictPgClient,
  conversationId: string,
  buyerUserId: string
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_participants (
       conversation_id, participant_type, participant_id, can_read, can_send
     )
     VALUES ($1, 'BUYER', $2, true, true)
     ON CONFLICT (conversation_id, participant_type, participant_id) DO NOTHING`,
    [conversationId, buyerUserId]
  );
}

/**
 * Buyer-only conversation initialization/reuse.
 * Enforces one OPEN conversation per (buyer_user_id, merchant_id) pair, handles concurrent
 * creation via partial unique index + SAVEPOINT retry, and creates the BUYER participant
 * inside the same Customer DB transaction.
 */
export async function createOrGetBuyerConversation(params: {
  customerPool: Pick<StrictPgPool, 'query' | 'connect'>;
  merchantPool: Pick<StrictPgPool, 'query'>;
  buyerUserId: string;
  merchantId: unknown;
}): Promise<CreateOrGetConversationResult> {
  if (!isValidUuid(params.buyerUserId)) {
    return {
      ok: false,
      status: 401,
      code: 'BUYER_AUTH_REQUIRED',
      error: 'Valid buyer authentication is required.'
    };
  }

  if (!isValidUuid(params.merchantId)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_MERCHANT_ID',
      error: 'Invalid merchantId format. Expected a valid UUID.'
    };
  }

  const buyerId = params.buyerUserId.trim().toLowerCase();
  const merchantId = params.merchantId.trim().toLowerCase();

  try {
    const storeRes = await params.merchantPool.query(
      `SELECT id, business_name, category, is_open
       FROM merchants
       WHERE id = $1
       LIMIT 1`,
      [merchantId]
    );

    if (storeRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        code: 'MERCHANT_NOT_FOUND',
        error: 'Merchant store not found.'
      };
    }

    const storeRow = storeRes.rows[0];
    const store: ConversationStoreSummary = {
      id: String(storeRow.id),
      businessName: String(storeRow.business_name || ''),
      category: String(storeRow.category || ''),
      isOpen: Boolean(storeRow.is_open)
    };

    const buyerRes = await params.customerPool.query(
      'SELECT id FROM users WHERE id = $1 LIMIT 1',
      [buyerId]
    );
    if (buyerRes.rows.length === 0) {
      return {
        ok: false,
        status: 401,
        code: 'BUYER_NOT_FOUND',
        error: 'Authenticated buyer account not found.'
      };
    }

    const txOutcome = await withPgTransaction(params.customerPool, async (client) => {
      const existingRes = await client.query(
        `SELECT id, buyer_user_id, merchant_id, status, created_at, updated_at
         FROM conversations
         WHERE buyer_user_id = $1
           AND merchant_id = $2
           AND status = 'OPEN'
         LIMIT 1`,
        [buyerId, merchantId]
      );

      if (existingRes.rows.length > 0) {
        const existingConv = mapConversationRow(existingRes.rows[0]);
        await ensureBuyerParticipantInTx(client, existingConv.id, buyerId);
        return { created: false, conversation: existingConv };
      }

      await client.query('SAVEPOINT sp_create_conversation');
      try {
        const insertRes = await client.query(
          `INSERT INTO conversations (buyer_user_id, merchant_id, status)
           VALUES ($1, $2, 'OPEN')
           RETURNING id, buyer_user_id, merchant_id, status, created_at, updated_at`,
          [buyerId, merchantId]
        );
        await client.query('RELEASE SAVEPOINT sp_create_conversation');

        const createdConv = mapConversationRow(insertRes.rows[0]);
        await ensureBuyerParticipantInTx(client, createdConv.id, buyerId);
        return { created: true, conversation: createdConv };
      } catch (insertErr: any) {
        if (insertErr?.code === '23505') {
          await client.query('ROLLBACK TO SAVEPOINT sp_create_conversation');
          await client.query('RELEASE SAVEPOINT sp_create_conversation');

          const winnerRes = await client.query(
            `SELECT id, buyer_user_id, merchant_id, status, created_at, updated_at
             FROM conversations
             WHERE buyer_user_id = $1
               AND merchant_id = $2
               AND status = 'OPEN'
             LIMIT 1`,
            [buyerId, merchantId]
          );

          if (winnerRes.rows.length === 0) {
            throw insertErr;
          }

          const winnerConv = mapConversationRow(winnerRes.rows[0]);
          await ensureBuyerParticipantInTx(client, winnerConv.id, buyerId);
          return { created: false, conversation: winnerConv };
        }
        throw insertErr;
      }
    });

    return {
      ok: true,
      created: txOutcome.created,
      conversation: {
        ...txOutcome.conversation,
        store
      }
    };
  } catch (err: unknown) {
    return mapUnexpectedDbFailure(err);
  }
}

/**
 * Lists conversations visible to the authenticated Buyer or Seller Account.
 * Sellers see ONLY conversations belonging to stores where they have an ACTIVE store membership.
 */
export async function listConversationsForPrincipal(params: {
  customerPool: Pick<StrictPgPool, 'query'>;
  merchantPool: Pick<StrictPgPool, 'query'>;
  participantType: ParticipantType;
  participantId: string;
}): Promise<ListConversationsResult> {
  if (!isValidUuid(params.participantId)) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_REQUIRED',
      error: 'Valid authentication is required.'
    };
  }

  const normalizedId = params.participantId.trim().toLowerCase();

  try {
    if (params.participantType === 'BUYER') {
      const convRes = await params.customerPool.query(
        `SELECT
           c.id,
           c.buyer_user_id,
           c.merchant_id,
           c.status,
           c.created_at,
           c.updated_at,
           lm.id AS last_message_id,
           lm.sender_type AS last_sender_type,
           lm.sender_id AS last_sender_id,
           lm.body AS last_body,
           lm.created_at AS last_created_at
         FROM conversations c
         INNER JOIN conversation_participants cp
           ON cp.conversation_id = c.id
          AND cp.participant_type = 'BUYER'
          AND cp.participant_id = $1
          AND cp.can_read = true
         LEFT JOIN LATERAL (
           SELECT id, sender_type, sender_id, body, created_at
           FROM messages m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT 1
         ) lm ON true
         WHERE c.buyer_user_id = $1
         ORDER BY c.updated_at DESC, c.id DESC`,
        [normalizedId]
      );

      const merchantIds = Array.from(
        new Set(convRes.rows.map((r: any) => String(r.merchant_id).toLowerCase()))
      );
      const storeMap = new Map<string, ConversationStoreSummary>();

      if (merchantIds.length > 0) {
        const storesRes = await params.merchantPool.query(
          `SELECT id, business_name, category, is_open
           FROM merchants
           WHERE id = ANY($1::uuid[])`,
          [merchantIds]
        );
        for (const row of storesRes.rows) {
          storeMap.set(String(row.id).toLowerCase(), {
            id: String(row.id),
            businessName: String(row.business_name || ''),
            category: String(row.category || ''),
            isOpen: Boolean(row.is_open)
          });
        }
      }

      const conversations: ConversationRecord[] = convRes.rows.map((row: any) => {
        const base = mapConversationRow(row);
        return {
          ...base,
          store: storeMap.get(base.merchantId.toLowerCase()),
          lastMessage: row.last_message_id
            ? {
                id: String(row.last_message_id),
                senderType: row.last_sender_type === 'SELLER_ACCOUNT' ? 'SELLER_ACCOUNT' : 'BUYER',
                senderId: String(row.last_sender_id),
                body: String(row.last_body),
                createdAt: toIsoString(row.last_created_at)
              }
            : null
        };
      });

      return { ok: true, conversations };
    }

    // SELLER_ACCOUNT: authorize exclusively via active Merchant DB store_memberships
    const sellerProfile = await listSellerAccountWithMemberships(params.merchantPool, normalizedId);
    if (!sellerProfile.ok) {
      return {
        ok: false,
        status: sellerProfile.status,
        code: sellerProfile.code,
        error: sellerProfile.error
      };
    }

    if (sellerProfile.memberships.length === 0) {
      return { ok: true, conversations: [] };
    }

    const membershipByStore = new Map(
      sellerProfile.memberships.map((m) => [m.storeId.toLowerCase(), m])
    );
    const allowedStoreIds = Array.from(membershipByStore.keys());

    const convRes = await params.customerPool.query(
      `SELECT
         c.id,
         c.buyer_user_id,
         c.merchant_id,
         c.status,
         c.created_at,
         c.updated_at,
         lm.id AS last_message_id,
         lm.sender_type AS last_sender_type,
         lm.sender_id AS last_sender_id,
         lm.body AS last_body,
         lm.created_at AS last_created_at
       FROM conversations c
       LEFT JOIN conversation_participants cp
         ON cp.conversation_id = c.id
        AND cp.participant_type = 'SELLER_ACCOUNT'
        AND cp.participant_id = $2
       LEFT JOIN LATERAL (
         SELECT id, sender_type, sender_id, body, created_at
         FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 1
       ) lm ON true
       WHERE c.merchant_id = ANY($1::uuid[])
         AND (cp.can_read IS NULL OR cp.can_read = true)
       ORDER BY c.updated_at DESC, c.id DESC`,
      [allowedStoreIds, normalizedId]
    );

    const conversations: ConversationRecord[] = [];
    for (const row of convRes.rows) {
      const base = mapConversationRow(row);
      const membership = membershipByStore.get(base.merchantId.toLowerCase());
      if (!membership) {
        continue;
      }
      conversations.push({
        ...base,
        store: {
          id: membership.store.id,
          businessName: membership.store.businessName,
          category: membership.store.category,
          isOpen: membership.store.isOpen
        },
        membership: {
          membershipId: membership.membershipId,
          role: membership.role,
          permissions: membership.permissions
        },
        lastMessage: row.last_message_id
          ? {
              id: String(row.last_message_id),
              senderType: row.last_sender_type === 'SELLER_ACCOUNT' ? 'SELLER_ACCOUNT' : 'BUYER',
              senderId: String(row.last_sender_id),
              body: String(row.last_body),
              createdAt: toIsoString(row.last_created_at)
            }
          : null
      });
    }

    return { ok: true, conversations };
  } catch (err: unknown) {
    return mapUnexpectedDbFailure(err);
  }
}

const NOT_FOUND_OR_FORBIDDEN: ServiceErrorResult = {
  ok: false,
  status: 404,
  code: 'CONVERSATION_NOT_FOUND_OR_FORBIDDEN',
  error: 'Conversation not found or access denied.'
};

/**
 * Authoritatively checks Customer DB conversation + participant state and (for Sellers)
 * re-verifies active Seller Account and active Store Membership against Merchant PostgreSQL.
 * Returns identical 404/FORBIDDEN for non-existent and unauthorized conversation IDs to prevent enumeration.
 */
export async function authorizeConversationAccess(params: {
  customerPool: Pick<StrictPgPool, 'query'>;
  merchantPool: Pick<StrictPgPool, 'query'>;
  conversationId: unknown;
  participantType: ParticipantType;
  participantId: string;
  action: 'READ' | 'SEND';
  ensureParticipantOnAccess?: boolean;
}): Promise<AuthorizeConversationAccessResult> {
  if (!isValidUuid(params.conversationId)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_CONVERSATION_ID',
      error: 'Invalid conversationId format. Expected a valid UUID.'
    };
  }

  if (!isValidUuid(params.participantId)) {
    return {
      ok: false,
      status: 401,
      code: 'AUTH_REQUIRED',
      error: 'Valid authentication is required.'
    };
  }

  const conversationId = params.conversationId.trim().toLowerCase();
  const participantId = params.participantId.trim().toLowerCase();

  try {
    const convRes = await params.customerPool.query(
      `SELECT id, buyer_user_id, merchant_id, status, created_at, updated_at
       FROM conversations
       WHERE id = $1
       LIMIT 1`,
      [conversationId]
    );

    if (convRes.rows.length === 0) {
      return NOT_FOUND_OR_FORBIDDEN;
    }

    const conversation = mapConversationRow(convRes.rows[0]);
    const roomName = getConversationRoomName(conversation.id);

    if (params.participantType === 'BUYER') {
      if (conversation.buyerUserId.toLowerCase() !== participantId) {
        return NOT_FOUND_OR_FORBIDDEN;
      }

      const partRes = await params.customerPool.query(
        `SELECT can_read, can_send
         FROM conversation_participants
         WHERE conversation_id = $1
           AND participant_type = 'BUYER'
           AND participant_id = $2
         LIMIT 1`,
        [conversation.id, participantId]
      );

      if (partRes.rows.length === 0) {
        return NOT_FOUND_OR_FORBIDDEN;
      }

      const canRead = Boolean(partRes.rows[0].can_read);
      const canSend = Boolean(partRes.rows[0].can_send);

      if (!canRead) {
        return NOT_FOUND_OR_FORBIDDEN;
      }

      if (params.action === 'SEND') {
        if (!canSend) {
          return {
            ok: false,
            status: 403,
            code: 'SEND_FORBIDDEN',
            error: 'Sending messages is disabled for this participant.'
          };
        }
        if (conversation.status !== 'OPEN') {
          return {
            ok: false,
            status: 409,
            code: 'CONVERSATION_CLOSED',
            error: 'Cannot send messages to a closed conversation.'
          };
        }
      }

      return {
        ok: true,
        conversation,
        roomName,
        canRead,
        canSend
      };
    }

    // SELLER_ACCOUNT: verify live Seller Account & ACTIVE Store Membership in Merchant PostgreSQL
    const accessCheck = await verifySellerStorePermission({
      merchantPool: params.merchantPool,
      sellerAccountId: participantId,
      storeId: conversation.merchantId,
      allowedRoles: ['OWNER', 'STAFF']
    });

    if (!accessCheck.ok) {
      return NOT_FOUND_OR_FORBIDDEN;
    }

    let partRes = await params.customerPool.query(
      `SELECT can_read, can_send
       FROM conversation_participants
       WHERE conversation_id = $1
         AND participant_type = 'SELLER_ACCOUNT'
         AND participant_id = $2
       LIMIT 1`,
      [conversation.id, participantId]
    );

    if (partRes.rows.length === 0 && params.ensureParticipantOnAccess) {
      await params.customerPool.query(
        `INSERT INTO conversation_participants (
           conversation_id, participant_type, participant_id, can_read, can_send
         )
         VALUES ($1, 'SELLER_ACCOUNT', $2, true, true)
         ON CONFLICT (conversation_id, participant_type, participant_id) DO NOTHING`,
        [conversation.id, participantId]
      );
      partRes = await params.customerPool.query(
        `SELECT can_read, can_send
         FROM conversation_participants
         WHERE conversation_id = $1
           AND participant_type = 'SELLER_ACCOUNT'
           AND participant_id = $2
         LIMIT 1`,
        [conversation.id, participantId]
      );
    }

    const canRead = partRes.rows.length > 0 ? Boolean(partRes.rows[0].can_read) : true;
    const canSend = partRes.rows.length > 0 ? Boolean(partRes.rows[0].can_send) : true;

    if (!canRead) {
      return NOT_FOUND_OR_FORBIDDEN;
    }

    if (params.action === 'SEND') {
      if (!canSend) {
        return {
          ok: false,
          status: 403,
          code: 'SEND_FORBIDDEN',
          error: 'Sending messages is disabled for this participant.'
        };
      }
      if (conversation.status !== 'OPEN') {
        return {
          ok: false,
          status: 409,
          code: 'CONVERSATION_CLOSED',
          error: 'Cannot send messages to a closed conversation.'
        };
      }
    }

    return {
      ok: true,
      conversation,
      roomName,
      canRead,
      canSend,
      storeAccess: accessCheck.access
    };
  } catch (err: unknown) {
    return mapUnexpectedDbFailure(err);
  }
}

/**
 * Fetches cursor-paginated message history in reverse chronological order (`created_at DESC, id DESC`)
 * after authorizing participant & live Store Membership (Sellers). Closed conversations remain readable.
 */
export async function listConversationMessages(params: {
  customerPool: Pick<StrictPgPool, 'query'>;
  merchantPool: Pick<StrictPgPool, 'query'>;
  conversationId: unknown;
  participantType: ParticipantType;
  participantId: string;
  limit?: unknown;
  before?: unknown;
}): Promise<ListMessagesResult> {
  let limit = DEFAULT_MESSAGE_PAGE_SIZE;
  if (params.limit !== undefined && params.limit !== '') {
    const parsedLimit = Number(params.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_MESSAGE_PAGE_SIZE) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_LIMIT',
        error: `limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_SIZE}.`
      };
    }
    limit = parsedLimit;
  }

  let cursor: MessageCursor | null = null;
  if (params.before !== undefined && params.before !== '') {
    cursor = decodeMessageCursor(params.before);
    if (!cursor) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_CURSOR',
        error: 'Invalid pagination cursor.'
      };
    }
  }

  const access = await authorizeConversationAccess({
    customerPool: params.customerPool,
    merchantPool: params.merchantPool,
    conversationId: params.conversationId,
    participantType: params.participantType,
    participantId: params.participantId,
    action: 'READ',
    ensureParticipantOnAccess: true
  });

  if (!access.ok) {
    return access;
  }

  try {
    const rowsRes = await params.customerPool.query(
      `SELECT id, conversation_id, sender_type, sender_id, client_message_id, body, created_at
       FROM messages
       WHERE conversation_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [access.conversation.id, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]
    );

    const hasMore = rowsRes.rows.length > limit;
    const slicedRows = hasMore ? rowsRes.rows.slice(0, limit) : rowsRes.rows;
    const messages = slicedRows.map(mapMessageRow);
    const lastRow = messages.length > 0 ? messages[messages.length - 1] : null;
    const nextCursor =
      hasMore && lastRow ? encodeMessageCursor(lastRow.createdAt, lastRow.id) : null;

    return {
      ok: true,
      conversationId: access.conversation.id,
      messages,
      pageInfo: {
        limit,
        hasMore,
        nextCursor
      }
    };
  } catch (err: unknown) {
    return mapUnexpectedDbFailure(err);
  }
}

/**
 * Validates and persists a message inside `withPgTransaction(customerPool, ...)`, updating
 * `conversations.updated_at` in the same Customer DB transaction and honouring `client_message_id`
 * idempotency. Revalidates live Seller Account and Store Membership from Merchant PostgreSQL first.
 */
export async function sendConversationMessage(params: {
  customerPool: Pick<StrictPgPool, 'query' | 'connect'>;
  merchantPool: Pick<StrictPgPool, 'query'>;
  conversationId: unknown;
  participantType: ParticipantType;
  participantId: string;
  body: unknown;
  clientMessageId?: unknown;
}): Promise<SendMessageResult> {
  if (typeof params.body !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_MESSAGE_BODY',
      error: 'Message text must be a non-empty string.'
    };
  }

  const trimmedBody = params.body.trim();
  if (trimmedBody.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'EMPTY_MESSAGE',
      error: 'Message text cannot be empty.'
    };
  }

  if (trimmedBody.length > MAX_CHAT_MESSAGE_LENGTH) {
    return {
      ok: false,
      status: 400,
      code: 'MESSAGE_TOO_LONG',
      error: `Message text exceeds maximum length of ${MAX_CHAT_MESSAGE_LENGTH} characters.`
    };
  }

  let normalizedClientMessageId: string | null = null;
  if (params.clientMessageId !== undefined && params.clientMessageId !== null && params.clientMessageId !== '') {
    if (!isValidUuid(params.clientMessageId)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_CLIENT_MESSAGE_ID',
        error: 'clientMessageId must be a valid UUID.'
      };
    }
    normalizedClientMessageId = params.clientMessageId.trim().toLowerCase();
  }

  const access = await authorizeConversationAccess({
    customerPool: params.customerPool,
    merchantPool: params.merchantPool,
    conversationId: params.conversationId,
    participantType: params.participantType,
    participantId: params.participantId,
    action: 'SEND',
    ensureParticipantOnAccess: false
  });

  if (!access.ok) {
    return access;
  }

  const normalizedSenderId = params.participantId.trim().toLowerCase();

  try {
    const committed = await withPgTransaction(params.customerPool, async (client) => {
      const convLockRes = await client.query(
        `SELECT id, status
         FROM conversations
         WHERE id = $1
         FOR SHARE`,
        [access.conversation.id]
      );

      if (convLockRes.rows.length === 0) {
        return { error: NOT_FOUND_OR_FORBIDDEN as ServiceErrorResult };
      }
      if (convLockRes.rows[0].status !== 'OPEN') {
        return {
          error: {
            ok: false,
            status: 409,
            code: 'CONVERSATION_CLOSED',
            error: 'Cannot send messages to a closed conversation.'
          } as ServiceErrorResult
        };
      }

      if (params.participantType === 'SELLER_ACCOUNT') {
        await client.query(
          `INSERT INTO conversation_participants (
             conversation_id, participant_type, participant_id, can_read, can_send
           )
           VALUES ($1, 'SELLER_ACCOUNT', $2, true, true)
           ON CONFLICT (conversation_id, participant_type, participant_id) DO NOTHING`,
          [access.conversation.id, normalizedSenderId]
        );
      }

      const partRes = await client.query(
        `SELECT can_read, can_send
         FROM conversation_participants
         WHERE conversation_id = $1
           AND participant_type = $2
           AND participant_id = $3
         LIMIT 1`,
        [access.conversation.id, params.participantType, normalizedSenderId]
      );

      if (partRes.rows.length === 0 || !partRes.rows[0].can_read) {
        return { error: NOT_FOUND_OR_FORBIDDEN as ServiceErrorResult };
      }

      if (!partRes.rows[0].can_send) {
        return {
          error: {
            ok: false,
            status: 403,
            code: 'SEND_FORBIDDEN',
            error: 'Sending messages is disabled for this participant.'
          } as ServiceErrorResult
        };
      }

      if (normalizedClientMessageId) {
        await client.query('SAVEPOINT sp_insert_message_idemp');
        try {
          const insertRes = await client.query(
            `INSERT INTO messages (
               conversation_id, sender_type, sender_id, client_message_id, body
             )
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, conversation_id, sender_type, sender_id, client_message_id, body, created_at`,
            [
              access.conversation.id,
              params.participantType,
              normalizedSenderId,
              normalizedClientMessageId,
              trimmedBody
            ]
          );
          await client.query('RELEASE SAVEPOINT sp_insert_message_idemp');

          const message = mapMessageRow(insertRes.rows[0]);
          await client.query(
            `UPDATE conversations
             SET updated_at = GREATEST(updated_at, $2::timestamptz)
             WHERE id = $1`,
            [access.conversation.id, message.createdAt]
          );
          return { deduplicated: false, message };
        } catch (insertErr: any) {
          if (insertErr?.code === '23505') {
            await client.query('ROLLBACK TO SAVEPOINT sp_insert_message_idemp');
            await client.query('RELEASE SAVEPOINT sp_insert_message_idemp');

            const dupRes = await client.query(
              `SELECT id, conversation_id, sender_type, sender_id, client_message_id, body, created_at
               FROM messages
               WHERE conversation_id = $1
                 AND sender_type = $2
                 AND sender_id = $3
                 AND client_message_id = $4
               LIMIT 1`,
              [
                access.conversation.id,
                params.participantType,
                normalizedSenderId,
                normalizedClientMessageId
              ]
            );
            if (dupRes.rows.length > 0) {
              return { deduplicated: true, message: mapMessageRow(dupRes.rows[0]) };
            }
          }
          throw insertErr;
        }
      }

      const insertRes = await client.query(
        `INSERT INTO messages (
           conversation_id, sender_type, sender_id, client_message_id, body
         )
         VALUES ($1, $2, $3, NULL, $4)
         RETURNING id, conversation_id, sender_type, sender_id, client_message_id, body, created_at`,
        [access.conversation.id, params.participantType, normalizedSenderId, trimmedBody]
      );

      const message = mapMessageRow(insertRes.rows[0]);
      await client.query(
        `UPDATE conversations
         SET updated_at = GREATEST(updated_at, $2::timestamptz)
         WHERE id = $1`,
        [access.conversation.id, message.createdAt]
      );

      return { deduplicated: false, message };
    });

    if ('error' in committed && committed.error) {
      return committed.error;
    }

    return {
      ok: true,
      deduplicated: Boolean(committed.deduplicated),
      roomName: access.roomName,
      message: committed.message
    };
  } catch (err: unknown) {
    return mapUnexpectedDbFailure(err);
  }
}
