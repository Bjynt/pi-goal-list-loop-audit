// pi-goal-list-loop-audit — v0.26.7
// tests/stale-api-terminal.test.ts
//
// pi 0.82.x invalidates the extension runtime on session replacement
// (ctx.newSession/fork/switchSession/reload; the compaction path reaches
// the same teardownCurrent → dispose → invalidate in pi's
// agent-session-runtime.js). Once stale, EVERY sendMessage throws
// forever in-process (`staleMessage ??=` — never cleared). Field-observed
// in hegemon 2026-07-26: goal_continuation_send_failed at EVERY
// compaction (10:10, 19:28, 19:30) with pi's exact stale error; a goal
// the user created never auto-started (continuation send threw); the
// heartbeat retried into a void. Retrying a dead handle is the hegemon
// failure shape — the fix detects the stale signature and goes
// terminally loud on FIRST detection (v0.28.1: goals STAY ACTIVE with an
// interrupt marker so the next fresh session auto-resumes; loops stop).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { isStaleApiError } from "../extensions/goal-loop-core.ts";

const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");

const PI_STALE_MSG = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

test("isStaleApiError matches pi's exact stale signature, rejects everything else", () => {
  assert.equal(isStaleApiError(new Error(PI_STALE_MSG)), true);
  assert.equal(isStaleApiError(new Error("stale after session replacement or reload. …")), true);
  assert.equal(isStaleApiError(new Error("quota exceeded")), false);
  assert.equal(isStaleApiError(new Error("network timeout")), false);
  assert.equal(isStaleApiError("stale after session replacement"), false, "non-Error");
  assert.equal(isStaleApiError(null), false);
  assert.equal(isStaleApiError(undefined), false);
});

test("both autonomous send paths detect staleness and go terminal", () => {
  const cont = SRC.indexOf('if (isStaleApiError(err)) goStaleTerminal(ctx, "sendContinuation");');
  const loop = SRC.indexOf('if (isStaleApiError(err)) goStaleTerminal(ctx, "sendLoopTurn");');
  assert.ok(cont > 0, "sendContinuation detects");
  assert.ok(loop > 0, "sendLoopTurn detects");
});

