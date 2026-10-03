// Tasks root — bridge → mount <TasksView/>.
//
// Single-feature app (unlike Suite, no feature registry / sidebar router). The
// source main.tsx mounts TasksView directly inside a QueryClientProvider; we
// mirror that. All data flows through the host bridge (host.dbQuery reads /
// host.dbExec writes) — there is no supabase-js client, so standalone (no
// parent shell) has no data backend and queries will surface a bridge error.

import {
  html,
  useState,
  useEffect,
  createRoot,
  QueryClient,
  QueryClientProvider,
} from './lib/ui.js';
import { connectBridge, isStandalone } from './lib/bridge.js';
import { operatorIdFrom } from './lib/assignees.js';
import { TasksView } from './features/tasks/tasks-view.js';
import tokensCss from './lib/tokens-css.js';
import appKitCss from './lib/app-kit-css.js';
import tasksCss from './lib/tasks-css.js';

// Styling, the no-build way. A <link>/fetch to a .css fails inside the shell's
// about:srcdoc iframe (WebKitGTK subresource bug — see index.html), so CSS
// rides the script path as JS strings and is injected as inline <style>
// (style-src 'unsafe-inline' permits it). Order matters (cascade): tokens first
// (they define --fg/--bg-base/--space-*/etc.), THEN the app-kit component layer
// (.frame*/.ip-*/.dense-row*/.tk-badge/.tk-execmode — the kit primitives tasks
// now consumes, P3 inc-3), THEN tasks.css (the slim domain residue, which is
// injected LAST so its scoped rules win over any kit base it intentionally
// overrides, e.g. the .ag-block agenda variant).
function injectCss(id, css) {
  if (document.querySelector(`style[${id}]`)) return;
  const el = document.createElement('style');
  el.setAttribute(id, '');
  el.textContent = css;
  document.head.appendChild(el);
}
// Token-alias shim REMOVED (P3 retrofit, 2026-06-03). @ikenga/tokens@0.3.0 now
// defines --live/--live-soft/--live-fg, --agent-soft, --achievement-soft,
// --fg-faint, --text-body-sm, --text-h4, --font-body, and --motion-*/--ease-*
// natively (the P0 reconciliation), so the hand-maintained drift-prone shim is
// gone. tokens-css.js below is the reconciled @ikenga/tokens (Dusk Wood);
// app-kit-css.js is the kit component layer vendored alongside it (P3 inc-3).
injectCss('data-tokens-css', tokensCss);
injectCss('data-app-kit-css', appKitCss);
injectCss('data-tasks-css', tasksCss);

// Theme — own it directly by mirroring the shell's <html> attributes, NOT via
// the AppBridge host-context push (which was unreliable: it clobbered our
// data-theme to light/dark and only fired on `mode` changes, never workspace
// theme / tint / system-OS flips). The pkg iframe is same-origin with the shell
// (srcdoc + sandbox allow-same-origin), so we read data-theme/data-mode/
// data-density/data-workspace off the parent <html> (the shell writes them — see
// shell/src/lib/ikenga/theme-store.ts) and copy them onto ours. @ikenga/tokens
// is keyed on exactly these attributes, so the bundled palette then matches the
// shell exactly across A/B/C × light/dark. A MutationObserver on the parent
// re-mirrors on every switch. Standalone (parent not same-origin-readable) we
// follow prefers-color-scheme with palette A. This is the proven artifact
// pattern — see shell/src/lib/artifact/bridge.ts setupTheme().
const APPEARANCE_ATTRS = ['data-theme', 'data-mode', 'data-density', 'data-workspace'];
const root = document.documentElement;

function readShellAppearance() {
  try {
    if (window.parent === window) return null;
    const pr = window.parent.document.documentElement;
    const mode = pr.getAttribute('data-mode');
    if (mode !== 'light' && mode !== 'dark') return null;
    return {
      'data-theme': pr.getAttribute('data-theme') || 'A',
      'data-mode': mode,
      'data-density': pr.getAttribute('data-density') || 'comfortable',
      'data-workspace': pr.getAttribute('data-workspace') || 'app',
    };
  } catch {
    return null; // cross-origin standalone embed — caller falls back to OS
  }
}

