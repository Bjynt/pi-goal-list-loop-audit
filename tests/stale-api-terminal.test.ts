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
  // v0.32.0: CRITICAL regression fix — the terminal path gates on its OWN flag;
  // extensionApiStale is set by the PROBE, so gating on it made the heartbeat's
  // probe→terminal sequence dead code. The orphan path must still preserve
  // state and explain the lifecycle boundary.
  assert.match(SRC, /let staleTerminalDone = false;/);
  assert.match(SRC, /if \(staleTerminalDone\) return; \/\/ already terminal/);
  assert.match(SRC, /if \(probeExtensionApiStale\(\)\) return;/); // no-ctx send path must not spin a 50ms re-arm
  assert.match(SRC, /clearInterval\(heartbeatTimer\)/); // zombie stand-down clears the immortal tickers
  assert.match(SRC, /clearInterval\(uiTicker\)/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "extension_api_stale", \{ where, kind:/);
  // v0.28.1 (S1/S2): the stale goal branch keeps status ACTIVE and sets the
  // interrupt marker — pausing here stranded goals (restore only
  // auto-resumes active goals).
  assert.match(SRC, /updateGoal\(\{ interruptedAt: nowIso\(\), interruptedReason: `extension api stale \(\$\{where\}\)` \}, ctx\)/);
  assert.ok(!SRC.includes('pauseReason: "extension api stale (pi session replacement)"'), "old pause shape gone");
  assert.match(SRC, /without delivering a replacement session\. glla stopped stale sends and kept the work safe in \.pi-glla\//);
  // guidance names the lifecycle handoff and the genuine orphan case:
  assert.match(SRC, /without delivering a replacement session/);
});

