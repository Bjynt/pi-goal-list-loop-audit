# Confirm dialog renders markdown — GitHub #4

2026-08-07 · item 2 of the "note.md newer ones" batch · v0.34.78

## The complaint (as filed)

[github.com/DraconDev/pi-goal-list-loop-audit/issues/4](https://github.com/DraconDev/pi-goal-list-loop-audit/issues/4):
`confirmDraft()` rendered the draft confirmation through `ctx.ui.select(title
+ "\n\n" + body, ["Yes", ALWAYS, "No"])` — a plain-text dialog with no
markdown support and no word wrapping — while the README promises every
confirm dialog renders through the rpiv `ask_user_question` tool with
markdown previews. Long objectives + verification contracts were hard to
read.

Verified against the installed runtime (pi 0.84.1): `ExtensionUIContext.select`
is `select(title: string, options: string[], opts?)` — plain strings only.
`ask_user_question` is an AGENT tool (it runs in a separate agent turn), so
`confirmDraft` cannot route through it directly. The correct primitive is
`ctx.ui.custom`, which can host real TUI components.

## The fix

- **`extensions/confirm-draft.ts` (new)**: `ConfirmDraftComponent` — a
  `ctx.ui.custom` component: DynamicBorder frame, `Markdown` body (title as
  H1 via `buildConfirmDraftMarkdown`, objective + contract at full width with
  word wrapping + syntax highlighting), a `SelectList` with the same three
  choices (`Yes` / `Yes — and always auto-accept drafts` / `No`), and a help
  line. The MarkdownTheme is built from the runtime Theme's own `md*` colors
  (`theme.fg("mdHeading", …)`), so the dialog follows the active theme.
- **`extensions/loops/goal.ts` `confirmDraft`**: custom-first — when
  `ctx.ui.custom` is a function, render the component; the plain `select`
  path remains byte-identical as the headless/RPC fallback (and as the
  non-stale custom-error degrade). The ALWAYS escape hatch, the
  `saveSettings("project", …)` persistence, the `draft_autoaccept_enabled`
  ledger entry, and the stale-API `"stale"` semantics are shared by both
  paths. A test-only hook (`__testOnlyLastConfirmDialog`) captures the
  rendered dialog's title/body/options for the mock harness (the mock never
  invokes the custom builder).

## Behavioral notes

- Draft confirms in the REAL interactive runtime now render markdown; the
  three converted harness tests (T1a stale, late-confirm, ALWAYS escape
  hatch) drive the dialog through `customImpl` instead of `selectImpl` —
  same semantics, new rendering path.
- Esc/cancel in the SelectList resolves `done(undefined)` → "no" (identical
  to the select path's `undefined` → "no").

## Evidence

- `tests/confirm-draft.test.ts` (new, 8 tests): pure markdown builder; the
  component renders title/body/all three choices at width; first-choice
  preselection + no-throw input/invalidate; custom path Yes/No/stale with
  dialog capture; select fallback Yes/stale when `custom` is unavailable.
- `tests/behavioral-orchestrator.test.ts`: 3 tests converted to `customImpl`.
- Full suite: **1034 pass / 1 skip / 0 fail across 96 files** (was
  1026/1/0 at v0.34.77), `npx tsc --noEmit` clean.

## v0.34.80 rework — the detached auditor disapproved (2026-08-07)

The item's own detached auditor (opencode-go/deepseek-v4-flash) DISAPPROVED
v0.34.78 with a legitimate finding: **the headless/RPC fallback is dead code
in the actual runtime**.

- pi 0.84.1's `custom` is **always a function**: RPC mode is
  `async custom() { /* Custom UI not supported */ return undefined; }`
  (dist/modes/rpc/rpc-mode.js:152) and the noOp/print runner is
  `custom: async () => undefined` (dist/core/extensions/runner.js:103) —
  neither ever invokes the factory.
- So `typeof custom === "function"` was true in every mode; the
  `custom = undefined` fallback tests emulated a state that never occurs.
- Worse: in RPC mode v0.34.77's `ctx.ui.select(...)` emitted
  `extension_ui_request {method:"select"}` which the host renders and
  answers; v0.34.78's `ctx.ui.custom(...)` resolved `undefined` instantly →
  `"no"` → every draft silently rejected, no dialog ever shown — a real
  regression in the exact mode the objective named.

### Required fixes (all done)

1. **Factory-invocation detection** (goal.ts `confirmDraft` + the copied
   `promptSettingsMenu` pattern): the custom-path factory sets a
   `factoryInvoked` flag; if `ctx.ui.custom(...)` settles and the builder
   never ran, custom is treated as unavailable and the byte-identical
   `ctx.ui.select` path takes over (ALWAYS/stale semantics preserved on both
   paths). Ledgered as `confirm_dialog_fallback_select` / `settings_menu_fallback_select`
   with `via: "custom-stub"`.
2. **Real-RPC-shape tests**: the mock harness now emulates real interactive
   pi (the factory IS invoked with a minimal fake tui/theme/keybindings) and
   gains `customStubMode=true` to reproduce the pi 0.84.1 RPC stub exactly
   (custom present, resolves `undefined`, builder never runs). New tests:
   the stub falls through to the select host dialog and accepts (Yes),
   declines (No), and returns stale on a stale select error. The
   `custom = undefined` emulation tests remain as the absent-API shape.
3. **Suite + tsc re-run**: 1045 pass / 1 skip / 0 fail across 97 files,
   `npx tsc --noEmit` clean.
