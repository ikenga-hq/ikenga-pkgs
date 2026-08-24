/**
 * `export.*` tools — composition exporter surface (WP-07c, closes G-38).
 *
 * The MCP had no export surface before this. These three tools forward to
 * the sidecar `export.*` RPCs (which own ffmpeg orchestration: concat +
 * xfade transitions + narration/music audio mix → `exports/<ISO>.mp4`).
 *
 * Envelope: the post-WP-03b camelCase `{ ok: true, ... } | { ok: false,
 * error, message? }` shape (NOT the retired WP-07 snake_case mock — that's
 * being realigned separately under G-37). Every handler funnels through
 * `callSidecar`, which maps sidecar transport errors into the same envelope.
 */

import type { SidecarClient } from '../sidecar-client.js';
import { EXTERNAL_CALL_TIMEOUT_MS } from '../sidecar-client.js';
import { callSidecar } from './project.js';
import type { ToolDef } from './types.js';

export function exportTools(sidecar: SidecarClient): ToolDef[] {
  return [
    {
      name: 'export.compose',
      description:
        'Compose a project\'s rendered cells into a single deliverable MP4 (concat + transitions + narration/music mix). Selection defaults to all cells in beat order; pass `rung` to restrict to one rung or `cellIds` for an explicit ordered subset. Returns { ok:true, exportId, outputPath, reveal:true }. The export runs serially in the sidecar — poll export.status for completion.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          rung: { type: 'number', description: 'Optional. 0|1|2 — restrict to one rung.' },
          cellIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional. Explicit cell uids, in export order (wins over rung).',
          },
          music_preset: {
            type: 'string',
            enum: ['none', 'silent', 'ambient', 'upbeat'],
            description:
              'Music bed. none/silent ship now; ambient/upbeat fall back to silent until bed asset files exist (assets/music/<preset>.mp3).',
          },
          outputPath: {
            type: 'string',
            description: 'Optional. Absolute or project-relative output path; defaults to exports/<ISO-8601>.mp4.',
          },
          engine: {
            type: 'string',
            description: 'Optional. Preferred render-engine subfolder to pull cell MP4s from.',
          },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      // The sidecar enqueues and returns an exportId synchronously today (poll
      // export.status), so 30s would suffice — but this is the external-render
      // entry point, so give it the generous budget to stay correct if compose
      // ever blocks on the ffmpeg run.
      handler: (args) =>
        callSidecar(
          sidecar,
          'export.compose',
          {
            projectId: args.projectId,
            rung: args.rung,
            cellIds: args.cellIds,
            music_preset: args.music_preset,
            outputPath: args.outputPath,
            engine: args.engine,
          },
          EXTERNAL_CALL_TIMEOUT_MS,
        ),
    },
    {
      name: 'export.status',
      description:
        'Fetch the status of a single export by id. Returns { ok:true, record: { exportId, projectId, status, outputPath?, error? } }.',
      inputSchema: {
        type: 'object',
        properties: { exportId: { type: 'string' } },
        required: ['exportId'],
        additionalProperties: false,
      },
      handler: (args) => callSidecar(sidecar, 'export.status', { exportId: args.exportId }),
    },
    {
      name: 'export.list',
      description:
        'List export records (most recent first). Optionally scope to one project. Returns { ok:true, exports: [...] }.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
        additionalProperties: false,
      },
      handler: (args) => callSidecar(sidecar, 'export.list', { projectId: args.projectId }),
    },
    {
      name: 'export.read_bytes',
      description:
        "Read a finished export's MP4 off disk, base64-encoded, for in-pane composed playback as a blob: URL. Returns { ok:true, base64, mime, sizeBytes, path }. Keyed on the export id.",
      inputSchema: {
        type: 'object',
        properties: { exportId: { type: 'string' } },
        required: ['exportId'],
        additionalProperties: false,
      },
      handler: (args) => callSidecar(sidecar, 'export.read_bytes', { exportId: args.exportId }),
    },
    {
      name: 'export.check_bed',
      description:
        'Pre-flight audio-bed check: does a real music-bed file exist on disk for the chosen preset? Returns { ok:true, hasBed, willBeSilent, byDesign, path? }. none/silent are silent by design; ambient/upbeat need assets/music/<preset>.mp3.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          music_preset: { type: 'string', enum: ['none', 'silent', 'ambient', 'upbeat'] },
        },
        required: ['projectId', 'music_preset'],
        additionalProperties: false,
      },
      handler: (args) =>
        callSidecar(sidecar, 'export.check_bed', {
          projectId: args.projectId,
          music_preset: args.music_preset,
        }),
    },
    {
      name: 'export.prompt_package',
      description:
        "Produce a platform-shaped prompt bundle for a target generator that has no API (Higgsfield, Google Flow, Veo, or generic). Shapes the cell's prompt for the platform (camera-move phrasing for higgsfield, 'Ingredients'/reference framing for flow, audio-cue hints for veo, plain for generic), resolves the cell's first character/location/image anchor to a ref_image_uri, and carries aspect_ratio, duration_ms, and camera (shot_type + camera_move + camera_text). Omit cellId to package every cell. Also writes the bundle to prompts/<platform>/<cellId|'all'>.json. Returns { ok:true, platform, path, count, packages: [...] }. The returned clip comes back via render.ingest_external.",
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          cellId: {
            type: 'string',
            description: 'Optional. Package a single cell; omit to package all cells.',
          },
          platform: {
            type: 'string',
            enum: ['higgsfield', 'flow', 'veo', 'generic'],
            description: 'Target generator the prompt is shaped for.',
          },
        },
        required: ['projectId', 'platform'],
        additionalProperties: false,
      },
      handler: (args) =>
        callSidecar(sidecar, 'export.prompt_package', {
          projectId: args.projectId,
          cellId: args.cellId,
          platform: args.platform,
        }),
    },
    {
      name: 'export.davinci_timeline',
      description:
        'Export project timeline to DaVinci Resolve format (OpenTimelineIO .otio, FCPXML, or Python script). Quantizes cell durations into timecode frames, aligns video tracks with narration and music audio tracks, and includes clip metadata. Returns { ok:true, format, outputPath, clipCount }.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          format: {
            type: 'string',
            enum: ['otio', 'fcpxml', 'python_script'],
            description: 'Output format preset for DaVinci Resolve integration.',
          },
          outputPath: {
            type: 'string',
            description: 'Optional output filepath. Defaults to exports/timeline.<otio|fcpxml|py>.',
          },
          fps: {
            type: 'number',
            description: 'Target frame rate (default 24).',
          },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      handler: (args) =>
        callSidecar(sidecar, 'export.davinci_timeline', {
          projectId: args.projectId,
          format: args.format || 'otio',
          outputPath: args.outputPath,
          fps: args.fps || 24,
        }),
    },
  ];
}
