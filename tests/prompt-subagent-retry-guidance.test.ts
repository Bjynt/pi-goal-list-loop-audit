// pi-goal-list-loop-audit — v0.25.0
// tests/prompt-subagent-retry-guidance.test.ts
//
// Eager-continuation contract item 38 (Section J): the continuation prompt
// treats subagent provider/runtime failures as generic retryable failures.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const prompt = fs.readFileSync(
  path.resolve("prompts", "goal-loop-continuation.md"),
  "utf-8",
);

test("continuation prompt treats provider wording as generic retryable failure (item 38)", () => {
  assert.match(prompt, /WHEN SUBAGENTS HIT PROVIDER\/RUNTIME ERRORS/);
  assert.match(prompt, /resume.*immediately|retry/i);
  assert.doesNotMatch(prompt, /wait for the upstream quota|wait for the quota window|Do NOT spawn more subagents.*quota/i);
  assert.match(prompt, /subagent|spawn/i);
  assert.match(prompt, /quota.*reset|rate-limit|billing|usage/i);
});

test("continuation prompt resumes or retries a failed subagent without a reset wait", () => {
  assert.match(prompt, /Resume it immediately/);
  assert.match(prompt, /retry a\s+bounded narrower spawn/i);
  assert.doesNotMatch(prompt, /Do NOT spawn more subagents/i);
});
