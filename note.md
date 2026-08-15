# NExt

## Resolved in v0.34.142

The provider-recovery policy is now intentionally blind: it does not query or
infer quota availability, classify quota-shaped wording, honor `Retry-After`,
or gate model fallback on a guessed provider state. Recoverable failures use
one generic retry envelope, with a 5-second eager retry and an extra
`hourlyRetryProbe` at `:00:30` after each hour starts. The existing bounded
attempt/window safety limits remain. Old quota-named state is compatibility
data only and cannot change the runtime policy.

##
/home/dracon/Pictures/Screenshots/Screenshot_20260814_140543.png 
after draft we get this not even sure why
i could start it so fine but just didnt auto start

##
no provider activity was observed
maybe we are giving up too eagerly we should keep retrying hard
even if the providers is dead the right call is to keep spamming the retry so we mgiht pick back up, if we just igve up then that guanrtees it 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_140947.png 

##

no turn start
/home/dracon/Pictures/Screenshots/Screenshot_20260814_164621.png 

##

very odd
/home/dracon/Pictures/Screenshots/Screenshot_20260814_165408.png 
restarting and resuming got it moving 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_165458.png 

##
auditor timed out
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170134.png 

we should retry the auditor really but also investigate why we timed out

##
auditor parker no verdict, we stopped
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170313.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170627.png 

##
blocked, waiting for non quota, but we should not cheeck for quota, we jsut agressively retry, no quota checking, and extra retries after the start of every hours so lieke 15:00 , 16:00, 17:00 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170654.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_180007.png 

##
hsot session lost
/home/dracon/Pictures/Screenshots/Screenshot_20260814_170942.png 

cant be restarted with resume either we must restart pi

##

/home/dracon/Pictures/Screenshots/Screenshot_20260814_223137.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_223137.png 

host session lost

##

pi did not start turn

/home/dracon/Pictures/Screenshots/Screenshot_20260814_223616.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260814_223616.png 

## feat

we want to show the total time spent
in fact coudl lets double check how we do the ui

# LATER

## research

codex is doing pretty good continuation without anything we seem to have we check it
we are also checking claude clode and the newest deepseek-harness too, we have all lcally

https://github.com/deepseek-ai/deepseek-harness

## idea
i wonder about a preference ai has, now generaly this can be argued to be fine but doesnt fit the long running task vibe that ai is not always long term minded
ai suggest fixes that work fine now an in cases are fine jsut to get to the next step but generally we want long term solution and esp in brownfield projects with tests ai coudl be a bit too status quo
now obviously there is right anwser here but essentily means that work stalls and hacks are promoted as primary considearations as (recommended) it is not too bad but it assumes more of hands on than 
long running automation, but its bit preference do we want to be pureist to the establish goal or more opportunistic and long term minded, so it mgiht lead toward what works now versus what works best

this also leads to more questions i think, that interrupts long running goals needlessly. now i am not against questions but if the question is some hack then no

/home/dracon/Pictures/Screenshots/Screenshot_20260812_054032.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260812_054236.png 

## feat
this is soemwhat more general but still a feature we can build in cosndiering we have an auditor too
we can have a designer sub agent and when specified then tasks that are called for the designer are delegated to it 
of course this can have fallback too and if deisgner not set, or not available then we fallback
designer subagent as an option and the plan / list is made with space for it 

## feat 

drafter model with fallbacks
