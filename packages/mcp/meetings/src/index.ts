#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { MeetingsDbClient, SqlExecutor } from '@ikenga/meetings-contract';
import { SEARCH_TOOLS, handleSearchTool } from './tools/search.js';
import { RECORDER_TOOLS, handleRecorderTool } from './tools/recorder.js';
import {
  BetterSqliteExecutor,
  InMemorySqlExecutor,
  resolveDatabasePath,
} from './sqlite.js';

export { BetterSqliteExecutor, InMemorySqlExecutor, resolveDatabasePath };

export const ALL_TOOLS = [...SEARCH_TOOLS, ...RECORDER_TOOLS];

export function parseDbPathFromArgs(argv: string[] = process.argv): string | undefined {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--db' || arg === '--sqlite' || arg === '-d') && argv[i + 1]) {
      return argv[i + 1];
    }
    if (arg?.startsWith('--db=')) {
      return arg.slice(5);
    }
    if (arg?.startsWith('--sqlite=')) {
      return arg.slice(9);
    }
  }
  return undefined;
}

export function createMeetingsDbClient(
  target?: MeetingsDbClient | SqlExecutor | string
): MeetingsDbClient {
  if (target instanceof MeetingsDbClient) {
    return target;
  }
  if (typeof target === 'string') {
    return new MeetingsDbClient(new BetterSqliteExecutor(target));
  }
  if (target && typeof (target as SqlExecutor).query === 'function') {
    return new MeetingsDbClient(target as SqlExecutor);
  }

  if (process.env.USE_IN_MEMORY_DB === 'true') {
    return new MeetingsDbClient(new InMemorySqlExecutor());
  }

  const dbPath = parseDbPathFromArgs() ?? resolveDatabasePath();
  return new MeetingsDbClient(new BetterSqliteExecutor(dbPath));
}

export function createMeetingsMcpServer(
  clientOrTarget?: MeetingsDbClient | SqlExecutor | string
): Server {
  const client = createMeetingsDbClient(clientOrTarget);

  const server = new Server(
    {
      name: 'dev.ikenga/mcp-meetings',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_TOOLS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (SEARCH_TOOLS.some((t) => t.name === name)) {
        const res = await handleSearchTool(client, name, args ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        };
      }

      if (RECORDER_TOOLS.some((t) => t.name === name)) {
        const res = await handleRecorderTool(client, name, args ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        };
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (err: any) {
      if (err instanceof McpError) throw err;
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool error (${name}): ${err.message}` }],
      };
    }
  });

  return server;
}

export async function runServer(dbPath?: string): Promise<void> {
  const resolvedPath = dbPath ?? parseDbPathFromArgs();
  const server = createMeetingsMcpServer(resolvedPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js')) {
  runServer().catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}
