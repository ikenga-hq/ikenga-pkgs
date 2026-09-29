#!/usr/bin/env node
//
// iyke-mcp — MCP server that exposes the Ikenga desktop app's Iyke
// control bridge to Claude. Tools mirror the `iyke` CLI subcommands so
// a Claude session in any terminal can drive the app the same way a
// developer types into iyke at a shell.
//
// Trust boundary is the localhost HTTP server inside the desktop app:
// we read control.json (port + bearer token) the same way the CLI does
// and forward calls. If the app isn't running, every tool fails with a
// structured error rather than hanging — Claude sees the failure and
// reports it instead of silently waiting.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { MINI_APP_NAMES } from '@ikenga/contract/iyke';

import { createRequire } from 'node:module';

import { IykeClient } from './api.js';
import { load, STALE_THRESHOLD_SECS } from './control.js';
import {
  EXPLORER_SECTIONS_PATH,
  NGWA_SNAPSHOT_PATH,
  NGWA_SNAPSHOT_TIMEOUT_MS,
  V16_MODES,
  findNgwaItem,
  isRouteMissing,
  resolveProjectId,
  routeMissingError,
  type NgwaSnapshot,
  type ProjectListEntry,
} from './nouns.js';

// Read the version from package.json rather than repeating it here. The literal
// that used to live in the Server() identity below drifted to 0.1.0 while the
// package shipped 0.2.1, so every MCP client asking who we are got a build from
// three releases earlier. Resolved from the built file (dist/index.js), so
// '../package.json' is the package root.
const { version: PKG_VERSION } = createRequire(import.meta.url)(
  '../package.json',
) as { version: string };

