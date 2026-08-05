import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { parseAuditorVerdict } from "../extensions/goal-loop-shield.ts";

type DisapprovalFixture = {
  name: string;
  file: string;
  distinctiveEvidence: RegExp[];
  requiredFixes: RegExp[];
};

const fixtures: DisapprovalFixture[] = [
  {
    name: "non-literal Done when contract proof",
    file: "auditor-disapproval-nonliteral-done-when.md",
    distinctiveEvidence: [
      /literal `Done when:` prefix/,
      /Contract item 3 as literally specified returns \*\*0\*\*, not 27/,
    ],
    requiredFixes: [
      /Prefix each of the 27 rows' final cell/,
      /Do not re-report item 3/,
    ],
  },
  {
    name: "inverted title/score hierarchy",
    file: "auditor-disapproval-inverted-title-score.md",
    distinctiveEvidence: [
      /title should be equal to or larger than score/,
      /Default modal: `2\.4rem` title vs `3\.6rem` value/,
      /Premium full-bleed variant/,
    ],
    requiredFixes: [
      /Make the title \*\*equal to or larger than\*\* the score/,
      /Extend the `reconcile-iter-11` regression pins/,
    ],
  },
];

for (const fixture of fixtures) {
  test(`screenshot-shaped ${fixture.name} stays an actionable disapproval`, () => {
    const report = readFileSync(path.resolve(process.cwd(), "tests/fixtures", fixture.file), "utf8");
    const verdict = parseAuditorVerdict(report);

    assert.equal(verdict.approved, false, "a valid disapproval must never become an approval");
    assert.equal(verdict.disapproved, true, "the final semantic verdict remains disapproved");
    assert.equal(verdict.impossible, false, "a fixable gap is not impossible");
    assert.doesNotMatch(report, /<approved\/>/, "the fixture contains no approval marker");
    assert.match(report, /<disapproved\/>\s*$/, "the report ends with its authoritative disapproval marker");

    for (const evidence of fixture.distinctiveEvidence) assert.match(report, evidence);

    const requiredFixes = report.slice(report.lastIndexOf("## Required fixes"));
    assert.ok(requiredFixes.length > 0, "the disapproval has a required-fixes tail");
    assert.ok((requiredFixes.match(/^\d+\.\s/gm) ?? []).length >= 2, "the required-fixes tail is actionable, not a bare verdict");
    for (const fix of fixture.requiredFixes) assert.match(requiredFixes, fix);
  });
}
