import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const smokeScript = `
import Module from "node:module";
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "pi-subagents" || request === "@tintinweb/pi-subagents") throw new Error("optional provider was imported");
  return originalLoad.call(this, request, ...args);
};
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const loaded = await jiti.import("./extensions/loops/goal.ts");
if (typeof loaded.default !== "function") throw new Error("GLLA extension did not load");
console.log("no-provider-smoke-ok");
`;

test("GLLA loads without the optional pi-subagents provider", async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", smokeScript], {
      cwd: process.cwd(),
      env: { ...process.env, PI_CODING_AGENT_DIR: "/tmp/glla-no-provider-agent-dir" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.once("error", (error) => resolve({ code: null, signal: null, stdout, stderr: String(error) }));
  });
  assert.equal(result.code, 0, result.stderr || `child signal: ${result.signal}`);
  assert.match(result.stdout, /no-provider-smoke-ok/);
});
