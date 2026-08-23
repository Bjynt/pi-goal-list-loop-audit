# Now
##

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls
investigate

# Next

##

auditor can go awol for long, we need some way to handle it
in this case its not slow response but we were workign with a model that kept ahving errors but it was fine when we retried but seemingly we dont least as eagerly for auditor
/home/dracon/Pictures/Screenshots/Screenshot_20260823_152629.png /home/dracon/Pictures/Screenshots/Screenshot_20260823_152617.png /home/dracon/Pictures/Screenshots/Screenshot_20260823_152536.png /home/dracon/Pictures/Screenshots/Screenshot_20260823_152321.png /home/dracon/Pictures/Screenshots/Screenshot_20260823_152319.png /home/dracon/Pictures/Screenshots/Screenshot_20260823_152316.png 


> /home/dracon/Pictures/Screenshots/Screenshot_20260823_153139.png so we can see the mdoel struggless but we still need ot keep retrying it 


##
another problem is that on session start, we odnt auto start the main thread we do auto start the auditor if it was their turn

##

another problem is htat failed requests add to the context, while clearly adding nothing of value
/home/dracon/Pictures/Screenshots/Screenshot_20260823_154439.png 

# Next2

##

the goal was gettick stuck so i started a new goal but then it was not visible or usable before i restarted

/home/dracon/Pictures/Screenshots/Screenshot_20260823_091841.png 


##

list seems corruped not only doesnt show but we cant start it 
/home/dracon/Pictures/Screenshots/Screenshot_20260823_120853.png 
here too we can't even start a new list 
/home/dracon/Pictures/Screenshots/Screenshot_20260823_122304.png 
> after reload it recovered very odd, now technically this is what i want just to list to stay visible and keep going 
/home/dracon/Pictures/Screenshots/Screenshot_20260823_130243.png 

##

another concern is that do we have these explores, clearly not desired, is this our bug 
/home/dracon/Pictures/Screenshots/Screenshot_20260823_120936.png 

# Later

##

we coudl use better visuals cause this is what wesee now and it is worth htinking what and how we show
/home/dracon/Pictures/Screenshots/Screenshot_20260822_132806.png 
/home/dracon/Pictures/Screenshots/Screenshot_20260822_200250.png 

##

update the readme and the docs its been a while and readme especially start with new visitors in mind

# Idea

##

/list audit
/goal audit 
/loop audit

i wonder what is the difference between list audit and list start and say audit ?

or do these have speical meaning, cause seemingly 
/list start
/goal start 
with saying audit would make more sense and audit might go too wide too cuase it start immedateli y without knowing what i meant
