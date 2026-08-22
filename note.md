# Now

##

https://github.com/DraconDev/pi-goal-list-loop-audit/issues

## DONE v0.35.17 (auditor-approved 2026-08-21)

after accepting the questiong we often see op was aborted /home/dracon/Pictures/Screenshots/Screenshot_20260821_152311.png 
→ root-caused; zero-stream watchdog abort now schedules ONE bounded automatic retry (~90s); second consecutive abort still parks; /glla pause freezes it; manual /goal resume intact.

## DONE — tags backfilled 2026-08-21 (v0.35.17)

the git repo is misisng tags
→ all 41 missing v-tags created at historical commits, pushed to origin/github/gitlab.

## DONE v0.35.17

maybe sometimes else or least update teh readme
→ README currency pass: footer glyphs/meter, /glla pause+resume, quiet-notify, auto-retry, version current.

# Next

All four queued and closed. Every fix auditor-approved; full release gate green at each version.

## DONE v0.35.24 (auditor-approved 2026-08-22)

the auditor seleciton should be like the main agent selector
→ the /glla Auditor model row already used the /model-style fuzzy picker and persisted to the exact key resolveAuditorModel reads; the real gap was policy — forbidden-models now filter the picker list AND typed matches are refused with a named warning (same for the fallback-agent row), so a saved pin is one the resolver honors.

## DONE v0.35.23 (auditor-approved 2026-08-22)

when we load a session we dont have to start it right away
we should decide not auto start
→ root cause: load consent read the aggressive-mode-coerced setting, so stock installs auto-resumed despite the documented hold-by-default. Now a consent-less cold load restores + displays everything but holds all automation (loadHoldAt through the /glla-pause freeze gates); released by /goal resume, /list resume, /list next, /loop resume|start, or starting new work. Opt-in: Auto-resume=on in /glla settings restores old behavior. Crash successors no longer auto-resume either; same-process /reload keeps continuity.

## DONE v0.35.22 (auditor-approved 2026-08-22)

suspicious goal, repair task was qd but nothing started or can be started
happened when tried to /goal start some kind of audit
→ activateNextListItem's loop guard refused LEDGER-ONLY while a loop owned the surface: unstartable AND invisibly so. Now the refusal is loud (names the queued item + "/loop stop … /list next") and ledgered with queueItemId; all three loop-end routes announce the unblocked queue. Also fixed the cross-file test pollution found by that audit round.

suspicious goal / objective
/home/dracon/Pictures/Screenshots/Screenshot_20260821_134442.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260821_134645.png 

/home/dracon/Pictures/Screenshots/Screenshot_20260821_114210.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260821_114109.png 

## DONE v0.35.21

list exec stopped and list because not visible til i restarted session
/home/dracon/Pictures/Screenshots/Screenshot_20260821_213238.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260821_214510.png 

here too
/home/dracon/Pictures/Screenshots/Screenshot_20260821_215228.png /home/dracon/Pictures/Screenshots/Screenshot_20260821_215209.png 
→ sidebar rendered state.list from memory only while the durable queue is the union of state + disk sidecars; a plugin re-init reset RAM to blank until restart. session_start now hydrates the queue from disk (hydrateListQueueFromDisk) and notifies "restored N queued list item(s)".

# Later

##

loop ended ? not sure it should have, albeit this may not be our fault but hte system went to sleep unless we can make sure that pi doesnt do that 
else i need a solution elsewhere
/home/dracon/Pictures/Screenshots/Screenshot_20260822_094423.png 

##

i think we are cutting the spec based strategy cause we can jsut make a big megaplan do that then we have some truth based on the iterate on while the spec is always double truth and stale and crude, so the 
loop is idea to code 

cut respec as i thin it is a bad strategy 

instead we can have 
/goal plan
/list plan 
/loop plan

that makes way more detailed and presumably longer "plan" than the regular draft that is already long, which we are not changing 


##

Is htis intended, like ai cant prune the list?

 I don't have a programmatic remove — the queue is yours to prune. Run these two commands in order:

 1. /list remove 3 — filled sidebar redesign (shipped in the earlier UX pass)
 2. /list remove 4 — live-signal simplification (also shipped; after removing item 3 it will be at position 4 again since the counter item shifts up... actually safest: run /list status after the first removal
    to confirm positions before the second)

 What remains queued afterwards: the codex-reset.json refresh automation, the SSR aria fail-loud check, and the resets-this-month counter — all real pending work from your DECIDED verdicts.

# Idea

##

/list audit
/goal audit 
/loop audit

these might wander outside the folder, not sure if good call

##

or do these have speical meaning, cause seemingly 
/list start
/goal start 
with saying audit would make more sense and audit might go too wide too cuase it start immedateli y without knowing what i meant