function applyAppearance(attrs) {
  for (const k of APPEARANCE_ATTRS) {
    if (attrs[k] != null) root.setAttribute(k, attrs[k]);
  }
}

function setupTheme() {
  const fromShell = readShellAppearance();
  if (fromShell) {
    applyAppearance(fromShell);
    try {
      const target = window.parent.document.documentElement;
      const obs = new MutationObserver(() => {
        const next = readShellAppearance();
        if (next) applyAppearance(next);
      });
      obs.observe(target, { attributes: true, attributeFilter: APPEARANCE_ATTRS });
    } catch {
      /* best-effort; the static apply above already themed the document */
    }
  } else {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const applyOs = () =>
      applyAppearance({
        'data-theme': 'A',
        'data-mode': mql.matches ? 'dark' : 'light',
        'data-density': 'comfortable',
        'data-workspace': 'app',
      });
    applyOs();
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', applyOs);
    else if (typeof mql.addListener === 'function') mql.addListener(applyOs);
  }
}
// Run synchronously at module eval (before React mounts) → themed first paint.
setupTheme();

// The shell side-menu is now published + maintained by TasksView (it folds in
// the live view + active-filter + triage-badge state and toggles the filter
// rows' `disabled` flag when a non-list view is active). See
// `buildTasksMenu` / the publish effect in features/tasks/tasks-view.js.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeError, setBridgeError] = useState(null);
  // Active side-menu item (shell PkgMode → hostContext.royaltiSuite.activeFeature).
  const [activeFeature, setActiveFeature] = useState(null);
  // Operator identity (hostContext.operator — see @ikenga/contract's
  // host-context). OPTIONAL: absent means an unknown operator, never a default
  // one. The shell resolves it asynchronously, so it can be missing from the
  // first handshake and arrive on a later hostContext change.
  const [operatorId, setOperatorId] = useState(null);

  useEffect(() => {
    if (isStandalone()) {
      // Standalone dev — no parent shell, so no host bridge and no data
      // backend. The view still mounts (themed first paint); data queries will
      // surface a bridge error. Mount the pkg inside the shell for live data.
      setBridgeReady(true);
      return;
    }
    // Bridge carries dispatch + activeFeature + operator only — theme is handled
    // by the parent-<html> mirror above, and data flows through host.dbQuery/dbExec.
    connectBridge({
      name: 'Tasks',
      version: '0.3.0',
      onContextChange: (ctx) => {
        const af = ctx?.royaltiSuite?.activeFeature;
        if (typeof af === 'string') setActiveFeature(af);
        // Only a payload that carries the operator updates it, so a partial
        // change (e.g. a theme switch) never wipes a known identity.
        if (ctx && 'operator' in ctx) setOperatorId(operatorIdFrom(ctx));
      },
    })
      .then((ctx) => {
        const af = ctx?.royaltiSuite?.activeFeature;
        if (typeof af === 'string') setActiveFeature(af);
        setOperatorId(operatorIdFrom(ctx));
        // The side menu is published by TasksView once it mounts (it owns the
        // view + filter state the menu reflects). No initial setMenu here.
        setBridgeReady(true);
      })
      .catch((e) => setBridgeError(e.message ?? String(e)));
  }, []);

  if (bridgeError) {
    return html`<div style=${{ padding: '2rem', color: 'var(--danger)' }}>Bridge error: ${bridgeError}</div>`;
  }
  if (!bridgeReady) {
    return html`<div style=${{ padding: '2rem', color: 'var(--fg-muted)' }}>Connecting…</div>`;
  }

  return html`<${QueryClientProvider} client=${queryClient}><${TasksView} activeFeature=${activeFeature} operatorId=${operatorId} /></${QueryClientProvider}>`;
}

createRoot(document.getElementById('root')).render(html`<${App} />`);
