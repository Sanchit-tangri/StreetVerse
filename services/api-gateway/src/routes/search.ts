import { Router, Request, Response } from 'express';
import axios from 'axios';
import { StrictPgPool } from '../db/postgres';
import { classifyHttpError, sanitizeErrorForLog } from '../utils/infraErrors';

export type AiSearchFetcher = (
  url: string,
  payload: {
    query: string;
    latitude: number;
    longitude: number;
    max_radius_km: number;
    limit: number;
  }
) => Promise<any>;

export function createSearchRouter(
  merchantPool?: StrictPgPool,
  aiEngineUrl?: string,
  aiSearchFetcher?: AiSearchFetcher
): Router {
  const router = Router();

  // The AI Engine runs on port 8000 by default
  const AI_ENGINE_URL = aiEngineUrl || process.env.AI_ENGINE_URL || 'http://localhost:8000';

  const handleSearch = async (
    query: string,
    latitude: number,
    longitude: number,
    max_radius_km: number,
    limit: number,
    res: Response
  ) => {
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Missing search query parameter' });
    }

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({ error: 'Invalid latitude or longitude parameter' });
    }

    if (!Number.isFinite(max_radius_km) || max_radius_km <= 0) {
      return res.status(400).json({ error: 'Invalid search radius parameter' });
    }

    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 12;

    if (!merchantPool) {
      return res.status(503).json({
        error: 'Merchant database service is temporarily unavailable.',
        code: 'POSTGRES_UNAVAILABLE'
      });
    }

    // 1. First attempt to call the AI Agent Engine (Python FastAPI)
    try {
      const payload = {
        query,
        latitude,
        longitude,
        max_radius_km,
        limit: safeLimit
      };
      const aiData = aiSearchFetcher
        ? await aiSearchFetcher(`${AI_ENGINE_URL}/api/v1/search/hyperlocal`, payload)
        : (
            await axios.post(`${AI_ENGINE_URL}/api/v1/search/hyperlocal`, payload, {
              timeout: 3500
            })
          ).data;

      if (aiData && Array.isArray(aiData.results) && aiData.results.length > 0) {
        return res.status(200).json(aiData);
      }
    } catch (err: unknown) {
      console.warn(
        `[Search Gateway] AI Engine unavailable (${sanitizeErrorForLog(err)}). Falling back to PostgreSQL search...`
      );
    }

    // 2. Query Merchant PostgreSQL DB directly with PostGIS earthdistance (only real stored records)
    try {
      const pattern = `%${query.trim()}%`;
      const dbRes = await merchantPool.query(
        `SELECT
            i.id AS item_id,
            i.item_name,
            i.category,
            i.price::float,
            i.stock_quantity,
            i.is_available,
            m.id AS merchant_id,
            m.business_name,
            round(earth_distance(ll_to_earth(m.latitude::float8, m.longitude::float8), ll_to_earth($1, $2))::numeric, 1)::float AS distance_meters,
            0.95 AS relevance_score
         FROM inventory_items i
         JOIN merchants m ON i.merchant_id = m.id
         WHERE m.is_open = true
           AND (i.item_name ILIKE $3 OR i.category ILIKE $3 OR m.business_name ILIKE $3)

         UNION ALL

         SELECT
            s.id AS item_id,
            s.service_name AS item_name,
            'SALON & SPA' AS category,
            s.price::float,
            1 AS stock_quantity,
            (s.status = 'AVAILABLE') AS is_available,
            m.id AS merchant_id,
            m.business_name,
            round(earth_distance(ll_to_earth(m.latitude::float8, m.longitude::float8), ll_to_earth($1, $2))::numeric, 1)::float AS distance_meters,
            0.95 AS relevance_score
         FROM service_slots s
         JOIN merchants m ON s.merchant_id = m.id
         WHERE m.is_open = true
           AND s.status = 'AVAILABLE'
           AND (s.service_name ILIKE $3 OR m.business_name ILIKE $3 OR m.category ILIKE $3)

         ORDER BY relevance_score DESC, distance_meters ASC
         LIMIT $4;`,
        [Number(latitude), Number(longitude), pattern, safeLimit]
      );

      const results = (dbRes.rows || []).map((r: any) => ({
        item_id: String(r.item_id),
        item_name: r.item_name,
        category: r.category,
        price: Number(r.price),
        stock_quantity: Number(r.stock_quantity),
        is_available: Boolean(r.is_available),
        merchant_id: String(r.merchant_id),
        business_name: r.business_name,
        distance_meters: r.distance_meters !== undefined && r.distance_meters !== null ? Number(r.distance_meters) : 0,
        relevance_score: Number(r.relevance_score ?? 0.95)
      }));

      return res.status(200).json({
        query,
        radius_km: max_radius_km,
        total_found: results.length,
        results
      });
    } catch (dbErr: unknown) {
      const mapped = classifyHttpError(dbErr);
      if (mapped.status === 503 || mapped.status === 400) {
        return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      }
      console.error(`[Search Gateway] Unexpected DB search error: ${sanitizeErrorForLog(dbErr)}`);
      return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
    }
  };

  /**
   * POST /api/v1/search/hyperlocal
   */
  router.post('/hyperlocal', async (req: Request, res: Response) => {
    const { query = '', latitude = 18.5074, longitude = 73.8077, max_radius_km = 10.0, limit = 12 } = req.body || {};
    await handleSearch(String(query), Number(latitude), Number(longitude), Number(max_radius_km), Number(limit), res);
  });

  /**
   * GET /api/v1/search/hyperlocal
   * Supports query parameters: ?q=...&lat=...&lon=...&radius=...
   */
  router.get('/hyperlocal', async (req: Request, res: Response) => {
    const query = (req.query.q || req.query.query || '').toString();
    const latitude = parseFloat((req.query.lat || req.query.latitude || '18.5074').toString());
    const longitude = parseFloat((req.query.lon || req.query.lng || req.query.longitude || '73.8077').toString());
    const max_radius_km = parseFloat((req.query.radius || req.query.max_radius_km || '10').toString());
    const limit = parseInt((req.query.limit || '12').toString(), 10);
    await handleSearch(query, latitude, longitude, max_radius_km, limit, res);
  });

  /**
   * GET /api/v1/search/live-catalog
   * Returns all active products & vendors directly from PostgreSQL
   */
  router.get('/live-catalog', async (_req: Request, res: Response) => {
    try {
      if (!merchantPool) {
        return res.status(503).json({
          error: 'Merchant database service is temporarily unavailable.',
          code: 'POSTGRES_UNAVAILABLE'
        });
      }

      const qRes = await merchantPool.query(`
        SELECT 
          i.id,
          i.item_name,
          i.category,
          i.description,
          i.price::float,
          i.stock_quantity,
          m.id AS merchant_id,
          m.business_name,
          m.category AS merchant_category,
          m.address,
          m.rating::float
        FROM inventory_items i
        JOIN merchants m ON i.merchant_id = m.id
        WHERE m.is_open = true AND i.is_available = true
        ORDER BY i.created_at DESC
        LIMIT 20;
      `);

      return res.status(200).json({
        success: true,
        count: qRes.rows.length,
        items: qRes.rows
      });
    } catch (err: unknown) {
      const mapped = classifyHttpError(err);
      if (mapped.status === 503 || mapped.status === 400) {
        return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      }
      console.error(`[Search Gateway] Unexpected live-catalog error: ${sanitizeErrorForLog(err)}`);
      return res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
