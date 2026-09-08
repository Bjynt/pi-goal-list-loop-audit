import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { deliverTerminalSummary } from "../extensions/terminal-summary-delivery.js";
import { approvalRenderStorePath, persistApprovalRender, replayUndeliveredApprovalRenders } from "../extensions/approval-render-store.js";
import { tmpCwd } from "./harness/mock-pi.js";

function host(cwd = tmpCwd()) {
  const file = path.join(cwd, "session.jsonl");
  const entries: any[] = [];
  const calls: any[] = [];
  let persist = true;
  let hasFile = true;
  const ctx = { cwd, sessionManager: { getBranch: () => entries, getSessionFile: () => hasFile ? file : undefined } };
  const pi = { sendMessage(message: any, options: any) {
    calls.push({ message, options });
    const entry = { type: "custom_message", id: String(calls.length), ...message };
    entries.push(entry); // Pi mutates branch before disk, even on write failure.
    if (persist && hasFile) fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } };
  const deliver = (goalId = "g1", content = "✓ done — fixed routing\nTests: routing suite passed\n— auditor approved.") =>
    deliverTerminalSummary(ctx as never, pi as never, "goal-event", goalId, content);
  return { cwd, ctx, pi, file, entries, calls, deliver, setPersist: (v: boolean) => { persist = v; }, setFile: (v: boolean) => { hasFile = v; } };
}

for (const idle of [true, false]) test(`visible summary persists without an LLM turn (idle=${idle})`, () => {
  const h = host();
  Object.assign(h.ctx, { isIdle: () => idle });
  assert.equal(h.deliver(), true);
  assert.equal(h.calls[0].message.display, true);
  assert.deepEqual(h.calls[0].options, { triggerTurn: false });
  assert.equal(h.deliver(), true);
  assert.equal(h.calls.length, 1);
});

test("branch-before-persist failure stays pending, suppresses duplicate, later persistence confirms", () => {
  const h = host(); h.setPersist(false);
  assert.equal(h.deliver(), false);
  assert.equal(h.deliver(), false);
  assert.equal(h.calls.length, 1);
  fs.writeFileSync(h.file, JSON.stringify(h.entries[0]) + "\n");
  assert.equal(h.deliver(), true);
  assert.equal(h.calls.length, 1);
});

test("no-file session never acknowledges but does not repeat the visible summary", () => {
  const h = host(); h.setFile(false);
  assert.equal(h.deliver(), false);
  assert.equal(h.deliver(), false);
  assert.equal(h.calls.length, 1);
});

test("outbox survives failed delivery and restart; acknowledged render never replays", () => {
  const h = host(); h.setPersist(false);
  const chatLines = ["✓ done — fixed routing", "Tests: routing suite passed", "— auditor approved."];
  persistApprovalRender(h.cwd, { goalId: "g1", objective: "fix routing", chatLines });
  const replay = (target: ReturnType<typeof host>) => replayUndeliveredApprovalRenders(target.ctx, e => target.deliver(e.goalId, e.chatLines.join("\n")));
  assert.equal(replay(h), 0);
  assert.equal(JSON.parse(fs.readFileSync(approvalRenderStorePath(h.cwd), "utf8"))[0].deliveredAt, undefined);
  const restarted = host(h.cwd);
  assert.equal(replay(restarted), 1);
  assert.equal(replay(restarted), 0);
  assert.equal(restarted.calls.length, 1);
  // A repeated settlement cannot enqueue the same goal again.
  persistApprovalRender(h.cwd, { goalId: "g1", objective: "fix routing", chatLines });
  assert.equal(replay(restarted), 0);
});

test("failed outbox acknowledgement does not duplicate an existing persisted branch summary", () => {
  const h = host(); assert.equal(h.deliver(), true);
  persistApprovalRender(h.cwd, { goalId: "g1", objective: "routing", chatLines: h.calls[0].message.content.split("\n") });
  assert.equal(replayUndeliveredApprovalRenders(h.ctx, e => h.deliver(e.goalId, e.chatLines.join("\n"))), 1);
  assert.equal(h.calls.length, 1);
});

test("confirmation requires exact identity/content and complete JSONL, tolerates malformed tail", () => {
  const h = host(); h.setPersist(false); h.deliver();
  const entry = h.entries[0];
  for (const wrong of [{ ...entry, content: "other" }, { ...entry, id: "other" }, { ...entry, details: { terminalApprovalGoalId: "other" } }]) {
    fs.writeFileSync(h.file, JSON.stringify(wrong) + "\n");
    assert.equal(h.deliver(), false);
  }
  fs.writeFileSync(h.file, JSON.stringify(entry));
  assert.equal(h.deliver(), false, "partial trailing record is not confirmed");
  fs.writeFileSync(h.file, JSON.stringify(entry) + "\n{partial");
  assert.equal(h.deliver(), true);
});

test("bounded confirmation fails conservatively when receipt is outside tail", () => {
  const h = host(); assert.equal(h.deliver(), true);
  fs.appendFileSync(h.file, "x".repeat(300 * 1024) + "\n");
  assert.equal(h.deliver(), false);
  assert.equal(h.calls.length, 1);
});
