## feat

we want to show the total time spent
in fact coudl lets double check how we do the ui

### addressed in v0.35.3 — 2026-08-15

- Goal cards and the always-visible status HUD now label the wall-clock
  lifetime as `total` in live, busy, idle, and queued states.
- `total` intentionally includes parked recovery time and detached-auditor
  wait time. It is not active model-compute time; tracking that separately
  would need persistent work-interval accounting.
- The compact UI was checked for width/truncation, and the full release gate
  passed: 1,361 tests passed, 1 skipped by environment, 0 failed.

## parked sessions

many parked, they even make sme progress i think not normal operation we need to fully explore this 

/home/dracon/Pictures/Screenshots/Screenshot_20260815_180007.png /home/dracon/Pictures/Screenshots/Screenshot_20260815_180005.png /home/dracon/Pictures/Screenshots/Screenshot_20260815_175523.png /home/dracon/Pictures/Screenshots/Screenshot_20260815_175459.png /home/dracon/Pictures/Screenshots/Screenshot_20260815_175457.png /home/dracon/Pictures/Screenshots/Screenshot_20260815_175453.png /home/dracon/Pictures/Screenshots/Screenshot_20260815_175450.png /home/dracon/Pictures/Screenshots/Screenshot_20260815_174832.png 


### audit result — behavior clarified in v0.35.3

- The screenshots show the generic main-model recovery envelope: the primary
  provider failed, the goal was safely parked, and the retry ladder/hourly
  probe remained armed. A parked goal is not doing useful model work while it
  waits, even if a retry/error event updates its activity timestamp.
- The screenshots also showed no configured main-agent fallback models, so
  repeated recovery around the same primary model was expected from the
  current configuration. This is not quota checking; the plugin continues to
  retry generically without attempting to infer quota state.
- Recovery surfaces now say `last host activity`, so provider/error events are
  not presented as useful progress. The retry and hourly `:00:30` behavior was
  intentionally left unchanged.

## detached auditor live UI

audtior deatch live tends to loo frozen in fact i thik it is frozen here 

/home/dracon/Pictures/Screenshots/Screenshot_20260815_180233.png 

18:03

restarting it 

ok that working and the timer is ticking 


/home/dracon/Pictures/Screenshots/Screenshot_20260815_180351.png 
we would also want to work on the look

### addressed in v0.35.3

- Root cause: the UI ticker refreshed active and timed-paused states, but not
  `auditing`, so a detached worker could look frozen between progress events.
- The ticker now refreshes while auditing, and the detached auditor clock
  advances from its inferred attempt start between worker events. Long
  `bash`, read, or thinking intervals remain visible; the existing quiet and
  watchdog paths still identify a genuinely stuck worker.
- The auditor card keeps the main host separate from the detached worker and
  shows phase, evidence, elapsed time, and next transition without exposing
  hidden thinking text.


## idea
i wonder about a preference ai has, now generaly this can be argued to be fine but doesnt fit the long running task vibe that ai is not always long term minded
ai suggest fixes that work fine now an in cases are fine jsut to get to the next step but generally we want long term solution and esp in brownfield projects with tests ai coudl be a bit too status quo
now obviously there is right anwser here but essentily means that work stalls and hacks are promoted as primary considearations as (recommended) it is not too bad but it assumes more of hands on than 
long running automation, but its bit preference do we want to be pureist to the establish goal or more opportunistic and long term minded, so it mgiht lead toward what works now versus what works best

this also leads to more questions i think, that interrupts long running goals needlessly. now i am not against questions but if the question is some hack then no

/home/dracon/Pictures/Screenshots/Screenshot_20260812_054032.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260812_054236.png 

##

we need to audito others pi goal plugins see if we can learn anything from them

# LATER
