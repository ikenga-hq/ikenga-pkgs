// Assignee roster — who a task can be owned by, used by both the create form
// (owner field) and the detail pane's Reassign picker, plus the small helpers
// that turn the operator's identity into labels.
//
// Two assignee kinds map onto the `tasks` columns: `assigned_to` (the id) and
// `assignee_type` ('human' | 'agent'). `assigneeIsAgent` in shared.js also
// treats a trailing `-agent` as the agent convention when the type column is
// empty, so keep agent ids suffixed `-agent`.
//
// ## Who "Me" is
//
// "Me" is the operator the shell reports through `hostContext.operator`
// (`{ id, displayName? }`, see @ikenga/contract's host-context). It is
// OPTIONAL: when absent the operator is UNKNOWN, not a default person. Every
// helper here fails safe on a missing operator:
//
//   - there is no "Me" option to pick (nothing real to store),
//   - rows and audit events this app writes carry a null creator / actor,
//   - the activity timeline reads those entries as "You".
//
// The id is threaded down from app.js (connectBridge ctx.operator.id) as a plain
// string or null, the same way every other no-build app pkg does it. The pure
// predicates (isMine, ...) come from the shared runtime copy in ./operator.js.
//
// ## Who the agents are
//
// There is no built-in agent list. Agents are offered only when the shell
// delivers a roster at `hostContext.royaltiSuite.tasksRoster` at iframe-mount
// time (via the AppBridge `connectBridge` return value and `onContextChange`,
// see bridge.js / app.js). The expected shape is:
//
//   hostContext.royaltiSuite.tasksRoster = {
//     humans: [{ value: string, label: string }],  // id → display name
//     agents: [{ id: string, label: string }],      // agent-id → display name
//   }
//
// When it is present and well-formed (both arrays non-empty) it is the whole
// list of assignees. When it is absent or malformed the picker offers just
// "Me" (when the operator is known) and "Unassigned". The shell reads the
// roster from an optional `.atelier/skill-tasks/roster.json` in the project
// folder and passes it through untouched; with no such file nothing is offered.

import { isMine } from './operator.js';

/** Label for the operator in pickers and filters. */
export const ME_LABEL = 'Me';

/** Label used for the operator's own timeline entries. */
export const SELF_LABEL = 'You';

/** @typedef {{ id: string, label: string }} AgentEntry */

/** @typedef {{ value: string, label: string, type: 'human' | 'agent' }} AssigneeOption */

/**
 * @typedef {{ value: string, label: string }} HumanEntry
 * @typedef {{ humans: HumanEntry[], agents: AgentEntry[] }} TasksRoster
 */

/**
 * The operator's id from a hostContext, or `null` when the shell did not
 * supply one (unknown operator). Never invents a default.
 *
 * @param {unknown} [hostContext]
 * @returns {string | null}
 */
export function operatorIdFrom(hostContext) {
  const id = /** @type {any} */ (hostContext)?.operator?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * Validate and return a configured roster from `hostContext.royaltiSuite.tasksRoster`,
 * or `null` if absent / malformed. A valid roster has both `humans` and `agents`
 * as non-empty arrays.
 *
 * @param {unknown} [hostContext]
 * @returns {TasksRoster | null}
 */
export function resolveRoster(hostContext) {
  const raw = /** @type {any} */ (hostContext)?.royaltiSuite?.tasksRoster;
  if (!raw) return null;
  const { humans, agents } = raw;
  if (
    !Array.isArray(humans) || humans.length === 0 ||
    !Array.isArray(agents) || agents.length === 0
  ) {
    return null;
  }
  // Basic per-entry shape validation — skip malformed entries rather than reject.
  const validHumans = humans.filter(
    (h) => h && typeof h.value === 'string' && typeof h.label === 'string',
  );
  const validAgents = agents.filter(
    (a) => a && typeof a.id === 'string' && typeof a.label === 'string',
  );
  if (validHumans.length === 0 || validAgents.length === 0) return null;
  return { humans: validHumans, agents: validAgents };
}

/**
 * Flat option list for an assignee <select>. The empty-value "Unassigned"
 * sentinel is added by the caller's <select> so this list stays purely the real
 * assignees.
 *
 * A configured roster (see above) wins outright. Without one the list is just
 * "Me" — and only when the operator is known. No agents are ever invented.
 *
 * @param {unknown} [hostContext] carries the optional roster
 * @param {string | null} [operatorId] the known operator id, or null/undefined when unknown
 * @returns {AssigneeOption[]}
 */
export function assigneeOptions(hostContext, operatorId = null) {
  const roster = resolveRoster(hostContext);
  if (roster) {
    return [
      ...roster.humans.map((h) => ({ value: h.value, label: h.label, type: /** @type {'human'} */ ('human') })),
      ...roster.agents.map((a) => ({ value: a.id, label: a.label, type: /** @type {'agent'} */ ('agent') })),
    ];
  }
  return operatorId
    ? [{ value: operatorId, label: ME_LABEL, type: /** @type {'human'} */ ('human') }]
    : [];
}

/**
 * Resolve a picked `assigned_to` value back to its `assignee_type`. Falls back
 * to the `-agent` naming convention for ids not in the list (e.g. legacy rows
 * or an agent that is not in the current roster).
 *
 * @param {string} value
 * @param {unknown} [hostContext]
 * @param {string | null} [operatorId]
 * @returns {'human' | 'agent'}
 */
export function assigneeTypeFor(value, hostContext, operatorId = null) {
  const match = assigneeOptions(hostContext, operatorId).find((o) => o.value === value);
  if (match) return match.type;
  return value.endsWith('-agent') ? 'agent' : 'human';
}

/**
 * True when an activity-timeline actor is an agent or system process rather
 * than a person: anything that is not the operator and not an email address.
 *
 * @param {string | null | undefined} actor
 * @param {string | null} [operatorId]
 */
export function isAgentActor(actor, operatorId = null) {
  return !!actor && !isMine(actor, operatorId) && !actor.includes('@');
}

/**
 * Label for an activity-timeline actor. The operator's own id reads "You". An
 * entry with no actor reads "You" too when it is one this app writes on the
 * operator's behalf (`userAction`) and the operator is unknown — that is what
 * the write helpers store in that case. Anything else is shown as stored.
 *
 * @param {string | null | undefined} actor
 * @param {string | null} operatorId
 * @param {boolean} [userAction]
 * @returns {string | null}
 */
export function actorLabel(actor, operatorId, userAction = false) {
  if (actor) return isMine(actor, operatorId) ? SELF_LABEL : actor;
  return userAction && operatorId == null ? SELF_LABEL : null;
}
