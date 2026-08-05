# Command registration routing (auto-recorded by tests/command-registration-collisions.test.ts)

- Recorded: 2026-08-05T19:42:35.719Z
- Agent dir: /home/dracon/.pi/agent
- Loaded extensions scanned: 16
- Winner rule (pi resolveRegisteredCommands): a SINGLY-registered name keeps its bare command (that registrant wins). A DUPLICATED name suffixes EVERY registration — `name:1`, `name:2`, … — the bare command becomes owned by nobody and dispatch stops routing it. Within one extension, re-registration is last-wins (Map).

## Routing table

| command | registrants | bare name owned? | winner (source) | winner (entry) | suffixed names |
|---|---|---|---|---|---|
| glla | 1 | yes | global packages: /home/dracon/Dev/pi-goal-loop-audit | /home/dracon/Dev/pi-goal-loop-audit/extensions/loops/goal.ts |  |
| goal | 1 | yes | global packages: /home/dracon/Dev/pi-goal-loop-audit | /home/dracon/Dev/pi-goal-loop-audit/extensions/loops/goal.ts |  |
| list | 1 | yes | global packages: /home/dracon/Dev/pi-goal-loop-audit | /home/dracon/Dev/pi-goal-loop-audit/extensions/loops/goal.ts |  |
| loop | 1 | yes | global packages: /home/dracon/Dev/pi-goal-loop-audit | /home/dracon/Dev/pi-goal-loop-audit/extensions/loops/goal.ts |  |

## Installed-but-unconfigured goal-family registrants (hazard list)

- `npm:@narumitw/pi-goal` (installed, NOT configured) registers: goal
- `npm:@fractaal/pi-goal-x` (installed, NOT configured) registers: goal
- `npm:@capyup/pi-goal` (installed, NOT configured) registers: goal
- `npm:pi-goal-loop-audit` (installed, NOT configured) registers: goal, glla, list, loop
- `npm:pi-goal-list-loop-audit` (installed, NOT configured) registers: goal, glla, list, loop
- `npm:pi-goal-x` (installed, NOT configured) registers: goal
- `npm:@misunders2d/pi-goal` (installed, NOT configured) registers: goal
