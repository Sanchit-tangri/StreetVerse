import { Server as SocketIOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { GatewayConfig } from '../config/env';
import { StrictPgPool } from '../db/postgres';
import { ManagedRedisClient } from '../db/redis';
import { verifyAccessToken } from '../middleware/authJwt';
import {
  authorizeConversationAccess,
  ChatMessageRecord,
  getConversationRoomName,
  ImmutableSocketPrincipal,
  sendConversationMessage,
  verifySocketPrincipalInDb
} from '../services/conversations';
import { ConversationBroadcaster } from '../routes/conversations';
import { sanitizeErrorForLog } from '../utils/infraErrors';

export interface RealtimeChatHubDeps {
  io: SocketIOServer;
  config: GatewayConfig;
  customerPool: StrictPgPool;
  merchantPool: StrictPgPool;
  redisPubClient?: ManagedRedisClient | null;
  redisSubClient?: ManagedRedisClient | null;
  enableRedisAdapter: boolean;
}

export interface RealtimeChatHub {
  ensurePubSubReady: () => Promise<boolean>;
  isFanoutReady: () => boolean;
  broadcaster: ConversationBroadcaster;
}

type SocketAckCallback = (response: Record<string, unknown>) => void;

function sendAck(callback: unknown, payload: Record<string, unknown>): void {
  if (typeof callback === 'function') {
    try {
      (callback as SocketAckCallback)(payload);
    } catch {
      // Ignore client acknowledgement handler errors safely
    }
  }
}

/**
 * Wraps the dedicated Pub/Sub publisher client's `publish` method so that if Redis disconnects
 * mid-broadcast with `enableOfflineQueue: false`, `@socket.io/redis-adapter`'s internal
 * fire-and-forget `this.pubClient.publish(...)` calls cannot cause an unhandled rejection.
 */
function createSafePublishProxy(pubClient: ManagedRedisClient): ManagedRedisClient {
  return new Proxy(pubClient as unknown as object, {
    get(target, prop, receiver) {
      if (prop === 'publish') {
        return (...args: any[]) => {
          const fn = (target as any).publish;
          if (typeof fn !== 'function') {
            return Promise.resolve(0);
          }
          try {
            return Promise.resolve(fn.apply(target, args)).catch((err: unknown) => {
              const code =
                err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
                  ? (err as { code: string }).code
                  : 'UNKNOWN';
              console.error(
                `[SocketIO:PubSub] Publish failed cleanly (code=${code}): ${sanitizeErrorForLog(err)}`
              );
              return 0;
            });
          } catch (err: unknown) {
            console.error(`[SocketIO:PubSub] Sync publish error: ${sanitizeErrorForLog(err)}`);
            return Promise.resolve(0);
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as unknown as ManagedRedisClient;
}

async function connectManagedClientIfNeeded(client: ManagedRedisClient): Promise<void> {
  if (client.status === 'ready') {
    return;
  }
  if (client.status === 'wait' && typeof client.connect === 'function') {
    await client.connect();
    return;
  }
  if (client.status === 'connecting' || client.status === 'connect' || client.status === 'reconnecting') {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        // ioredis EventEmitter supports removeListener if present; no-op fallback if mocked
        (client as any).removeListener?.('ready', onReady);
        (client as any).removeListener?.('error', onError);
        (client as any).removeListener?.('end', onEnd);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(sanitizeErrorForLog(err)));
      };
      const onEnd = () => {
        cleanup();
        reject(new Error('Pub/Sub client closed before reaching ready state.'));
      };
      client.on('ready', onReady);
      client.on('error', onError);
      client.on('end', onEnd);
    });
  }
}

export function attachSecureChatSocketHandlers(deps: RealtimeChatHubDeps): RealtimeChatHub {
  const { io, config, customerPool, merchantPool, redisPubClient, redisSubClient, enableRedisAdapter } =
    deps;

  let adapterAttached = false;
  let pubSubInitPromise: Promise<boolean> | null = null;

  const tryAttachRedisAdapter = (): boolean => {
    if (!enableRedisAdapter || !redisPubClient || !redisSubClient) {
      return false;
    }
    if (adapterAttached) {
      return true;
    }
    if (redisPubClient.status !== 'ready' || redisSubClient.status !== 'ready') {
      return false;
    }
    try {
      io.adapter(
        createAdapter(createSafePublishProxy(redisPubClient), redisSubClient) as unknown as any
      );
      adapterAttached = true;
      return true;
    } catch (err: unknown) {
      console.error(`[SocketIO:PubSub] Failed to attach Redis adapter: ${sanitizeErrorForLog(err)}`);
      return false;
    }
  };

  if (enableRedisAdapter && redisPubClient && redisSubClient) {
    // Self-heal attachment automatically if Redis comes up later after a degraded gateway boot
    redisPubClient.on('ready', () => {
      tryAttachRedisAdapter();
    });
    redisSubClient.on('ready', () => {
      tryAttachRedisAdapter();
    });
    tryAttachRedisAdapter();
  }

  const ensurePubSubReady = async (): Promise<boolean> => {
    if (!enableRedisAdapter || !redisPubClient || !redisSubClient) {
      return true;
    }
    if (
      adapterAttached &&
      redisPubClient.status === 'ready' &&
      redisSubClient.status === 'ready'
    ) {
      return true;
    }
    if (pubSubInitPromise) {
      return pubSubInitPromise;
    }

    pubSubInitPromise = (async () => {
      try {
        await Promise.all([
          connectManagedClientIfNeeded(redisPubClient),
          connectManagedClientIfNeeded(redisSubClient)
        ]);
        return tryAttachRedisAdapter();
      } catch (err: unknown) {
        console.error(
          `[SocketIO:PubSub] Redis Pub/Sub connection unavailable: ${sanitizeErrorForLog(err)}`
        );
        return false;
      } finally {
        pubSubInitPromise = null;
      }
    })();

    return pubSubInitPromise;
  };

  const isFanoutReady = (): boolean => {
    if (!enableRedisAdapter) {
      return true;
    }
    return Boolean(
      adapterAttached &&
        redisPubClient &&
        redisSubClient &&
        redisPubClient.status === 'ready' &&
        redisSubClient.status === 'ready'
    );
  };

  const emitNewMessage = (
    roomName: string,
    message: ChatMessageRecord
  ): { realtimeDelivered: boolean } => {
    if (!enableRedisAdapter) {
      io.to(roomName).emit('new_message', message);
      return { realtimeDelivered: true };
    }

    if (isFanoutReady()) {
      io.to(roomName).emit('new_message', message);
      return { realtimeDelivered: true };
    }

    console.error(
      `[SocketIO:PubSub] Redis Pub/Sub unavailable; committed message ${message.id} preserved in PostgreSQL without confirmed cross-instance delivery.`
    );
    // Emit only locally to avoid touching disconnected pubClient and mark realtimeDelivered=false
    io.to(roomName).local.emit('new_message', message);
    return { realtimeDelivered: false };
  };

  // =========================================================================
  // 1. STRICT AUTHENTICATED HANDSHAKE (Bearer JWT from handshake.auth.token)
  // =========================================================================
  io.use(async (socket: Socket, next) => {
    try {
      const authPayload = socket.handshake.auth as { token?: unknown } | undefined;
      const queryPayload = socket.handshake.query as { token?: unknown } | undefined;
      const rawToken = typeof authPayload?.token === 'string' ? authPayload.token.trim() : '';

      // Explicitly refuse query-string token transport (?token=...) or missing auth.token
      if (queryPayload?.token !== undefined) {
        return next(
          new Error('UNAUTHORIZED: Authentication tokens must not be sent in query parameters.')
        );
      }

      if (!rawToken) {
        return next(new Error('UNAUTHORIZED: Missing handshake auth token.'));
      }

      const verification = verifyAccessToken(rawToken, config);
      if (!verification.ok) {
        return next(new Error(`UNAUTHORIZED: ${verification.error}`));
      }

      const dbCheck = await verifySocketPrincipalInDb({
        customerPool,
        merchantPool,
        auth: verification.principal
      });

      if (!dbCheck.ok) {
        if (dbCheck.status === 503) {
          return next(new Error(`SERVICE_UNAVAILABLE: ${dbCheck.error}`));
        }
        return next(new Error(`UNAUTHORIZED: ${dbCheck.error}`));
      }

      socket.data.principal = dbCheck.principal;
      return next();
    } catch (err: unknown) {
      console.error(`[SocketIO Auth Error]: ${sanitizeErrorForLog(err)}`);
      return next(new Error('SERVICE_UNAVAILABLE: Authentication service unavailable.'));
    }
  });

  // =========================================================================
  // 2. AUTHORIZED ROOM JOIN & PERSISTENT MESSAGE SEND
  // =========================================================================
  io.on('connection', (socket: Socket) => {
    const principal = socket.data.principal as ImmutableSocketPrincipal | undefined;
    if (!principal) {
      socket.disconnect(true);
      return;
    }

    socket.on('join_conversation', async (payload: unknown, callback?: unknown) => {
      const rawConversationId =
        typeof payload === 'string'
          ? payload
          : payload && typeof payload === 'object'
            ? (payload as { conversationId?: unknown }).conversationId
            : undefined;

      const access = await authorizeConversationAccess({
        customerPool,
        merchantPool,
        conversationId: rawConversationId,
        participantType: principal.participantType,
        participantId: principal.participantId,
        action: 'READ',
        ensureParticipantOnAccess: true
      });

      if (!access.ok) {
        const ackCode =
          access.status === 503
            ? 'SERVICE_UNAVAILABLE'
            : access.code === 'INVALID_CONVERSATION_ID'
              ? 'INVALID_CONVERSATION_ID'
              : 'FORBIDDEN';
        sendAck(callback, {
          success: false,
          code: ackCode,
          error:
            ackCode === 'SERVICE_UNAVAILABLE'
              ? 'Conversation authorization service is temporarily unavailable.'
              : access.error
        });
        return;
      }

      try {
        await socket.join(access.roomName);
        sendAck(callback, {
          success: true,
          conversationId: access.conversation.id,
          room: access.roomName
        });
      } catch (err: unknown) {
        console.error(`[SocketIO Join Error]: ${sanitizeErrorForLog(err)}`);
        sendAck(callback, {
          success: false,
          code: 'INTERNAL_ERROR',
          error: 'Failed to join conversation room.'
        });
      }
    });

    socket.on('send_message', async (payload: unknown, callback?: unknown) => {
      const currentPrincipal = socket.data.principal as ImmutableSocketPrincipal | undefined;
      if (!currentPrincipal) {
        sendAck(callback, {
          success: false,
          code: 'UNAUTHORIZED',
          error: 'Socket authentication required.'
        });
        return;
      }

      const rawConversationId =
        payload && typeof payload === 'object'
          ? (payload as { conversationId?: unknown }).conversationId
          : undefined;

      if (typeof rawConversationId !== 'string' || !rawConversationId.trim()) {
        sendAck(callback, {
          success: false,
          code: 'INVALID_CONVERSATION_ID',
          error: 'Invalid conversationId format.'
        });
        return;
      }

      const expectedRoom = getConversationRoomName(rawConversationId);
      if (!socket.rooms.has(expectedRoom)) {
        sendAck(callback, {
          success: false,
          code: 'ROOM_NOT_JOINED',
          error: 'Join the authorized conversation room before sending messages.'
        });
        return;
      }

      const textBody =
        payload && typeof payload === 'object'
          ? (payload as { text?: unknown; body?: unknown }).text ??
            (payload as { body?: unknown }).body
          : undefined;
      const clientMessageId =
        payload && typeof payload === 'object'
          ? (payload as { clientMessageId?: unknown }).clientMessageId
          : undefined;

      const sendResult = await sendConversationMessage({
        customerPool,
        merchantPool,
        conversationId: rawConversationId,
        participantType: currentPrincipal.participantType,
        participantId: currentPrincipal.participantId,
        body: textBody,
        clientMessageId
      });

      if (!sendResult.ok) {
        const ackCode =
          sendResult.status === 503
            ? 'SERVICE_UNAVAILABLE'
            : sendResult.status === 404
              ? 'FORBIDDEN'
              : sendResult.code;
        sendAck(callback, {
          success: false,
          code: ackCode,
          error: sendResult.error
        });
        return;
      }

      if (sendResult.deduplicated) {
        sendAck(callback, {
          success: true,
          persisted: true,
          deduplicated: true,
          realtimeDelivered: isFanoutReady(),
          message: sendResult.message
        });
        return;
      }

      const { realtimeDelivered } = emitNewMessage(sendResult.roomName, sendResult.message);

      sendAck(callback, {
        success: true,
        persisted: true,
        deduplicated: false,
        realtimeDelivered,
        ...(realtimeDelivered ? {} : { code: 'REALTIME_FANOUT_UNAVAILABLE' }),
        message: sendResult.message
      });
    });

    socket.on('disconnect', () => {
      // Connection cleanup handled cleanly by Socket.IO & adapter
    });
  });

  return {
    ensurePubSubReady,
    isFanoutReady,
    broadcaster: { emitNewMessage }
  };
}
