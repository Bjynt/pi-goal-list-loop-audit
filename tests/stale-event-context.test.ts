import { test } from "node:test";
import * as assert from "node:assert/strict";

import activate from "../extensions/loops/goal.js";
import { makeMockCtx, MockPi, staleError, tmpCwd } from "./harness/mock-pi.js";

test("late agent_settled events with stale contexts are ignored safely", async () => {
  const pi = new MockPi();
  activate(pi.api);

  const ctx = makeMockCtx(tmpCwd());
  const error = staleError();
  for (const key of ["hasUI", "mode", "cwd", "sessionManager", "model"]) {
    Object.defineProperty(ctx, key, {
      configurable: true,
      get() {
        throw error;
      },
    });
  }
  ctx.isIdle = () => {
    throw error;
  };

  await assert.doesNotReject(() => pi.fire("agent_settled", {}, ctx));
});
