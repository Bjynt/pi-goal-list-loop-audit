// pi-goal-list-loop-audit — v0.37.3
// Regression for issue #40: pi >=0.84 does not emit before_agent_start for
// followUp continuations, so the start proof must also accept agent_start /
// turn_start fallback (owner/generation/foreign still fence it).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("v0.37.3 (issue #40) — start proof accepts agent_start fallback for followUp continuations", () => {
  const CONT_SRC = fs.readFileSync(path.resolve("extensions/goal-continuation.ts"), "utf-8");
  // The dispatch gate must allow agent_start/turn_start to create the first proof
  // while before_agent_start still requires the marker.
  assert.match(
    CONT_SRC,
    /source !== "before_agent_start" &&\s*\n?\s*source !== "agent_start" &&\s*\n?\s*source !== "turn_start"/,
    "gate 1 allows before_agent_start, agent_start, turn_start to create first proof",
  );
  assert.match(CONT_SRC, /source === "before_agent_start"/, "before_agent_start branch exists");
  assert.match(CONT_SRC, /!dispatchPromptMatches\(record, prompt\)/, "before_agent_start still requires marker");
  assert.match(CONT_SRC, /source === "agent_start" \|\| source === "turn_start"/, "fallback branch exists");
});

test("v0.37.3 (issue #40) — retry backoff is env-configurable independently", () => {
  const CONT_SRC = fs.readFileSync(path.resolve("extensions/goal-continuation.ts"), "utf-8");
  assert.match(CONT_SRC, /GLLA_CONTINUATION_RETRY_BACKOFF_MS/, "retry backoff env var");
  assert.match(CONT_SRC, /const NO_TURN_START_RETRY_BACKOFF_MS = Number\(/, "backoff reads env at load");
});

test("v0.37.3 (issue #40) — activation wires agent_start and turn_start fallbacks", () => {
  const ACT_SRC = fs.readFileSync(path.resolve("extensions/loops/goal-activation.ts"), "utf-8");
  assert.match(ACT_SRC, /dispatchStartAcknowledged\(ctx, "agent_start"\)/, "activation wires agent_start proof");
  assert.match(ACT_SRC, /dispatchStartAcknowledged\(ctx, "turn_start"\)/, "activation wires turn_start proof");
  assert.match(ACT_SRC, /pi\.on\("before_agent_start"/, "before_agent_start still wired as primary");
});
