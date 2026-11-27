import { Router, NextFunction, Response } from 'express';
import { StrictPgPool } from '../db/postgres';
import {
  AuthenticatedRequest,
  JwtAuthConfig,
  requireBuyerJwt,
  SELLER_ACCOUNT_PRINCIPAL_TYPE,
  verifyAccessToken
} from '../middleware/authJwt';
import {
  ChatMessageRecord,
  createOrGetBuyerConversation,
  listConversationMessages,
  listConversationsForPrincipal,
  mapAuthPrincipalToParticipant,
  sendConversationMessage
} from '../services/conversations';

export interface ConversationBroadcaster {
  emitNewMessage: (roomName: string, message: ChatMessageRecord) => { realtimeDelivered: boolean };
}

function requireBuyerOrSellerAccountJwt(jwtConfig: JwtAuthConfig) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authentication token provided.', code: 'AUTH_REQUIRED' });
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided.', code: 'AUTH_REQUIRED' });
    }

    const verification = verifyAccessToken(token, jwtConfig);
    if (!verification.ok) {
      return res.status(verification.status).json({ error: verification.error, code: 'UNAUTHORIZED' });
    }

    const principal = verification.principal;
    if (principal.role === 'SELLER' && principal.principalType !== SELLER_ACCOUNT_PRINCIPAL_TYPE) {
      return res.status(401).json({
        error: 'Legacy or invalid seller session token. Please sign in again.',
        code: 'LEGACY_SELLER_TOKEN_UNSUPPORTED'
      });
    }

    req.auth = principal;
    return next();
  };
}

export function createConversationsRouter(
  customerPool: StrictPgPool,
  merchantPool: StrictPgPool,
  jwtConfig: JwtAuthConfig,
  broadcaster?: ConversationBroadcaster
): Router {
  const router = Router();

  /**
   * Buyer-only conversation creation / active-thread reuse.
   * Derives buyer_user_id strictly from verified Buyer JWT `sub`.
   */
  router.post(
    '/',
    requireBuyerJwt(jwtConfig),
    async (req: AuthenticatedRequest, res: Response) => {
      const buyerUserId = req.auth?.sub;
      if (!buyerUserId) {
        return res.status(401).json({ error: 'Buyer authentication required.', code: 'BUYER_AUTH_REQUIRED' });
      }

      const requestedMerchantId = req.body?.merchantId ?? req.body?.storeId;
      const result = await createOrGetBuyerConversation({
        customerPool,
        merchantPool,
        buyerUserId,
        merchantId: requestedMerchantId
      });

      if (!result.ok) {
        return res.status(result.status).json({
          success: false,
          code: result.code,
          error: result.error
        });
      }

      return res.status(result.created ? 201 : 200).json({
        success: true,
        created: result.created,
        conversation: result.conversation
      });
    }
  );

  /**
   * Lists conversations accessible to the authenticated Buyer or Seller Account.
   */
  router.get(
    '/',
    requireBuyerOrSellerAccountJwt(jwtConfig),
    async (req: AuthenticatedRequest, res: Response) => {
      const participant = req.auth ? mapAuthPrincipalToParticipant(req.auth) : null;
      if (!participant) {
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      }

      const result = await listConversationsForPrincipal({
        customerPool,
        merchantPool,
        participantType: participant.participantType,
        participantId: participant.participantId
      });

      if (!result.ok) {
        return res.status(result.status).json({
          success: false,
          code: result.code,
          error: result.error
        });
      }

      return res.status(200).json({
        success: true,
        conversations: result.conversations
      });
    }
  );

  /**
   * Lists paginated historical messages for an authorized Buyer or active Store Member.
   */
  router.get(
    '/:id/messages',
    requireBuyerOrSellerAccountJwt(jwtConfig),
    async (req: AuthenticatedRequest, res: Response) => {
      const participant = req.auth ? mapAuthPrincipalToParticipant(req.auth) : null;
      if (!participant) {
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      }

      const result = await listConversationMessages({
        customerPool,
        merchantPool,
        conversationId: req.params.id,
        participantType: participant.participantType,
        participantId: participant.participantId,
        limit: req.query.limit,
        before: req.query.before
      });

      if (!result.ok) {
        return res.status(result.status).json({
          success: false,
          code: result.code,
          error: result.error
        });
      }

      return res.status(200).json({
        success: true,
        conversationId: result.conversationId,
        messages: result.messages,
        pageInfo: result.pageInfo
      });
    }
  );

  /**
   * REST message-send fallback. Sender identity comes strictly from verified JWT.
   * Commits inside Customer PostgreSQL before any Socket.IO fan-out occurs.
   */
  router.post(
    '/:id/messages',
    requireBuyerOrSellerAccountJwt(jwtConfig),
    async (req: AuthenticatedRequest, res: Response) => {
      const participant = req.auth ? mapAuthPrincipalToParticipant(req.auth) : null;
      if (!participant) {
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      }

      const bodyText =
        typeof req.body?.text === 'string'
          ? req.body.text
          : typeof req.body?.body === 'string'
            ? req.body.body
            : req.body?.text;

      const result = await sendConversationMessage({
        customerPool,
        merchantPool,
        conversationId: req.params.id,
        participantType: participant.participantType,
        participantId: participant.participantId,
        body: bodyText,
        clientMessageId: req.body?.clientMessageId
      });

      if (!result.ok) {
        return res.status(result.status).json({
          success: false,
          code: result.code,
          error: result.error
        });
      }

      let realtimeDelivered = false;
      if (broadcaster && !result.deduplicated) {
        realtimeDelivered = broadcaster.emitNewMessage(
          result.roomName,
          result.message
        ).realtimeDelivered;
      }

      return res.status(result.deduplicated ? 200 : 201).json({
        success: true,
        persisted: true,
        deduplicated: result.deduplicated,
        realtimeDelivered,
        message: result.message
      });
    }
  );

  return router;
}
