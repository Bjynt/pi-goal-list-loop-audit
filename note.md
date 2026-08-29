# Now

## context bloat problem in seemingly long running tasts, going over designated but not over the limit of the model

/home/dracon/Pictures/Screenshots/Screenshot_20260828_180734.png 

it did compact when it hit the limit but clealry that is not ideal

## chekc pr 

https://github.com/DraconDev/pi-goal-list-loop-audit/pull/37

## auditor parker no verdict, very recent, albeit seemingly was model releated as i kept switching to a more stable one it was fixd but we need a beter way to handle still

/home/dracon/Pictures/Screenshots/Screenshot_20260828_165509.png /home/dracon/Pictures/Screenshots/Screenshot_20260828_165506.png /home/dracon/Pictures/Screenshots/Screenshot_20260828_165455.png 

## list execution is stalling, list queued

/home/dracon/Pictures/Screenshots/Screenshot_20260828_124432.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260829_001635.png new

## explore subagent shown as valid session to load 

is it our bug or tin tin subagents 
/home/dracon/Pictures/Screenshots/Screenshot_20260828_063011.png 

## resolved: bare start commands now infer bounded context safely

`/goal start`, `/loop start`, and `/list start` now inspect only a bounded
active-branch window. A single clear actionable user request is shown before
starting; ambiguous, generic, truncated, or multi-task context falls back to
the existing drafting/confirmation flow. Queue activation, loop metric
settings, and explicit consent remain visible.

# Next

## No confoirmed glla ownedtransition was found

## investigate

https://github.com/DraconDev/pi-goal-list-loop-audit/pull/38

## maybe turn limit too harsh ? in bigger projects we hit it despite seeming correct use

/home/dracon/Pictures/Screenshots/Screenshot_20260828_232807.png 

## make sure model selectors as as good as the main model selector with fallbacks

## audits should focus on the project at hand they can explore outside but we dont want it to turn into a fix the world

## proactive evidence gathering for draft

currently draft fires first if we use like /goal and even if provided claism and evidence the ai didnt look at it, like pictures and asks me quesitons, 
while it owuld be in some cases would be useful to run a miniaudit 

## we should prefer long term focused action, i just got recommended 3 defers 

/home/dracon/Pictures/Screenshots/Screenshot_20260829_185215.png 
this had the best solution last 

audit can fix more in line if makes snse

## auditor 

not sure but for visual tasks do we take new picutres? so for anything visual the auditor should take a picture look at it and critique it and feed it back int othe main 
currenlty visual problems seem to pass throug way more 

# Later

## check out out other harnesses and goal extensions 
nottably pi goal x, deepseek harness, codex, cladue, antirgravity, grok harness

## nvidia AVO careful consideration 

we have prs too it too but apparently incomplete
https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

# Idea

