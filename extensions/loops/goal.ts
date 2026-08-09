/**
 * pi-goal-list-loop-audit — v0.34.114 installer
 * extensions/loops/goal.ts
 *
 * Decomposition step 6: the large historical goal runtime now lives in the
 * sibling goal-runtime.ts module. This file is intentionally the thin public
 * installer/export surface so the extension entry remains stable for pi and
 * for source-pinned imports.
 */

export * from "./goal-runtime.js";
export { default } from "./goal-runtime.js";
