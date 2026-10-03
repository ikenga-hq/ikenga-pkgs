// Sweeper — auto-close review queue. Ports the design's SWEEPER_HTML
// (atelier-tasks.html, Section C). The design surfaces a confidence band: ≥ 0.9
// auto-closes silently; 0.6–0.9 waits here for human sign-off. The 4-segment
// confidence bar now reads a REAL per-row score from the `task_signals` table
// (shell migration 0049) joined onto each row — `signal_source = 'derived'`, so
// the bar is labelled as a transparent derived score, not a model output. When a
// row has no signal yet the bar falls back to the cohort tier (auto rows lvl-4 /
// lvl-3, flagged rows lvl-2). Evidence prose is the real `outcome_notes` text —
// no fabricated rows. Two cohorts:
//
//   1. "Awaiting your call" — open tasks whose `outcome_notes` carry a
//      sweeper hint (`Needs review by task-health`) but aren't auto-closed yet.
//   2. "Recently auto-closed" — completed tasks where `outcome_notes` begins
//      `Auto-closed by task-health`. Silent closes kept visible so they can be
//      reopened if wrong.
//
// Schema columns used: id, title, status, priority, outcome_notes,
// completed_at, updated_at, category. All present in the shell's `tasks` table
// (migration 0025_tasks_domain).

import { html, Icon, Button, useQuery } from '../../lib/ui.js';
import { hostDbQuery } from '../../lib/bridge.js';
import { queryKeys } from '../../lib/query-keys.js';
import { autoCloseSignal, shortId } from '../../lib/shared.js';

/** @typedef {import('../../lib/queries.js').Task} Task */

/**
 * @param {string} iso
 * @returns {string}
 */
function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const dt = Date.now() - t;
  const min = Math.round(dt / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const dy = Math.round(hr / 24);
  return `${dy}d ago`;
}

// Strip the "Auto-closed by task-health:" / "Needs review by task-health:"
// prefix so the evidence column shows just the observed side-effect.
function evidenceText(notes) {
  if (!notes) return '';
  return notes.replace(/^(Auto-closed|Needs review) by task-health:?\s*/i, '').trim();
}

// Map a 0..1 confidence to the 4-segment bar level. null = no signal yet.
function confLevel(conf) {
  if (conf == null || Number.isNaN(conf)) return null;
  if (conf < 0.25) return 1;
  if (conf < 0.5) return 2;
  if (conf < 0.75) return 3;
  return 4;
}

