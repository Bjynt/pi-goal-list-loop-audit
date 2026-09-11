// Live demo of the merged fixes (bounded resume chain), real worker + model.
import { runDetachedGoalCompletionAuditor, MAX_RESUME_SESSION_BYTES } from "/home/bjyn/external-projects/pi-goal-list-loop-audit/extensions/goal-loop-auditor-process.ts";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cwd = await mkdtemp(path.join(tmpdir(), "loopdemo-"));
await mkdir(path.join(cwd, ".git"), { recursive: true }); // worker sanity
const model = `${process.env.PI_PROVIDER || "allamacpp"}/${process.env.PI_MODEL || "qwen27b_180k_turbo"}`;
const subject = "loop:demo-capped";
const prompt = "REPRO audit. Reply with exactly one short line ending in <approved/>.";

async function go(attemptId) {
  const r = await runDetachedGoalCompletionAuditor({
    cwd, prompt, model, thinkingLevel: "low", inspection: true, auditSubject: subject,
    runtime: { pollIntervalMs: 1000, attemptId: () => attemptId },
  });
  const dir = path.join(cwd, ".pi-glla", "audit-jobs", attemptId);
  const req = JSON.parse(await readFile(path.join(dir, "request.json"), "utf8"));
  let sess = ""; try { sess = await readFile(path.join(dir, "session.jsonl"), "utf8"); } catch {}
  return { r, dir, req, sess };
}

console.log("cap bytes:", MAX_RESUME_SESSION_BYTES);
const A = await go("demo-a"); console.log("A:", A.r.approved ? "approved" : `fail:${A.r.error}`, "| resumedFrom:", A.req.inspectionResumedFrom ?? "none(fresh)", "| sess:", A.sess.length);
const B = await go("demo-b"); console.log("B:", B.r.approved ? "approved" : `fail:${B.r.error}`, "| resumedFrom:", B.req.inspectionResumedFrom ?? "none", "| seeded-prefix:", B.sess.startsWith(A.sess) ? "intact" : "BROKEN");
// Bloat the newest completed seed beyond the cap.
await writeFile(path.join(B.dir, "session.jsonl"), B.sess + "\n" + "x".repeat(MAX_RESUME_SESSION_BYTES));
const C = await go("demo-c"); console.log("C:", C.r.approved ? "approved" : `fail:${C.r.error}`, "| resumedFrom:", C.req.inspectionResumedFrom ?? "none", "=> expected demo-a (older small hop; bloated b skipped)");
console.log("ALL:", A.sess.length > 0 && B.req.inspectionResumedFrom === "demo-a" && C.req.inspectionResumedFrom === "demo-a" ? "PASS" : "CHECK");
process.exit(0);