test("v0.29.11 — heartbeat PROBES staleness before burning stall refires", () => {
  // Field (polis stall 3/5, endless-td stall 1/5, 2026-07-30): the
  // heartbeat refired into a session-replaced handle until a send happened
  // to throw. Now the first tick after replacement goes terminal at once.
  // v0.30.0: terminal only for ORPHANS — rebind-window and
  // successor-instance cases are absorbed silently first.
  // v0.34.62: the probe is now the RAW non-caching form inside a debounce
  // (HEARTBEAT_STALE_DEBOUNCE) — a single transient probe failure must not
  // park a live session (hegemon 2026-08-06); consecutive failures still
  // go terminal before any stall refire can burn.
  assert.match(SRC, /const knownCtx = lastCtx;[\s\S]*if \(extensionApiStale \|\| probeExtensionApiStaleRaw\(\)\) \{[\s\S]*if \(knownCtx && !absorbStaleIfSuperseded\(knownCtx\)\) goStaleTerminal\(knownCtx, "heartbeat probe"\);/);
});

test("v0.30.0 — rebind-first survival: session_shutdown attribution, session_start rebind, zombie stand-down", () => {
  // Pi's sanctioned lifecycle is the recovery boundary: persist debt before
  // shutdown, stop old timers, then resume from a fresh session_start ctx.
  assert.match(SRC, /pi\.on\("session_shutdown", async \(event: any, ctx: ExtensionContext\) => \{/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "session_shutdown", \{ reason: shutdownReason \}\);/);
  assert.match(SRC, /writeSessionHandoff\(ctx, shutdownReason\);/);
  assert.match(SRC, /clearSessionOwnedTimers\(\);/);
  assert.match(SRC, /sessionReplacementUntil = Date\.now\(\) \+ SESSION_REBIND_GRACE_MS;/);
  assert.ok(SRC.includes('appendLedger(ctx.cwd, "session_handoff_pending", { reason, pid: process.pid, generation: sessionGeneration });'), "handoff debt is ledgered with its generation");
  assert.ok(SRC.includes('appendLedger(ctx.cwd, "session_handoff_suppressed", { reason });'), "explicit quit does not create resume debt");
  assert.match(SRC, /data\.reason\?\.trim\(\)\.toLowerCase\(\) !== "quit"/, "legacy quit debt cannot bypass consent");
  assert.match(SRC, /data\.generation === expectedGeneration/, "handoff must match the predecessor generation");
  assert.match(SRC, /data\.ownerSessionId === expectedOwnerSessionId/, "handoff must match the predecessor owner");
  assert.ok(SRC.includes('appendLedger(ctx.cwd, "session_handoff_resumed", { pid: process.pid, reason: startReason });'), "handoff consumption is ledgered");
  assert.ok(SRC.includes("sessionHandoffPending = false;"), "fresh session reopens the runtime");
  assert.ok(SRC.includes("startHeartbeat();") && SRC.includes("startUITicker();"), "fresh session restarts timers");
  assert.ok(SRC.includes("writeOwnerFile(ctx.cwd);"), "session_start claims ownership");
  assert.ok(SRC.includes('appendLedger(ctx.cwd, "zombie_stood_down", { owner: owner.instanceId });'), "successor stand-down ledgered");
  assert.ok(SRC.includes('appendLedger(ctx.cwd, "stale_awaiting_rebind", {});'), "rebind window absorbs stale probes");
  assert.ok(SRC.includes("owner.instanceId !== instanceId"), "stand-down only when a DIFFERENT instance owns the cwd");
  assert.ok(SRC.includes("owner.pid === process.pid"), "stand-down is same-process only (cross-process twins untouched)");
  assert.match(SRC, /function goStaleTerminal\(ctx: ExtensionContext, where: string\): void/);
  assert.ok(!SRC.includes("function attemptAutoReload"), "terminal transport was removed");
  assert.ok(!SRC.includes("auto_reload_injected"), "no terminal keystroke ledger remains");
});

test("v0.29.11 — stale/stall-stopped loops HOLD on next load (resume, not restart-from-scratch)", () => {
  // "loops need /loop start" discarded iteration/best/history; the loop
  // now holds on restore and /loop resume continues from the saved state.
  assert.match(SRC, /stopReason\?\.startsWith\("extension api stale"\) \|\| state\.loop\.stopReason\?\.startsWith\("stalled:"\)/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "loop_held_for_resume"/);
  assert.match(SRC, /then \/loop resume — the loop holds on restore\./);
  assert.ok(!SRC.includes("loops need /loop start"), "stale guidance no longer discards loop state");
  assert.ok(!SRC.includes("then /loop start again"), "stall escalation no longer discards loop state");
});

test("v0.29.12 — /glla resume is stale-aware (the zombie must not say 'Nothing to resume')", () => {
  // Field (endless-td 2026-07-30): the zombie instance answered /glla
  // resume with "Nothing to resume" — misleading. The entry probe now
  // names the real recovery: wait for lifecycle replacement, or restart pi
  // normally if this is a true orphan.
  assert.match(SRC, /warnIfStaleAtEntry\(ctx, "\/glla resume"\)/);
  assert.ok(!SRC.includes("compaction triggers it in pi 0.82.x"), "compaction blame removed — compaction never disposes (pi 0.83.0 source-verified)");
});

test("v0.34.16 — lifecycle handoff replaces terminal keystroke recovery", () => {
  const SETTINGS = fs.readFileSync(new URL("../extensions/goal-settings.ts", import.meta.url), "utf8");
  assert.match(SRC, /const SESSION_HANDOFF_FILE = "session-handoff\.json";/);
  assert.match(SRC, /function writeSessionHandoff\(ctx: ExtensionContext, reason: string\): boolean/);
  assert.match(SRC, /function consumeSessionHandoff\(\n  cwd: string,\n  expectedGeneration: number \| null,\n  expectedOwnerSessionId: string \| null,\n\): boolean/);
  assert.match(SRC, /scheduleSessionTimeout\(callback: \(\) => void, delayMs: number\): NodeJS\.Timeout/);
  assert.match(SRC, /for \(const timer of sessionTimeouts\) clearTimeout\(timer\);/);
  assert.ok(!SRC.includes("process.env.TMUX_PANE"), "no tmux keystroke transport");
  assert.ok(!SRC.includes("process.env.WEZTERM_PANE"), "no WezTerm keystroke transport");
  assert.ok(!SRC.includes("auto_reload_injected"), "no automatic /reload ledger event");
  assert.match(SETTINGS, /@deprecated v0\.34\.16/);
});

test("v0.34.16 — lifecycle recovery has no multiplexer dependency", () => {
  assert.ok(!SRC.includes("attemptTmuxAutoReload"), "old tmux helper is gone");
  assert.ok(!SRC.includes("process.env.WEZTERM_PANE"), "no WezTerm pane transport");
  assert.ok(!SRC.includes("wezterm cli send-text"), "no WezTerm keystroke injection");
  assert.ok(!SRC.includes("tmux send-keys"), "no tmux keystroke injection");
  assert.ok(SRC.includes("waiting for a fresh session_start"), "orphan guidance names the lifecycle boundary");
});

test("v0.34.16 — stale paths never inject terminal input", () => {
  assert.ok(!SRC.includes("send-keys"), "no terminal keystrokes");
  assert.ok(!SRC.includes("'\\x1b'"), "no Escape byte");
  const entryIdx = SRC.indexOf("function warnIfStaleAtEntry");
  const entryEnd = SRC.indexOf("}", SRC.indexOf("return true;", entryIdx));
  const entryBlock = SRC.slice(entryIdx, entryEnd);
  assert.ok(!entryBlock.includes("exec("), "entry probe has no transport side effect");
  assert.ok(!SRC.includes("attemptAutoReload"), "no stale self-reload helper");
});

test("send paths short-circuit once stale (no retry-into-the-void)", () => {
  assert.match(SRC, /if \(!extensionApi \|\| extensionApiStale\) return;/, "sendContinuation guard");
  assert.match(SRC, /if \(!extensionApi \|\| extensionApiStale\) return null;/, "sendLoopTurn guard");
});

test("a fresh factory run clears the stale flag (extension reload recovery)", () => {
  assert.match(SRC, /export default function \(pi: ExtensionAPI\): void \{\n  extensionApi = pi;\n  extensionApiStale = false;/);
});

test("v0.32.0: audit-opportunistic fix batch — dispose, keys, caps, message", () => {
  // v0.34.108: the in-process auditor session (dispose?.()) is gone with
  // runGoalCompletionAuditor; the production path kills every detached
  // worker child on complete_goal teardown — no worker leaked per complete.
  const AUD = fs.readFileSync("extensions/goal-loop-auditor-process.ts", "utf-8");
  assert.match(AUD, /child\.kill\("SIGTERM"\)/); // detached auditor children are terminated on teardown
  const GS = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  assert.match(GS, /"auditorModelFallback",/); // provenance-tracked — menu row shows pinned value
  assert.match(GS, /"auditorSameSessionSwap",/);
  const GOAL = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(GOAL, /slice\(0, 50\)/); // fan-out cap
  assert.match(GOAL, /MAX_AUDITOR_QUOTA_AUTO_ATTEMPTS = 5/); // durable quota retry terminal cap
  // v0.34.108: quotaRetryStreak (process-local mirror) was dead code and removed;
  // the durable reset is quotaAttempts: undefined on a manual-origin audit claim.
  assert.match(GOAL, /origin === "manual"\n\s*\? \{ \.\.\.claim, quotaAttempts: undefined, quotaFirstAt: undefined, quotaAutoRetryUntil: undefined \}/); // streak resets on any non-quota outcome
  assert.match(GOAL, /handing off to a fresh pi context — /); // entry probe names the lifecycle handoff honestly
  assert.match(GOAL, /function clearSessionOwnedTimers\(\): void/); // terminal kills all old-session timers
});

// v0.34.94 — host-session-lost self-heal. Field evidence (darklord/hegemon
// Screenshot_20260808_080109/080230/080248): pi invalidated the extension
// handle WITHOUT delivering a replacement session (silent_handle_death);
// the plugin sat with staleTerminalDone=true and extensionApiStale=true
// forever, the user had to manually restart pi. The heartbeat probe is now
// evidence of recovery: when raw probe returns false (pi is fresh) but
// staleTerminalDone is still latched, the heartbeat self-heals the
// in-memory state and absorbs the replacement via tryAbsorbHostSuccessor.
// No sends are re-queued, so there is NO blind queue storm risk — the
// path just unblocks future events from a fresh ctx.
test("v0.34.94: heartbeat self-heals stale-terminal when raw probe says pi is fresh", () => {
  // The new heartbeat path lives between the raw-probe and freshCtx() call
  // in heartbeatTick. It checks staleTerminalDone and clears the stale
  // flags so the next freshCtx() returns a non-null ctx.
  assert.match(
    SRC,
    /if \(staleTerminalDone && knownCtx\) \{[\s\S]*appendLedger\(knownCtx\.cwd, "stale_terminal_recovered_via_probe"/,
    "heartbeat self-heal ledger event is recorded",
  );
  assert.match(SRC, /staleTerminalDone = false;\s*\n\s*extensionApiStale = false;/, "stale flags are cleared on probe-fresh-after-stale-terminal");
  assert.match(SRC, /tryAbsorbHostSuccessor\(knownCtx, "heartbeat-self-heal"\)/, "tryAbsorbHostSuccessor is called against the knownCtx");
  // No sends re-queued: the self-heal only resets flags and absorbs — it
  // never calls scheduleContinuation / sendMessage / etc. The user has to
  // either issue a fresh goal or resume explicitly.
  const heartbeatRegion = SRC.match(/stale_terminal_recovered_via_probe[\s\S]{0,800}return;\s*\n\s*\}/);
  assert.ok(heartbeatRegion, "self-heal region is in scope");
  assert.ok(!heartbeatRegion![0].includes("scheduleContinuation"), "no continuation scheduled during self-heal");
  assert.ok(!heartbeatRegion![0].includes("sendMessage"), "no sendMessage during self-heal");
});
