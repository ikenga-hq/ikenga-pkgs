// React + htm via esm.sh — no JSX transpile needed. Forkers edit JS, reload.
//
// SOURCE OF TRUTH (WP-19). This is the single, byte-identical UI runtime vendored
// into every no-build app pkg's dist/lib/ui.js. It supersedes the ~80%-shared
// per-pkg copies; the only thing that used to diverge was each pkg's slice of the
// icon dictionary, so this file carries the UNION of every pkg's glyphs (70) — a
// pkg simply ignores the names it never references. Never hand-edit a vendored
// copy; edit here and re-run the pkg's scripts/build.mjs.
//
// htm uses tagged template literals to render React elements. Same mental model
// as JSX (component tags, expressions in ${}), just without a build step.

import * as React from 'https://esm.sh/react@19.0.0';
import * as ReactDOMClient from 'https://esm.sh/react-dom@19.0.0/client';
import htm from 'https://esm.sh/htm@3.1.1';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from 'https://esm.sh/@tanstack/react-query@5?deps=react@19.0.0';

export const {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useReducer,
  Fragment,
} = React;
export const createRoot = ReactDOMClient.createRoot;
export const html = htm.bind(React.createElement);

// TanStack Query — caching layer carried over from the source app (triage
// counts query + list/detail caches). Pinned to the source's installed major
// (@tanstack/react-query ^5.100.6 → 5). `?deps=react@19` keeps a single React.
export {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
};

// Tiny icon helper — lucide-static SVG paths inlined as needed to avoid an
// extra CDN hop (the source apps used lucide-react; we mirror suite's inline
// pattern instead). WP-19 UNION of every pkg's glyphs; add more as features need.
const ICONS = {
  'calendar-clock': "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5M16 2v4M8 2v4M3 10h5M17.5 17.5 16 16.3V14M22 16a6 6 0 1 1-12 0 6 6 0 0 1 12 0z",
  'copy': "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  'external-link': "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
  'grip-vertical': "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  'image': "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21",
  'image-off': "M2 2l20 20M10.41 10.41a2 2 0 1 1-2.83-2.83M13.5 13.5 6 21M18 12l3 3M3.59 3.59A2 2 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.05-.22 1.41-.59M21 15V5a2 2 0 0 0-2-2H9",
  'keyboard': "M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 17h8M10 13h4",
  'layers': "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  'link': "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  'maximize-2': "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  'message-square': "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  'rotate-ccw': "M1 4v6h6M3.51 15a9 9 0 1 0 2.13-9.36L1 10",
  'sliders': "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  'alert-circle': "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 16h.01",
  'alert-triangle': "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
  archive: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
  'arrow-down': "M12 5v14M19 12l-7 7-7-7",
  'arrow-left': "M19 12H5M12 5l-7 7 7 7",
  'arrow-right': "M5 12h14M12 5l7 7-7 7",
  'bar-chart-2': "M18 20V10M12 20V4M6 20v-6",
  'book-open': "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z",
  broom: "M9.8 12.2 5 17l3 3 4.8-4.8M14 8l-3.5 3.5 4 4L18 12l-4-4z M14 8l5-5M19 3l2 2",
  calendar: "M3 4h18v18H3V4zM16 2v4M8 2v4M3 10h18",
  'calendar-days': "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01",
  check: "M20 6L9 17l-5-5",
  'check-check': "M18 6 7 17l-5-5M22 10l-7.5 7.5L13 16",
  'check-circle': "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3",
  'check-square': "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  'chevron-down': "M6 9l6 6 6-6",
  'chevron-left': "M15 18l-6-6 6-6",
  'chevron-right': "M9 18l6-6-6-6",
  'chevron-up': "M18 15l-6-6-6 6",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  'corner-down-left': "M9 10l-5 5 5 5M4 15h7a4 4 0 0 0 4-4V5",
  'edit-3': "M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  'file-text': "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  filter: "M22 3H2l8 9.46V19l4 2v-8.54L22 3z",
  'git-branch': "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  inbox: "M22 12h-6l-2 3H10l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  linkedin: "M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2zM4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  loader: "M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  'more-horizontal': "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  people: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  'play-circle': "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM10 8l6 4-6 4V8z",
  plus: "M5 12h14M12 5v14",
  radio: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4.93 4.93a10 10 0 0 0 0 14.14M19.07 4.93a10 10 0 0 1 0 14.14M7.76 7.76a6 6 0 0 0 0 8.49M16.24 7.76a6 6 0 0 1 0 8.49",
  'refresh-cw': "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  search: "M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM21 21l-4.35-4.35",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  share2: "M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98M21 5a3 3 0 1 0-6 0 3 3 0 0 0 6 0zM9 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0zM21 19a3 3 0 1 0-6 0 3 3 0 0 0 6 0z",
  'skip-forward': "M5 4l10 8-10 8V4zM19 5v14",
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  stethoscope: "M11 2v2M5 2v2M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1M8 15a6 6 0 0 0 12 0v-3M20 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  tag: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01",
  terminal: "M4 17l6-6-6-6M12 19h8",
  timer: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6M16.24 16.24l-4.24-4.24M4.93 4.93l14.14 14.14",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  'trending-up': "M23 6l-9.5 9.5-5-5L1 18M17 6h6v6",
  twitter: "M23 3a10.9 10.9 0 0 1-3.14 1.53 4.48 4.48 0 0 0-7.86 3v1A10.66 10.66 0 0 1 3 4s-4 9 5 13a11.64 11.64 0 0 1-7 2c9 5 20 0 20-11.5a4.5 4.5 0 0 0-.08-.83A7.72 7.72 0 0 0 23 3z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  x: "M18 6L6 18M6 6l12 12",
  'x-circle': "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM15 9l-6 6M9 9l6 6",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
};

