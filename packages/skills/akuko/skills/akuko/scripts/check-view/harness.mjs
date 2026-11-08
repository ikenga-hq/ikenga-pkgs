// Small jsdom harnesses for the fast unit tests in scripts/check-view/*.test.ts
// (plain JS: jsdom ships no types). Nothing here runs a whole check-view pass.

import { JSDOM } from 'jsdom';
import { hiddenReason } from './hidden.mjs';

/** hiddenReason() for each element id in a page. */
export function hiddenReasons(html, ids) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  try {
    return Object.fromEntries(ids.map((id) => {
      const el = dom.window.document.getElementById(id);
      if (!el) throw new Error(`no element #${id}`);
      return [id, hiddenReason(dom.window, el)];
    }));
  } finally {
    dom.window.close();
  }
}

/**
 * Load a page that inlines `writer` as an Ikenga pane would show it, with
 * `outbox` already in its localStorage (a pane reload keeps it; a remount
 * does not). Returns every message the page posted to its parent on load,
 * and an `emit()` that records the posts one decision causes.
 */
export function loadWriter({ writer, outbox = [], slug = 'the-beating', ikenga = true }) {
  const html = `<!doctype html><html><body>
<script type="application/json" id="akuko-view">{"contract":"akuko-view@1","id":"writer-test","version":"1","writes_decisions":true,"views":[]}</script>
<script type="application/json" id="akuko-project">{"project":{"slug":"${slug}"}}</script>
<script>\n${writer}\n</script></body></html>`;
  const posts = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://writer.check-view.test/board.html',
    beforeParse(w) {
      if (outbox !== null) w.localStorage.setItem(`akuko-outbox:${slug}`, JSON.stringify(outbox));
      if (ikenga) w.__ikenga_host__ = { kind: 'ikenga', user: null };
      // top-level jsdom: window.parent === window, so this records the bridge post
      w.postMessage = (msg) => { posts.push(JSON.parse(JSON.stringify(msg))); };
    },
  });
  const onLoad = posts.slice();
  return {
    onLoad,
    emit(f) {
      const from = posts.length;
      const d = dom.window.akukoDecisions.emit(f);
      return { decision: JSON.parse(JSON.stringify(d)), posts: posts.slice(from) };
    },
    close: () => dom.window.close(),
  };
}
