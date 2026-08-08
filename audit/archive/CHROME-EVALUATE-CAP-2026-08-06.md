# chrome_evaluate output cap — steal-list #13 / bug class #1.2

**Date:** 2026-08-06 · **Status:** applied (list item #6, goal `20260806183719-ox0kxh`)

## Problem

A single `chrome_evaluate` returning a scraped HTML page can blow the model's
`maximum output token limit`, force a compaction, and (on the affected rigs)
go stale on the Chrome Bridge handle — see `Screenshot_20260805_225654.png`
and OPEN-ISSUES-2026-08-06.md bug #1.2. The old tool returned the full
payload inline (`truncateText` at a 30 KB char cap) AND stuffed the complete
raw value into `details` — both unbounded relative to the model's output
budget when the model starts quoting the page back.

## Fix

`chrome_evaluate` results over an 8 KB cap are no longer returned inline:

- **Structured digest** replaces the payload in the tool result (type, byte
  count, cap, sidecar path, and a structural sketch: string head preview /
  object keys with per-key type+size / array items, bounded at 15 entries).
- **Raw payload sidecar** is written to
  `<cwd>/.pi/chrome-evaluate-sidecars/evaluate-<iso>-<rand>.(txt|json)` —
  verbatim string for string results, pretty-printed JSON otherwise. The
  digest names the absolute path, so the model can `read` the sidecar on
  demand. The `details` object never carries the raw payload when capped
  (`{ capped, type, bytes, capBytes, sidecar }` only).
- **Config knob:** `PI_CHROME_EVALUATE_OUTPUT_CAP` (bytes, default 8192;
  non-numeric/≤0 values fall back to the default).
- Under the cap the behavior is byte-for-byte unchanged (inline text,
  `details.value`).

## Files

- `extensions/chrome-profile-bridge/evaluate-cap.mjs` — NEW, pure ESM
  (no fs/pi imports): `capEvaluateOutput(value, { capBytes, sidecarDir,
  now })` → `{ kind: "inline", text, details }` | `{ kind: "sidecar", text,
  details, sidecarPath, sidecarPayload }`; `evaluateText()` serialization
  rules; `EVALUATE_CAP_DEFAULT_BYTES = 8 * 1024`.
- `extensions/chrome-profile-bridge/index.ts` — imports the module; adds
  `EVALUATE_OUTPUT_CAP_BYTES` (env-configurable, finite-guarded) and
  `EVALUATE_SIDECAR_DIR = ".pi/chrome-evaluate-sidecars"`; the
  `chrome_evaluate` execute handler now resolves `workspaceCwd(ctx)`, calls
  `capEvaluateOutput`, writes the sidecar (mkdir + writeFile) when the
  result is capped, and returns `{ content: [digest], details }`.
  The old handler body it replaced:

  ```ts
  async execute(_id, params, signal): Promise<ToolTextResult> {
    const value = await authorizedBridgeSend("page.evaluate", withBackground(params), DEFAULT_TIMEOUT_MS, signal);
    const text = value === undefined ? "undefined" : typeof value === "string" ? value : safeJson(value) ?? "undefined";
    return { content: [{ type: "text", text: truncateText(text) }], details: { value: value as Json } };
  },
  ```

- `test-suite/unit/evaluate-cap.test.mjs` — NEW, plain-node `node:test`:
  10 tests pinning the default 8 KB cap, inline-under-cap parity, the
  at-cap/over-cap boundary on the configured size, string/object/array
  digest structure + payload round-trip, the (b) readability contract
  (write returned payload to returned path → exact raw payload), the
  undefined edge, the no-sidecar-dir truncation fallback, and
  `evaluateText` serialization rules.
- `package.json` — `npm test` now also runs the new unit file
  (csp-eval + automation-target + evaluate-cap).

## Where it lives

The loaded copy is `~/.pi/agent/npm/node_modules/pi-chrome/` (resolved from
`npm:pi-chrome` in `~/.pi/agent/settings.json`); the change is mirrored to
the parallel `~/.npm-global/lib/node_modules/pi-chrome/` install. Neither is
a git repo — **re-apply this fix after any `pi update pi-chrome`** by
copying the three files back (or re-publishing the package).

## Verification

- `node test-suite/unit/evaluate-cap.test.mjs` → 10 pass / 0 fail
- `npm test` in pi-chrome → 26 + 62 + 10 = 98 pass / 0 fail
- `bun build extensions/chrome-profile-bridge/index.ts` → bundles the .mjs
  module (import resolution confirmed; jiti loads extensions at runtime)
- glla repo suite → 922 pass / 1 env skip / 0 fail (unchanged — no glla
  code touched); `npx tsc --noEmit` clean
- Takes effect on the next pi start or /reload of the running instance
  (no live reload performed during this session).