const TOOLS = [
  {
    name: 'iyke_state',
    description:
      'Get the current state of the Ikenga desktop app — sidebar mode, focused pane route, and the full pane tree under shell.panes. shell.panes has shape { leaves: [{ id, focused, activeTabIdx, tabs: [{kind,title}] }], tree: <recursive PaneNode> }; use leaves[].id with iyke_focus or iyke_close (pane_id) to operate on a specific pane. Call this before iyke_go / iyke_mode / iyke_focus / iyke_close to check what the user is currently looking at.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'iyke_go',
    description:
      'Navigate the focused pane to a route path inside the Ikenga desktop app (e.g. "/notes/today"). Path must start with "/". This replaces the focused pane\'s active tab content; use iyke_open with kind=route to add a new tab instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Route path, must start with "/".' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_mode',
    description:
      'Switch the rail activity mode. Valid modes: project, chi, ngwa, settings — the four modes the v16 shell owns. (The bridge still accepts the legacy pre-v16 names for one compatibility release and normalizes them shell-side, but they are no longer advertised here.)',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: [...V16_MODES] },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_open',
    description:
      'Open a new tab in the focused pane. `kind` selects the view type. For "route" pass `path`; "terminal" optionally `cmd` (a shell command string); "chat" requires `session_id`; "artifact" requires `path` (a single .html file); "artifact-studio" requires `path` plus optional `density` (grid for a folder, loupe for a single artifact, compare for two — with a `vs` sibling path); "artifact-grid" is a back-compat alias for `artifact-studio` at grid density; "mini-app" requires `name`.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [
            'route',
            'terminal',
            'chat',
            'artifact',
            'artifact-studio',
            'artifact-grid',
            'mini-app',
          ],
        },
        path: {
          type: 'string',
          description:
            'For route, artifact, artifact-studio, or artifact-grid kinds. For artifact-studio: a folder for grid density, a file for loupe / compare.',
        },
        density: {
          type: 'string',
          enum: ['grid', 'loupe', 'compare'],
          description:
            "For artifact-studio kind. Defaults: folder path → 'grid'; file path → 'loupe'. Required with `vs` for compare.",
        },
        vs: {
          type: 'string',
          description: 'For artifact-studio kind at compare density — the second artifact path.',
        },
        cmd: { type: 'string', description: 'For terminal kind. Omit for default login shell.' },
        session_id: { type: 'string', description: 'For chat kind.' },
        name: {
          type: 'string',
          enum: [...MINI_APP_NAMES],
          description: 'For mini-app kind.',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_split',
    description:
      'Split the focused pane (or a specific pane via pane_id) into two. "horizontal" splits side-by-side; "vertical" splits top-bottom. Subject to the in-app MAX_LEAVES cap (currently 6).',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['horizontal', 'vertical'] },
        pane_id: { type: 'string', description: 'Optional. Defaults to focused pane.' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_focus',
    description:
      'Focus a specific pane. Provide either pane_id (leaf id from iyke_state response — shell.panes.leaves[].id) or index (1-based DFS leaf index, matching the in-app ⌃1..⌃6 keyboard shortcuts).',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'string' },
        index: { type: 'integer', minimum: 1, maximum: 6 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_close',
    description:
      'Close a pane (or the focused pane if pane_id omitted). Closes the entire pane and all its tabs — to close a single tab from the in-app keyboard, use ⌘⇧W (⌘W closes the whole pane). Refuses to close the last remaining pane.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'Optional. Defaults to focused pane.' },
      },
      additionalProperties: false,
    },
  },
  // Phase A — runtime inspection + driving.
  {
    name: 'iyke_dom',
    description:
      'Take an accessibility-tree snapshot of the focused pane. Returns Playwright-style text plus structured JSON. Each interactive element gets a stable ref like e1, e2; pass that ref to iyke_click / iyke_type / iyke_key. Refs invalidate on the next snapshot or page navigation. Use `query` for substring filter, `all=true` to include hidden elements.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring filter against role/name/value.' },
        all: { type: 'boolean', description: 'Include hidden + aria-hidden elements.' },
        pane: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_logs',
    description:
      'Read recent console + error logs (last 500) from the running webview. Includes window error and unhandledrejection captures.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['log', 'info', 'warn', 'error', 'debug'],
        },
        since: { type: 'integer', description: 'Only entries with ts >= this (epoch ms).' },
        source: { type: 'string', description: 'Filter by pane source ("shell" or leaf id).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_network',
    description:
      'Read recent fetch + XHR network activity (last 100). Each entry has method, url, status, duration_ms, and error if it failed.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer' },
        source: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_screenshot',
    description:
      'Capture a PNG screenshot of either the full window or a specific pane. Returns the saved path, dimensions, and byte count. Default writes to ~/.local/share/ikenga/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['window', 'pane'], default: 'window' },
        pane_id: { type: 'string', description: 'Required when target=pane.' },
        out_path: { type: 'string', description: 'Override default output path.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_wait',
    description:
      'Wait until a predicate is satisfied or timeout. Use this after iyke_click / iyke_go to wait for the new state to render, instead of fixed sleeps. Returns { satisfied, elapsed_ms, message? }.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['text', 'selector', 'ref', 'gone-text', 'gone-selector'],
        },
        value: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, default: 10000 },
        pane: { type: 'string' },
      },
      required: ['kind', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_click',
    description:
      'Click an element. Specify exactly one of `ref` (from iyke_dom), `selector` (CSS), or `text` (innerText match). Refs are most reliable.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        pane: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_type',
    description:
      'Type text into an input/textarea/contenteditable element. Specify exactly one of `ref` or `selector`. By default appends; pass `replace=true` to overwrite the existing value.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        replace: { type: 'boolean', default: false },
        pane: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_key',
    description:
      'Dispatch a keyboard combo. Use names like "Enter", "Escape", "Tab", "ArrowDown", and modifiers Ctrl/Alt/Shift/Meta separated by + or , (e.g. "Ctrl+S", "Meta+K"). Optional `ref`/`selector` targets a specific element; otherwise the active element receives.',
    inputSchema: {
      type: 'object',
      properties: {
        combo: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        pane: { type: 'string' },
      },
      required: ['combo'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_query_cache',
    description:
      'Dump the TanStack Query cache: queryKey, status, fetchStatus, isStale, dataUpdatedAt, errorUpdatedAt, error, and a 200-char data preview for each entry. Useful for diagnosing stale data or failed fetches.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_devtools',
    description:
      'Open Chrome DevTools for the main webview (debug builds only). Returns 503 in production builds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  // Phase C — iframe runtime state.
  {
    name: 'iyke_iframe_state',
    description:
      'Read the latest published state object for an iframe pane (storyboard cursor, comp current frame, etc.). Iframes call publishState(key, value) from their iyke-bridge to expose runtime state for inspection.',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string' } },
      required: ['pane'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_iframe_send',
    description:
      'Send a fire-and-forget postMessage to an iframe pane. The iframe bridge listens for known kinds (e.g. "story-select") and acts on the payload. Use to drive mini-app actions from outside the running app.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
        kind: { type: 'string' },
        payload: {},
      },
      required: ['pane', 'kind'],
      additionalProperties: false,
    },
  },
  // Phase 0 — projects as a first-class entity. A project scopes sessions,
  // installed pkgs, pane state, todos, scratchpads and cron entries; the
  // shell always has exactly one active project (defaulting to the built-in
  // "Default" project on first boot). Call iyke_project_get_active before
  // any project-mutating action so an agent operates against the project
  // the user is actually looking at.
  {
    name: 'iyke_project_create',
    description:
      'Create a new project in the Ikenga shell. Projects scope chats, installed pkgs, pane layouts, todos, scratchpads and cron jobs — switching project rebinds those surfaces. Slug `id` must match ^[a-z0-9][a-z0-9_-]{0,63}$ and be unique; `default` is reserved. `display_name` is freely Unicode, capped at 120 chars. `root_path` is optional but recommended — it becomes the cwd for new chats spawned inside the project. `color` is a hex string used for the activity-bar dot. Use when the user asks to set up a new working context (a codebase, a label, an experiment).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Slug: ^[a-z0-9][a-z0-9_-]{0,63}$. Unique. "default" is reserved.' },
        display_name: { type: 'string', description: 'Human-readable name, up to 120 chars.' },
        root_path: { type: 'string', description: 'Absolute path. Used as cwd for new chats. Need not exist yet.' },
        icon: { type: 'string', description: 'Emoji or filename inside ~/.local/share/ikenga/projects/<id>/.' },
        color: { type: 'string', description: 'Hex color like #4f8cff for the activity-bar dot.' },
        description: { type: 'string' },
      },
      required: ['id', 'display_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_project_update',
    description:
      'Patch fields on an existing project. Only the fields you pass in `patch` are touched — omit a field to leave it as is. Pass `null` to clear a nullable field (root_path, icon, color, description). `position` controls the project ordering in the activity-bar switcher (lower = earlier). Cannot change `id`; create a new project and migrate instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Slug of the project to update.' },
        patch: {
          type: 'object',
          properties: {
            display_name: { type: 'string' },
            root_path: { type: ['string', 'null'] },
            icon: { type: ['string', 'null'] },
            color: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
            position: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_project_list',
    description:
      'List projects in switcher order (position ASC, then created_at). Each entry has id, display_name, root_path, icon, color, description, position, is_default, created_at, archived_at. Archived projects are hidden by default — pass include_archived=true to surface them (e.g. when an agent is restoring an old project).',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_project_archive',
    description:
      'Archive a project (soft-delete — sets archived_at, no data removed). The project disappears from the default switcher list but its sessions/pkgs/todos remain on disk and can be restored by a later iyke_project_update if needed. Refuses to archive the built-in "Default" project. If the archived project was active, the shell falls back to Default automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Slug of the project to archive.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_project_set_active',
    description:
      'Switch the shell\'s active project. Subsequent new chats, scratchpads, todos and pkg installs default to this project; existing project-scoped TanStack queries (sessions, pkgs, todos, scratchpads, cron) refetch automatically. Does NOT navigate panes — pane contents stay put until a phase-2/6-aware surface reads the new active id. Fails if the id is unknown or archived.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Slug of an existing, non-archived project.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_project_get_active',
    description:
      'Return the currently active project (id, display_name, root_path, icon, color, description, position, is_default, created_at). Call this before iyke_project_set_active or any project-scoped mutation so an agent knows which project the user is in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  // WP-21b — the rest of the `iyke project …` noun, mirroring
  // iyke-cli/src/cmd/project.rs one-for-one.
  {
    name: 'iyke_project_show',
    description:
      'Alias of iyke_project_get_active — returns the currently active project. Exists so the MCP surface mirrors `iyke project show` one-for-one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'iyke_project_switch',
    description:
      'Switch the shell\'s active project, mirroring `iyke project switch <path>`. Accepts a root path (separators, trailing slashes, and casing are normalized) or a bare project id (e.g. "default"). Resolves against the project list and fails with the candidate list when nothing matches. Same side effects as iyke_project_set_active.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project root path (or a bare project id).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_project_sections',
    description:
      "List the Explorer sidebar's registered sections for the active project (G-STATE ExplorerSectionState[] — id, source, order, collapsed), mirroring `iyke project sections`. Requires GET /iyke/explorer/sections, which is pending a WP-28 bridge route — on shells that don't expose it this tool fails with a clear 'route missing' error.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  // ── WP-21b — the Ngwa noun, mirroring `iyke ngwa …` ────────────────────
  // The unified equipment catalogue the `/ngwa/*` surfaces render: installed
  // pkgs + Ọba-placed primitives + engine config. All five tools read one
  // payload — GET /iyke/ngwa/snapshot, the bridge twin of WP-14's
  // `ngwa_snapshot` Tauri command — so installed/store/scopes/health return
  // the verbatim `NgwaSnapshot` (`{ items, as_of_ms, sources }`) and
  // iyke_ngwa_item extracts one entry. The route is pending WP-28; shells
  // that don't expose it produce a 'route missing' error, not a different
  // shape.
  {
    name: 'iyke_ngwa_installed',
    description:
      'The /ngwa/installed facet — every installed NgwaItem (pkgs + primitives), as the shell surface renders them. Returns the verbatim snapshot: { items, as_of_ms, sources }.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'iyke_ngwa_store',
    description:
      'The /ngwa/store catalogue facet — the snapshot the store renders. Remote-registry rows (state: available/update) are enriched frontend-side and are not part of the bridged snapshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'iyke_ngwa_scopes',
    description:
      'The /ngwa/scopes facet — the snapshot the scope matrix renders. Items carry scope { kind: personal } or { kind: project, project_id }; group by it client-side for the matrix view.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'iyke_ngwa_health',
    description:
      'The /ngwa/health facet — the snapshot the health surface renders. The `sources` rollup (kernel, oba, engine_config, engine_assets, trust, usage — each { ok, error, count }) plus items in state broken/orphaned are the parts the surface leads with.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'iyke_ngwa_item',
    description:
      'One NgwaItem\'s full detail — the /ngwa/item/<id> surface. `id` is the namespaced snapshot id, e.g. "com.ikenga.iyke" or "skill:personal:groundwork"; iyke_ngwa_installed lists them. 404-style error when absent.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'NgwaItem id from the snapshot.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  // Phase 3 (projects-first-class): chat sessions are projects' first-class
  // children. Agents listing or re-attributing sessions must always go
  // through the project lens — the shell's /sessions view is filtered by
  // the active project by default and these tools mirror that behavior.
  {
    name: 'iyke_session_list',
    description:
      'List Claude chat sessions. Filter by project (defaults to active); pass include_all=true to list across all projects. Returns at most 50 threads by default (max 200). Each entry has id, title, cwd, project_id, claude_session_id, created_at, updated_at.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description:
            'Slug of the project to filter by. Omit to use the shell\'s active project.',
        },
        include_all: {
          type: 'boolean',
          default: false,
          description: 'Skip the project filter entirely.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_session_move',
    description:
      'Move a chat thread between projects. Metadata-only — does not restart the claude subprocess. The cwd captured at spawn time stays whatever it was. Fails if the target project is unknown or archived.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        project_id: { type: 'string' },
      },
      required: ['thread_id', 'project_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_session_start_in_project',
    description:
      'Mint a new Claude chat thread attached to a project. The shell resolves the project root as the session cwd, builds the layered Claude-config overlay dir (skills + agents + commands + merged .mcp.json) for the spawn, and routes the request through the ACP `session/new` handler. Returns the new thread_id; the actual subprocess spawns lazily on the first prompt — fire `acp_prompt` or open `/sessions/$threadId` in the UI to send the initial message. `initial_prompt` is currently informational only (the bridge does not forward it yet).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        initial_prompt: { type: 'string' },
        cwd: { type: 'string', description: 'Optional cwd override; defaults to the project root_path.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  // Phase 6 — chi-first agent runs.
  {
    name: 'iyke_chi_run',
    description:
      'Start a new chi agent run against an engine. Returns { runId, status, output?, error? }. Use iyke_chi_status to poll for output. engine_id examples: claude-code, gemini, codex. mode controls permissions: plan, default, auto, bypassPermissions.',
    inputSchema: {
      type: 'object',
      properties: {
        engine_id: { type: 'string', description: 'Engine id, e.g. claude-code.' },
        prompt: { type: 'string', description: 'Initial prompt / task for the agent.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the active project root.' },
        model: { type: 'string', description: 'Optional engine model.' },
        mode: { type: 'string', enum: ['plan', 'default', 'auto', 'bypassPermissions'], description: 'Permission mode. Defaults to default.' },
        parent_id: { type: 'string', description: 'Optional parent run id for subagent chains.' },
        resume_session_id: { type: 'string', description: 'Optional existing engine session id to resume.' },
        timeout_seconds: { type: 'integer', description: 'Timeout in seconds (currently advisory).' },
      },
      required: ['engine_id', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_chi_resume',
    description:
      'Continue an existing chi agent run with a new prompt. Requires run_id from a previous iyke_chi_run or iyke_chi_list.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['run_id', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_chi_status',
    description:
      'Get the current status and output of a chi run. Returns { runId, engineId, status, output?, error?, brief? }. Poll periodically after iyke_chi_run.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_chi_list',
    description:
      'List chi agent runs. Optionally filter by engine_id. Returns rows newest-first with runId, engineId, status, and brief.',
    inputSchema: {
      type: 'object',
      properties: {
        engine_id: { type: 'string' },
        limit: { type: 'integer', default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_chi_cancel',
    description: 'Cancel a running chi agent run by run_id.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  // Phase 5 — MCP supervisor + per-project resolved set.
  {
    name: 'iyke_mcp_list',
    description:
      'List MCP servers visible from a project. Returns each (server name × source) pair so conflicts across tiers are surfaced separately. Each entry reports: source tier (personal | workspace_pkg | project | project_pkg), provider (pkg id or "personal"), lifecycle (long-lived | per-call | on-demand), live state (running / parked / crashed / blocked / not-started / on-demand), and the source file path. Defaults to the active project; pass project_id to query a specific one.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_mcp_restart',
    description:
      'Restart a supervised MCP server by pkg id. Restarts every long-lived MCP entry the pkg declares (the supervisor keys per pkg, not per server name). Useful when a child has wedged. Fails with 404 if the pkg is not supervised — per-call MCPs spawn fresh on every tool invocation and have nothing persistent to restart.',
    inputSchema: {
      type: 'object',
      properties: {
        pkg_id: { type: 'string' },
      },
      required: ['pkg_id'],
      additionalProperties: false,
    },
  },
  // Phase 9 — manifest trust gating. READ-ONLY tools only; granting trust
  // is deliberately a human action (the FE Settings → Pkgs Trust column
  // is the only path that calls /iyke/trust/grant). Agents can read state
  // and surface "approval required" to the user.
  {
    name: 'iyke_pkg_trust_status',
    description:
      'Get the trust state for a single installed pkg. Returns one of: auto_trusted (built-in com.ikenga.* shipped with the shell), auto_granted (no sensitive permissions declared), granted (user approved a specific manifest version), or needs_approval (sensitive perms declared but no current grant; either never approved, perms changed since last grant, or explicitly revoked). When state is needs_approval, MCP tools/call against this pkg returns the structured `trust_required` error until the user grants approval via Settings → Pkgs.',
    inputSchema: {
      type: 'object',
      properties: {
        pkg_id: { type: 'string' },
      },
      required: ['pkg_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_pkg_trust_list',
    description:
      'List trust state for every installed pkg. Returns one entry per pkg with state (auto_trusted / auto_granted / granted / needs_approval), declared sensitive permissions summary, and last grant timestamp when applicable. Use when surveying which third-party pkgs need user approval before their MCP tools can be invoked.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  // Runtime-ACL violations audit (2026-05-15). Read-only by design — the
  // bridge intentionally does not expose a clear endpoint over MCP. Use
  // this to investigate why a pkg`s MCP tools/call started failing with
  // a `shell.execute denied` error: the audit log records every blocked
  // spawn attempt with the binary name and the manifest`s declared
  // allowlist at attempt time.
  {
    name: 'iyke_pkg_violations_list',
    description:
      'List kernel-level permission-violation audit rows newest-first. Today only `shell.execute` denials write here (a pkg attempted to spawn a binary outside its manifest\'s declared allowlist). Returns one entry per attempt with attempted (the resolved command), declared (the manifest allowlist at attempt time, comma-joined), scope_kind (\'shell.execute\'), pkg_id, and occurred_at (unix millis). Pass pkg_id to filter to one pkg; omit for a cross-pkg view. limit defaults to 100 and is hard-capped at 1000.',
    inputSchema: {
      type: 'object',
      properties: {
        pkg_id: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  // Phase 7 — vault secrets with scope partitioning.
  {
    name: 'iyke_secret_get',
    description:
      'Read a secret from the vault. The scope arg partitions the read: omit it (or pass an empty string) to read from the active project; pass "workspace" to read a cross-project shared secret; pass "project:<id>" or "pkg:<id>" to target a specific partition. Returns the value as a string, or null when the key does not exist in the chosen scope. Falls back transparently to the legacy unscoped key when a scoped value is missing (with a deprecation log on the host).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_secret_set',
    description:
      "Write a secret to the vault under the given scope (same scope semantics as iyke_secret_get). Triggers a re-dump of the runtime env-vault file so sidecars and per-call MCP children pick up the new value on next spawn. Use this sparingly — secrets are sensitive and the values land in the user's encrypted Stronghold snapshot.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_secret_delete',
    description:
      'Delete a secret from the given scope. Same scope semantics as iyke_secret_get. Returns ok even if the key did not exist. Does not touch the legacy unscoped key — to clean up legacy entries, delete the value at the unscoped key directly.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_secret_list',
    description:
      'List secret KEY NAMES (not values) in a scope. Same scope semantics as iyke_secret_get. Returns sorted bare key names — the scope prefix is stripped. Use to inventory what secrets are stored in a project without revealing values.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  // Phase 6 — pane layout per project.
  {
    name: 'iyke_layout_get',
    description:
      'Get the saved layout (pane tree, files-explorer state, panel sizes) for a project. Returns the raw layout_state row contents — each field is the JSON the shell wrote, or null when nothing has been saved for that key. Defaults to the active project; pass project_id to query a specific one. Useful for the conductor pattern (an agent inspecting "what does this project look like to the user").',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_layout_reset',
    description:
      "Reset a project's saved layout — deletes the pane tree, files-explorer state, and panel sizes rows. Next time the user (or anyone) switches to this project, the layout-swap orchestrator finds no saved state and leaves the current view in place. Use this to recover from a wedged layout or as part of a clean-slate workflow.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
  // Phase 4 — Claude-config asset discovery + pin resolution.
  {
    name: 'iyke_claude_assets_list',
    description:
      'List Claude-config assets (skills, agents, commands, hooks, mcps) discovered for a project, grouped by provider tier. Returns a tree where each asset name maps to one or more AssetSource entries; multiple entries on the same name indicate a conflict between tiers. Defaults to the active project; pass project_id to query a specific one. Use this to see what an agent will actually load in a project context.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['skill', 'agent', 'command', 'hook', 'mcp'],
          description: 'Optional. Filter to one asset kind.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_claude_asset_pin',
    description:
      'Pin a preferred provider for a Claude-config asset name in a scope. When discovery finds the same asset name in multiple tiers (e.g. a `code-reviewer` agent in both ~/.claude/ and a project pkg), the lowest tier wins by default; a pin overrides that. Scope is "workspace" (cross-project) or "project:<id>" (this project only). preferred_tier is one of personal | workspace_pkg | project | project_pkg. preferred_source is the pkg id (or "personal" for ~/.claude/) — omit to match any source in the tier.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Either "workspace" or "project:<id>".',
        },
        asset_kind: { type: 'string', enum: ['skill', 'agent', 'command', 'hook', 'mcp'] },
        asset_name: { type: 'string' },
        preferred_tier: {
          type: 'string',
          enum: ['personal', 'workspace_pkg', 'project', 'project_pkg'],
        },
        preferred_source: { type: 'string' },
      },
      required: ['scope', 'asset_kind', 'asset_name', 'preferred_tier'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_claude_asset_unpin',
    description:
      'Remove a pinned resolution. Falls back to the default lowest-tier-wins rule.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        asset_kind: { type: 'string', enum: ['skill', 'agent', 'command', 'hook', 'mcp'] },
        asset_name: { type: 'string' },
      },
      required: ['scope', 'asset_kind', 'asset_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_claude_asset_list_pins',
    description:
      'List Claude-config asset pins for a scope. Scope is "workspace" (cross-project) or "project:<id>" (this project only). Returns one entry per pin with preferred_tier + preferred_source.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Either "workspace" or "project:<id>".',
        },
      },
      required: ['scope'],
      additionalProperties: false,
    },
  },
  // ── Phase 1 memory + coordination primitives ─────────────────────────────
  {
    name: 'iyke_agent_register',
    description:
      'Register this agent so locks and timers can attribute work to it. Returns an opaque id. Pass the id as holder to iyke_lock_acquire. Repeated calls with the same {id} bump last_seen_at; omit id to mint a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional. Caller-supplied id (e.g. session-derived). Server mints one if omitted.' },
        name: { type: 'string', description: 'Display name, e.g. "claude-conductor".' },
        model: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_scratchpad_write',
    description:
      'Create or replace a project-scoped Markdown scratchpad. Use for plans, handoffs, working context that should outlive a chat. `scope` defaults to the active project (project:<active_id>); pass "workspace" or "pkg:<id>" to opt out. `name` is a slug unique within scope. Body cap 1 MB.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        name: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_scratchpad_append',
    description:
      'Append to a scratchpad without overwriting. Creates it if missing. `with_separator=true` (default) inserts a horizontal rule + timestamp between the prior body and the new content.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        name: { type: 'string' },
        body: { type: 'string' },
        with_separator: { type: 'boolean', default: true },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_scratchpad_read',
    description: 'Read a scratchpad by scope+name. 404 if missing. Returns id, body, updated_at.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_scratchpad_list',
    description:
      'List scratchpads in a scope (defaults to active project). Each entry has id, name, updated_at, and a 200-char preview.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_scratchpad_delete',
    description: 'Delete a scratchpad by scope+name. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_kv_set',
    description:
      'Store a small JSON value at scope+key. Cap 64 KB per value; cap 1 MB total per scope. For larger durable text, use scratchpads. Scope defaults to active project.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, key: { type: 'string' }, value: {} },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_kv_get',
    description: 'Read a JSON value at scope+key. Returns { key, value: null } if absent (200, not 404).',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_kv_delete',
    description: 'Delete a KV entry. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_kv_list',
    description: 'List KV entries in a scope. `prefix` filter narrows by key prefix.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, prefix: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_lock_acquire',
    description:
      'Acquire a project-scoped lease lock on a named resource. Use for short-lived coordination around shared files, plans, migrations. holder is the agent id from iyke_agent_register. ttl_ms defaults to 60000 (clamped to [1000, 600000]). If wait_ms is set, blocks up to that long for an existing lock to expire.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        resource: { type: 'string' },
        holder: { type: 'string' },
        ttl_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
        wait_ms: { type: 'integer', minimum: 0, maximum: 30000 },
      },
      required: ['resource', 'holder'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_lock_status',
    description: 'Check whether a resource is currently locked (active leases only). Returns held=false if the lease has expired.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, resource: { type: 'string' } },
      required: ['resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_lock_release',
    description: 'Release a lock you hold. No-op if held by someone else or already expired.',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, resource: { type: 'string' }, holder: { type: 'string' } },
      required: ['resource', 'holder'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_lock_renew',
    description: 'Extend a lock you hold by ttl_ms. Useful for long-running work that needs more time than the original lease.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        resource: { type: 'string' },
        holder: { type: 'string' },
        ttl_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
      },
      required: ['resource', 'holder'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_todo_create',
    description:
      'Create a project-scoped todo. Tags are free-form strings; assignee is a free-form name (agent or user). Set blocker_id to mark this todo as blocked by another.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        assignee: { type: 'string' },
        blocker_id: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_todo_update',
    description: 'Partial update of a todo. Only supplied fields are changed. Pass status="done" or use iyke_todo_complete for the common case.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'] },
        title: { type: 'string' },
        body: { type: 'string' },
        assignee: { type: 'string' },
        blocker_id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_todo_list',
    description: 'List todos in a scope (defaults to active project). Filter by status, tag, assignee.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'] },
        tag: { type: 'string' },
        assignee: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_todo_complete',
    description: 'Mark a todo as done and stamp completed_at. Equivalent to iyke_todo_update with status=done.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_timer_schedule',
    description:
      'Schedule a one-shot timer in the active project (or specified scope). Pass either fire_at (absolute epoch-ms) or delay_ms (relative from now), not both. When the timer fires the shell emits an OS notification; if agent_id is set, an entry also lands in that agent\'s inbox (delivered on its next tool call, 24h TTL).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        title: { type: 'string', description: 'Notification title. <=300 chars.' },
        body: { type: 'string', description: 'Optional notification body. <=4 KB.' },
        agent_id: { type: 'string', description: 'Registered agent id to deliver an inbox event to on fire.' },
        fire_at: { type: 'integer', description: 'Absolute fire time, unix epoch ms. Mutually exclusive with delay_ms.' },
        delay_ms: { type: 'integer', minimum: 0, description: 'Fire delay from now, ms. Mutually exclusive with fire_at.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_timer_cancel',
    description: 'Cancel a pending timer by id. No-op if already fired or cancelled. Returns { cancelled: bool }.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_timer_list',
    description: 'List timers in a scope (defaults to active project). Optional status filter: pending | fired | cancelled. Returns timers sorted by fire_at ascending.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'fired', 'cancelled'] },
      },
      additionalProperties: false,
    },
  },
  // ── Phase 2 pkg project-scoping ───────────────────────────────────────
  {
    name: 'iyke_pkg_list',
    description:
      'List installed pkgs visible from the active project. Workspace-scoped pkgs are always included; project-scoped pkgs are included only when their project is active unless include_other_projects=true. Each entry: id, version, install_path, enabled, source, scope ("workspace" | "project:<id>"), active_now.',
    inputSchema: {
      type: 'object',
      properties: {
        include_other_projects: { type: 'boolean', default: false },
        kind: { type: 'string', enum: ['workspace', 'project'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_pkg_install_scope_set',
    description:
      'Change the scope of an installed pkg. scope="workspace" (always loaded) or "project:<id>" (loaded only when that project is active). Triggers a kernel reconcile so sidecars start/stop accordingly.',
    inputSchema: {
      type: 'object',
      properties: {
        pkg_id: { type: 'string' },
        scope: { type: 'string' },
      },
      required: ['pkg_id', 'scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_pkg_uninstall',
    description:
      'Uninstall a pkg. Stops its sidecars, removes its registry entries, deletes its files. Project-scoped state in iyke_kv / iyke_scratchpads / iyke_todos survives. Builtins (com.ikenga.*) cannot be uninstalled.',
    inputSchema: {
      type: 'object',
      properties: { pkg_id: { type: 'string' } },
      required: ['pkg_id'],
      additionalProperties: false,
    },
  },
  // Artifact-grid pin comments (artifact-grid v0). The routing dispatcher
  // pastes a one-line `address pin #<id>` prompt into the active claude PTY;
  // claude then uses `iyke_pin_read` to fetch the full structured payload
  // (artifact path, selector, comment text, screenshot file path). On
  // starting work it calls `iyke_pin_acknowledge` so the grid cell can show
  // the in-progress status; on completion `iyke_pin_resolve` (or the user
  // resolves manually from the grid right-click menu).
  {
    name: 'iyke_pin_read',
    description:
      'Fetch the full payload for an artifact-grid pin by id. The routing dispatcher pastes a short prompt referencing the pin id; call this tool to retrieve the structured context — artifact_path (the .html file on disk), selector (CSS selector inside the artifact iframe), text (the user\'s comment body), screenshot_path (local PNG of the targeted element, may be null), plus lifecycle stamps. Use the path + selector + text to reason about and execute the requested change. 404 if the pin no longer exists.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Pin id as posted by the dispatcher.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_pin_acknowledge',
    description:
      'Transition a pin from `open` to `in_progress`. Call this once you\'ve read the pin and started working — the grid cell\'s pin dot flips to kola-amber so the user sees you\'re on it. Idempotent: later calls leave the existing `acknowledged_at` timestamp intact.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_pin_resolve',
    description:
      'Transition a pin to `resolved`. Call this after committing the change you set out to make — the grid cell\'s pin dot flips to verdigris (resolved). Users can also resolve manually from the grid right-click menu; this is the agent-initiated path for closing the loop without bouncing back to the human. Stamps `resolved_at` on first transition; idempotent on re-calls.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_pa_actions_pause',
    description:
      "Pause a batch of drafted actions into the Ikenga approve gate for operator sign-off (ux_mode: approve). Call this INSTEAD of performing the side effect (sending an email, posting, etc.) once you have drafted the outgoing items: it writes them to the gate at /outbox/approvals where the operator edits + approves, then STOP — the operator's approval drives the real send, not you. Each draft's `payload` must be `{ item: DraftItem, meta: ApproveGateMeta }` (the draft content + batch metadata).",
    inputSchema: {
      type: 'object',
      properties: {
        batchId: { type: 'string', description: 'A unique id for this pause batch.' },
        actionId: { type: 'string', description: 'The action id, e.g. "<pkgId>/<verb>".' },
        drafts: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              channel: { type: 'string', description: 'smtp | resend | listmonk | buffer' },
              scheduledAt: { type: 'string' },
              payload: {
                type: 'object',
                description: '{ item: DraftItem, meta: ApproveGateMeta } — the draft + batch meta.',
              },
            },
            required: ['id', 'channel', 'payload'],
            additionalProperties: false,
          },
        },
      },
      required: ['batchId', 'actionId', 'drafts'],
      additionalProperties: false,
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]['name'];

function getClient(): IykeClient {
  const outcome = load();
  switch (outcome.kind) {
    case 'ok':
      return new IykeClient(outcome.control);
    case 'missing':
      throw new McpError(
        ErrorCode.InternalError,
        'Ikenga desktop app does not appear to be running (no control.json found).',
      );
    case 'stale-removed':
      throw new McpError(
        ErrorCode.InternalError,
        'Ikenga desktop app does not appear to be running (cleared a stale control.json from a previous launch).',
      );
    case 'stale-young':
      throw new McpError(
        ErrorCode.InternalError,
        `control.json exists but its PID is dead and the file is only ${outcome.ageSecs}s old (threshold ${STALE_THRESHOLD_SECS}s). The app may be launching or in a startup race; retry shortly.`,
      );
  }
}

// The ngwa snapshot's first call does a cold transcript scan (~100 s on a
// post-0065 database) — the default 5 s GET timeout would abort mid-scan,
// so this uses the same 130 s budget as `iyke ngwa`. A bare 404 means the
// shell predates the pending WP-28 route; say so instead of parroting it.
async function ngwaSnapshot(client: IykeClient): Promise<NgwaSnapshot> {
  try {
    return (await client.get(
      NGWA_SNAPSHOT_PATH,
      undefined,
      NGWA_SNAPSHOT_TIMEOUT_MS,
    )) as NgwaSnapshot;
  } catch (e) {
    if (isRouteMissing(e)) {
      throw routeMissingError(
        NGWA_SNAPSHOT_PATH,
        "the HTTP twin of WP-14's `ngwa_snapshot` Tauri command",
        e,
      );
    }
    throw e;
  }
}

async function dispatch(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  const client = getClient();
  switch (name) {
    case 'iyke_state':
      return client.get('/iyke/state');
    case 'iyke_go':
      return client.post('/iyke/go', { path: args.path });
    case 'iyke_mode':
      return client.post('/iyke/mode', { mode: args.mode });
    case 'iyke_open':
      return client.post('/iyke/open', args);
    case 'iyke_split':
      return client.post('/iyke/split', {
        direction: args.direction,
        pane_id: args.pane_id ?? null,
      });
    case 'iyke_focus':
      return client.post('/iyke/focus', {
        pane_id: args.pane_id ?? null,
        index: args.index ?? null,
      });
    case 'iyke_close':
      return client.post('/iyke/close', { pane_id: args.pane_id ?? null });
    case 'iyke_dom':
      return client.get('/iyke/dom', {
        query: args.query,
        all: args.all,
        pane: args.pane,
      });
    case 'iyke_logs':
      return client.get('/iyke/logs', {
        level: args.level,
        since: args.since,
        source: args.source,
      });
    case 'iyke_network':
      return client.get('/iyke/network', {
        since: args.since,
        source: args.source,
      });
    case 'iyke_screenshot': {
      const target = (args.target as string) ?? 'window';
      const path = target === 'pane' ? '/iyke/screenshot/pane' : '/iyke/screenshot/window';
      const body: Record<string, unknown> = {};
      if (args.out_path !== undefined) body.out_path = args.out_path;
      if (target === 'pane') {
        if (!args.pane_id) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'pane_id required when target=pane',
          );
        }
        body.pane_id = args.pane_id;
      }
      return client.post(path, body, 15000);
    }
    case 'iyke_wait': {
      const timeoutMs =
        typeof args.timeout_ms === 'number' ? args.timeout_ms : 10_000;
      return client.post(
        '/iyke/wait',
        {
          kind: args.kind,
          value: args.value,
          timeout_ms: timeoutMs,
          pane: args.pane ?? null,
        },
        timeoutMs + 2_000,
      );
    }
    case 'iyke_click':
      return client.post('/iyke/click', {
        ref: args.ref ?? null,
        selector: args.selector ?? null,
        text: args.text ?? null,
        pane: args.pane ?? null,
      });
    case 'iyke_type':
      return client.post('/iyke/type', {
        ref: args.ref ?? null,
        selector: args.selector ?? null,
        text: args.text,
        replace: args.replace === true,
        pane: args.pane ?? null,
      });
    case 'iyke_key':
      return client.post('/iyke/key', {
        combo: args.combo,
        ref: args.ref ?? null,
        selector: args.selector ?? null,
        pane: args.pane ?? null,
      });
    case 'iyke_query_cache':
      return client.get('/iyke/query-cache', { pane: args.pane });
    case 'iyke_devtools':
      return client.post('/iyke/devtools', {});
    case 'iyke_iframe_state':
      return client.get('/iyke/iframe-state', { pane: args.pane });
    case 'iyke_iframe_send':
      return client.post('/iyke/iframe-message', {
        pane: args.pane,
        kind: args.kind,
        payload: args.payload ?? null,
      });
    case 'iyke_project_create':
      return client.post('/iyke/project/create', {
        id: args.id,
        display_name: args.display_name,
        root_path: args.root_path ?? null,
        icon: args.icon ?? null,
        color: args.color ?? null,
        description: args.description ?? null,
      });
    case 'iyke_project_update':
      return client.post('/iyke/project/update', {
        id: args.id,
        patch: args.patch ?? {},
      });
    case 'iyke_project_list':
      return client.get('/iyke/project/list', {
        include_archived: args.include_archived === true,
      });
    case 'iyke_project_archive':
      return client.post('/iyke/project/archive', { id: args.id });
    case 'iyke_project_set_active':
      return client.post('/iyke/project/set-active', { id: args.id });
    case 'iyke_project_get_active':
    case 'iyke_project_show':
      return client.get('/iyke/project/active');
    case 'iyke_project_switch': {
      const target = typeof args.path === 'string' ? args.path : '';
      const res = (await client.get('/iyke/project/list')) as {
        projects?: ProjectListEntry[];
      };
      const id = resolveProjectId(res.projects ?? [], target);
      return client.post('/iyke/project/set-active', { id });
    }
    case 'iyke_project_sections':
      try {
        return await client.get(EXPLORER_SECTIONS_PATH);
      } catch (e) {
        if (isRouteMissing(e)) {
          throw routeMissingError(
            EXPLORER_SECTIONS_PATH,
            'the Explorer section registry',
            e,
          );
        }
        throw e;
      }
    case 'iyke_ngwa_installed':
    case 'iyke_ngwa_store':
    case 'iyke_ngwa_scopes':
    case 'iyke_ngwa_health':
      return ngwaSnapshot(client);
    case 'iyke_ngwa_item':
      return findNgwaItem(await ngwaSnapshot(client), String(args.id));
    case 'iyke_session_list':
      return client.get('/iyke/session/list', {
        project_id: args.project_id ?? undefined,
        include_all: args.include_all === true,
        limit: args.limit,
      });
    case 'iyke_session_move':
      return client.post('/iyke/session/move', {
        thread_id: args.thread_id,
        project_id: args.project_id,
      });
    case 'iyke_session_start_in_project':
      return client.post('/iyke/session/start', {
        project_id: args.project_id,
        initial_prompt: args.initial_prompt ?? null,
        cwd: args.cwd ?? null,
      });
    case 'iyke_chi_run':
      return client.post(
        '/iyke/chi/run',
        {
          engineId: args.engine_id,
          prompt: args.prompt,
          cwd: args.cwd ?? null,
          model: args.model ?? null,
          mode: args.mode ?? null,
          parentId: args.parent_id ?? null,
          resumeSessionId: args.resume_session_id ?? null,
          timeoutSeconds: args.timeout_seconds ?? null,
        },
        130_000,
      );
    case 'iyke_chi_resume':
      return client.post('/iyke/chi/resume', {
        runId: args.run_id,
        prompt: args.prompt,
      });
    case 'iyke_chi_status':
      return client.get('/iyke/chi/status', { runId: args.run_id });
    case 'iyke_chi_list':
      return client.get('/iyke/chi/list', {
        engineId: args.engine_id,
        limit: args.limit,
      });
    case 'iyke_chi_cancel':
      return client.post('/iyke/chi/cancel', { runId: args.run_id });
    case 'iyke_mcp_list':
      return client.get('/iyke/mcp/list', {
        project_id: args.project_id,
      });
    case 'iyke_mcp_restart':
      return client.post('/iyke/mcp/restart', {
        pkg_id: args.pkg_id,
      });
    case 'iyke_pkg_trust_status': {
      // Bridge has a list endpoint, not a per-pkg one — fetch + filter so
      // agents get a single-shape response. Cheap; trust list is short.
      const res = (await client.get('/iyke/trust/list')) as {
        entries?: Array<{ pkg_id: string }>;
      };
      const match = (res.entries ?? []).find((e) => e.pkg_id === args.pkg_id);
      if (!match) {
        return { error: `pkg \`${args.pkg_id}\` not installed` };
      }
      return match;
    }
    case 'iyke_pkg_trust_list':
      return client.get('/iyke/trust/list');
    case 'iyke_pkg_violations_list':
      return client.get('/iyke/violations/list', {
        pkg_id: args.pkg_id,
        limit: args.limit,
      });
    case 'iyke_secret_get':
      return client.get('/iyke/secret/get', {
        scope: args.scope,
        key: args.key,
      });
    case 'iyke_secret_set':
      return client.post('/iyke/secret/set', {
        scope: args.scope ?? null,
        key: args.key,
        value: args.value,
      });
    case 'iyke_secret_delete':
      return client.post('/iyke/secret/delete', {
        scope: args.scope ?? null,
        key: args.key,
      });
    case 'iyke_secret_list':
      return client.get('/iyke/secret/list', {
        scope: args.scope,
      });
    case 'iyke_layout_get':
      return client.get('/iyke/layout/get', {
        project_id: args.project_id,
      });
    case 'iyke_layout_reset':
      return client.post('/iyke/layout/reset', {
        project_id: args.project_id,
      });
    case 'iyke_claude_assets_list':
      return client.get('/iyke/claude/assets', {
        project_id: args.project_id,
        kind: args.kind,
      });
    case 'iyke_claude_asset_pin':
      return client.post('/iyke/claude/asset/pin', {
        scope: args.scope,
        asset_kind: args.asset_kind,
        asset_name: args.asset_name,
        preferred_tier: args.preferred_tier,
        preferred_source: args.preferred_source ?? null,
      });
    case 'iyke_claude_asset_unpin':
      return client.post('/iyke/claude/asset/unpin', {
        scope: args.scope,
        asset_kind: args.asset_kind,
        asset_name: args.asset_name,
      });
    case 'iyke_claude_asset_list_pins':
      return client.get('/iyke/claude/asset/pins', {
        scope: args.scope,
      });
    // ── Phase 1 memory primitives ────────────────────────────────────────
    case 'iyke_agent_register':
      return client.post('/iyke/agent/register', {
        id: args.id ?? null,
        name: args.name,
        model: args.model ?? null,
        metadata: args.metadata ?? null,
      });
    case 'iyke_scratchpad_write':
      return client.post('/iyke/scratchpad/write', {
        scope: args.scope ?? null,
        name: args.name,
        body: args.body,
      });
    case 'iyke_scratchpad_append':
      return client.post('/iyke/scratchpad/append', {
        scope: args.scope ?? null,
        name: args.name,
        body: args.body,
        with_separator: args.with_separator !== false,
      });
    case 'iyke_scratchpad_read':
      return client.get('/iyke/scratchpad/read', {
        scope: args.scope,
        name: args.name,
      });
    case 'iyke_scratchpad_list':
      return client.get('/iyke/scratchpad/list', { scope: args.scope });
    case 'iyke_scratchpad_delete':
      return client.post('/iyke/scratchpad/delete', {
        scope: args.scope ?? null,
        name: args.name,
      });
    case 'iyke_pa_actions_pause':
      return client.post('/iyke/pa-actions/pause', {
        batchId: args.batchId,
        actionId: args.actionId,
        drafts: args.drafts,
      });
    case 'iyke_kv_set':
      return client.post('/iyke/kv/set', {
        scope: args.scope ?? null,
        key: args.key,
        value: args.value,
      });
    case 'iyke_kv_get':
      return client.get('/iyke/kv/get', { scope: args.scope, key: args.key });
    case 'iyke_kv_delete':
      return client.post('/iyke/kv/delete', {
        scope: args.scope ?? null,
        key: args.key,
      });
    case 'iyke_kv_list':
      return client.get('/iyke/kv/list', { scope: args.scope, prefix: args.prefix });
    case 'iyke_lock_acquire':
      return client.post(
        '/iyke/lock/acquire',
        {
          scope: args.scope ?? null,
          resource: args.resource,
          holder: args.holder,
          ttl_ms: args.ttl_ms ?? null,
          wait_ms: args.wait_ms ?? null,
        },
        // Acquire may wait up to wait_ms; pad the HTTP timeout by 2s.
        typeof args.wait_ms === 'number' ? args.wait_ms + 2000 : undefined,
      );
    case 'iyke_lock_status':
      return client.get('/iyke/lock/status', {
        scope: args.scope,
        resource: args.resource,
      });
    case 'iyke_lock_release':
      return client.post('/iyke/lock/release', {
        scope: args.scope ?? null,
        resource: args.resource,
        holder: args.holder,
      });
    case 'iyke_lock_renew':
      return client.post('/iyke/lock/renew', {
        scope: args.scope ?? null,
        resource: args.resource,
        holder: args.holder,
        ttl_ms: args.ttl_ms ?? null,
      });
    case 'iyke_todo_create':
      return client.post('/iyke/todo/create', {
        scope: args.scope ?? null,
        title: args.title,
        body: args.body ?? null,
        tags: args.tags ?? [],
        assignee: args.assignee ?? null,
        blocker_id: args.blocker_id ?? null,
      });
    case 'iyke_todo_update':
      return client.post('/iyke/todo/update', {
        id: args.id,
        status: args.status ?? null,
        title: args.title ?? null,
        body: args.body ?? null,
        assignee: args.assignee ?? null,
        blocker_id: args.blocker_id ?? null,
      });
    case 'iyke_todo_list':
      return client.get('/iyke/todo/list', {
        scope: args.scope,
        status: args.status,
        tag: args.tag,
        assignee: args.assignee,
      });
    case 'iyke_todo_complete':
      return client.post('/iyke/todo/complete', { id: args.id });
    case 'iyke_timer_schedule':
      return client.post('/iyke/timer/schedule', {
        scope: args.scope ?? null,
        title: args.title,
        body: args.body ?? null,
        agent_id: args.agent_id ?? null,
        fire_at: args.fire_at ?? null,
        delay_ms: args.delay_ms ?? null,
      });
    case 'iyke_timer_cancel':
      return client.post('/iyke/timer/cancel', { id: args.id });
    case 'iyke_timer_list':
      return client.get('/iyke/timer/list', {
        scope: args.scope,
        status: args.status,
      });
    case 'iyke_pkg_list':
      return client.get('/iyke/pkg/list', {
        include_other_projects: args.include_other_projects,
        kind: args.kind,
      });
    case 'iyke_pkg_install_scope_set':
      return client.post('/iyke/pkg/scope-set', {
        pkg_id: args.pkg_id,
        scope: args.scope,
      });
    case 'iyke_pkg_uninstall':
      return client.post('/iyke/pkg/uninstall', { pkg_id: args.pkg_id });
    // Artifact-grid pin comments.
    case 'iyke_pin_read':
      return client.get('/iyke/pin/read', { id: args.id });
    case 'iyke_pin_acknowledge':
      return client.post('/iyke/pin/acknowledge', { id: args.id });
    case 'iyke_pin_resolve':
      return client.post('/iyke/pin/resolve', { id: args.id });
  }
}

async function main() {
  const server = new Server(
    { name: 'iyke-mcp', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!TOOLS.some((t) => t.name === name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const result = await dispatch(name as ToolName, (args ?? {}) as Record<string, unknown>);
      return {
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      if (err instanceof McpError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Surface as a normal tool result with isError so Claude can read
      // and react instead of treating it as a transport-level failure.
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('iyke-mcp fatal:', err);
  process.exit(1);
});
