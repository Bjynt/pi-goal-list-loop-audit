# Command registration routing (auto-recorded by tests/command-registration-collisions.test.ts)

- Recorded: 2026-08-05T12:38:39.306Z
- Agent dir: /home/dracon/.pi/agent
- Loaded extensions scanned: 16
- Winner rule (pi resolveRegisteredCommands): the FIRST registrant in load order keeps the bare command name; duplicates get `:N` suffixes and are unreachable via the bare name. Within one extension, re-registration is last-wins (Map).

## Routing table

| command | registrants | winner (source) | winner (entry) | suffixed duplicates |
|---|---|---|---|---|
| glla | 1 | global packages: /home/dracon/Dev/pi-goal-loop-audit | /home/dracon/Dev/pi-goal-loop-audit/extensions/loops/goal.ts | — |
| goal | 1 | global packages: /home/dracon/Dev/pi-goal-loop-audit | /home/dracon/Dev/pi-goal-loop-audit/extensions/loops/goal.ts | — |
| list | 1 | global packages: /home/dracon/Dev/pi-goal-loop-audit | /home/dracon/Dev/pi-goal-loop-audit/extensions/loops/goal.ts | — |
| loop | 1 | global packages: /home/dracon/Dev/pi-goal-loop-audit | /home/dracon/Dev/pi-goal-loop-audit/extensions/loops/goal.ts | — |

## Installed-but-unconfigured goal-family registrants (hazard list)

- `npm:@narumitw/pi-goal` (installed, NOT configured) registers: goal
- `npm:@fractaal/pi-goal-x` (installed, NOT configured) registers: goal
- `npm:@capyup/pi-goal` (installed, NOT configured) registers: goal
- `npm:pi-goal-loop-audit` (installed, NOT configured) registers: goal, glla, list, loop
- `npm:pi-goal-list-loop-audit` (installed, NOT configured) registers: goal, glla, list, loop
- `npm:pi-goal-x` (installed, NOT configured) registers: goal
- `npm:@misunders2d/pi-goal` (installed, NOT configured) registers: goal
