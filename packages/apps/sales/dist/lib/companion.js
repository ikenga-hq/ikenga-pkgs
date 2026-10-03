// Hand a request to the companion (the active chat session) and report back
// honestly whether it was accepted.
//
// Why this exists next to the shared create-dispatch.js: the host does not throw
// when it declines a request. It resolves with `structuredContent.ok === false`
// and a `reason` ('no-active-session' when no chat is open, 'scope-denied' when
// the app may not use an engine). create-dispatch.js treats any resolved call as
// success, so on a machine with no chat open "Ask the companion" looked like it
// worked and nothing happened. This helper reads the result and returns a
// message the pane can show.
//
// The brief itself is still built with buildCreateBrief from create-dispatch.js
// (a vendored copy of the shared runtime, which this app does not edit).

import { hostSendToActiveSession, isStandalone } from './bridge.js';
import { buildCreateBrief } from './create-dispatch.js';

const REFUSALS = {
  'no-active-session':
    'No chat session is open. Open the companion, start a chat, and try again.',
  'scope-denied': 'This app is not allowed to use an AI engine here.',
};

/**
 * Send a prompt to the active session.
 * @param {string} prompt
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function sendToCompanion(prompt) {
  if (isStandalone()) {
    return { ok: false, message: 'The companion is only available inside Ikenga.' };
  }
  try {
    const res = await hostSendToActiveSession(prompt);
    const sc = res?.structuredContent;
    if (sc?.ok === true) return { ok: true };
    const reason = typeof sc?.reason === 'string' ? sc.reason : null;
    const text = res?.content?.[0]?.text;
    return {
      ok: false,
      message:
        (reason && REFUSALS[reason]) ||
        (typeof text === 'string' && text) ||
        'The companion did not accept the request.',
    };
  } catch (e) {
    return {
      ok: false,
      message: `Could not reach the companion: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Ask the companion to research and add a deal. `company` and `stageLabel` are
 * optional context from the form; both are left out of the brief when empty.
 */
export function askCompanionToAddDeal({ company, stageLabel } = {}) {
  const brief = buildCreateBrief({
    entity: 'sales deal',
    table: 'sales_deals',
    seed: { company: company || undefined, stage: stageLabel || undefined },
    instruction:
      'Research the company, then set the title, company, owner, value, next action, '
      + 'and win probability'
      + (stageLabel ? `, and file it at the ${stageLabel} stage` : '')
      + '. Ask me for anything you still need, then add it to the sales_deals table.',
  });
  return sendToCompanion(brief);
}
