import { MattermostClient } from './client.js';
import { MattermostGate } from './gate.js';
import type { MattermostBridgeConfig, MattermostPost, MattermostPostEvent } from './types.js';

export class MattermostBridge {
  readonly config: MattermostBridgeConfig;
  readonly client: MattermostClient;
  readonly gate: MattermostGate;
  readonly echoPrefix: string;
  private running = false;

  constructor(config: MattermostBridgeConfig) {
    this.config = config;
    this.echoPrefix = config.echoPrefix ?? 'echo: ';
    this.gate = new MattermostGate(config);
    this.client = new MattermostClient(config);
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Fetch bot profile to ignore own messages
    try {
      const me = await this.client.getMe();
      if (me?.id) {
        this.gate.setBotUserId(me.id);
      }
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

      try {
        const replyText = `${this.echoPrefix}${post.message}`;
        const targetRootId = post.root_id || post.id;
        await this.client.reply(post.channel_id, replyText, targetRootId);
      } catch (err) {
        console.error('Failed to send echo reply:', err);
      }
    });

    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.client.close();
  }

  isRunning(): boolean {
    return this.running;
  }
}

// Sidecar CLI entry point when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const url = process.env.MATTERMOST_URL || 'http://localhost:8065';
  const token = process.env.MATTERMOST_TOKEN || '';
  const allowedUsers = (process.env.MATTERMOST_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowedChannels = (process.env.MATTERMOST_ALLOWED_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!token) {
    console.error('error: MATTERMOST_TOKEN is required');
    process.exit(1);
  }

  const bridge = new MattermostBridge({
    mattermostUrl: url,
    mattermostToken: token,
    allowedUsers,
    allowedChannels,
  });

  bridge.start().then(() => {
    console.log('Mattermost echo bridge started');
  }).catch((err) => {
    console.error('Bridge failed to start:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    bridge.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    bridge.stop();
    process.exit(0);
  });
}
