// API & WebSocket Configuration

// 1. Dynamic HTTP base URL from environment or fallback to localhost (strips trailing slashes)
export const API_BASE_URL: string = 
  ((import.meta.env.VITE_API_URL as string) || 'http://localhost:5000').trim().replace(/\/+$/, '');

// 2. Automatically derive WebSocket URL (ws:// for http:// and wss:// for https://)
export const WS_BASE_URL: string = API_BASE_URL.replace(/^http/, 'ws') + '/ws';

export interface HealthResponse {
  status: string;
  uptimeSeconds: number;
  timestamp: string;
  database: {
    connected: boolean;
    latencyMs?: number;
    error?: string;
  };
  websocketPath: string;
}

export interface DbTestResponse {
  success: boolean;
  data?: {
    database: string;
    version: string;
    server_time: string;
  };
  error?: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const url = `${API_BASE_URL}/api/health`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
  } catch (err: any) {
    console.error(`[API Error] Failed fetching ${url}:`, err);
    throw err;
  }
}

export async function testDatabaseQuery(): Promise<DbTestResponse> {
  const url = `${API_BASE_URL}/api/db/test`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
  } catch (err: any) {
    console.error(`[DB Query Error] Failed query ${url}:`, err);
    throw err;
  }
}
