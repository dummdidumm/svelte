# kit-sandbox reproduction

This playground reproduces a `goto` navigation issue across nested dynamic routes in SvelteKit (Svelte 5 app):

- navigating from `/bananas/123` to `/apples/456` can temporarily evaluate the old component as `bananas/456`
- that mismatch throws in the old page and is rendered by a local `<svelte:boundary>`
- the URL in the browser already shows the target location

## Run

```sh
pnpm dev
```

## Repro steps

1. Open `http://localhost:5173/bananas/123`
2. Click `goto(/apples/456)`
3. Observe boundary failure before navigation finishes
