// com.ikenga.studio · Launcher (Wave 1 rebuild — concept L-A "production desk")
//
// The pre-project shell (Screen S1). Pre-empts the Pattern-C pane layout when
// no project is open (project-store isOpen === false) and unmounts once a
// project opens. Visual + behavioral spec: plans/studio/designs/redesign/
// launcher-a-production-desk.html, with grafts from L-B (teaching footer +
// dashed Custom card) and L-C (⌘K command palette).
//
// THE HONESTY RULE (this rebuild's core): render ONLY data that has a real
// seam. Recents come from the real project.recents() registry (G-47) in real
// mode — name / path / last-opened PLUS archetype / aspect / cell-count
// recorded at open time, with dead paths filtered server-side rather than
// faked — and from project.list() in mock/standalone (no matching mock tool
// case for recents). Render-coverage / exported-status for an un-opened
// project still have no seam, so those decorations stay dropped. Widgets
// whose data isn't reachable in Wave 1 are OMITTED (see the report's
// deferral list): poster thumbnails, "Latest export" card, render-engine
// stat facts, a user-name greeting.
//
// Every create/open/list call is wrapped in try/catch with a visible surface
// (toast + inline error). Open-folder consumes the shell's real picker/grant
// result honestly — cancel does nothing, denial shows "access denied", success
// opens the actually-picked path. No pkg-side trust pre-modal (the shell's
// native picker + grant dialog is the single consent surface). When that call
// times out there is nothing to open: the picked path lives only in the
// response that never arrived, so the timeout branch says so rather than
// guessing at a recents row (see openFolderFlow's catch), and the wait itself
// gets a visible banner with a cancel rather than ten silent minutes.

import { useCallback, useEffect, useRef, useState } from 'react';

import { archetypeApi, projectApi, renderApi, getMcpClient, getProbedEngines, type McpClient } from '../mcp-client';
import { openFolder, isHostCallTimeout } from '../bridge';
import { useProjectStore } from '../project-store';
import { openProjectByPath, errText } from '../lib/open-project';
import { basename } from '../lib/path';
import type { AspectRatio, Archetype, EngineCapability } from '../mcp-types';
import { Icon } from './launcher/icons';
import { Gallery } from './launcher/Gallery';
import { Recents } from './launcher/Recents';
import { CommandPalette, type PaletteAction } from './launcher/CommandPalette';
import { derivePhase, normalizeRecent, type RecentRow } from './launcher/presentation';

// ─── toasts ──────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
  /** Skip the 6.5s auto-dismiss. For failures whose whole point is that the
   *  user was NOT at the keyboard when they happened (the open-folder timeout
   *  branch below fires only after ≥10 minutes in native dialogs) — a toast
   *  that expires 6.5s later is the same invisible failure the live round
   *  recorded (wp04/verdict.md: "the error toast had auto-dismissed by the
   *  time I read the DOM"). Sticky toasts stay until the X or the action is
   *  clicked. */
  sticky?: boolean;
}

// ─── view ──────────────────────────────────────────────────────────────────

export interface LauncherViewProps {
  /** Set when App's own optimistic-resume attempt (App.tsx) failed — the
   *  project moved / access was denied / the sidecar errored. App already
   *  cleared the stale last-project entry; this is purely the honest banner.
   *  `null`/omitted on a normal (non-resume) landing. */
  resumeError?: { name: string; detail: string } | null;
  /** Dismiss the resume-failure banner. Omitted when there's nothing to
   *  dismiss (no `resumeError`). */
  onDismissResumeError?: () => void;
}

