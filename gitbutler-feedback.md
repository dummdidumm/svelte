- reactive types? they need better help for what is reactive and what not
  - .current convention will help
- .svelte.ts -> we need better documentation around reusable stuff, how to do it etc
- .svelte file with `export interface Props` in script module is just ignored, why?
  - only happens with `vitePreprocess({ script: true })` ???
  - also then uses the isomorphic component ?
- writable `$derived`: you have some polling, you get new data every 30 seconds. but then you POST an update and get back the new data, then you don't need to wait for the next poll to update the data you wanna set it right away
- textarea: you have PR templates, and they take a second to load. you can say "yes I want to use one of those" and it populates the textarea. but you also want the user to override it.

```js
$derived.by(() => {
	if (type === 'display') return pr.text;
	if (prTemplate) return prTemplate;
	return '';
});
```

... but once user does something we also want it to be overridable. And we don't want it to glitch and want it to be ok on the server

```js
const { name, onChange } = $props();
let editableName = $state(name);
$effect(() = editableName = name);
<input {value} onblur={() => onChange(editableName)}>
```

"not writable derived, but updateable state initialization"

- typed route helpers: `<a href={href('/foo/[bar]', { bar: 'baz' })}>`, or even `<a href={foobar('baz')}` (rails has the latter)

- "We're solving problems that other frameworks solve for your, like DI in Angular"
- "This is reactive, or not?" --> warn in more cases (are we doing this for $derived and $props?)
- migration has been very smooth
- `createEventDispatcher` implemented wrong? Are we not bubbling up all the way by default? (like doing `on:blabla` on a div three components higher up)
