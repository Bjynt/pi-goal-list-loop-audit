import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { waitForDurableEvent, readDurableFile } from "../scripts/durable-wait.mjs";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function scratchFile() {
  const directory = await mkdtemp("/tmp/glla-durable-wait-");
  const file = path.join(directory, "active.jsonl");
  await writeFile(file, '{"event":"pending"}\n');
  return { directory, file };
}

async function cleanup(directory, timers) {
  for (const timer of timers) clearTimeout(timer);
  await rm(directory, { recursive: true, force: true });
}

test("durable wait succeeds before its deadline and reports elapsed polling", async () => {
  const { directory, file } = await scratchFile();
  const timers = [setTimeout(() => appendFile(file, '{"event":"done"}\n'), 20)];
  try {
    const result = await waitForDurableEvent(
      () => readDurableFile(file, { doneNeedles: ['"event":"done"'] }),
      { timeoutMs: 250, pollIntervalMs: 5 },
    );
    assert.equal(result.ok, true);
    assert.equal(result.terminalReason, "done");
    assert.ok(result.elapsedMs < 250, `wait took ${result.elapsedMs}ms`);
    assert.ok(result.checks >= 2, "the reader was polled after the initial read");
  } finally {
    await cleanup(directory, timers);
  }
});

test("durable wait returns a real timeout instead of treating elapsed time as success", async () => {
  const { directory, file } = await scratchFile();
  try {
    const result = await waitForDurableEvent(
      () => readDurableFile(file, { doneNeedles: ['"event":"never"'] }),
      { timeoutMs: 30, pollIntervalMs: 5 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.terminalReason, "timeout");
    assert.ok(result.elapsedMs >= 30, `timeout returned early at ${result.elapsedMs}ms`);
    assert.ok(result.elapsedMs < 300, `timeout exceeded its bound at ${result.elapsedMs}ms`);
  } finally {
    await cleanup(directory, []);
  }
});

test("a restarted waiter observes the same durable file without an old timer", async () => {
  const { directory, file } = await scratchFile();
  const timers = [setTimeout(() => appendFile(file, '{"event":"restart"}\n'), 10)];
  try {
    const first = await waitForDurableEvent(
      () => readDurableFile(file, {
        doneNeedles: ['"event":"done"'],
        terminalNeedles: [{ reason: "restart", needle: '"event":"restart"' }],
      }),
      { timeoutMs: 250, pollIntervalMs: 5 },
    );
    assert.equal(first.terminalReason, "restart");

    const secondTimer = setTimeout(() => appendFile(file, '{"event":"done"}\n'), 10);
    timers.push(secondTimer);
    const second = await waitForDurableEvent(
      () => readDurableFile(file, { doneNeedles: ['"event":"done"'] }),
      { timeoutMs: 250, pollIntervalMs: 5 },
    );
    assert.equal(second.ok, true);
    assert.equal(second.terminalReason, "done");
  } finally {
    await cleanup(directory, timers);
  }
});

test("provider recovery is a terminal reason, never a false approval or timeout", async () => {
  const { directory, file } = await scratchFile();
  const timers = [setTimeout(() => appendFile(file, '{"event":"main_model_recovery_wait"}\n'), 10)];
  try {
    const result = await waitForDurableEvent(
      () => readDurableFile(file, {
        doneNeedles: ['"approved":true'],
        terminalNeedles: [{ reason: "provider-failure", needle: '"event":"main_model_recovery_wait"' }],
      }),
      { timeoutMs: 250, pollIntervalMs: 5 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.terminalReason, "provider-failure");
    assert.ok(result.elapsedMs < 250, "provider failure should end the wait promptly");
  } finally {
    await cleanup(directory, timers);
  }
});

test("smoke harness uses the durable wait CLI for durable outcomes", async () => {
  const smoke = await readFile(new URL("../scripts/smoke.sh", import.meta.url), "utf8");
  assert.match(smoke, /scripts\/durable-wait\.mjs/);
  assert.match(smoke, /wait_for_durable/);
});

// Keep this test file from leaving a dangling event-loop delay if a future
// implementation changes cleanup behavior during a failed assertion.
await pause(0);
