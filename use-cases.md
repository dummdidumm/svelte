# Use cases for a mutable derived/projection/state link

## "sync effects"

https://discord.com/channels/457912077277855764/1298613953580105802/1298624532885671947

-> Something from below needs to synchronously update something above whenever something changes

-> can this be solved with a projection API? The thing above defines the projection and things from below can register their projection somehow?

## "link state"

override from above (possibly not if a certain condition is met), mutate from below

-> needs a good example that can't be solved differently efficiently

// TODO: do end of the file end - but ideally also notice elsewhere when something is closed while something inside is still open
// to fix:
// - component tag not closed https://github.com/sveltejs/language-tools/issues/1884
// - acorn in case of error somehow know where to end and print text into AST or sth? https://github.com/sveltejs/language-tools/issues/1990
// - block not closed, especially snippets https://github.com/sveltejs/language-tools/issues/2499

# Collecting data fetching patterns

## Nuxt

Their primary tool for getting data is `useFetch`, which you `await` in your script tag, which uses a built-in suspense boundary that notices all the async components and only resolves after they're all done. That way it's blocking on the server (but you can opt out of that on a per fetch basis if you want). Subsequent fetches are NOT triggering the suspense, which means the `data` property contains a stale value until it's loaded again, and it's on you to decide whether or not you want to show some kind of `pending` state during it.

```vue
<script setup>
const props = defineProps({
	id: Number
});
const {
	data: quote,
	pending,
	error
} = await useFetch(() => `https://dummyjson.com/quotes/${props.id}`);
</script>
```

Links:

- Guide: https://nuxt.com/docs/api/composables/use-fetch
- Playground: https://nuxt.com/docs/examples/features/data-fetching

Side note:

- https://nuxt.com/docs/api/composables/use-state looks interesting, could be something we use (assuming we rely on AsyncContext on the server) for save global-per-request server state

# Async without using async

So far our exploration of async work in components has shown us some promising ideas but also many tough problems, inherintly so. Quickly recapping two approaches, which helps better understand the tradeoffs of the proposal I'm going to make.

### Rich's await proppsal

In [Rich's await proposal](https://gist.github.com/Rich-Harris/55439f8ff02a51331f4f545b0f36862b) we've seen how it's nice to not having to learn new syntax/behaviors and instead rely on "just JavaScript" (and also makes people point towards JS-the-language for things that are cumbersome, not us). But we have also seen that using `await` inside components can become verbose pretty quickly.

This is how you do it today with SvelteKit's data loading where the async work happens before it gets to the component:

```svelte
<script>
	let { data } = $props();

	const tooHigh = $derived(data.count > 10);
</script>