export function SweeperView() {
  // Two queries. Both narrow on `outcome_notes` to keep the result set bounded
  // to sweeper-flagged rows — the broader `tasks` table is already exposed by
  // the List view.
  const awaiting = useQuery({
    queryKey: queryKeys.tasks.list('sweeper:awaiting'),
    /** @returns {Promise<Task[]>} */
    queryFn: async () => {
      const rows = await hostDbQuery(
        `SELECT t.id, t.title, t.status, t.priority, t.outcome_notes, t.due_date,
                t.updated_at, t.category, ts.confidence AS confidence
         FROM tasks t
         LEFT JOIN task_signals ts ON ts.task_id = t.id
         WHERE t.status IN ('pending','in_progress','blocked')
           AND t.outcome_notes LIKE 'Needs review by task-health%'
         ORDER BY t.updated_at DESC LIMIT 50`,
        [],
      );
      return /** @type {Task[]} */ (rows);
    },
  });

  const recent = useQuery({
    queryKey: queryKeys.tasks.list('sweeper:recent'),
    /** @returns {Promise<Task[]>} */
    queryFn: async () => {
      const rows = await hostDbQuery(
        `SELECT t.id, t.title, t.status, t.priority, t.outcome_notes, t.completed_at,
                t.category, ts.confidence AS confidence
         FROM tasks t
         LEFT JOIN task_signals ts ON ts.task_id = t.id
         WHERE t.status = 'completed'
           AND t.outcome_notes LIKE 'Auto-closed by task-health%'
         ORDER BY t.completed_at DESC LIMIT 50`,
        [],
      );
      return /** @type {Task[]} */ (rows);
    },
  });

  const awaitingRows = awaiting.data ?? [];
  const recentRows = recent.data ?? [];
  const pendingCount = awaitingRows.length;
  const closedCount = recentRows.length;

  return html`
    <div class="sweeper-wrap" style=${{
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
      padding: 'var(--space-5)',
      maxWidth: '980px',
    }}>
      <div class="tk-section-label" style=${{ marginBottom: 'var(--space-3)' }}>
        Auto-close sweeper · review queue
      </div>
      <p style=${{
        fontSize: 'var(--text-body-sm)',
        color: 'var(--fg-muted)',
        margin: '0 0 var(--space-5)',
        maxWidth: '62ch',
        lineHeight: 1.55,
      }}>
        The sweeper closes a task when its side-effect is observed — reply sent, post published,
        deal closed, commit landed. Confidence ≥ 0.9 auto-closes silently; 0.6–0.9 waits here
        for your sign-off.
      </p>

      ${(awaiting.isLoading || recent.isLoading) && html`
        <div class="tk-loading">
          <${Icon} name="loader" size=${16} className="tk-spin" />
          Loading…
        </div>
      `}

      ${!awaiting.isLoading && !recent.isLoading && pendingCount === 0 && closedCount === 0 && html`
        <div style=${{ color: 'var(--fg-muted)', fontSize: 'var(--text-body-sm)', padding: 'var(--space-3) 0' }}>
          No sweep proposals yet. This app does not run a sweeper itself: proposals appear here
          when an assistant that reviews your tasks writes them. High-confidence ones auto-close
          and stay visible for 7d, mid-confidence ones wait for your call.
        </div>
      `}

      ${/* Cohort 1 · awaiting human sign-off — flag tier (lvl-2). The section
            label uses the plain .tk-section-label (no inline style overrides,
            F-19); the class already carries the mono eyebrow styling. */ ''}
      ${awaitingRows.length > 0 && html`
        <div class="tk-section-label" style=${{ margin: 'var(--space-5) 0 var(--space-2)' }}>
          <span>Awaiting your call <span class="ct">${pendingCount}</span></span>
        </div>
        ${awaitingRows.map((t) => {
          const ev = evidenceText(t.outcome_notes) || 'flagged for review — confidence below auto-close threshold';
          const conf = t.confidence == null ? null : Number(t.confidence);
          const lvl = confLevel(conf) ?? 2;
          const label = conf == null ? 'flag · review' : `${conf.toFixed(2)} · derived`;
          return html`
            <div class="sw-row" key=${t.id}>
              <div class="lhs">
                <span class="rule is-flag">${autoCloseSignal(t.outcome_notes) ?? 'review'} · flag</span>
                <span class="task">${t.title}</span>
                <span class="id">task · ${shortId(t.id)} · ${relTime(t.updated_at)}</span>
              </div>
              <div class="ev">${ev}</div>
              <div class=${`sw-conf lvl-${lvl}`} title=${conf == null ? 'no signal yet' : 'derived from cohort tier + evidence — not a model score'}>
                <div class="bar"><span></span><span></span><span></span><span></span></div>
                <span class="label">${label}</span>
              </div>
              <div class="sw-actions">
                <${Button} size="sm" variant="outline" type="button">Keep open</${Button}>
                <${Button} size="sm" variant="affirmative" type="button">
                  <${Icon} name="check" size=${11} strokeWidth=${2.5} />
                  Close
                </${Button}>
              </div>
            </div>
          `;
        })}
      `}

      ${/* Cohort 2 · recently auto-closed (traceability) — auto tier.
            Alternate lvl-4 / lvl-3 like the design's two auto rows. */ ''}
      ${recentRows.length > 0 && html`
        <div class="tk-section-label" style=${{ margin: 'var(--space-5) 0 var(--space-2)' }}>
          <span>Recently auto-closed <span class="ct">${closedCount}</span></span>
        </div>
        ${recentRows.map((t, i) => {
          const ev = evidenceText(t.outcome_notes) || 'auto-closed — observed side-effect matched';
          const conf = t.confidence == null ? null : Number(t.confidence);
          // Fall back to the structural auto tier (alternating lvl-4 / lvl-3)
          // only when no derived signal exists for the row.
          const lvl = confLevel(conf) ?? (i % 2 === 0 ? 4 : 3);
          const label = conf == null ? 'auto · closed' : `${conf.toFixed(2)} · derived`;
          return html`
            <div class="sw-row" key=${t.id} style=${{ opacity: 0.85 }}>
              <div class="lhs">
                <span class="rule is-auto">${autoCloseSignal(t.outcome_notes) ?? 'auto-close'} · auto</span>
                <span class="task">${t.title}</span>
                <span class="id">task · ${shortId(t.id)} · auto-closed ${relTime(t.completed_at)}</span>
              </div>
              <div class="ev">${ev}</div>
              <div class=${`sw-conf lvl-${lvl}`} title=${conf == null ? 'no signal yet' : 'derived from cohort tier + evidence — not a model score'}>
                <div class="bar"><span></span><span></span><span></span><span></span></div>
                <span class="label">${label}</span>
              </div>
              <div class="sw-actions">
                <span class="tk-badge is-completed" style=${{ fontSize: 9 }}><span class="dot"></span>closed</span>
              </div>
            </div>
          `;
        })}
      `}

      ${(pendingCount > 0 || closedCount > 0) && html`
        <div class="sw-foot" style=${{ marginTop: 'var(--space-4)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-soft)' }}>
          <span>${closedCount} closed · ${pendingCount} flagged · cooldown 24h/task</span>
          <a href="#" onClick=${(e) => e.preventDefault()}>View sweep-log.jsonl →</a>
        </div>
      `}
    </div>
  `;
}
