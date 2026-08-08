# Contributing to pi-until-done

Thanks for considering a contribution. This project follows the
[pi-config](https://github.com/srinitude/pi-config) operating contract.
Most of what's below is enforced by the contract; this document is the
human-readable summary.

## Ground rules

1. **Read [AGENTS.md](AGENTS.md) first.** It states the project's TDD-first
   bootstrap discipline, the structural constraints (≤3 nesting depth,
   ≤30 LOC per construct, ≤200 LOC per file), and the canonical CI source.
2. **Mise is the sole CLI tool.** Every command goes through
   `mise run <task>` or `mise exec -- <cmd>`. No `package.json` `scripts`.
3. **Open an issue before a large PR.** For typo fixes, doc tweaks, or
   small bug fixes, just send the PR.

## No AI co-authorship in commits or PRs

> This project's commits and pull requests **do not include AI
> co-authorship attribution**. Do not add any of the following:
>
> - `Co-Authored-By: Claude <noreply@anthropic.com>` (or any other AI/LLM)
> - `🤖 Generated with [Claude Code](...)`, `Generated with Claude`, etc.
> - Any other trailer or footer that attributes the work to an AI assistant.

You may absolutely use AI tooling to help write code — Pi, Claude Code,
Cursor, Codex, Copilot, etc. — but the commit message and PR description
should reflect *your* authorship and *your* understanding of the change.
Reviewers expect to be able to ask you questions about every line.

If your AI tool inserts these trailers automatically, strip them before
opening the PR. If a reviewer notices one, they will ask you to amend
the commit.

Standard trailers like `Signed-off-by:` (DCO) are welcome.

## Local setup

```bash
git clone https://github.com/srinitude/pi-until-done.git
cd pi-until-done
mise install              # installs bun + node from mise.toml
mise run install-deps     # bun install
```

Verify the bootstrap is healthy:

```bash
mise run check            # fast: typecheck + lint + format
mise run ci               # full: + compile + test + build
mise run release-ready    # release-readiness suite
```

## TDD-first

Per pi-config:

1. **BOOTSTRAP** if the automation foundation isn't passing — fix that
   first.
2. **RED**: add a failing production test that represents real user
   behavior, a contract, or a system boundary. Tests under
   `tests/*.test.ts`.
3. **GREEN**: smallest production change that makes the test pass.
4. **REFACTOR**: improve structure, performance, cacheability — must not
   change observable behavior.
5. **CLEANUP**: strip debug prints, scratch files, lint-disables before
   you mark the PR ready.

State the active phase in your PR description and in commit messages
where it helps.

## Code style

- TypeScript: Effect + Bun.
- Format with biome (`mise run format-write`).
- Imports auto-organized via biome's `assist`.
- Structural constraints — checked manually but enforced socially:
  - nesting depth ≤ 3
  - construct ≤ 30 LOC
  - file ≤ 200 LOC
  - single responsibility per construct

If your change pushes a file or function past the limits, **split it**
rather than disabling the rule.

## Tests

- Tests live under `tests/` (or `extensions/**/*.test.ts` for co-located).
- They MUST be deterministic, isolated, and parallel-safe.
- They MUST target public interfaces, contracts, or system boundaries —
  not private functions, internal state, or call patterns.
- They MUST NOT depend on shared mutable state.
- Run with `mise run test`.

## Pull requests

Use the PR template at [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).

Required sections:

- **Summary** — what changed and why (1–3 bullets).
- **Test plan** — how you verified it. Quote the actual command output.
- **Phase declaration** — ANALYSIS / BOOTSTRAP / RED / GREEN / REFACTOR /
  CLEANUP — which TDD phase your change is in.
- **Constraint check** — confirm structural limits still hold.

Before requesting review:

- [ ] `mise run ci` passes locally
- [ ] No AI co-authorship trailers
- [ ] Commit messages explain the *why*, not the *what*
- [ ] PR description explains the *why*, not the *what*

## Commit messages

```
<short subject, ≤72 chars>

<body explaining the why; wrap at 72 cols>
<reference issues with `Fixes #N` if applicable>
```

Use imperative mood ("add X", "fix Y") in the subject. The body should
explain *why* the change is correct and *what tradeoffs* you considered.

## Reporting issues

Use the issue templates at [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).

For security issues, see [SECURITY.md](SECURITY.md). Do not file public
issues for vulnerabilities.

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](LICENSE).
