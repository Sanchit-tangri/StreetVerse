import { Router, Request, Response } from 'express';
import axios from 'axios';

export function createSearchRouter(): Router {
  const router = Router();
  
  // The AI Engine runs on port 8000 by default
  const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://localhost:8000';

  /**
   * Proxy hyperlocal search query to Python RAG Engine
   */
  router.post('/hyperlocal', async (req: Request, res: Response) => {
    try {
      const { query, latitude, longitude, max_radius_km, limit } = req.body;

      if (!query || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Missing query, latitude, or longitude' });
      }

      // Forward to AI Agent Engine
      const response = await axios.post(`${AI_ENGINE_URL}/api/v1/search/hyperlocal`, {
        query,
        latitude,
        longitude,
        max_radius_km: max_radius_km || 3.0,
        limit: limit || 10
      });

      return res.status(200).json(response.data);
    } catch (err: any) {
      console.error('[Search Gateway] Error proxying to AI Engine:', err.message);
      return res.status(500).json({ error: 'AI Search Engine is currently unavailable.' });
    }
  });

  return router;
}
