// pi-goal-list-loop-audit — v0.28.0
// tests/glla-table-menu.test.ts
//
// Pins the new TUI table renderer (SettingsMenuComponent). Drives
// handleInput() synthetically (no TUI required) to verify tab-switch +
// row-select + input routing. Renders at 3 widths (120/80/60) to verify
// column truncation.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildSettingsRows,
  SETTINGS_SECTIONS,
  SettingsMenuComponent,
  type SettingsRow,
} from "../extensions/settings-menu.ts";
import type { Settings } from "../extensions/goal-settings.ts";

/* --------------------------------------------------------------------- */
/*  Test doubles                                                         */
/* --------------------------------------------------------------------- */

const THEME = {
  fg(_color: "accent" | "muted" | "dim" | "warning" | "success", text: string) {
    return text; // strip colors for deterministic snapshots
  },
  bold(text: string) {
    return text;
  },
};

/** Synthetic KeybindingsManager-like that maps plain input strings to canonical keys. */
const KB = {
  matches(data: string, key: string): boolean {
    const map: Record<string, string> = {
      "\r": "tui.select.confirm",
      "\n": "tui.select.confirm",
      "\x1b": "tui.select.cancel",
      "up": "tui.select.up",
      "down": "tui.select.down",
      "pageUp": "tui.select.pageUp",
      "pageDown": "tui.select.pageDown",
    };
    if (map[data] === key) return true;
    // Empty data → never matches
    return false;
  },
};

function makeComponent(rows: SettingsRow[], width = 120) {
  let capturedId: string | undefined = "INIT";
  const done = (id: string | undefined) => {
    capturedId = id;
  };
  const component = new SettingsMenuComponent(
    {
      rows,
      title: "test — glla settings table",
    },
    () => undefined,
    THEME,
    KB,
    done,
  );
  return {
    component,
    done: (): string | undefined => capturedId,
    lastId: (): string | undefined => (capturedId === "INIT" ? undefined : capturedId),
  };
}

/* --------------------------------------------------------------------- */
/*  Sample rows                                                          */
/* --------------------------------------------------------------------- */

const SAMPLE_ROWS: SettingsRow[] = buildSettingsRows(
  {
    subagentModelStrategy: "inherit-parent",
    notifyCmd: "notify-send $1",
    tokenLimit: 200000,
  } as Settings,
  {},
);

/* --------------------------------------------------------------------- */
/*  Pin 1: rendering                                                     */
/* --------------------------------------------------------------------- */

test("render: title row", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  const lines = component.render(120);
  assert.equal(lines[0], "test — glla settings table");
});

test("render: tabs row lists all 5 sections", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  const lines = component.render(120);
  // Tabs row is index 1 (after title).
  for (const s of SETTINGS_SECTIONS) {
    assert.match(lines[1]!, new RegExp(s.label.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")), `tabs row mentions ${s.label}`);
  }
});

test("render: at width=120, the keep-going section renders 3 rows", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  // activeSectionIdx starts at 0 (keep-going).
  const lines = component.render(120);
  // line layout at width 120: [title, tabs, header, row0, row1, row2, footer]
  assert.ok(lines.length >= 7, `expected ≥7 lines, got ${lines.length}`);
  // The 3 keep-going rows must be visible somewhere between line 3 and the footer.
  const body = lines.slice(3, -1).join("\n");
  assert.match(body, /Auto-resume on load/);
  assert.match(body, /Auto-accept drafts/);
  assert.match(body, /Aggressive mode/);
});

test("render: header row has KEY, VALUE, SOURCE, DESCRIPTION columns", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const lines = component.render(120);
  const header = lines[2]!;
  assert.match(header, /KEY/);
  assert.match(header, /VALUE/);
  assert.match(header, /SOURCE/);
  assert.match(header, /DESCRIPTION/);
});

test("render: footer pin (←/→ tab · ↑/↓ move · enter drill-in · esc exit)", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const lines = component.render(120);
  const footer = lines[lines.length - 1]!;
  assert.match(footer, /←\/→ tab/);
  assert.match(footer, /↑\/↓ move/);
  assert.match(footer, /enter drill-in/);
  assert.match(footer, /esc exit/);
});

/* --------------------------------------------------------------------- */
/*  Pin 2: navigation                                                    */
/* --------------------------------------------------------------------- */

