import { EventEmitter } from 'node:events';
import type { MattermostBridgeConfig, MattermostPost, MattermostPostEvent, MattermostReaction } from './types.js';

export interface MattermostClientEvents {
  post: (event: MattermostPostEvent, post: MattermostPost) => void;
  reaction: (reaction: MattermostReaction) => void;
  open: () => void;
  /** `expected` is true when we closed it ourselves (`close()`); false means the connection was lost. */
  close: (code: number, reason: string, expected: boolean) => void;
  error: (err: Error) => void;
  /** A reconnect is scheduled: which attempt this is and how long we wait first. */
  reconnecting: (attempt: number, delayMs: number) => void;
  /** A reconnect attempt succeeded (the socket is open and the auth challenge is sent). */
  reconnected: (attempt: number) => void;
}

/** Websocket resilience knobs. Defaults suit production; tests pass tiny values. */
export interface MattermostClientTiming {
  /** First reconnect delay. Doubles per consecutive failed attempt. Default 1s. */
  backoffMinMs?: number;
  /** Cap on the reconnect delay. Default 60s. */
  backoffMaxMs?: number;
  /** A connection that stays open this long is "healthy": the backoff starts over. Default 60s. */
  healthyMs?: number;
  /** Liveness ping period. `0` turns the check off. Default 30s. */
  pingIntervalMs?: number;
  /**
   * Give up on one connection attempt whose websocket handshake has not completed in this long. `0` turns it off.
   * Default 30s. Without it a peer that accepts TCP but never answers the upgrade holds the attempt for undici's own
   * 300s header timeout, the bot deaf all that time, whatever the backoff cap says.
   */
  connectTimeoutMs?: number;
  /** Jitter source in [0, 1). Default `Math.random`; tests pin it. */
  random?: () => number;
}

/**
 * Delay before reconnect attempt number `attempt` (0-based): `min * 2^attempt`, capped at `max`, then "equal jitter"
 * (half fixed, half random) so a fleet of bots that lost the same server does not reconnect in lockstep.
 */
export function backoffDelayMs(attempt: number, min: number, max: number, random: () => number): number {
  const base = Math.min(max, min * 2 ** Math.min(attempt, 30));
  return Math.round(base / 2 + (random() * base) / 2);
}

/** `notFound` is a definite "no such channel for this bot"; otherwise the lookup itself failed and may be retried. */
export class ChannelLookupError extends Error {
  constructor(
    message: string,
    readonly notFound: boolean,
  ) {
    super(message);
    this.name = 'ChannelLookupError';
  }
}

