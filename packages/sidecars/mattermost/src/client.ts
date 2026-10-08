import { EventEmitter } from 'node:events';
import type { MattermostBridgeConfig, MattermostPost, MattermostPostEvent, MattermostReaction } from './types.js';

export interface MattermostClientEvents {
  post: (event: MattermostPostEvent, post: MattermostPost) => void;
  reaction: (reaction: MattermostReaction) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
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

  /** Edit a post's message in place (`PUT /posts/{id}/patch`). Edits do not notify. */
  async updatePost(postId: string, message: string): Promise<MattermostPost> {
    const res = await fetch(`${this.config.mattermostUrl}/api/v4/posts/${encodeURIComponent(postId)}/patch`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.config.mattermostToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
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
  async getUser(userId: string): Promise<{ id: string; username: string }> {
    const res = await fetch(`${this.config.mattermostUrl}/api/v4/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${this.config.mattermostToken}` },
    });
    if (!res.ok) {
      throw new Error(`Mattermost getUser failed: HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { id: string; username: string };
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
            } else if (msg.event === 'reaction_added' && msg.data?.reaction) {
              // `data.reaction` is a JSON string, like `data.post`.
              const reaction: MattermostReaction = JSON.parse(msg.data.reaction);
              this.emit('reaction', reaction);
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
