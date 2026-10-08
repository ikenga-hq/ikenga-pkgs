import http from 'node:http';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import type { MattermostPost, MattermostReaction } from './types.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buf: Buffer): string[] {
  const messages: string[] = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const isMasked = (buf[offset + 1]! & 0x80) !== 0;
    let payloadLength = buf[offset + 1]! & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buf.length) break;
      payloadLength = buf.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buf.length) break;
      payloadLength = Number(buf.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskOffset = offset + headerLength;
    const dataOffset = maskOffset + (isMasked ? 4 : 0);

    if (dataOffset + payloadLength > buf.length) {
      break;
    }

    const payload = buf.subarray(dataOffset, dataOffset + payloadLength);
    if (isMasked) {
      const mask = buf.subarray(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i++) {
        unmasked[i] = payload[i]! ^ mask[i % 4]!;
      }
      messages.push(unmasked.toString('utf8'));
    } else {
      messages.push(payload.toString('utf8'));
    }

    offset = dataOffset + payloadLength;
  }

  return messages;
}

export class MockMattermostServer {
  private server: http.Server;
  private wsClients: Set<Socket> = new Set();

  /** Connected WebSocket clients (tests wait on this instead of sleeping). */
  get clientCount(): number {
    return this.wsClients.size;
  }
  readonly receivedPosts: Array<{ id?: string; channel_id: string; message: string; root_id?: string }> = [];
  /** Every post the bridge created, by id, with its CURRENT message (patches applied). */
  readonly posts = new Map<string, { id: string; channel_id: string; message: string; root_id?: string }>();
  /** Every `PUT /posts/{id}/patch` the bridge made, in order. */
  readonly patches: Array<{ id: string; message: string }> = [];
  /** Reactions by post id, as `GET /posts/{id}/reactions` returns them. */
  readonly reactions = new Map<string, MattermostReaction[]>();
  /** `user_id -> username`, for `GET /users/{id}`. A missing id is a 404. */
  readonly users = new Map<string, string>([
    ['alice', 'alice'],
    ['bob', 'bob'],
    ['mallory', 'mallory'],
  ]);
  /** Make `GET /users/{id}` fail (a Mattermost outage). */
  failUserLookups = false;
  /** Channels the bot can see, `name -> id`, in one team. A missing name is a 404. */
  readonly channels = new Map<string, string>([
    ['engineering', 'c1'],
    ['rex-test', 'c-rex-test'],
    ['ruby-test', 'c-ruby-test'],
    ['rex-alerts', 'c-alerts'],
  ]);
  /** Make channel lookups fail with a 500 (a Mattermost outage). */
  failChannelLookups = false;
  private nextPostId = 1;
  readonly botId = 'bot-12345';
  readonly botUsername = 'ikenga-bot';
  private port = 0;
  private seq = 1;

  constructor() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);

      if (req.method === 'GET' && url.pathname === '/api/v4/users/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: this.botId, username: this.botUsername }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v4/posts') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const id = `bot-post-${this.nextPostId++}`;
            this.receivedPosts.push({ ...data, id });
            this.posts.set(id, { id, ...data });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id, ...data }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid json' }));
          }
        });
        return;
      }

      const reactionsOf = /^\/api\/v4\/posts\/([^/]+)\/reactions$/.exec(url.pathname);
      if (req.method === 'GET' && reactionsOf) {
        const list = this.reactions.get(decodeURIComponent(reactionsOf[1] as string));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list && list.length ? list : null)); // Mattermost answers null for none
        return;
      }

      const userOf = /^\/api\/v4\/users\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && userOf) {
        const id = decodeURIComponent(userOf[1] as string);
        const username = this.users.get(id);
        if (this.failUserLookups || !username) {
          res.writeHead(this.failUserLookups ? 500 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'no such user' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, username }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v4/users/me/teams') {
        res.writeHead(this.failChannelLookups ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.failChannelLookups ? { error: 'down' } : [{ id: 'team1', name: 'royalti' }]));
        return;
      }

      const channelByName = /^\/api\/v4\/teams\/([^/]+)\/channels\/name\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && channelByName) {
        const id = this.channels.get(decodeURIComponent(channelByName[2] as string));
        const status = this.failChannelLookups ? 500 : id ? 200 : 404;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status === 200 ? { id, name: decodeURIComponent(channelByName[2] as string) } : { error: 'no such channel' }));
        return;
      }

      // `GET /channels/{id}`: a 26-character id the bot can see (the ids in `channels` are short, so a test that wants
      // to name a channel by id gives it a 26-character one).
      const channelById = /^\/api\/v4\/channels\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && channelById) {
        const id = decodeURIComponent(channelById[1] as string);
        const name = [...this.channels.entries()].find(([, v]) => v === id)?.[0];
        const status = this.failChannelLookups ? 500 : name ? 200 : 404;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status === 200 ? { id, name } : { error: 'no such channel' }));
        return;
      }

      const patch = /^\/api\/v4\/posts\/([^/]+)\/patch$/.exec(url.pathname);
      if (req.method === 'PUT' && patch) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const id = decodeURIComponent(patch[1] as string);
          const existing = this.posts.get(id);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'no such post' }));
            return;
          }
          const { message } = JSON.parse(body) as { message: string };
          existing.message = message;
          this.patches.push({ id, message });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(existing));
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.server.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }

      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      this.wsClients.add(socket as Socket);

      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const messages = decodeFrames(buffer);
        for (const msg of messages) {
          try {
            const parsed = JSON.parse(msg);
            if (parsed.action === 'authentication_challenge') {
              const resp = {
                status: 'OK',
                seq_reply: parsed.seq,
              };
              socket.write(encodeFrame(JSON.stringify(resp)));
            }
          } catch {
            // ignore non-json
          }
        }
        buffer = Buffer.alloc(0);
      });

      socket.on('close', () => {
        this.wsClients.delete(socket as Socket);
      });
      socket.on('error', () => {
        this.wsClients.delete(socket as Socket);
      });
    });
  }

  async listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (typeof addr === 'object' && addr) {
          this.port = addr.port;
        }
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  /** Messages of the bot's posts in a thread, current text, oldest first. */
  thread(rootId: string): string[] {
    return [...this.posts.values()].filter((p) => p.root_id === rootId).map((p) => p.message);
  }

  broadcastPost(post: MattermostPost, channelName = 'general', senderName?: string): void {
    const event = {
      event: 'posted',
      data: {
        channel_name: channelName,
        channel_type: 'O',
        ...(senderName ? { sender_name: senderName } : {}),
        post: JSON.stringify(post),
      },
      seq: this.seq++,
    };
    const frame = encodeFrame(JSON.stringify(event));
    for (const client of this.wsClients) {
      client.write(frame);
    }
  }

  /** Record a reaction without telling the bridge (one made while it was down). */
  addReaction(reaction: MattermostReaction): MattermostReaction {
    const r = { create_at: Date.now(), ...reaction };
    this.reactions.set(r.post_id, [...(this.reactions.get(r.post_id) ?? []), r]);
    return r;
  }

  /** A user reacts: recorded, and sent to every connected bridge as `reaction_added`. */
  broadcastReaction(reaction: MattermostReaction): void {
    const r = this.addReaction(reaction);
    const event = { event: 'reaction_added', data: { reaction: JSON.stringify(r) }, seq: this.seq++ };
    const frame = encodeFrame(JSON.stringify(event));
    for (const client of this.wsClients) {
      client.write(frame);
    }
  }

  async close(): Promise<void> {
    for (const client of this.wsClients) {
      client.destroy();
    }
    this.wsClients.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
