import express, { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { checkDatabaseConnection, pool } from './db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Permissive CORS for Localhost & all Vercel Preview/Production deployments
app.use((req: Request, res: Response, next) => {
  const origin = req.headers.origin;
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, ngrok-skip-browser-warning, Accept');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Base Route
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'StreetVerse Backend API',
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/api/health',
      dbTest: '/api/db/test',
      websocket: '/ws'
    }
  });
});

// Health check endpoint (Returns DB status, system uptime, and server time)
app.get('/api/health', async (_req: Request, res: Response) => {
  const dbStatus = await checkDatabaseConnection();
  res.json({
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    database: dbStatus,
    websocketPath: '/ws'
  });
});

// Database test endpoint
app.get('/api/db/test', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT current_database() as database, version() as version, NOW() as server_time');
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create HTTP server
const server = http.createServer(app);

// Attach WebSocket Server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${clientIp}`);

  // Send immediate welcome packet
  ws.send(JSON.stringify({
    type: 'WELCOME',
    message: 'Connected to StreetVerse Realtime WebSocket Stream',
    timestamp: new Date().toISOString()
  }));

  // Handle incoming messages
  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      } else {
        ws.send(JSON.stringify({ type: 'ACK', received: data }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'ECHO', data: message.toString() }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

// Broadcast periodic realtime tick (every 2 seconds) to all active clients
const tickerInterval = setInterval(() => {
  if (wss.clients.size > 0) {
    const tick = JSON.stringify({
      type: 'REALTIME_TICK',
      marketStatus: 'OPEN',
      liveIndex: 24500 + Math.round((Math.random() - 0.5) * 40),
      timestamp: new Date().toISOString(),
      activeClients: wss.clients.size
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(tick);
      }
    }
  }
}, 2000);

// Graceful shutdown
process.on('SIGTERM', () => {
  clearInterval(tickerInterval);
  server.close(() => {
    pool.end();
    console.log('Server terminated');
  });
});

server.listen(PORT, () => {
  console.log(`[Server] StreetVerse Backend listening on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket stream live at ws://localhost:${PORT}/ws`);
});
