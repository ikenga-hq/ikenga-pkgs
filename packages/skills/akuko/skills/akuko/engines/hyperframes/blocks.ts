// The akuko block set (blocks/compositions/*.html) and how to mount one on its own. Pure; no I/O.

import { HYPERFRAMES_GSAP_VERSION } from './cli.ts';

/** Every block, by file stem. The stem is also its host id, composition id and timeline key. */
export const BLOCKS = [
  'stat',
  'reveal-list',
  'highlight-words',
  'ken-burns',
  'annotation',
  'chat-bubble',
  'avatar-badge',
  'caption-bar',
] as const;

export type BlockId = (typeof BLOCKS)[number];

/** GSAP as HyperFrames expects it: this URL is served from HyperFrames' own vendored copy. */
export const GSAP_URL = `https://cdn.jsdelivr.net/npm/gsap@${HYPERFRAMES_GSAP_VERSION}/dist/gsap.min.js`;

export interface MountOptions {
  /** Slot length in seconds. Default 5. */
  duration?: number;
  /** Per-mount variable values (data-variable-values). */
  values?: Record<string, string | number | boolean>;
}

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

/**
 * A root composition (index.html) that mounts one block for `duration` seconds, for
 * `hyperframes lint` / `check` / `snapshot` / `render` of that block alone. Lay the project out
 * like blocks/: this index.html, compositions/<block>.html and fonts/.
 */
export function hostHtml(block: BlockId, o: MountOptions = {}): string {
  const d = o.duration ?? 5;
  if (!(d > 0)) throw new RangeError('duration must be > 0');
  const values = o.values ? ` data-variable-values='${attr(JSON.stringify(o.values))}'` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>${block}</title>
    <script src="${GSAP_URL}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #0d0b0a; }
      #ground { position: absolute; inset: 0; background: #0d0b0a; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${d}" data-width="1920" data-height="1080" data-fps="30">
      <div id="ground"></div>
      <div id="${block}" data-composition-id="${block}" data-composition-src="compositions/${block}.html" data-start="0" data-duration="${d}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"${values}></div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}

/** The `const MOTION = {...};` object a block carries inline, parsed; null when absent. */
export function inlineMotion(html: string): unknown {
  const m = /const MOTION = (\{.*?\});/.exec(html);
  return m?.[1] ? JSON.parse(m[1]) : null;
}

/** Font files a block's @font-face rules point at. */
export function fontFiles(html: string): string[] {
  return [...html.matchAll(/url\("fonts\/([^"]+)"\)/g)].map((m) => m[1] as string);
}
