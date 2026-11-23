import React, { useState, useEffect } from 'react';
import { 
  Server, 
  Database, 
  Radio, 
  Activity, 
  Globe, 
  RefreshCw, 
  Terminal, 
  Send,
  CheckCircle2, 
  XCircle,
  Clock
} from 'lucide-react';
import { fetchHealth, testDatabaseQuery, API_BASE_URL, WS_BASE_URL, HealthResponse } from './services/api';
import { wsClient, WebSocketStatus, WebSocketMessage } from './services/websocket';

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState<boolean>(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [dbTestData, setDbTestData] = useState<any>(null);
  const [dbLoading, setDbLoading] = useState<boolean>(false);

  const [wsStatus, setWsStatus] = useState<WebSocketStatus>('CONNECTING');
  const [logs, setLogs] = useState<{ id: string; time: string; type: string; message: string }[]>([]);

  // Load health check
  const loadHealth = async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const data = await fetchHealth();
      setHealth(data);
    } catch (err: any) {
      setHealthError(err.message || 'Failed to connect to backend');
      setHealth(null);
    } finally {
      setHealthLoading(false);
    }
  };

  // Run database test query
  const runDbTest = async () => {
    setDbLoading(true);
    try {
      const res = await testDatabaseQuery();
      setDbTestData(res.data);
    } catch (err: any) {
      setDbTestData({ error: err.message });
    } finally {
      setDbLoading(false);
    }
  };

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  // Connect WebSocket and listen
  useEffect(() => {
    wsClient.connect();

    const unsubscribeStatus = wsClient.onStatusChange((status) => {
      setWsStatus(status);
    });

    const unsubscribeMsg = wsClient.onMessage((msg: WebSocketMessage) => {
      setLogs((prev) => [
        {
          id: Math.random().toString(36).substring(2, 9),
          time: new Date().toLocaleTimeString(),
          type: msg.type,
          message: JSON.stringify(msg)
        },
        ...prev.slice(0, 49) // Keep last 50 logs
      ]);
    });

    return () => {
      unsubscribeStatus();
      unsubscribeMsg();
      wsClient.disconnect();
    };
  }, []);

  const sendWsPing = () => {
    wsClient.send({ type: 'PING', clientTime: Date.now() });
  };

  return (
    <div className="app-container">
      {/* Navigation Header */}
      <nav className="navbar">
        <div className="brand">
          <div className="brand-icon">
            <Activity size={22} color="#ffffff" />
          </div>
          <div>
            <h1 className="brand-title">StreetVerse</h1>
            <p className="tagline">Cloud Frontend & Local Hybrid Infrastructure</p>
          </div>
        </div>

        <div className="env-badge">
          <Globe size={15} color="#3b82f6" />
          <span>Host: {window.location.hostname}</span>
        </div>
      </nav>

      {/* Main Grid Cards */}
      <div className="status-grid">
        {/* Card 1: Backend REST Service */}
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-icon">
                <Server size={20} color="#3b82f6" />
              </div>
              <h2 className="card-title">Backend API</h2>
            </div>
            {healthLoading ? (
              <span className="pill warning"><span className="pill-dot"></span>Checking...</span>
            ) : health ? (
              <span className="pill success"><CheckCircle2 size={12} /> Online</span>
            ) : (
              <span className="pill danger"><XCircle size={12} /> Offline</span>
            )}
          </div>

          <div className="card-details">
            <div className="detail-row">
              <span>Endpoint:</span>
              <a 
                href={`${API_BASE_URL}/api/health`} 
                target="_blank" 
                rel="noreferrer" 
                className="detail-val" 
                style={{ color: '#38bdf8', textDecoration: 'underline' }}
                title="Click to open backend health endpoint in new tab"
              >
                {API_BASE_URL.replace(/^https?:\/\//, '').slice(0, 22)}... ↗
              </a>
            </div>
            <div className="detail-row">
              <span>Uptime:</span>
              <span className="detail-val">{health ? `${health.uptimeSeconds}s` : '—'}</span>
            </div>
            <div className="detail-row">
              <span>Status Msg:</span>
              <span className="detail-val">{healthError ? healthError : health?.status || '—'}</span>
            </div>
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <button className="btn btn-secondary" onClick={loadHealth} disabled={healthLoading}>
              <RefreshCw size={14} className={healthLoading ? 'spin' : ''} /> Refresh Status
            </button>
            {healthError && (
              <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#f87171', lineHeight: '1.4' }}>
                Tip: Click the endpoint link above to check if Chrome blocks the tunnel tab.
              </div>
            )}
          </div>
        </div>

        {/* Card 2: PostgreSQL Database */}
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-icon">
                <Database size={20} color="#10b981" />
              </div>
              <h2 className="card-title">PostgreSQL Database</h2>
            </div>
            {health?.database.connected ? (
              <span className="pill success"><CheckCircle2 size={12} /> Connected</span>
            ) : (
              <span className="pill danger"><XCircle size={12} /> Disconnected</span>
            )}
          </div>

          <div className="card-details">
            <div className="detail-row">
              <span>Host / Engine:</span>
              <span className="detail-val">localhost:5433 (PG 16)</span>
            </div>
            <div className="detail-row">
              <span>Latency:</span>
              <span className="detail-val">
                {health?.database.latencyMs !== undefined ? `${health.database.latencyMs}ms` : '—'}
              </span>
            </div>
            <div className="detail-row">
              <span>DB Error:</span>
              <span className="detail-val" style={{ color: health?.database.error ? '#f43f5e' : '#9ca3af' }}>
                {health?.database.error || 'None'}
              </span>
            </div>
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <button className="btn btn-secondary" onClick={runDbTest} disabled={dbLoading || !health?.database.connected}>
              <Database size={14} /> {dbLoading ? 'Querying...' : 'Test DB Query'}
            </button>
            {dbTestData && (
              <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#a7f3d0' }}>
                ✓ Database: {dbTestData.database} ({dbTestData.server_time})
              </div>
            )}
          </div>
        </div>

        {/* Card 3: Realtime WebSockets */}
        <div className="card">
          <div className="card-header">
            <div className="card-title-group">
              <div className="card-icon">
                <Radio size={20} color="#06b6d4" />
              </div>
              <h2 className="card-title">WebSocket Stream</h2>
            </div>
            {wsStatus === 'CONNECTED' ? (
              <span className="pill success"><span className="pill-dot"></span>Live Stream</span>
            ) : wsStatus === 'CONNECTING' ? (
              <span className="pill warning"><span className="pill-dot"></span>Connecting</span>
            ) : (
              <span className="pill danger"><XCircle size={12} /> {wsStatus}</span>
            )}
          </div>

          <div className="card-details">
            <div className="detail-row">
              <span>WS URL:</span>
              <span className="detail-val" title={WS_BASE_URL}>
                {WS_BASE_URL.length > 28 ? WS_BASE_URL.slice(0, 25) + '...' : WS_BASE_URL}
              </span>
            </div>
            <div className="detail-row">
              <span>Protocol:</span>
              <span className="detail-val">{WS_BASE_URL.startsWith('wss:') ? 'Secure WSS' : 'WS'}</span>
            </div>
            <div className="detail-row">
              <span>Packets Received:</span>
              <span className="detail-val">{logs.length}</span>
            </div>
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <button className="btn" onClick={sendWsPing} disabled={wsStatus !== 'CONNECTED'}>
              <Send size={14} /> Send Ping Packet
            </button>
          </div>
        </div>
      </div>

      {/* Terminal Stream View */}
      <section className="terminal-section">
        <div className="terminal-header">
          <div className="terminal-title">
            <Terminal size={18} color="#06b6d4" />
            <span>Realtime WebSocket Stream Output</span>
          </div>
          <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>Auto-updating (2s tick)</span>
        </div>

        <div className="terminal-window">
          {logs.length === 0 ? (
            <div style={{ color: '#6b7280', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Clock size={14} /> Waiting for WebSocket incoming packets...
            </div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="log-entry">
                <span className="log-time">[{log.time}]</span>
                <span className="log-type">{log.type}</span>
                <span className="log-body">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