export class MattermostClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: MattermostBridgeConfig;
  private seq = 1;
  /** True once `close()` was called: the one case where losing the socket is expected and not retried. */
  private isClosed = false;
  private readonly timing: Required<MattermostClientTiming>;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private unansweredPings = 0;

  constructor(config: MattermostBridgeConfig, timing: MattermostClientTiming = {}) {
    super();
    this.config = config;
    this.timing = {
      backoffMinMs: timing.backoffMinMs ?? 1_000,
      backoffMaxMs: timing.backoffMaxMs ?? 60_000,
      healthyMs: timing.healthyMs ?? 60_000,
      pingIntervalMs: timing.pingIntervalMs ?? 30_000,
      connectTimeoutMs: timing.connectTimeoutMs ?? 30_000,
      random: timing.random ?? Math.random,
    };
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

  async reply(channelId: string, message: string, rootId?: string, props?: Record<string, unknown>): Promise<MattermostPost> {
    const payload: Record<string, unknown> = {
      channel_id: channelId,
      message,
    };
    if (rootId) {
      payload.root_id = rootId;
    }
    if (props) {
      payload.props = props;
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

  /** Delete a post (`DELETE /posts/{id}`). */
  async deletePost(postId: string): Promise<void> {
    const res = await fetch(`${this.config.mattermostUrl}/api/v4/posts/${encodeURIComponent(postId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.config.mattermostToken}` },
    });

    if (!res.ok) {
      throw new Error(`Mattermost deletePost failed: HTTP ${res.status} ${res.statusText}`);
    }
  }

  /**
   * Edit a post's message in place (`PUT /posts/{id}/patch`). Edits do not notify. `props`, when given, replaces the
   * post's props (`{attachments: []}` takes interactive buttons off a post).
   */
  async updatePost(postId: string, message: string, props?: Record<string, unknown>): Promise<MattermostPost> {
    const res = await fetch(`${this.config.mattermostUrl}/api/v4/posts/${encodeURIComponent(postId)}/patch`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.config.mattermostToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(props ? { message, props } : { message }),
    });

    if (!res.ok) {
      throw new Error(`Mattermost updatePost failed: HTTP ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as MattermostPost;
  }

  /** Reactions on a post (`GET /posts/{id}/reactions`; Mattermost answers `null` for none). */
  async getReactions(postId: string): Promise<MattermostReaction[]> {
    const res = await fetch(`${this.config.mattermostUrl}/api/v4/posts/${encodeURIComponent(postId)}/reactions`, {
      headers: { Authorization: `Bearer ${this.config.mattermostToken}` },
    });
    if (!res.ok) {
      throw new Error(`Mattermost getReactions failed: HTTP ${res.status} ${res.statusText}`);
    }
    return ((await res.json()) as MattermostReaction[] | null) ?? [];
  }

  /** A user's profile, to turn a reaction's `user_id` into a username. */
  async getUser(userId: string): Promise<{ id: string; username: string; is_bot?: boolean }> {
    const res = await fetch(`${this.config.mattermostUrl}/api/v4/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${this.config.mattermostToken}` },
    });
    if (!res.ok) {
      throw new Error(`Mattermost getUser failed: HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { id: string; username: string; is_bot?: boolean };
  }

  /**
   * Turn a channel name (`engineering`, `#engineering`) or id into a channel id. A name is looked up in every team the
   * bot belongs to. Throws `ChannelLookupError` with `notFound` true when no such channel is visible to the bot.
   */
  async resolveChannelId(ref: string): Promise<string> {
    const name = ref.replace(/^#/, '');
    const auth = { Authorization: `Bearer ${this.config.mattermostToken}` };
    const base = this.config.mattermostUrl;
    if (/^[a-z0-9]{26}$/.test(name)) {
      const res = await fetch(`${base}/api/v4/channels/${encodeURIComponent(name)}`, { headers: auth });
      if (res.ok) return ((await res.json()) as { id: string }).id;
      if (res.status === 404 || res.status === 403) throw new ChannelLookupError(`channel id '${name}' not found or not visible to the bot`, true);
      throw new ChannelLookupError(`channel lookup failed: HTTP ${res.status} ${res.statusText}`, false);
    }
    const teamsRes = await fetch(`${base}/api/v4/users/me/teams`, { headers: auth });
    if (!teamsRes.ok) throw new ChannelLookupError(`team lookup failed: HTTP ${teamsRes.status} ${teamsRes.statusText}`, false);
    const teams = ((await teamsRes.json()) as Array<{ id: string }> | null) ?? [];
    for (const team of teams) {
      const res = await fetch(
        `${base}/api/v4/teams/${encodeURIComponent(team.id)}/channels/name/${encodeURIComponent(name)}`,
        { headers: auth },
      );
      if (res.ok) return ((await res.json()) as { id: string }).id;
      if (res.status !== 404 && res.status !== 403) {
        throw new ChannelLookupError(`channel lookup failed: HTTP ${res.status} ${res.statusText}`, false);
      }
    }
    throw new ChannelLookupError(`channel '#${name}' not found in any team the bot belongs to (is the bot a member?)`, true);
  }

  /**
   * Open the websocket. The returned promise rejects if the FIRST connection cannot be made (the caller decides what
   * that means; the bridge exits non-zero and lets systemd restart it). Once it has resolved, an unexpected loss of
   * the connection is retried here, forever, with capped exponential backoff, until `close()` is called.
   */
  async connect(): Promise<void> {
    this.isClosed = false;
    this.attempt = 0;
    this.clearReconnectTimer();
    await this.openSocket();
  }

  /** Close for good: no reconnect, and the pending reconnect timer (if any) is cancelled. */
  close(): void {
    this.isClosed = true;
    this.clearReconnectTimer();
    this.stopSocketTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closing
      }
    }
  }

  /** One websocket attempt. Resolves when open; rejects if it errors or closes before opening. */
  private openSocket(): Promise<void> {
    const wsUrl = this.getWebSocketUrl();

    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      let opened = false;
      const authSeq = this.seq;
      const timeoutMs = this.timing.connectTimeoutMs;
      let connectTimer: NodeJS.Timeout | null = null;
      const clearConnectTimer = () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
      };
      if (timeoutMs > 0) {
        connectTimer = setTimeout(() => {
          connectTimer = null;
          if (opened) return;
          // The handshake never completed: abandon this attempt (no events from it any more) and let the caller retry.
          ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
          if (this.ws === ws) this.ws = null;
          try {
            ws.close();
          } catch {
            // already closing
          }
          const err = new Error(`WebSocket handshake timed out after ${timeoutMs} ms`);
          this.emitError(err);
          reject(err);
        }, timeoutMs);
      }

      ws.onopen = () => {
        opened = true;
        clearConnectTimer();
        // Send authentication challenge on connection (every connection, so also every reconnect)
        const challenge = {
          seq: this.seq++,
          action: 'authentication_challenge',
          data: {
            token: this.config.mattermostToken,
          },
        };
        ws.send(JSON.stringify(challenge));
        this.startSocketTimers(ws);
        this.emit('open');
        resolve();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.ws !== ws) return;
        // Any inbound frame (ping reply, event, auth reply) proves the connection is alive.
        this.unansweredPings = 0;
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString();
          const msg = JSON.parse(raw);

          if (msg.seq_reply === authSeq && msg.status && msg.status !== 'OK') {
            this.emitError(new Error(`Mattermost websocket authentication failed (${msg.status})`));
          } else if (msg.event === 'posted' && msg.data?.post) {
            const post: MattermostPost = JSON.parse(msg.data.post);
            this.emit('post', msg as MattermostPostEvent, post);
          } else if (msg.event === 'reaction_added' && msg.data?.reaction) {
            // `data.reaction` is a JSON string, like `data.post`.
            const reaction: MattermostReaction = JSON.parse(msg.data.reaction);
            this.emit('reaction', reaction);
          }
        } catch (err) {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.onerror = () => {
        const err = new Error('WebSocket connection error');
        this.emitError(err);
        // Before the socket has opened an error means this attempt failed (a close event follows, too).
        if (!opened) {
          clearConnectTimer();
          reject(err);
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (!opened) {
          clearConnectTimer();
          reject(new Error(`WebSocket closed before it opened (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`));
          if (this.ws === ws) this.ws = null;
          return;
        }
        // A socket we already replaced or dropped (our own close(), or the liveness check) reports nothing new.
        if (this.ws !== ws) {
          if (this.isClosed) this.emit('close', event.code, event.reason, true);
          return;
        }
        this.handleLost(ws, event.code, event.reason);
      };
    });
  }

  /** The connection went away without us asking: say so once, then reconnect. */
  private handleLost(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopSocketTimers();
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
    this.emit('close', code, reason, false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.isClosed || this.reconnectTimer) return;
    const t = this.timing;
    const delay = backoffDelayMs(this.attempt, t.backoffMinMs, t.backoffMaxMs, t.random);
    this.attempt++;
    const attempt = this.attempt;
    this.emit('reconnecting', attempt, delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isClosed) return;
      this.openSocket().then(
        () => {
          // close() may have raced the open; do not announce a connection we already threw away.
          if (!this.isClosed) this.emit('reconnected', attempt);
        },
        () => this.scheduleReconnect(),
      );
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * Per-connection timers, started when the socket opens:
   *  - the healthy timer resets the backoff once the connection has held for `healthyMs` (it is NOT reset on open, so
   *    a server that accepts and immediately drops us cannot pin the delay at the minimum);
   *  - the liveness ping (Mattermost sends no app-level pings, so a half-open TCP connection, for example after a NAT
   *    or load-balancer drop, would otherwise stay "open" and deaf forever).
   */
  private startSocketTimers(ws: WebSocket): void {
    this.stopSocketTimers();
    this.unansweredPings = 0;
    this.healthyTimer = setTimeout(() => {
      this.attempt = 0;
    }, this.timing.healthyMs);
    if (this.timing.pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => {
        if (this.ws !== ws) return;
        // Two pings in a row got no frame of any kind back: treat the connection as dead and reconnect. We do not wait
        // for the close handshake (a half-open peer never answers it); the old socket is abandoned.
        if (this.unansweredPings >= 2) {
          this.handleLost(ws, 1006, 'liveness check failed: no reply to ping');
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ seq: this.seq++, action: 'ping' }));
          this.unansweredPings++;
        } catch {
          // a failed send means a dying socket; the close event or the next tick handles it
        }
      }, this.timing.pingIntervalMs);
    }
  }

  private stopSocketTimers(): void {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.healthyTimer = null;
    this.pingTimer = null;
  }

  /** `emit('error')` with no listener throws in Node; a socket hiccup must not take the process down. */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  private getWebSocketUrl(): string {
    const parsed = new URL(this.config.mattermostUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}/api/v4/websocket`;
  }
}