test("terminal path: ledger event, single-fire, goal ACTIVE+marker / loop stop with restart guidance", () => {
  assert.match(SRC, /let extensionApiStale = false;/);
  assert.match(SRC, /if \(extensionApiStale\) return; \/\/ already terminal/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "extension_api_stale", \{ where, kind:/);
  // v0.28.1 (S1/S2): the stale goal branch keeps status ACTIVE and sets the
  // interrupt marker — pausing here stranded goals (restore only
  // auto-resumes active goals).
  assert.match(SRC, /updateGoal\(\{ interruptedAt: nowIso\(\), interruptedReason: `extension api stale \(\$\{where\}\)` \}, ctx\)/);
  assert.ok(!SRC.includes('pauseReason: "extension api stale (pi session replacement)"'), "old pause shape gone");
  assert.match(SRC, /Run \/reload — extensions rebuild IN PLACE, no pi restart needed — then \/glla resume \(autoresume=on resumes for you\)\. Restart pi only if \/reload itself fails\./);
  // guidance names the pi-side cause:
  assert.match(SRC, /session replacement — the session was disposed and this process's sends can never land/);
});

test("v0.29.11 — heartbeat PROBES staleness before burning stall refires", () => {
  // Field (polis stall 3/5, endless-td stall 1/5, 2026-07-30): the
  // heartbeat refired into a session-replaced handle until a send happened
  // to throw. Now the first tick after replacement goes terminal at once.
  assert.match(SRC, /if \(probeExtensionApiStale\(\)\) \{ goStaleTerminal\(ctx, "heartbeat probe"\); return; \}/);
});

test("v0.29.11 — stale/stall-stopped loops HOLD on next load (resume, not restart-from-scratch)", () => {
  // "loops need /loop start" discarded iteration/best/history; the loop
  // now holds on restore and /loop resume continues from the saved state.
  assert.match(SRC, /stopReason\?\.startsWith\("extension api stale"\) \|\| state\.loop\.stopReason\?\.startsWith\("stalled:"\)/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "loop_held_for_resume"/);
  assert.match(SRC, /Restart pi, then \/loop resume \(the loop holds on restore\)\./);
  assert.ok(!SRC.includes("loops need /loop start"), "stale guidance no longer discards loop state");
  assert.ok(!SRC.includes("then /loop start again"), "stall escalation no longer discards loop state");
});

test("v0.29.12 — /glla resume is stale-aware (the zombie must not say 'Nothing to resume')", () => {
  // Field (endless-td 2026-07-30): the zombie instance answered /glla
  // resume with "Nothing to resume" — misleading. The entry probe now
  // names the real recovery: /reload rebuilds extensions in place.
  assert.match(SRC, /warnIfStaleAtEntry\(ctx, "\/glla resume"\)/);
  assert.ok(!SRC.includes("compaction triggers it in pi 0.82.x"), "compaction blame removed — compaction never disposes (pi 0.83.0 source-verified)");
});

test("v0.29.13 — automatic recovery: tmux keystroke self-heal (opt-out via autoReloadOnStale=false)", () => {
  // pi walls ctx.reload() behind assertActive() — the zombie can't
  // self-reload through the API. But fs/child_process are extension-side:
  // when pi runs inside tmux, inject /reload as keystrokes into our own
  // pane; the fresh instance then loads state and holds (autoresume=on
  // resumes for you). Outside tmux the manual warning stands alone.
  const SETTINGS = fs.readFileSync(new URL("../extensions/goal-settings.ts", import.meta.url), "utf8");
  assert.match(SRC, /loadSettings\(ctx\.cwd\)\.autoReloadOnStale === false/);
  assert.ok(SRC.includes("process.env.TMUX_PANE"));
  assert.ok(SRC.includes("/^%\\d+$/"), "pane shape validated before shell use");
  assert.match(SRC, /appendLedger\(ctx\.cwd, "auto_reload_injected"/);
  assert.ok(SRC.includes("tmux send-keys -t ${pane} Escape"));
  assert.ok(SRC.includes("-l '/reload'"));
  assert.ok(SETTINGS.includes("autoReloadOnStale?: boolean"));
});

test("v0.29.22 — self-heal transport-generalized to WezTerm + fires from the entry probe", () => {
  // Field (polis 2026-07-31, user: "stopping and told to reload is
  // common"): this rig runs WezTerm (TERM_PROGRAM=WezTerm, WEZTERM_PANE
  // set, NO TMUX) — the tmux-only gate failed silently 100% of the time
  // (auto_reload_injected had never fired fleet-wide). And the entry
  // probe — the most common stale discovery (/glla resume, /list) —
  // never attempted the self-heal at all.
  assert.match(SRC, /function attemptAutoReload\(ctx: ExtensionContext, where: string\): void/);
  assert.ok(!SRC.includes("attemptTmuxAutoReload"), "tmux-only helper renamed/removed");
  assert.ok(SRC.includes("process.env.WEZTERM_PANE"), "wezterm pane env read");
  assert.ok(SRC.includes("/^\\d+$/"), "wezterm pane id validated before shell use");
  assert.ok(SRC.includes("wezterm cli send-text --pane-id ${pane} --no-paste"), "wezterm keystroke injection");
  assert.ok(SRC.includes("'/reload\\r'"), "reload command + carriage return");
  assert.ok(SRC.includes('appendLedger(ctx.cwd, "auto_reload_injected", { where, transport, pane })'), "ledger names the transport");
  assert.ok(SRC.includes('"auto_reload_skipped"'), "no-multiplexer path ledgered, not silent");
  const entryIdx = SRC.indexOf("function warnIfStaleAtEntry");
  const healIdx = SRC.indexOf('attemptAutoReload(ctx, `entry probe (${what})`);');
  assert.ok(entryIdx > 0 && healIdx > entryIdx, "entry probe self-heals too");
  assert.ok(SRC.includes("glla: extension api stale — run /reload, then /glla resume."), "external notify says /reload, not restart pi");
  assert.ok(!SRC.includes("extension api stale — restart pi"), "stale 'restart pi' external messaging gone");
});

test("send paths short-circuit once stale (no retry-into-the-void)", () => {
  assert.match(SRC, /if \(!extensionApi \|\| extensionApiStale\) return;/, "sendContinuation guard");
  assert.match(SRC, /if \(!extensionApi \|\| extensionApiStale\) return null;/, "sendLoopTurn guard");
});

test("a fresh factory run clears the stale flag (extension reload recovery)", () => {
  assert.match(SRC, /export default function \(pi: ExtensionAPI\): void \{\n  extensionApi = pi;\n  extensionApiStale = false;/);
});