export function LauncherView({ resumeError = null, onDismissResumeError }: LauncherViewProps) {
  const openProject = useProjectStore((s) => s.openProject);

  const clientRef = useRef<McpClient | null>(null);
  const [mode, setMode] = useState<'real' | 'mock' | null>(null);

  const [archetypes, setArchetypes] = useState<Archetype[]>([]);
  const [archLoading, setArchLoading] = useState(true);
  const [archError, setArchError] = useState<string | null>(null);

  const [recents, setRecents] = useState<RecentRow[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(true);
  const [recentsError, setRecentsError] = useState<string | null>(null);

  const [engines, setEngines] = useState<EngineCapability[]>([]);

  const [picked, setPicked] = useState<Archetype | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Open-folder is the one action that waits on a human clicking through two
  // NATIVE dialogs (OS picker, then the shell's "Grant Studio folder access?"
  // prompt), which can easily land behind a maximized shell window. `opening`
  // greys out Resume / every recents row / both "Open folder…" buttons for the
  // whole wait, and the host call's ceiling is 10 minutes (bridge.ts) — so the
  // wait needs a visible state and a way out, or the desk is simply inert with
  // no explanation. `folderWait` drives the banner + button labels;
  // `folderAbortRef` is what the banner's Cancel aborts. `folderCancelledRef`
  // is required because the SDK reports an abort with the SAME
  // `ErrorCode.RequestTimeout` as a real timeout (see HostCallOptions.signal)
  // — the flag is the only way to tell our own cancel apart from the deadline.
  const [folderWait, setFolderWait] = useState(false);
  const folderAbortRef = useRef<AbortController | null>(null);
  const folderCancelledRef = useRef(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const galleryRef = useRef<HTMLDivElement>(null);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastId.current;
    setToasts((cur) => [...cur, { ...t, id }]);
    if (!t.sticky) {
      window.setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 6500);
    }
    return id;
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  // ─── loaders ────────────────────────────────────────────────────────────

  const loadArchetypes = useCallback(async () => {
    setArchLoading(true);
    setArchError(null);
    try {
      const client = clientRef.current ?? (clientRef.current = await getMcpClient());
      setMode(client.mode);
      const { archetypes: list } = await archetypeApi.list(client);
      setArchetypes(list);
    } catch (e) {
      setArchError(errText(e));
      setArchetypes([]);
    } finally {
      setArchLoading(false);
    }
  }, []);

  const loadRecents = useCallback(async () => {
    setRecentsLoading(true);
    setRecentsError(null);
    try {
      const client = clientRef.current ?? (clientRef.current = await getMcpClient());
      setMode(client.mode);
      // G-47 — real mode gets the enriched registry (archetype/cell-count/
      // aspect, dead paths filtered server-side); the mock client has no
      // matching tool case, so standalone keeps reading project.list() as
      // before (the runtime-detection seam this already relies on).
      const { projects } =
        client.mode === 'real' ? await projectApi.recents(client) : await projectApi.list(client);
      setRecents((projects ?? []).map(normalizeRecent).filter((r): r is RecentRow => r !== null));
    } catch (e) {
      setRecentsError(errText(e));
      setRecents([]);
    } finally {
      setRecentsLoading(false);
    }
  }, []);

  const loadEngines = useCallback(async () => {
    try {
      const client = clientRef.current ?? (clientRef.current = await getMcpClient());
      // The real client's own cold-start probe already ran render.list_engines
      // — reuse that result instead of re-issuing the call. `null` (mock mode,
      // or the probe failed over to mock) falls back to calling it directly.
      const cached = getProbedEngines();
      const list = cached ?? (await renderApi.list_engines(client)).engines;
      setEngines(list ?? []);
    } catch {
      // Honest degrade: no engine seam → omit the rail card entirely.
      setEngines([]);
    }
  }, []);

  useEffect(() => {
    void loadArchetypes();
    void loadRecents();
    void loadEngines();
  }, [loadArchetypes, loadRecents, loadEngines]);

  // ─── actions ────────────────────────────────────────────────────────────

  const createAndOpen = useCallback(
    async (archetype: Archetype, name: string, aspect: AspectRatio) => {
      setCreating(true);
      setCreateError(null);
      try {
        const client = clientRef.current ?? (clientRef.current = await getMcpClient());
        const { project_id } = await projectApi.create(client, {
          archetype_id: archetype.id,
          name,
          path: `~/Projects/${name}`,
          aspect_ratio: aspect,
        });
        setPicked(null);
        openProject({ project_id, name, archetype_id: archetype.id, aspect_ratio: aspect, path: `~/Projects/${name}` });
      } catch (e) {
        const msg = errText(e);
        setCreateError(msg); // keep the panel + its input; surface inline
        pushToast({ kind: 'error', title: `Couldn’t create “${name}”`, detail: msg });
      } finally {
        setCreating(false);
      }
    },
    [openProject, pushToast],
  );

  // Open a project by path, then fetch its real archetype/aspect (project.info)
  // so the in-project header shows the truth rather than a guess. Delegates to
  // the shared `openProjectByPath` helper (lib/open-project.ts) so the shell
  // side-menu's `recent:<path>` rows reuse the SAME open + enrichment +
  // persistence flow rather than forking it.
  const openByPath = useCallback(
    (path: string, fallbackName: string) => openProjectByPath(path, fallbackName),
    [],
  );

  const openRecentRow = useCallback(
    async (row: RecentRow) => {
      if (opening) return;
      setOpening(true);
      try {
        await openByPath(row.path || `~/Projects/${row.name}`, row.name);
      } catch (e) {
        pushToast({
          kind: 'error',
          title: `Couldn’t open “${row.name}”`,
          detail: errText(e),
          action: { label: 'Retry', run: () => void openRecentRow(row) },
        });
      } finally {
        setOpening(false);
      }
    },
    [opening, openByPath, pushToast],
  );

  // Resume opens the first row whose folder still exists on disk — never a
  // dimmed "missing" row (audit: Recents hygiene).
  const firstOpenable = recents.find((r) => r.exists) ?? null;
  const resumeLast = useCallback(() => {
    const target = recents.find((r) => r.exists);
    if (target) void openRecentRow(target);
  }, [recents, openRecentRow]);

  // Abandon the wait on the native dialogs. Client-side only, and honestly so:
  // the abort deletes the response handler and sends notifications/cancelled,
  // but the shell's `openDialog` / `pkg_studio_request_project_access` are not
  // abortable, so a dialog already on screen stays there and a grant the user
  // then confirms is still written. That's why the banner says as much rather
  // than claiming the request was called off.
  const cancelFolderWait = useCallback(() => {
    folderCancelledRef.current = true;
    folderAbortRef.current?.abort(new Error('open-folder wait cancelled from the Launcher'));
    pushToast({
      kind: 'info',
      title: 'Stopped waiting for the folder dialog',
      detail:
        'If the picker or the grant prompt is still on screen, answering it now won’t open anything here — close it, then use “Open folder…” when you’re ready.',
    });
  }, [pushToast]);

  // Open-folder: the shell pops its OWN native picker + grant dialog. We consume
  // the real result honestly — no pkg-side pre-modal, no hardcoded mock project.
  const openFolderFlow = useCallback(async () => {
    if (opening) return;
    const ac = new AbortController();
    folderAbortRef.current = ac;
    folderCancelledRef.current = false;
    setOpening(true);
    setFolderWait(true);
    try {
      const res = await openFolder({ signal: ac.signal });
      setFolderWait(false); // both native dialogs are done; the rest is ours
      const sc = (res.structuredContent ?? {}) as {
        ok?: boolean;
        cancelled?: boolean;
        granted?: boolean;
        path?: string;
      };
      if (sc.cancelled) return; // user cancelled the OS picker — do nothing
      if (sc.ok === false || sc.granted === false || !sc.path) {
        pushToast({ kind: 'info', title: 'Access denied — nothing opened' });
        return;
      }
      await openByPath(sc.path, basename(sc.path) || 'project');
      void loadRecents(); // the just-opened project now belongs in recents
    } catch (e) {
      // The banner's Cancel aborts the call; the SDK rejects that with the same
      // RequestTimeout code as a real deadline, so the flag — not the error —
      // is what tells them apart. A cancel the user just performed needs no
      // message.
      if (folderCancelledRef.current) return;
      // host.openFolder gets a generous ceiling (10 min, bridge.ts) because the
      // OS picker + native grant dialog are user-paced, but a user who never
      // answers them still trips it — and the host may have finished the grant
      // write anyway (WP-04 live round: verdict.md "Live-found gap").
      //
      // There is NO recovery seam here, and we deliberately don't fake one:
      // the timed-out response is the only carrier of the picked path, and
      // nothing on the host side of `host.openFolder` touches the project
      // registry (it does `openDialog` + `pkg_studio_request_project_access`
      // and returns `{ok, granted, path}`; `last_opened` moves only in the
      // sidecar's `project.open` handler, which only the iframe or the agent-
      // facing MCP tool reaches). So after a timeout Studio genuinely does not
      // know which folder was picked — any "newest recents row" guess would
      // open a DIFFERENT project than the user chose. Say the true thing
      // instead, and say it in a toast that doesn't expire: this branch fires
      // only after ≥10 minutes, i.e. when the user is almost certainly not
      // looking. No auto-retry action either — the picker/grant dialog it timed
      // out on is still live, so re-firing openFolder() here would pop a second
      // picker and leave the first call's grant prompt to surface later, for a
      // folder the user has meanwhile abandoned.
      if (isHostCallTimeout(e)) {
        pushToast({
          kind: 'info',
          sticky: true,
          title: 'Studio didn’t hear back about that folder',
          detail:
            'The folder picker or the “Grant Studio folder access?” prompt may still be open behind this window — finish or close it before retrying. Any access you already granted was saved, so “Open folder…” will skip the prompt for that folder next time, but Studio never learned which folder you picked: choose it again.',
        });
        return;
      }
      pushToast({
        kind: 'error',
        title: 'Couldn’t open that folder',
        detail: errText(e),
        action: { label: 'Try again', run: () => void openFolderFlow() },
      });
    } finally {
      if (folderAbortRef.current === ac) folderAbortRef.current = null;
      setFolderWait(false);
      setOpening(false);
    }
  }, [opening, openByPath, pushToast, loadRecents]);

  const toggleGallery = useCallback(() => {
    setGalleryOpen((v) => {
      const next = !v;
      if (next) {
        window.setTimeout(
          () => galleryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
          0,
        );
      }
      return next;
    });
  }, []);

  const pickArchetype = useCallback((a: Archetype) => {
    setPicked(a);
    setCreateError(null);
    setGalleryOpen(true);
  }, []);

  const onDisabledArchetype = useCallback(
    (a: Archetype) => {
      pushToast({
        kind: 'info',
        title: `${a.name} isn’t available yet`,
        detail: 'Explainer, Product & Tutorial are live now — the rest ship in a later phase.',
      });
    },
    [pushToast],
  );

  const onCustom = useCallback(() => {
    pushToast({
      kind: 'info',
      title: 'Custom chains are composed with your Chi',
      detail: 'Ask in chat to start one — the desk seeds one-click templates only.',
    });
  }, [pushToast]);

  // ─── keyboard: R / O / N + ⌘K ─────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (paletteOpen || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'r' && firstOpenable) {
        e.preventDefault();
        resumeLast();
      } else if (k === 'o') {
        e.preventDefault();
        void openFolderFlow();
      } else if (k === 'n') {
        e.preventDefault();
        toggleGallery();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [paletteOpen, firstOpenable, resumeLast, openFolderFlow, toggleGallery]);

  // ─── command-palette actions ──────────────────────────────────────────────

  const paletteActions: PaletteAction[] = [];
  if (firstOpenable) {
    paletteActions.push({
      id: 'resume',
      label: 'Resume last project',
      hint: firstOpenable.name,
      icon: 'play',
      keywords: 'recent open continue',
      run: resumeLast,
    });
  }
  paletteActions.push(
    { id: 'open', label: 'Open folder…', hint: 'pick a project folder on disk', icon: 'folder', keywords: 'existing disk import', run: () => void openFolderFlow() },
    { id: 'new', label: 'New project', hint: 'seed beats & cells from a template', icon: 'plus', keywords: 'create template archetype', run: toggleGallery },
  );
  for (const a of archetypes) {
    // Same phase guard as the gallery: unavailable (P2/P3) archetypes don't
    // get a create shortcut — the palette must not bypass the disabled card.
    if (!derivePhase(a.id).available) continue;
    paletteActions.push({
      id: `new-${a.id}`,
      label: `New ${a.name} project`,
      hint: 'template',
      icon: 'plus',
      keywords: `create ${a.id}`,
      run: () => pickArchetype(a),
    });
  }

  const engineReady = mode === 'real';

  return (
    <div className="launcher-desk flex h-full min-h-0 flex-col overflow-auto bg-base text-fg">
      {/* App header */}
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-soft bg-sunken/90 px-5 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-md border"
            style={{ color: 'var(--tint-studio-fg)', background: 'var(--tint-studio-bg)', borderColor: 'color-mix(in srgb, var(--ember) 34%, var(--border))' }}
          >
            <Icon name="film" size={16} />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight text-fg">Studio</div>
            <div className="font-mono text-[10px] leading-tight text-fg-faint">no project open</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="hidden items-center gap-2 rounded-full border border-soft px-2.5 py-1 font-mono text-[11px] text-fg-muted sm:inline-flex"
            style={{ background: 'var(--bg-surface)' }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: engineReady ? 'var(--live)' : 'var(--fg-faint)',
                boxShadow: engineReady ? '0 0 0 3px var(--live-soft)' : 'none',
              }}
            />
            {engineReady ? 'Studio engine · ready' : 'Demo data'}
          </span>
          <button
            type="button"
            onClick={() => void openFolderFlow()}
            disabled={opening}
            className="flex items-center gap-2 rounded-md border border-soft px-3 py-1.5 text-xs text-fg-muted hover:border-[var(--chip-carve)] hover:text-fg disabled:opacity-60"
          >
            <Icon name="folder" size={14} /> {folderWait ? 'Waiting for folder…' : 'Open folder…'}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-7">
        {/* Optimistic-resume failure banner (App.tsx owns the resume attempt
            itself — it already ran and failed before this Launcher ever
            mounted, and already cleared the stale last-project entry). */}
        {resumeError && (
          <div
            role="alert"
            className="mb-5 flex items-start gap-3 rounded-lg border px-4 py-3"
            style={{ borderColor: 'color-mix(in srgb, var(--danger) 44%, var(--border))', background: 'var(--danger-soft)' }}
          >
            <span className="mt-0.5 flex-none" style={{ color: 'var(--danger)' }}>
              <Icon name="alert" size={16} />
            </span>
            <div className="min-w-0 flex-1 text-[13px] leading-snug">
              <div className="font-semibold text-fg">Couldn&rsquo;t reopen &ldquo;{resumeError.name}&rdquo;</div>
              <p className="mt-0.5 text-fg-muted">
                It may have moved or access was denied. Removed it from the last-opened slot — open it again from Recent projects or a folder below.{' '}
                <span className="font-mono text-fg-faint">{resumeError.detail}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => onDismissResumeError?.()}
              aria-label="Dismiss"
              className="flex-none text-fg-faint hover:text-fg"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        {/* Waiting-on-native-dialogs banner. `opening` disables Resume, every
            recents row and both "Open folder…" buttons for as long as the host
            call is in flight — up to 10 minutes (bridge.ts OPEN_FOLDER_TIMEOUT_
            MS). This is the explanation for that, and the way out of it. */}
        {folderWait && (
          <div
            role="status"
            className="mb-5 flex items-start gap-3 rounded-lg border px-4 py-3"
            style={{ borderColor: 'color-mix(in srgb, var(--info) 42%, var(--border))', background: 'var(--info-soft)' }}
          >
            <span className="mt-0.5 flex-none" style={{ color: 'var(--info)' }}>
              <Icon name="folder" size={16} />
            </span>
            <div className="min-w-0 flex-1 text-[13px] leading-snug">
              <div className="font-semibold text-fg">Waiting for the folder dialog…</div>
              <p className="mt-0.5 text-fg-muted">
                The OS folder picker &mdash; and then Studio&rsquo;s &ldquo;Grant Studio folder
                access?&rdquo; prompt &mdash; are open. They can appear <em>behind</em> this window,
                so check your taskbar. The desk stays locked until you answer them.
              </p>
            </div>
            <button
              type="button"
              onClick={cancelFolderWait}
              className="flex-none rounded-md border border-soft px-2.5 py-1 text-xs text-fg-muted hover:border-[var(--chip-carve)] hover:text-fg"
            >
              Stop waiting
            </button>
          </div>
        )}

        {/* Command band */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-6">
          <div>
            <h1
              className="text-[28px] font-medium leading-tight tracking-[-0.01em]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Back at the{' '}
              <em className="not-italic" style={{ fontStyle: 'italic', color: 'var(--kola-amber)' }}>
                desk
              </em>
              .
            </h1>
            <p className="mt-1.5 max-w-[46ch] text-sm text-fg-muted">
              Pick up a project where you left it, open a folder from disk, or start a new one from a
              template. Chat with your Chi still drives the same production loop — the desk just skips
              the blank start.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap justify-end gap-2">
              {firstOpenable && (
                <button
                  type="button"
                  onClick={resumeLast}
                  disabled={opening}
                  className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
                  style={{ background: 'var(--primary)', color: 'var(--primary-fg)' }}
                >
                  <Icon name="play" size={15} filled /> Resume last project
                </button>
              )}
              <button
                type="button"
                onClick={() => void openFolderFlow()}
                disabled={opening}
                className="flex items-center gap-2 rounded-lg border border-soft bg-raised px-4 py-2.5 text-sm font-semibold text-fg hover:border-[var(--chip-carve)] disabled:opacity-60"
              >
                <Icon name="folder" size={15} /> {folderWait ? 'Waiting for folder…' : 'Open folder…'}
              </button>
              <button
                type="button"
                onClick={toggleGallery}
                aria-expanded={galleryOpen}
                aria-controls="new-project-gallery"
                className="flex items-center gap-2 rounded-lg border border-soft bg-raised px-4 py-2.5 text-sm font-semibold text-fg hover:border-[var(--chip-carve)]"
              >
                <Icon name="plus" size={15} /> New project
                <Icon
                  name="chevron"
                  size={14}
                  className={'transition-transform ' + (galleryOpen ? 'rotate-180' : '')}
                />
              </button>
            </div>
            <div className="flex gap-3.5 font-mono text-[11px] text-fg-faint" aria-hidden="true">
              <span>
                <kbd className="mr-1 rounded border border-soft px-1.5 py-px">R</kbd>resume
              </span>
              <span>
                <kbd className="mr-1 rounded border border-soft px-1.5 py-px">O</kbd>open
              </span>
              <span>
                <kbd className="mr-1 rounded border border-soft px-1.5 py-px">N</kbd>new
              </span>
              <span>
                <kbd className="mr-1 rounded border border-soft px-1.5 py-px">⌘K</kbd>all
              </span>
            </div>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Left column */}
          <div className="flex flex-col gap-5">
            <Recents
              loading={recentsLoading}
              error={recentsError}
              rows={recents}
              onOpen={openRecentRow}
              onOpenFolder={() => void openFolderFlow()}
              onNew={toggleGallery}
              onRetry={() => void loadRecents()}
            />

            {/* Teaching footer (graft from L-B) */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-soft bg-surface px-4 py-3 font-mono text-[11px] text-fg-muted">
              <span className="uppercase tracking-[0.06em] text-fg-faint">the loop</span>
              <span className="flex items-center gap-1.5">
                <Icon name="list" size={12} /> Beats &amp; cells
              </span>
              <Icon name="arrow" size={12} className="text-fg-faint" />
              <span className="flex items-center gap-1.5">
                <Icon name="film" size={12} /> Compose
              </span>
              <Icon name="arrow" size={12} className="text-fg-faint" />
              <span className="flex items-center gap-1.5">
                <Icon name="check" size={12} /> Render &amp; export
              </span>
            </div>

            {galleryOpen && (
              <div ref={galleryRef} id="new-project-gallery">
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h2 className="font-mono text-[12px] uppercase tracking-[0.05em] text-fg-muted">
                    Start something new
                  </h2>
                  <span className="font-mono text-[11px] text-fg-faint">
                    templates seed beats &amp; cells — edit everything after
                  </span>
                </div>
                <Gallery
                  archetypes={archetypes}
                  loading={archLoading}
                  error={archError}
                  picked={picked}
                  creating={creating}
                  createError={createError}
                  onPick={pickArchetype}
                  onCloseCreate={() => setPicked(null)}
                  onCreate={(name, aspect) => picked && void createAndOpen(picked, name, aspect)}
                  onDisabled={onDisabledArchetype}
                  onCustom={onCustom}
                  onRetry={() => void loadArchetypes()}
                />
              </div>
            )}
          </div>

          {/* Rail — sticky below the sticky app header (top-0 + py-2.5 ≈ 3.5rem)
              so the desk cards stay in view while recents/gallery scroll. */}
          <aside className="sticky top-14 flex flex-col gap-4 self-start" aria-label="Desk sidebar">
            <div className="rounded-lg border border-soft bg-surface p-4">
              <h3 className="mb-2.5 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.07em] text-fg-muted">
                <Icon name="command" size={13} /> Jump back in
              </h3>
              <div className="flex flex-col gap-2 text-[12.5px] text-fg-muted">
                <div className="flex items-center justify-between gap-2">
                  <span>Resume last project</span>
                  <kbd className="rounded border border-soft px-1.5 py-px font-mono text-[11px]">R</kbd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Open a folder from disk</span>
                  <kbd className="rounded border border-soft px-1.5 py-px font-mono text-[11px]">O</kbd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>New from a template</span>
                  <kbd className="rounded border border-soft px-1.5 py-px font-mono text-[11px]">N</kbd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>All commands</span>
                  <kbd className="rounded border border-soft px-1.5 py-px font-mono text-[11px]">⌘K</kbd>
                </div>
              </div>
            </div>

            {engines.length > 0 && (
              <div className="rounded-lg border border-soft bg-surface p-4">
                <h3 className="mb-2.5 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.07em] text-fg-muted">
                  <Icon name="film" size={13} /> Render engines
                </h3>
                <div className="flex flex-col gap-2 text-[12.5px] text-fg-muted">
                  {engines.map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-2">
                      <span className="text-fg">{e.id}</span>
                      <span className="font-mono text-[10.5px] text-fg-faint">
                        {e.aspect_ratios?.join(' · ')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div
              className="rounded-lg border p-4"
              style={{
                borderColor: 'color-mix(in srgb, var(--agent) 30%, var(--border))',
                background: 'color-mix(in srgb, var(--agent-soft) 55%, var(--bg-surface))',
              }}
            >
              <h3
                className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                style={{ color: 'color-mix(in srgb, var(--agent) 75%, var(--fg))' }}
              >
                <Icon name="message" size={13} /> Or ask your Chi
              </h3>
              <p className="text-[12.5px] leading-relaxed text-fg-muted">
                Rather describe the video than click? Tell it to{' '}
                <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', color: 'color-mix(in srgb, var(--agent) 80%, var(--fg))' }}>
                  your Chi
                </span>{' '}
                in chat — it runs the same create, storyboard, and render steps the desk does, and the
                result lands right here in Recent projects.
              </p>
            </div>
          </aside>
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />

      {/* Toasts */}
      {toasts.length > 0 && (
        <div
          className="fixed bottom-6 left-1/2 z-50 flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 flex-col items-center gap-2"
          aria-live="polite"
          aria-atomic="false"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className="flex w-full items-start gap-3 rounded-lg border bg-raised px-3 py-3 shadow-2xl"
              style={{
                borderColor:
                  t.kind === 'success'
                    ? 'color-mix(in srgb, var(--live) 40%, var(--border))'
                    : t.kind === 'error'
                    ? 'color-mix(in srgb, var(--danger) 46%, var(--border))'
                    : 'var(--border)',
              }}
            >
              <span
                className="mt-0.5 flex-none"
                style={{
                  color:
                    t.kind === 'success'
                      ? 'var(--live)'
                      : t.kind === 'error'
                      ? 'var(--danger)'
                      : 'var(--info)',
                }}
              >
                <Icon name={t.kind === 'success' ? 'check' : t.kind === 'error' ? 'alert' : 'arrow'} size={16} />
              </span>
              <div className="min-w-0 flex-1 text-xs leading-snug">
                <div className="font-semibold text-fg">{t.title}</div>
                {t.detail && <div className="mt-0.5 break-words font-mono text-fg-faint">{t.detail}</div>}
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      t.action?.run();
                      dismissToast(t.id);
                    }}
                    className="mt-1 font-mono text-[11.5px]"
                    style={{ color: 'var(--info)' }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss"
                className="flex-none text-fg-faint hover:text-fg"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
