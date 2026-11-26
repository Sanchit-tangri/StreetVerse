import { CorsOptions } from 'cors';
import { NextFunction, Request, Response } from 'express';

export class CorsOriginError extends Error {
  public readonly statusCode = 403;

  constructor(message = 'Origin not allowed by CORS policy.') {
    super(message);
    this.name = 'CorsOriginError';
  }
}

/**
 * Checks whether an incoming request Origin matches the validated allowlist.
 * Non-browser requests without an Origin header are permitted by CORS (not treated as auth).
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

/**
 * Builds shared CORS configuration used consistently by Express and Socket.IO.
 */
export function createCorsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin, allowedOrigins)) {
        return callback(null, true);
      }
      return callback(new CorsOriginError(), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
  };
}

/**
 * Maps rejected CORS origins to a predictable 403 JSON response without leaking stack traces.
 */
export function corsErrorHandler(err: any, _req: Request, res: Response, next: NextFunction) {
  if (err instanceof CorsOriginError || err?.name === 'CorsOriginError') {
    return res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
  }
  return next(err);
}