// Class-name joiner — replaces clsx + tailwind-merge. With Tailwind gone there
// are no utility conflicts to dedupe, so a truthy-join is sufficient.
export function cn(...inputs) {
  /** @type {string[]} */ const out = [];
  for (const i of inputs) {
    if (!i) continue;
    if (typeof i === 'string') out.push(i);
    else if (Array.isArray(i)) out.push(cn(...i));
    else if (typeof i === 'object') {
      for (const k of Object.keys(i)) if (i[k]) out.push(k);
    }
  }
  return out.join(' ');
}

// Button — ported from src/components/Button.tsx. Tailwind utility classes
// became .tk-btn / sz-* / v-* rules in the pkg's domain CSS.
export function Button({ variant = 'default', size = 'md', class: cls = '', children, ...props }) {
  const className = ['tk-btn', `sz-${size}`, `v-${variant}`, cls]
    .filter(Boolean)
    .join(' ');
  return html`<button class=${className} ...${props}>${children}</button>`;
}

export function Icon({ name, size = 16, className, strokeWidth = 2 }) {
  const path = ICONS[name];
  if (!path) return null;
  // Multi-subpath glyphs are encoded as a single `d` string with multiple M
  // segments — render as one <path>; works for every glyph above.
  return html`<svg
    class=${className}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
  ><path d=${path} /></svg>`;
}

// Auto-growing textarea hook — the body-editor pattern for outbox/detail panes.
// A fixed-height textarea with an inner scrollbar reads as a cramped form
// field; content-sized, it reads as a document the pane scrolls naturally
// (the outer pane owns overflow). Sets height to scrollHeight on mount, on
// value change, and on container resize; CSS `field-sizing: content` will
// obsolete this once WebKitGTK ships it.
//   const ref = useAutoGrow(value);
//   html`<textarea ref=${ref} value=${value} ... style=${{ overflow: 'hidden', resize: 'none' }}></textarea>`
export function useAutoGrow(value, { minHeight = 160 } = {}) {
  const ref = React.useRef(null);
  const fit = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);
  React.useLayoutEffect(fit, [fit, value]);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement ?? el);
    return () => ro.disconnect();
  }, [fit]);
  return ref;
}
