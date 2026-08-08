
import { readFile, writeFile } from "node:fs/promises";
const dir = process.argv[process.argv.indexOf("--job-dir") + 1];
const request = JSON.parse(await readFile(dir + "/request.json", "utf8"));
const progress = {
  protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash,
  phase: "running", elapsedMs: 1,
  ...(process.env.FAKE_TELEMETRY === "yes" ? {
    lastActivityAt: Date.now(),
    recentOutput: ["inspected README.md"],
    currentTool: "read",
    currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
    currentToolStartedAt: Date.now() - 20,
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: Date.now() - 30 }],
  } : { recentOutput: [], toolCalls: [] }),
};
await writeFile(dir + "/progress.json", JSON.stringify(progress));
await writeFile(dir + "/result.json", JSON.stringify({ protocolVersion: 1, attemptId: request.attemptId, requestHash: request.requestHash, ok: true, output: process.env.FAKE_AUDIT_OUTPUT || "<disapproved/>", model: request.model, thinkingLevel: request.thinkingLevel, toolCalls: process.env.FAKE_TOOL === "yes" ? [{ name: "read", argsPrefix: "{}", finishedAt: Date.now() }] : [] }));
