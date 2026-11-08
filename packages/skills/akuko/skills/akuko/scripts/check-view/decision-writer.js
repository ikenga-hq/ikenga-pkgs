/* akuko-decision-writer v2 — views/contract.md §Decision writer. Inline this block verbatim. */
(function () {
  'use strict';
  var STATE_KEY = 'akuko.decisions';
  function readJson(id) {
    try { return JSON.parse(document.getElementById(id).textContent); } catch (e) { return null; }
  }
  var M = readJson('akuko-view') || {};
  var P = readJson('akuko-project') || {};
  var VIEW = (M.id || 'unknown') + '@' + (M.version || '0');
  var OUTBOX = 'akuko-outbox:' + ((P.project && P.project.slug) || 'project');
  var outbox = [];
  try { outbox = JSON.parse(window.localStorage.getItem(OUTBOX) || '[]'); } catch (e) { outbox = []; }
  if (!Array.isArray(outbox)) outbox = [];
  var stored = true;
  var db = null;
  var who = 'you';
  var listeners = [];
  var ikenga = !!window.__ikenga_host__;

  function save() {
    try { window.localStorage.setItem(OUTBOX, JSON.stringify(outbox)); stored = true; } catch (e) { stored = false; }
  }
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function toDb(d) {
    if (!db) return;
    try { db.collection('decisions').doc(d.id).set(d).catch(function () { /* stays in the outbox */ }); } catch (e) { /* stays in the outbox */ }
  }
  function toIkenga() {
    if (!ikenga) return;
    try { window.parent.postMessage({ __iyke: true, kind: 'state', payload: { key: STATE_KEY, value: outbox.slice() } }, '*'); } catch (e) { /* ignore */ }
  }
  function changed() { listeners.forEach(function (fn) { try { fn(outbox.slice()); } catch (e) { /* ignore */ } }); }

  /**
   * Write one decision. Call ONLY from a person's click / submit / key press,
   * once per unit. f = {action, unit, stage, text?, undoes?}. Returns the record.
   */
  function emit(f) {
    var d = { id: uuid(), action: f.action, unit: f.unit, stage: f.stage };
    if (f.action === 'undo') d.undoes = f.undoes;
    if (typeof f.text === 'string' && (f.text !== '' || f.action === 'note' || f.action === 'request-changes')) d.text = f.text;
    d.by = who;
    d.at = new Date().toISOString();
    d.view = VIEW;
    outbox.push(d);
    save();
    toDb(d);
    toIkenga();
    changed();
    return d;
  }
  function jsonl() { return outbox.map(function (d) { return JSON.stringify(d); }).join('\n') + (outbox.length ? '\n' : ''); }

  window.akukoDecisions = {
    view: VIEW,
    emit: emit,
    all: function () { return outbox.slice(); },
    jsonl: jsonl,
    stored: function () { return stored; },
    store: function () { return db ? 'artifact-db' : ikenga ? 'ikenga' : 'outbox'; },
    onChange: function (fn) { listeners.push(fn); }
  };

  // Host A: claude.ai artifact DB (declare capabilities {db, user}). Resolves later, never during this run.
  if (window.claude && typeof window.claude.use === 'function') {
    Promise.all([window.claude.use('db'), window.claude.use('user')]).then(function (r) {
      db = r[0] || null;
      var u = r[1];
      var flush = function () { outbox.forEach(toDb); changed(); };
      if (u && typeof u.id === 'function') {
        return u.id().then(function (id) { if (id) who = id; flush(); }, flush);
      }
      flush();
    }).catch(function () { db = null; });
  }
  // Host C: re-publish the outbox after a pane reload.
  if (outbox.length) toIkenga(); // never post an empty list over a stored one (host C remount)
})();
/* end akuko-decision-writer */
