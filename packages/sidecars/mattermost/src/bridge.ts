import path from 'node:path';
import { ApprovalManager, ApprovalStore, resolveApprovals } from './approvals.js';
import { MattermostClient } from './client.js';
import { loadBridgeConfigs, defaultDataDir } from './config.js';
import { DaemonClient } from './daemon.js';
import { MattermostGate } from './gate.js';
import { ScheduleRunner, ScheduleStore, resolveSchedules } from './schedules.js';
import type { RunOutcome } from './schedules.js';
import { ThreadRouter } from './sessions.js';
import { ThreadStore } from './store.js';
import type { MattermostBridgeConfig, MattermostPost, MattermostPostEvent, MattermostReaction } from './types.js';

export class MattermostBridge {
  readonly config: MattermostBridgeConfig;
  readonly client: MattermostClient;
  readonly gate: MattermostGate;
  readonly echoPrefix: string;
  /** Present when the bot is configured for Chi runs (B2); absent means B1 echo. */
  readonly router?: ThreadRouter;
  readonly daemon?: DaemonClient;
  /** Present when the bot has an `approvals` block (B3). */
  readonly approvals?: ApprovalManager;
  /** Present when the bot has `schedules` (B4). Never given the approval manager: scheduled runs are always read-only. */
  readonly scheduler?: ScheduleRunner;
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
      let gate: { manager: ApprovalManager; actingMode: string } | undefined;
      if (config.approvals) {
        const where = `bot '${name}'`;
        const resolved = resolveApprovals(config.approvals, where);
        // The daemon takes the mode of a run from `chi.mode`; under approvals the bridge owns it.
        if (config.chi.mode) {
          throw new Error(`${where}: chi.mode is ignored under approvals; set approvals.actingMode instead`);
        }
        this.approvals = new ApprovalManager({
          bot: name,
          client: this.client,
          store: new ApprovalStore(path.join(config.dataDir ?? defaultDataDir(), `approvals-${name}.json`), name),
          approvals: resolved,
          onApproved: (rec, approver) => this.router?.runApproved(rec, approver) ?? Promise.resolve(),
        });
        gate = { manager: this.approvals, actingMode: resolved.actingMode };
      }
      this.router = new ThreadRouter({
        bot: name,
        client: this.client,
        daemon: this.daemon,
        store,
        chi: config.chi,
        progress: config.progress,
        approvals: gate,
      });
      if (config.schedules?.length) {
        const where = `bot '${name}'`;
        this.scheduler = new ScheduleRunner({
          bot: name,
          schedules: resolveSchedules(config.schedules, where, config.allowedChannels),
          client: this.client,
          daemon: this.daemon,
          store: new ScheduleStore(
            config.schedulesPath ?? path.join(config.dataDir ?? defaultDataDir(), `schedules-${name}.json`),
          ),
          chi: config.chi,
          progress: config.progress,
          scheduler: config.scheduler,
        });
      }
    } else if (config.approvals) {
      throw new Error(`bot '${config.name ?? 'bot'}': approvals needs daemon and chi (B2) to be configured`);
    } else if (config.schedules?.length) {
      throw new Error(`bot '${config.name ?? 'bot'}': schedules needs daemon and chi (B2) to be configured`);
    }
  }

  /**
   * Run one schedule now, by hand (`--run-schedule`). Does not need `start()` (no websocket) and leaves the persisted
   * scheduler state alone, so it never disturbs the real timetable.
   */
  async runScheduleNow(name: string): Promise<RunOutcome> {
    if (!this.scheduler) throw new Error(`bot '${this.config.name ?? 'bot'}' has no schedules`);
    const outcome = await this.scheduler.runNow(name);
    await this.scheduler.whenIdle();
    return outcome;
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Fetch bot profile to ignore own messages
    try {
      const me = await this.client.getMe();
      if (me?.id) {
        this.gate.setBotUserId(me.id);
        this.approvals?.setBotUserId(me.id);
      }
      if (me?.username) this.router?.setBotUsername(me.username);
    } catch (err) {
      // If getMe fails or botUserId was provided in config, fallback
      if (this.config.botUserId) {
        this.gate.setBotUserId(this.config.botUserId);
        this.approvals?.setBotUserId(this.config.botUserId);
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

    // Reactions are not post events, so the post gate does not see them: the approver
    // list inside the manager is their gate (separate from `allowedUsers`).
    if (this.approvals) {
      const approvals = this.approvals;
      this.client.on('reaction', (reaction: MattermostReaction) => {
        approvals.handleReaction(reaction).catch((err) => {
          console.error('Failed to handle reaction:', err instanceof Error ? err.message : err);
        });
      });
    }

    this.router?.recover();
    await this.approvals?.recover().catch((err) => {
      console.error('Failed to recover approvals:', err instanceof Error ? err.message : err);
    });
    // B4: refuses to start on an unknown schedule channel; catches up at most one missed occurrence per schedule.
    try {
      await this.scheduler?.start();
    } catch (err) {
      this.stop();
      throw err;
    }
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.router?.stop();
    this.approvals?.stop();
    this.scheduler?.stop();
    this.client.close();
  }

  isRunning(): boolean {
    return this.running;
  }
}

/** `--run-schedule <bot>/<name>` and `--list-schedules`: operator commands that never start the websocket. */
function parseCli(argv: string[]): { runSchedule?: string; listSchedules: boolean } {
  const out: { runSchedule?: string; listSchedules: boolean } = { listSchedules: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--list-schedules') out.listSchedules = true;
    else if (a === '--run-schedule') {
      const v = argv[++i];
      if (!v) {
        console.error('error: --run-schedule needs <bot>/<schedule>');
        process.exit(2);
      }
      out.runSchedule = v;
    } else if (a.startsWith('--run-schedule=')) out.runSchedule = a.slice('--run-schedule='.length);
  }
  return out;
}

/** Operator commands. Returns the process exit code. */
async function runOperatorCommand(bridges: MattermostBridge[], cli: ReturnType<typeof parseCli>): Promise<number> {
  if (cli.listSchedules) {
    for (const b of bridges) {
      for (const name of b.scheduler?.names() ?? []) {
        const next = b.scheduler?.nextDue(name);
        console.log(`${b.config.name ?? 'bot'}/${name}\tnext ${next ? new Date(next).toISOString() : 'never'}`);
      }
    }
    return 0;
  }
  const [botName, ...rest] = (cli.runSchedule as string).split('/');
  const schedule = rest.join('/');
  const bridge = bridges.find((b) => (b.config.name ?? 'bot') === botName);
  if (!bridge || !schedule) {
    console.error(`error: --run-schedule expects <bot>/<schedule>; bots: ${bridges.map((b) => b.config.name ?? 'bot').join(', ')}`);
    return 2;
  }
  try {
    const outcome = await bridge.runScheduleNow(schedule);
    console.log(`${botName}/${schedule}: ${outcome.kind}${'reason' in outcome ? ` (${outcome.reason})` : ''}`);
    return outcome.kind === 'posted' || outcome.kind === 'quiet' ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
}

// Sidecar CLI entry point when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const bridges: MattermostBridge[] = [];
  const configFile = process.env.MATTERMOST_BRIDGE_CONFIG;
  const cli = parseCli(process.argv.slice(2));
  const operator = Boolean(cli.runSchedule) || cli.listSchedules;

  try {
    if (configFile) {
      for (const cfg of loadBridgeConfigs(configFile)) bridges.push(new MattermostBridge(cfg));
    } else if (operator) {
      console.error('error: --run-schedule and --list-schedules need MATTERMOST_BRIDGE_CONFIG');
      process.exit(2);
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

  if (operator) {
    runOperatorCommand(bridges, cli).then((code) => process.exit(code));
  } else {
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
}
