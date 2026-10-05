export interface MattermostBridgeConfig {
  mattermostUrl: string;
  mattermostToken: string;
  botUserId?: string;
  allowedUsers: string[];
  allowedChannels: string[];
  echoPrefix?: string;
}

export interface MattermostPost {
  id: string;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
  is_pinned?: boolean;
  user_id: string;
  channel_id: string;
  root_id?: string;
  original_id?: string;
  message: string;
  type?: string;
  props?: Record<string, unknown>;
  filenames?: string[];
}

export interface MattermostPostEvent {
  event: 'posted';
  data: {
    channel_name?: string;
    channel_type?: string;
    channel_display_name?: string;
    team_id?: string;
    sender_name?: string;
    post: string; // JSON-serialized MattermostPost
  };
  broadcast?: {
    channel_id?: string;
    user_id?: string;
    team_id?: string;
  };
  seq: number;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
}
