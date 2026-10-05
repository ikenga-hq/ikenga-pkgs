import type { GateResult, MattermostBridgeConfig, MattermostPost, MattermostPostEvent } from './types.js';

export class MattermostGate {
  private allowedUsersSet: Set<string>;
  private allowedChannelsSet: Set<string>;
  private botUserId?: string;

  constructor(config: MattermostBridgeConfig) {
    this.allowedUsersSet = new Set(config.allowedUsers);
    this.allowedChannelsSet = new Set(config.allowedChannels);
    this.botUserId = config.botUserId;
  }

  setBotUserId(botUserId: string): void {
    this.botUserId = botUserId;
  }

  check(event: MattermostPostEvent, post: MattermostPost): GateResult {
    // 1. Ignore own bot posts to prevent reply loops
    if (this.botUserId && post.user_id === this.botUserId) {
      return { allowed: false, reason: 'ignored own post' };
    }

    // 2. Ignore system messages
    if (post.type && post.type.startsWith('system_')) {
      return { allowed: false, reason: 'ignored system message' };
    }

    // 3. Deny by default: require non-empty allowedUsers
    if (this.allowedUsersSet.size === 0) {
      return { allowed: false, reason: 'no allowed users configured (deny by default)' };
    }

    // 4. Check user: match by user_id or sender_name / username
    const username = (post.props?.username as string) || event.data?.sender_name || '';
    const userAllowed =
      this.allowedUsersSet.has(post.user_id) ||
      (username && this.allowedUsersSet.has(username)) ||
      (username && this.allowedUsersSet.has(`@${username}`));

    if (!userAllowed) {
      return { allowed: false, reason: `user '${post.user_id}' (${username || 'unknown'}) is not in allowed_users` };
    }

    // 5. Deny by default: require non-empty allowedChannels
    if (this.allowedChannelsSet.size === 0) {
      return { allowed: false, reason: 'no allowed channels configured (deny by default)' };
    }

    // 6. Check channel: match by channel_id or channel_name
    const channelName = event.data?.channel_name || '';
    const channelAllowed =
      this.allowedChannelsSet.has(post.channel_id) ||
      (channelName && this.allowedChannelsSet.has(channelName)) ||
      (channelName && this.allowedChannelsSet.has(`#${channelName}`));

    if (!channelAllowed) {
      return { allowed: false, reason: `channel '${post.channel_id}' (${channelName || 'unknown'}) is not in allowed_channels` };
    }

    return { allowed: true };
  }
}
