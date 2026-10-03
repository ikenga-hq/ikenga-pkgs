// operator.js — operator-identity helpers shared by every no-build domain app
// pkg (sales/research/content/strategy). SOURCE OF TRUTH — vendored
// byte-identically into each pkg's dist/lib/operator.js via vendorRuntime()
// (add 'operator' to that pkg's build.mjs `files` list). Never hand-edit a
// vendored copy; edit here and re-run the pkg's `scripts/build.mjs`.
//
// hostContext.operator is OPTIONAL (see @ikenga/contract's host-context.ts —
// IkengaHostContextExtensions.operator: OperatorIdentity | undefined): absent
// means an UNKNOWN operator, not a default one. Every helper below fails safe
// on a null/undefined operatorId — "mine" matches nothing, "other owner"
// defaults to true (never mislabels an unclaimed row as the human), and
// initials degrade to a neutral glyph rather than guessing an identity.
//
// This module is host/bridge-agnostic on purpose (pure functions only, no
// import from bridge.js): callers thread the plain `operatorId` string (or
// null) down from app.js's `connectBridge()` ctx.operator.id, the same way
// `activeFeature` is already threaded from ctx.royaltiSuite.activeFeature.

/** True only when `value` names the CURRENT known operator. An unknown
 *  operator (`operatorId` null/undefined) never matches — a "mine" filter or
 *  badge count degrades to empty, never to "everyone" or "no one knows". */
export function isMine(value, operatorId) {
  return operatorId != null && value === operatorId;
}

/** True when `value` names an owner other than the current operator — the
 *  complement used for "agent-tracked" grouping and is-agent avatar styling.
 *  An unknown operator makes every named owner read as "other" (we can never
 *  be sure an unclaimed value is the human), so this defaults to true rather
 *  than false when `operatorId` is null. */
export function isOtherOwner(value, operatorId) {
  return value != null && value !== operatorId;
}

/** Single-glyph label for an avatar/initial badge. Falls back to '?' rather
 *  than guessing when the label is missing or empty. */
export function initialOf(label) {
  return typeof label === 'string' && label.length > 0 ? label[0].toUpperCase() : '?';
}
