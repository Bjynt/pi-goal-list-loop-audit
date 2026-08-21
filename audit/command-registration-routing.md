# Command registration routing (auto-recorded by tests/command-registration-collisions.test.ts)

- Recorded: live rig scan (timestamp intentionally omitted)
- Agent dir: <configured pi agent dir>
- Loaded extensions scanned: 11
- Winner rule (pi resolveRegisteredCommands): a SINGLY-registered name keeps its bare command (that registrant wins). A DUPLICATED name suffixes EVERY registration — `name:1`, `name:2`, … — the bare command becomes owned by nobody and dispatch stops routing it. Within one extension, re-registration is last-wins (Map).

## Routing table

| command | registrants | bare name owned? | winner (source) | winner (entry) | suffixed names |
|---|---|---|---|---|---|
| glla | 0 | no registrant | — | — |  |
| goal | 0 | no registrant | — | — |  |
| list | 0 | no registrant | — | — |  |
| loop | 0 | no registrant | — | — |  |

## Installed-but-unconfigured goal-family registrants (hazard list)

- `npm:@narumitw/pi-goal` (installed, NOT configured) registers: goal
- `npm:@fractaal/pi-goal-x` (installed, NOT configured) registers: goal
- `npm:@capyup/pi-goal` (installed, NOT configured) registers: goal
- `npm:pi-goal-loop-audit` (installed, NOT configured) registers: goal, list, loop
- `npm:pi-codex-goal` (installed, NOT configured) registers: goal
- `npm:pi-goal-x` (installed, NOT configured) registers: goal
- `npm:@misunders2d/pi-goal` (installed, NOT configured) registers: goal
