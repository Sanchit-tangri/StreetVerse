import { WS_BASE_URL } from './api';

export type WebSocketStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export interface WebSocketMessage {
  type: string;
  [key: string]: any;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimeout: any = null;
  private onStatusChangeCallbacks: ((status: WebSocketStatus) => void)[] = [];
  private onMessageCallbacks: ((msg: WebSocketMessage) => void)[] = [];

  constructor(url: string = WS_BASE_URL) {
    this.url = url;
  }

  public connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.notifyStatus('CONNECTING');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.notifyStatus('CONNECTED');
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          this.onMessageCallbacks.forEach(cb => cb(parsed));
        } catch {
          this.onMessageCallbacks.forEach(cb => cb({ type: 'RAW', data: event.data }));
        }
      };

      this.ws.onclose = () => {
        this.notifyStatus('DISCONNECTED');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.notifyStatus('ERROR');
      };
    } catch {
      this.notifyStatus('ERROR');
      this.scheduleReconnect();
    }
  }

  public send(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  public onStatusChange(callback: (status: WebSocketStatus) => void) {
    this.onStatusChangeCallbacks.push(callback);
    return () => {
      this.onStatusChangeCallbacks = this.onStatusChangeCallbacks.filter(cb => cb !== callback);
    };
  }

  public onMessage(callback: (msg: WebSocketMessage) => void) {
    this.onMessageCallbacks.push(callback);
    return () => {
      this.onMessageCallbacks = this.onMessageCallbacks.filter(cb => cb !== callback);
    };
  }

  public disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect() {
    if (!this.reconnectTimeout) {
      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null;
        this.connect();
      }, 3000);
    }
  }

  private notifyStatus(status: WebSocketStatus) {
    this.onStatusChangeCallbacks.forEach(cb => cb(status));
  }
}

export const wsClient = new WebSocketClient();
