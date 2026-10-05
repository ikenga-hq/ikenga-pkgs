import { EventEmitter } from 'node:events';
import type { MattermostBridgeConfig, MattermostPost, MattermostPostEvent } from './types.js';

export interface MattermostClientEvents {
  post: (event: MattermostPostEvent, post: MattermostPost) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
}

export class MattermostClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: MattermostBridgeConfig;
  private seq = 1;
  private isClosed = false;

  constructor(config: MattermostBridgeConfig) {
    super();
    this.config = config;
  }

  async getMe(): Promise<{ id: string; username: string }> {
    const res = await fetch(`${this.config.mattermostUrl}/api/v4/users/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.mattermostToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Mattermost getMe failed: HTTP ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as { id: string; username: string };
  }

  async reply(channelId: string, message: string, rootId?: string): Promise<MattermostPost> {
    const payload: Record<string, unknown> = {
      channel_id: channelId,
      message,
    };
    if (rootId) {
      payload.root_id = rootId;
    }

    const res = await fetch(`${this.config.mattermostUrl}/api/v4/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.mattermostToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Mattermost reply failed: HTTP ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as MattermostPost;
  }

  connect(): Promise<void> {
    this.isClosed = false;
    const wsUrl = this.getWebSocketUrl();

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.onopen = () => {
          // Send authentication challenge on connection
          const challenge = {
            seq: this.seq++,
            action: 'authentication_challenge',
            data: {
              token: this.config.mattermostToken,
            },
          };
          ws.send(JSON.stringify(challenge));
          this.emit('open');
          resolve();
        };

        ws.onmessage = (event: MessageEvent) => {
          try {
            const raw = typeof event.data === 'string' ? event.data : event.data.toString();
            const msg = JSON.parse(raw);

            if (msg.event === 'posted' && msg.data?.post) {
              const post: MattermostPost = JSON.parse(msg.data.post);
              this.emit('post', msg as MattermostPostEvent, post);
            }
          } catch (err) {
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
          }
        };

        ws.onerror = (event: Event) => {
          const err = new Error('WebSocket connection error');
          this.emit('error', err);
          if (!this.ws) {
            reject(err);
          }
        };

        ws.onclose = (event: CloseEvent) => {
          this.emit('close', event.code, event.reason);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  close(): void {
    this.isClosed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private getWebSocketUrl(): string {
    const parsed = new URL(this.config.mattermostUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}/api/v4/websocket`;
  }
}