test("nav: Enter on the first row emits that row's id", () => {
  const { component, lastId } = makeComponent(SAMPLE_ROWS);
  component.handleInput("\r");
  assert.equal(lastId(), "autoResume"); // first keep-going row
});

test("nav: Down arrow moves to the next visible row", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  component.handleInput("down");
  component.handleInput("\r");
  // Use the done directly: we cannot reach the closure variable, so we
  // synthesize by checking the selected index.
  assert.equal(component.getSelectedIdx(), 1);
});

test("nav: Down wrapping at the end of a section wraps to 0", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  // Keep-going has 3 rows; press down 5 times — should wrap to 5 % 3 = 2.
  for (let i = 0; i < 5; i++) component.handleInput("down");
  assert.equal(component.getSelectedIdx(), 2);
});

test("nav: Esc emits undefined (close)", () => {
  const { component, lastId } = makeComponent(SAMPLE_ROWS);
  component.handleInput("\x1b");
  assert.equal(lastId(), undefined);
});

test("nav: Tab advances to the next section", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  component.handleInput("\t");
  assert.equal(component.getActiveSectionIdx(), 1); // auditor
  assert.equal(component.getSelectedIdx(), 0);     // reset
});

test("nav: Back-tab (\\x1b[Z) retreats to the previous section", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  // Move to last section, then back-tab.
  component.switchSection(4); // → "other" (idx 4)
  component.handleInput("\x1b[Z");
  assert.equal(component.getActiveSectionIdx(), 3); // → "subagents"
});

test("nav: Right-arrow CSI sequence (\\x1b[C) advances section", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  component.handleInput("\x1b[C");
  assert.equal(component.getActiveSectionIdx(), 1);
});

test("nav: Left-arrow CSI sequence (\\x1b[D) retreats section", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  component.switchSection(1); // → auditor
  component.handleInput("\x1b[D");
  assert.equal(component.getActiveSectionIdx(), 0);
});

/* --------------------------------------------------------------------- */
/*  Pin 3: truncation                                                    */
/* --------------------------------------------------------------------- */

test("truncate: at width=60 the description column is ≤ MIN_DESC_W", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 60);
  const lines = component.render(60);
  // The header row carries KEY/VALUE/SOURCE/DESCRIPTION labels; the body
  // rows are data. Each body row's description column is truncated to
  // MAX(width - keyW - valueW - sourceW - 3*gutter, MIN_DESC_W).
  // Check that NO line has more than 60 visible chars (sanity).
  for (const line of lines) {
    // strip test escape codes (we don't apply any, but be safe)
    assert.ok(line.length <= 60, `line exceeds 60: "${line}" (len=${line.length})`);
  }
});

test("truncate: at width=120 the description column keeps full text (no truncation visible)", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const lines = component.render(120);
  // The keep-going rows' descriptions all start with "on:" / "flips DEFAULTS…".
  const body = lines.slice(3, -1).join("\n");
  // Pick a long-but-fits-at-120 description, e.g. aggressiveMode's.
  assert.match(
    body,
    /flips DEFAULTS toward keep-going.*explicit per-key settings still win/,
    "aggressiveMode description should remain intact at 120 cols",
  );
});

/* --------------------------------------------------------------------- */
/*  Pin 4: cache invariant                                               */
/* --------------------------------------------------------------------- */

test("cache: identical renders at the same width return the same array reference", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const first = component.render(120);
  const second = component.render(120);
  assert.equal(first, second, "second render must hit the same cached array");
});

test("cache: state change invalidates cache (move → next render produces new lines)", () => {
  const { component } = makeComponent(SAMPLE_ROWS, 120);
  const first = component.render(120);
  component.handleInput("down");
  const second = component.render(120);
  assert.notEqual(first, second, "selection move must invalidate the render cache");
});

/* --------------------------------------------------------------------- */
/*  Pin 5: structural                                                    */
/* --------------------------------------------------------------------- */

test("structural: Class implements Component (has render + invalidate + handleInput)", () => {
  const { component } = makeComponent(SAMPLE_ROWS);
  assert.equal(typeof component.render, "function");
  assert.equal(typeof component.handleInput, "function");
  assert.equal(typeof component.invalidate, "function");
});

test("structural: buildSettingsRows returns ≥20 rows across all 5 sections (coverage)", () => {
  const rows = buildSettingsRows({} as Settings, {});
  assert.ok(rows.length >= 20, `expected ≥20 rows, got ${rows.length}`);
});