{#if tooHigh}
	<p>Your count is too high</p>
{/if}

<div class="info">
	<span>First Name: {data.firstname}</span>
	<span>Name: {data.name}</span>
</div>
```

This is what you would have to do if you could only do `await` in the template:

```svelte
<script>
	let data = load_data_somehow();

	const tooHigh = $derived.by(async () => data.then((data) => data.count > 10));
</script>

{#if await tooHigh}
	<p>Your count is too high</p>
{/if}

<div class="info">
	<span>First Name: {await data.firstname}</span>
	<span>Name: {await data.name}</span>
</div>
```

That's just horrible in comparison what you had before. In the common case you have one piece/set of data you want to load initially, and then display that. So what you want to be able to do is this instead:

```svelte
<script>
	let data = await load_data_somehow();

	const tooHigh = $derived(data.count > 10);
</script>

{#if tooHigh}
	<p>Your count is too high</p>
{/if}

<div class="info">
	<span>First Name: {data.firstname}</span>
	<span>Name: {data.name}</span>
</div>
```

But that also comes with its own set of problems around effect scheduling and ordering.

### Dominic's $await proppsal

In [Dominic's $await proposal](https://gist.github.com/trueadm/9738adf58365c9155bdd5e054c466e63) we get back that desired "handle things synchronously" behavior. It comes at the cost of an additional rune with a few caveats and rules that are not immediately obvious / may look very weird to some people. The proposal also does not really solve the effect scheduling/ordering problems.

Furthermore, both proposals leave out the use case of refetches and how you deal with them. I for one would not want to show my high-up suspense loading fallback again once a fetch deep down my component tree reruns. Yes, forking would address this _somehow_, but it would mean learning yet another API and TBH I'm still not sold on the whole concept of forking being a good idea (because it has too many implications/gotchas).

### What I really (don't) want

Taking a step, what is it what we - or rather, I - really want from this endeavour? Why are we doing this? Here's the list of requirements I see:

- we want that work to be able to be done at a component level because of colocation (get the data where I need it)
- we want to be able to coordinate that async work, e.g. we don't want a separate spinner for each fetch, we want one big spinner higher up the tree
- we want to use the result in an ergonomic way
- we want to be able to use the same mechanism on the client and server, and it should be able to transport a serialized response across to not refetch on hydration
- we want this to happen in the most optimal way possible (also see [this good overview of different fetch approaches](https://17.reactjs.org/docs/concurrent-mode-suspense.html#traditional-approaches-vs-suspense))

### The proposal

My proposal is based on my experiences with working with tanstack-query and SvelteKit's data loading mechanism. What they both have in common is that they take care of the async parts and turn it into a synchronous (a _real_ synchronous) API for you, and don't come with the aformentioned gotchas around effect ordering/scheduling.

The day-to-day API you would use is essentially a wrapper around the low level primitives.

```svelte
<script>
	import { AsyncTask } from 'svelte';

	const profile = new AsyncTask(() => fetch(...));
</script>

<div>{profile.data?.name}</div>
<Component {profile.data} />
```

Most of this you could implement in userland today. What you can't today and what would become possible with this is suspending and data hydration, through two new low-level methods built for exactly that. `AsyncTask` would therefore look something like this:

```js
// server variant
import { suspend, reduceData } from 'svelte';

class AsyncTask {
	#data;

	get data() {
		return this.#data;
	}

	// other stuff like loading etc

	constructor(fetch) {
		const key = {};
		const promise = fetch();
		suspend(key, true);

		promise.then((data) => {
			this.#data = data;
			reduceData(data);
			suspend(key, false);
		});
	}
}

// client variant
import { suspend, reviveData } from 'svelte';

class AsyncTask {
	#data;

	get data() {
		return this.#data;
	}

	// other stuff like loading etc

	constructor(fetch) {
		const key = {};
		const server_result = reviveData();

		if (server_result) {
			this.#data = server_result;
			return;
		}

		const promise = fetch();
		suspend(key, true);
		promise.then((data) => {
			this.#data = data;
			suspend(key, false);
		});
	}
}
```

As you can see, `AsyncTask` is making use of `suspend(key, boolean)` and `reduceData/reviveData` under the hood.

- `suspend(key, boolean)` tells the nearest boundary to go into/out of suspense. The suspense boundary puts the keys in a set, and once that set is empty, it waits one more microtask and after that goes out of suspense. (in a way, the mechanism is the opposite of React, where suspense is happening by default and `startTransition` opts out of it)
- `reduceData(data, key?)` serializes the data puts it into HTML somehow (maybe like SvelteKit with script tags). If a key is given, that key is used to find the data on the client. If not, it's a incrementing counter (we can make this more robust using a [similar mechanism to what I envisage for stable IDs](https://github.com/sveltejs/svelte/issues/7517#issuecomment-2555863199))
- `reviveData(key?)` is the counterpart that gets the data out of the HTML back into JS

This approach has several advantages:

- people are not constrained to whatever abstraction we deem best (`AsyncTask` would just be a wrapper that helps with 80% of the cases); Tanstack-Query can use those primitives for a first-class SSR/hydration/suspense experience, or people can just implement one themselves
- since we have not introduced await into Svelte components itself, all the existing knowledge about how the system works is preserved, and its pitfalls avoided
- explaining suspense is straightforward, so is avoiding waterfalls

```svelte
<script>
	import { AsyncTask } from 'svelte';

	const profile = new AsyncTask(() => fetch(...));
	// no hoop-jumping, just use the profile-data directly with optional chaining
	const isOld = $derived(profile.data?.age > 60);

	function update() {
		// Can refetch the profile, and choose to suspend or show stale data until the update has arrived
		profile.refetch({ suspend: true });
	}
</script>

<div>{profile.data?.name}</div>
<!-- can render sub components as soon as possible, avoiding waterfalls ... -->
<Component />
<!-- ...or explicitly wait on the data -->
{#if profile.data}
	<Component />
{/if}
```

### ...

```svelte
<script module>
	import { AsyncTask } from 'svelte';

	// What I want from this for Svelte:
	// - Have a way to describe "this one is blocking, I don't want to load the component at all until these things are loaded"
	// 
	// What I want from this for SvelteKit:
	// - Wire up an endpoint behind the scenes in SvelteKit for me
	// - Still make it obvious that there's a barrier I'm crossing (through the API/types)
	//
	// -> these APIs need to be layered/separate, because I may want to do the Svelte bit but not the SvelteKit bit
	export const $data = {
		profile: new AsyncTask(() => fetch(...))
	};
	// you can import `$data` data elsewhere to prefetch it, or do it right here
	// if (Component.prefetch()) { await Component.prefetch(); Component (...)}
	$data.profile.prefetch(); // ugh why is this on the profile
</script>

<!-- Svelte will wait with actually rendering the component until all $data is resolved -->
<script>
	// you can use await, but _only_ before any deriveds or effect, and you cannot reference instance variables (including stuff from $props)

	// or: you can us await, but _only_ before any effects, and you cannot await deriveds
	let { foo } = $props();
	const bar = new AsyncTask(() => fetch(foo)); // blocks until bar.data is done. how does that work with the constructor return type??

	// no hoop-jumping, just use the profile-data directly
	const isOld = $derived($data.profile.age > 60);
</script>

<div>{$data.profile.name}</div>
<!-- can render sub components as soon as possible, avoiding waterfalls ... -->
<Component />
```

### what about

```svelte
<!-- Svelte will wait with actually rendering the component until all $data is resolved -->
<script module>
	function doFetch() {
		// return fetch(...);
	}
</script>

<script>
	import { AsyncTask } from 'svelte';
	// you can use await, but _only_ before any deriveds or effect, and you cannot reference instance variables (including stuff from $props)

	// or: you can us await, but _only_ before any effects, and you cannot await deriveds
	let { foo } = $props();
	const bar = new AsyncTask(() => fetch(foo)); // blocks until bar.data is done. how does that work with the constructor return type??
	const unrelated = new AsyncTask(() => fetch(asd));

	export const $preload() {
		return Promise.all([unrelated.prefetch()]);
	}

	const { data } = await bar;
	const { data: unrelatedData } = await unrelated;

	// no hoop-jumping, just use the profile-data directly
	const isOld = $derived($data.profile.age > 60);

	const x = await new AsyncTask(() => fetch(isOld));
</script>

<div>{$data.profile.name}</div>
<!-- can render sub components as soon as possible, avoiding waterfalls ... -->
<Component />
```

# svelte:portal

```svelte
<!-- <script>
	let x = $state(0)}

<!-- <script>
	let x = $state(0)}

<!-- <script>
	let x = $state(0)}

<!-- <script>
	let x = $state(0);
</script>

<button onclick={() => x++}>inc</button>

before
{#if x === 0}
	d
{:else if x === 1}
	e
{:else if x === 2}
	f
{:else}
	x
{/if}
after -->

<!-- <script>
    import { createPortalKey } from 'svelte';
    let x = createPortalKey();
    let count = $state(0);
    let root = $state();

    $effect(() => {
        root = document.querySelector('#root');
    })
</script>

<div>
    <svelte:portal for={x}></svelte:portal>
</div>

<button onclick={() => count++}>increment</button>

<svelte:portal target={x}>
    hello {count}
</svelte:portal>

{#if count < 5}
    <svelte:portal target={x}>
        <span>hello2 {count}</span>
    </svelte:portal>
{/if}

<p></p>

<svelte:portal target="{root}">
    I'm rendered in the
    <button onclick={() => root = document.querySelector('p')}>
        {root === document.querySelector('#root') ? 'root' : 'p'}
    </button>
</svelte:portal> -->
```
