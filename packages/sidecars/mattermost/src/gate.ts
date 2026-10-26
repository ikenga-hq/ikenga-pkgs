import type { ResolvedUserPolicy } from './policy.js';
import type { GateResult, MattermostBridgeConfig, MattermostPost, MattermostPostEvent } from './types.js';

export class MattermostGate {
  private allowedUsersSet: Set<string>;
  private allowedChannelsSet: Set<string>;
  private botUserId?: string;
  /** Policy users by Mattermost user id. Empty unless the bridge hands the RESOLVED policies in: raw config alone grants nothing. */
  private readonly policies: ReadonlyMap<string, ResolvedUserPolicy>;

  constructor(config: MattermostBridgeConfig, policies?: ReadonlyMap<string, ResolvedUserPolicy>) {
    this.allowedUsersSet = new Set(config.allowedUsers);
    this.allowedChannelsSet = new Set(config.allowedChannels);
    this.botUserId = config.botUserId;
    this.policies = policies ?? new Map();
  }

  setBotUserId(botUserId: string): void {
    this.botUserId = botUserId;
  }

  check(event: MattermostPostEvent, post: MattermostPost): GateResult {
    // 1. Ignore own bot posts to prevent reply loops
    if (this.botUserId && post.user_id === this.botUserId) {
      return { allowed: false, reason: 'ignored own post', code: 'own_post' };
    }

    // 2. Ignore system messages
    if (post.type && post.type.startsWith('system_')) {
      return { allowed: false, reason: 'ignored system message', code: 'system_post' };
    }

    // 3. Deny by default: require non-empty allowedUsers
    if (this.allowedUsersSet.size === 0 && this.policies.size === 0) {
      return { allowed: false, reason: 'no allowed users configured (deny by default)', code: 'no_allowed_users' };
    }

    // 4. Check user: match by user_id or the server-set sender_name. Never
    //    read `post.props`: any client can put arbitrary keys there, so
    //    `props.username` would let an unlisted channel member impersonate an
    //    allowed user. Mattermost sends `sender_name` as `@name`; the list may
    //    hold either spelling, so compare without the `@`.
    const username = (event.data?.sender_name || '').replace(/^@/, '');
    const userAllowed =
      this.allowedUsersSet.has(post.user_id) ||
      (username && this.allowedUsersSet.has(username)) ||
      (username && this.allowedUsersSet.has(`@${username}`));

    if (!userAllowed) {
      // A policy user is let in by Mattermost user id only (a username can be renamed or reused), and only in the
      // channels of their own policy: `allowedChannels` is the allowedUsers' list, not theirs.
      const policy = this.policies.get(post.user_id);
      if (policy) {
        const channelName = event.data?.channel_name || '';
        const inPolicyChannel = policy.channels.some((c) => c === post.channel_id || (channelName && c === channelName));
        if (!inPolicyChannel) {
          return { allowed: false, reason: `channel '${post.channel_id}' (${channelName || 'unknown'}) is not in this user's policy channels`, code: 'channel_not_allowed' };
        }
        return { allowed: true, policy };
      }
      return { allowed: false, reason: `user '${post.user_id}' (${username || 'unknown'}) is not in allowed_users`, code: 'user_not_allowed' };
    }

    // 5. Deny by default: require non-empty allowedChannels
    if (this.allowedChannelsSet.size === 0) {
      return { allowed: false, reason: 'no allowed channels configured (deny by default)', code: 'no_allowed_channels' };
    }

    // 6. Check channel: match by channel_id or channel_name
    const channelName = event.data?.channel_name || '';
    const channelAllowed =
      this.allowedChannelsSet.has(post.channel_id) ||
      (channelName && this.allowedChannelsSet.has(channelName)) ||
      (channelName && this.allowedChannelsSet.has(`#${channelName}`));

    if (!channelAllowed) {
      return { allowed: false, reason: `channel '${post.channel_id}' (${channelName || 'unknown'}) is not in allowed_channels`, code: 'channel_not_allowed' };
    }

    return { allowed: true };
  }
}
