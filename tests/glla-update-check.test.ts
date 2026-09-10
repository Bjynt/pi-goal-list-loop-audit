import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildVersionTail,
  compareVersions,
  readUpdateCheck,
  refreshUpdateCheck,
  staleUpdateNudge,
  UPDATE_CHECK_TTL_MS,
} from "../extensions/glla-update-check.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glla-update-check-"));
}

test("compareVersions orders semver-ish strings and shrugs at garbage", () => {
  assert.equal(compareVersions("0.38.44", "0.38.43"), 1);
  assert.equal(compareVersions("0.38.43", "0.38.44"), -1);
  assert.equal(compareVersions("0.38.44", "0.38.44"), 0);
  assert.equal(compareVersions("v0.38.44", "0.38.44"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("garbage", "0.38.44"), 0);
});

test("staleUpdateNudge fires only when the cache proves the registry is ahead", () => {
  const now = Date.now();
  assert.equal(staleUpdateNudge("0.38.43", { latest: "0.38.44", checkedAt: now }), "update v0.38.44 available");
  assert.equal(staleUpdateNudge("0.38.44", { latest: "0.38.44", checkedAt: now }), null);
  assert.equal(staleUpdateNudge("0.38.45", { latest: "0.38.44", checkedAt: now }), null);
  assert.equal(staleUpdateNudge("0.38.43", null), null);
  assert.equal(staleUpdateNudge("unknown", { latest: "99.0.0", checkedAt: now }), null);
});

test("buildVersionTail always names the running version, nudges only when stale", () => {
  assert.equal(buildVersionTail("0.38.44", null), "· v0.38.44");
  assert.equal(buildVersionTail("0.38.44", "0.38.44"), "· v0.38.44");
  assert.equal(buildVersionTail("0.38.43", "0.38.44"), "· v0.38.43 · update v0.38.44 available");
  assert.equal(buildVersionTail("unknown", "99.0.0"), "");
  assert.equal(buildVersionTail("", null), "");
});

test("readUpdateCheck returns null for missing, malformed, and future-dated caches", () => {
  const cwd = tmpRoot();
  assert.equal(readUpdateCheck(cwd), null);
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "update-check.json"), "not json");
  assert.equal(readUpdateCheck(cwd), null);
  fs.writeFileSync(path.join(cwd, ".pi-glla", "update-check.json"), JSON.stringify({ latest: "", checkedAt: 1 }));
  assert.equal(readUpdateCheck(cwd), null);
  fs.writeFileSync(
    path.join(cwd, ".pi-glla", "update-check.json"),
    JSON.stringify({ latest: "0.38.44", checkedAt: Date.now() + 3_600_000 }),
  );
  assert.equal(readUpdateCheck(cwd), null);
  const checkedAt = Date.now() - 1_000;
  fs.writeFileSync(path.join(cwd, ".pi-glla", "update-check.json"), JSON.stringify({ latest: "0.38.44", checkedAt }));
  assert.deepEqual(readUpdateCheck(cwd), { latest: "0.38.44", checkedAt });
});

test("refreshUpdateCheck skips spawn while the cache is within TTL", () => {
  const cwd = tmpRoot();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi-glla", "update-check.json"),
    JSON.stringify({ latest: "0.38.44", checkedAt: Date.now() - 1_000 }),
  );
  let spawned = 0;
  refreshUpdateCheck(cwd, Date.now(), (() => {
    spawned++;
    throw new Error("must not spawn");
  }) as never);
  assert.equal(spawned, 0);
});

test("refreshUpdateCheck shells npm view when stale and caches the latest", () => {
  const cwd = tmpRoot();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi-glla", "update-check.json"),
    JSON.stringify({ latest: "0.1.0", checkedAt: Date.now() - UPDATE_CHECK_TTL_MS - 1 }),
  );
  const hooks: {
    close: ((code: number | null) => void) | null;
    data: ((chunk: Buffer) => void) | null;
  } = { close: null, data: null };
  const fakeSpawn = (
    command: string,
    args: string[],
    _options: { timeout: number },
  ) => {
    assert.equal(command, "npm");
    assert.deepEqual(args, ["view", "pi-goal-list-loop-audit", "version"]);
    return {
      on: (event: "close", listener: (code: number | null) => void) => {
        assert.equal(event, "close");
        hooks.close = listener;
      },
      stdout: {
        on: (event: "data", listener: (chunk: Buffer) => void) => {
          assert.equal(event, "data");
          hooks.data = listener;
        },
      },
    };
  };
  refreshUpdateCheck(cwd, Date.now(), fakeSpawn as never);
  assert.ok(hooks.close && hooks.data, "refresh subscribes before returning");
  (hooks.data as (chunk: Buffer) => void)(Buffer.from("0.38.44\n"));
  (hooks.close as (code: number | null) => void)(0);
  assert.deepEqual(readUpdateCheck(cwd)?.latest, "0.38.44");
});

test("refreshUpdateCheck never throws and never writes on registry failure", () => {
  const cwd = tmpRoot();
  assert.doesNotThrow(() =>
    refreshUpdateCheck(cwd, Date.now(), (() => {
      throw new Error("no npm");
    }) as never),
  );
  assert.equal(readUpdateCheck(cwd), null);
  const box: { close: ((code: number | null) => void) | null } = { close: null };
  refreshUpdateCheck(
    cwd,
    Date.now(),
    ((..._args: unknown[]) => ({
      on: (_e: string, l: (code: number | null) => void) => {
        box.close = l;
      },
      stdout: { on: () => {} },
    })) as never,
  );
  (box.close as (code: number | null) => void)(1);
  assert.equal(readUpdateCheck(cwd), null);
});
