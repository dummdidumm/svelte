# Several loose thoughts on our reactivity system

## on derived (re)connection and effects not being able to be created outside a reactive context

I'm wondering if we should instead opt for an overall "simpler" model. I believe the main reason people run into connect/disconnect is because they create global state outside of a reactive context. So what if we allow to create deriveds/effects outside of a reactive context, and if so we warn about it and just never clean it up? This likely makes the whole connect/disconnect much simpler, and we can instead rerun deriveds when they reconnect - which is much rarer in this world.

Anyway that's all food for thought and shouldn't hold up this PR, because the current behavior definitely is more broken.

Came up as part of https://github.com/sveltejs/svelte/pull/17682
