
# Now

## v0.38.5 shipped — delta-only goal continuation (marker-only steady-state)

Steady-state turns send `[GOAL CHECKPOINT goalId=…]` 45 chars; resync+marker after compact; full 23k only first-send/dirty. See `audit/DELTA-ONLY-CONTINUATION-2026-09-03.md`. 1824 pass.


# Next

## objectives can be seemingly lost and next time we load the session we seemingly dont have any 

/home/dracon/Pictures/Screenshots/Screenshot_20260902_223042.png /home/dracon/Pictures/Screenshots/Screenshot_20260902_223001.png 

## in some cases we are not compacting perhaps proactively enough and end up with a stuck state, but also can be bloated of unable to proceed

/home/dracon/Pictures/Screenshots/Screenshot_20260902_223213.png 

# Later

## visual improvements ? 

