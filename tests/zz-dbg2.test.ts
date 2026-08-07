import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpCwd } from "./harness/mock-pi.js";
import { parseGoalPolicyFromMd, readGoalMd } from "../extensions/goal-loop-core.js";

test("debug parse", () => {
  const cwd = tmpCwd();
  const mdPath = path.join(cwd, ".pi-glla", "goals", "abc.md");
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  const content = "# Goal\n\n**Status**: active\n**Policy**: list\n\n## Objective\n\n> x\n";
  fs.writeFileSync(mdPath, content);
  console.log("readGoalMd:", JSON.stringify(readGoalMd(cwd, "abc")));
  console.log("parse:", parseGoalPolicyFromMd(cwd, "abc"));
  console.log("regex test:", content.match(/\*\*Policy\*\*:\s*(goal|list)/)?.[1]);
  fs.rmSync(cwd, { recursive: true, force: true });
});
