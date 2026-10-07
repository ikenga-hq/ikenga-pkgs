import path from 'node:path';
import { MattermostClient } from './client.js';
import { loadBridgeConfigs, defaultDataDir } from './config.js';
import { DaemonClient } from './daemon.js';
import { MattermostGate } from './gate.js';
import { ThreadRouter } from './sessions.js';
import { ThreadStore } from './store.js';
import type { MattermostBridgeConfig, MattermostPost, MattermostPostEvent } from './types.js';

export class MattermostBridge {
  readonly config: MattermostBridgeConfig;
  readonly client: MattermostClient;
  readonly gate: MattermostGate;
  readonly echoPrefix: string;
  /** Present when the bot is configured for Chi runs (B2); absent means B1 echo. */
  readonly router?: ThreadRouter;
  readonly daemon?: DaemonClient;
  private running = false;

  constructor(config: MattermostBridgeConfig) {
    this.config = config;
    this.echoPrefix = config.echoPrefix ?? 'echo: ';
    this.gate = new MattermostGate(config);
    this.client = new MattermostClient(config);

    if (config.daemon && config.chi) {
      const name = config.name ?? 'bot';
      this.daemon = new DaemonClient(config.daemon);
      const store = new ThreadStore(
        config.storePath ?? path.join(config.dataDir ?? defaultDataDir(), `threads-${name}.json`),
        name,
        config.retentionMs,
      );
      this.router = new ThreadRouter({
        bot: name,
        client: this.client,
        daemon: this.daemon,
        store,
        chi: config.chi,
        progress: config.progress,
      });
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Fetch bot profile to ignore own messages
    try {
      const me = await this.client.getMe();
      if (me?.id) {
        this.gate.setBotUserId(me.id);
      }
      if (me?.username) this.router?.setBotUsername(me.username);
    } catch (err) {
      // If getMe fails or botUserId was provided in config, fallback
      if (this.config.botUserId) {
        this.gate.setBotUserId(this.config.botUserId);
      }
    }

    // Connect WebSocket
    await this.client.connect();

    this.client.on('post', async (event: MattermostPostEvent, post: MattermostPost) => {
      const gateResult = this.gate.check(event, post);
      if (!gateResult.allowed) {
        return;
      }

      if (this.router) {
        // The gate has already run: everything below is for allowed users in allowed channels.
        try {
          await this.router.handle(post);
        } catch (err) {
          console.error('Failed to route post:', err instanceof Error ? err.message : err);
        }
        return;
      }

      try {
        const replyText = `${this.echoPrefix}${post.message}`;
        const targetRootId = post.root_id || post.id;
        await this.client.reply(post.channel_id, replyText, targetRootId);
      } catch (err) {
        console.error('Failed to send echo reply:', err);
      }
    });

    this.router?.recover();
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.router?.stop();
    this.client.close();
  }

  isRunning(): boolean {
    return this.running;
  }
}

// Sidecar CLI entry point when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const bridges: MattermostBridge[] = [];
  const configFile = process.env.MATTERMOST_BRIDGE_CONFIG;

  try {
    if (configFile) {
      for (const cfg of loadBridgeConfigs(configFile)) bridges.push(new MattermostBridge(cfg));
    } else {
      // B1 fallback: a single echo bot configured from the environment.
      const token = process.env.MATTERMOST_TOKEN || '';
      if (!token) {
        console.error('error: set MATTERMOST_BRIDGE_CONFIG (B2) or MATTERMOST_TOKEN (B1 echo)');
        process.exit(1);
      }
      bridges.push(
        new MattermostBridge({
          mattermostUrl: process.env.MATTERMOST_URL || 'http://localhost:8065',
          mattermostToken: token,
          allowedUsers: (process.env.MATTERMOST_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
          allowedChannels: (process.env.MATTERMOST_ALLOWED_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean),
        }),
      );
    }
  } catch (err) {
    console.error('Bridge config error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  Promise.all(bridges.map((b) => b.start()))
    .then(() => console.log(`Mattermost bridge started (${bridges.length} bot${bridges.length === 1 ? '' : 's'})`))
    .catch((err) => {
      console.error('Bridge failed to start:', err instanceof Error ? err.message : err);
      process.exit(1);
    });

  const shutdown = () => {
    for (const b of bridges) b.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
