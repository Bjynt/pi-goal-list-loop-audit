// Tests for the v0.36.x commissar settings surface:
// - typed Settings keys + opt-in default (off)
// - pure clamps on hand-edited values
// - settings-menu rows exist in their own section and dispatch
// Real modules, no copies.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
} from "../extensions/goal-settings.ts";
import {
  DEFAULT_COMMISSAR_INTERVAL_MINUTES,
  DEFAULT_COMMISSAR_WANTING_THRESHOLD,
  MAX_COMMISSAR_INTERVAL_MINUTES,
  MAX_COMMISSAR_WANTING_THRESHOLD,
  MIN_COMMISSAR_INTERVAL_MINUTES,
  MIN_COMMISSAR_WANTING_THRESHOLD,
  normalizeCommissarIntervalMinutes,
  normalizeCommissarWantingThreshold,
} from "../extensions/goal-commissar.ts";
import {
  buildSettingsRows,
  SETTINGS_SECTIONS,
} from "../extensions/settings-menu.ts";

const EMPTY_PROV = {} as Record<
  string,
  { value: unknown; source: "project" | "global" | "default" }
>;

test("commissar settings default to opt-in OFF with bounded knobs", () => {
  assert.equal(DEFAULT_SETTINGS.commissarEnabled, false);
  assert.equal(
    DEFAULT_SETTINGS.commissarIntervalMinutes,
    DEFAULT_COMMISSAR_INTERVAL_MINUTES,
  );
  assert.equal(
    DEFAULT_SETTINGS.commissarWantingThreshold,
    DEFAULT_COMMISSAR_WANTING_THRESHOLD,
  );
  assert.equal(DEFAULT_SETTINGS.commissarIntervalMinutes, 20);
  assert.equal(DEFAULT_SETTINGS.commissarWantingThreshold, 2);
});

test("all three commissar keys are provenance-tracked", () => {
  for (const key of [
    "commissarEnabled",
    "commissarIntervalMinutes",
    "commissarWantingThreshold",
  ] as const) {
    assert.ok(SETTINGS_KEYS.includes(key), `${key} is tracked`);
  }
});

test("interval clamp: finite values round into [1, 720]; junk falls back", () => {
  assert.equal(
    normalizeCommissarIntervalMinutes(0),
    MIN_COMMISSAR_INTERVAL_MINUTES,
  );
  assert.equal(
    normalizeCommissarIntervalMinutes(-5),
    MIN_COMMISSAR_INTERVAL_MINUTES,
  );
  assert.equal(normalizeCommissarIntervalMinutes(1.4), 1);
  assert.equal(normalizeCommissarIntervalMinutes(19.6), 20);
  assert.equal(
    normalizeCommissarIntervalMinutes(100_000),
    MAX_COMMISSAR_INTERVAL_MINUTES,
  );
  assert.equal(normalizeCommissarIntervalMinutes("42"), 42);
  assert.equal(normalizeCommissarIntervalMinutes(undefined), 20);
  assert.equal(normalizeCommissarIntervalMinutes("not-a-number"), 20);
});

test("wanting threshold clamp: [1, 5], junk falls back to 2", () => {
  assert.equal(
    normalizeCommissarWantingThreshold(0),
    MIN_COMMISSAR_WANTING_THRESHOLD,
  );
  assert.equal(
    normalizeCommissarWantingThreshold(99),
    MAX_COMMISSAR_WANTING_THRESHOLD,
  );
  assert.equal(normalizeCommissarWantingThreshold(2.7), 3);
  assert.equal(
    normalizeCommissarWantingThreshold("junk"),
    DEFAULT_COMMISSAR_WANTING_THRESHOLD,
  );
  assert.equal(
    normalizeCommissarWantingThreshold(undefined),
    DEFAULT_COMMISSAR_WANTING_THRESHOLD,
  );
});

test("settings menu exposes a dedicated commissar section with three dispatchable rows", () => {
  const section = SETTINGS_SECTIONS.find((s) => s.id === "commissar");
  assert.ok(section, "commissar section exists");
  assert.equal(section.label, "Commissar");
  const rows = buildSettingsRows(DEFAULT_SETTINGS as never, EMPTY_PROV).filter(
    (r) => r.section === "commissar",
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [
      "commissarEnabled",
      "commissarIntervalMinutes",
      "commissarWantingThreshold",
    ],
  );
  for (const row of rows) {
    assert.ok(row.description.length > 0, `${row.id} carries a description`);
    assert.ok(
      typeof row.valueText === "string",
      `${row.id} carries a valueText`,
    );
  }
});
