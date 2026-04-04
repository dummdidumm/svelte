# Svelte 5 Reactivity System — Internal Architecture

This document describes the internal reactivity system as it exists on the current branch, with particular focus on how effects are scheduled and executed.

## Core Concepts

### Signals: Sources, Deriveds, and Effects

The reactivity graph is built from three kinds of nodes:

- **Sources** (`$state`): Leaf values. When written to, they notify their dependents via `mark_reactions`. A source has a `wv` (write version) that increments on each change.
- **Deriveds** (`$derived`): Computed values. They track their own dirtiness via flags (`DIRTY`, `MAYBE_DIRTY`, `CLEAN`) on `signal.f`. A derived is demand-driven — it only recomputes when read (via `get()`), not when its dependencies change. `mark_reactions` sets the derived's flag to `MAYBE_DIRTY`, and the actual recomputation happens lazily inside `is_dirty()` → `update_derived()`.
- **Effects**: Side-effectful computations (DOM updates, user `$effect()`, etc). Unlike deriveds, effects are push-driven — they are _scheduled_ when their dependencies change, and _executed_ during a flush cycle.

### Node Shapes

All reactive nodes share a base `Signal` interface:

```
Signal { f: number, wv: number }
```

**Value** (extends Signal) — used by sources and deriveds:

- `v` — the current value
- `equals` — equality function (default: `===` via `equals()`, or `safe_equals()` for mutable sources)
- `reactions` — array of reactions (deriveds/effects) that depend on this value
- `rv` — read version, used during dependency tracking to avoid duplicates
- `wv` — write version, incremented when the value changes

**Reaction** (extends Signal) — used by deriveds and effects:

- `fn` — the computation function
- `deps` — array of `Value` nodes this reaction reads from
- `ctx` — component context
- `ac` — AbortController, aborted when reaction is re-run or destroyed

**Derived** (extends both Value and Reaction):

- `effects` — child effects created inside this derived (destroyed on recomputation)
- `parent` — parent effect or derived in the tree

**Effect** (extends Reaction):

- `first` / `last` — first/last child effects (doubly-linked list)
- `prev` / `next` — sibling links within parent
- `parent` — parent effect
- `teardown` — cleanup function returned from `fn`
- `nodes` — DOM node references (`start`, `end`, animation `a`, transitions `t`)
- `b` — the `Boundary` this effect belongs to

### Flags

The `f` field is a bitmask combining type flags and status flags:

**Type flags** (what kind of node this is):

- `DERIVED` — node is a derived
- `EFFECT` — deferred user effect (`$effect()`)
- `RENDER_EFFECT` — synchronous render effect (attribute bindings, text updates)
- `BLOCK_EFFECT` — structural block (`{#if}`, `{#each}`, etc). Does not destroy branch children on re-run
- `MANAGED_EFFECT` — like BLOCK_EFFECT (doesn't destroy children) but runs as a deferred render effect
- `BRANCH_EFFECT` — container for a conditional branch's content
- `ROOT_EFFECT` — top of an effect tree (`mount()` or `$effect.root()`)
- `BOUNDARY_EFFECT` — `<svelte:boundary>` effect
- `EAGER_EFFECT` — runs synchronously when dependencies change (used for `$inspect`)
- `USER_EFFECT` — marks an effect as user-created (for validation)
- `ASYNC` — async effect/signal

**Status flags** (current state, mutually exclusive via `STATUS_MASK`):

- `CLEAN` — value is up-to-date
- `DIRTY` — value needs re-computation
- `MAYBE_DIRTY` — a transitive dependency _may_ have changed; needs checking

**Lifecycle flags**:

- `CONNECTED` — derived is connected to the effect tree (has dependents)
- `INERT` — effect is paused (transitioning out, skipped during traversal)
- `DESTROYED` — effect has been destroyed
- `REACTION_RAN` — sync effect/derived has executed at least once
- `EFFECT_TRANSPARENT` — does not create a transition boundary
- `HEAD_EFFECT` — marks internal head effects
- `EFFECT_PRESERVED` — effect is kept in tree even if it has no deps/children
- `REACTION_IS_UPDATING` — reaction is currently executing its `fn`
- `ERROR_VALUE` — the `v` field holds an error to be thrown on read

**Derived-specific**:

- `WAS_MARKED` — performance optimization during `mark_reactions` traversal

### Version Tracking

The system uses version numbers instead of per-edge dirty flags:

- `**write_version**` (global): Monotonically increasing counter. Incremented on every source write or derived recomputation that produces a new value.
- `**source.wv**`: Set to `++write_version` when the source is written to.
- `**derived.wv**`: Set to `++write_version` when the derived recomputes to a new value.
- `**reaction.wv**`: Set to `write_version` when the reaction finishes executing (in `update_effect`).

To check if a dependency changed: `dep.wv > reaction.wv` — if the dependency was written _after_ the reaction last ran, the reaction is dirty.

- `**read_version**` (global): Incremented at the start of each `update_reaction()`. Used during dependency tracking to avoid adding the same dependency twice.
- `**signal.rv**`: Set to `read_version` the first time a signal is read during a reaction's execution.

## Dependency Tracking

### How `get()` Registers Dependencies

When `get(signal)` is called inside an active reaction (during `update_reaction()`), the signal is registered as a dependency:

1. Check `signal.rv < read_version` to avoid duplicates
2. Set `signal.rv = read_version`
3. **Fast path**: if `deps[skipped_deps] === signal`, increment `skipped_deps` (same dep as last time, no allocation needed)
4. **Slow path**: push signal onto `new_deps` array

This optimization means reactions with stable dependency sets cause zero GC pressure.

### How `update_reaction()` Manages Dependencies

At the end of `update_reaction()`, the deps array is reconciled:

1. If `new_deps !== null` (deps changed):

- Remove the reaction from old deps that are no longer needed (`remove_reactions` from `skipped_deps` onward)
- Merge `skipped_deps` (reused prefix) with `new_deps` (new suffix) into `reaction.deps`
- Add the reaction to `reactions` arrays of new deps

2. If `new_deps === null` but `skipped_deps < deps.length` (deps were truncated):

- Remove the reaction from the trimmed deps

### Connected / Disconnected Deriveds

Deriveds have a `CONNECTED` flag that controls whether they participate in `mark_reactions`:

- **Connected**: The derived has at least one dependent effect. It receives `mark_reactions` notifications and is kept alive.
- **Disconnected**: No effects depend on this derived. It is removed from its own dependencies' `reactions` arrays, allowing it (and its dependency chain) to be garbage collected.

This lazy connect/disconnect mechanism means unused deriveds don't consume memory or CPU.

## Dirty Propagation

### `mark_reactions(signal, status)`

Called when a source is written (`internal_set`). Walks the source's `reactions` array:

For each **derived** reaction:

1. Set the derived's status to `status` (DIRTY if direct dep, MAYBE_DIRTY if transitive) — but never downgrade DIRTY to MAYBE_DIRTY
2. Delete the derived from `batch_values` (cached value is stale)
3. If not yet `WAS_MARKED`: set `WAS_MARKED` and recurse with `mark_reactions(derived, MAYBE_DIRTY)`
4. The `WAS_MARKED` flag prevents expensive loops when deriveds form diamond patterns

For each **effect** reaction:

1. Set the effect's status (DIRTY or MAYBE_DIRTY)
2. If BLOCK_EFFECT and `eager_block_effects` exists: add to the eager set (for processing during `flush_queued_effects`)
3. Call `schedule_effect(effect)` to queue it for execution

### `is_dirty(reaction)` — Lazy Dirtiness Check

Used for both deriveds and effects. The algorithm:

1. If `DIRTY`: return `true` immediately
2. If `MAYBE_DIRTY`:

- Walk through `deps` array
- For each dep that is a dirty derived: `update_derived(dep)` first (recursive)
- Then check `dep.wv > reaction.wv` — if any dep changed since this reaction last ran, it's dirty
- If none changed: set status to `CLEAN` and return `false`

3. Otherwise: return `false`

This is the mechanism that makes deriveds lazy — a `MAYBE_DIRTY` derived only recomputes if its actual dependencies (transitively) have genuinely changed.

## The Effect Tree

### Tree Structure

Effects form a tree rooted at a `ROOT_EFFECT`. The tree mirrors the component hierarchy:

```
ROOT_EFFECT
├── BRANCH_EFFECT (component instance)
│   ├── BLOCK_EFFECT ({#if ...})
│   │   ├── BRANCH_EFFECT (true branch)
│   │   │   ├── RENDER_EFFECT (text binding)
│   │   │   └── BLOCK_EFFECT ({#each ...})
│   │   │       ├── BRANCH_EFFECT (item 1)
│   │   │       └── BRANCH_EFFECT (item 2)
│   │   └── BRANCH_EFFECT (false branch)
│   ├── EFFECT ($effect(...))
│   └── RENDER_EFFECT (attribute binding)
```

Effects are linked as a doubly-linked list within their parent (`first` ↔ `last`, `prev` ↔ `next`).

### Effect Types and Their Execution Timing

| Type             | Created By                                      | When It Runs                                                 | Children on Re-run    |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------ | --------------------- |
| `BLOCK_EFFECT`   | `{#if}`, `{#each}`, `{#key}`, `{#await}`        | Inline during tree traversal                                 | Keeps branch children |
| `MANAGED_EFFECT` | Similar to BLOCK_EFFECT                         | Deferred (like render effects)                               | Keeps children        |
| `BRANCH_EFFECT`  | Branch containers                               | Never re-runs (created/destroyed)                            | N/A                   |
| `RENDER_EFFECT`  | Attribute bindings, text updates, `$effect.pre` | Inline during traversal (sync mode) or deferred (async mode) | Destroys all children |
| `EFFECT`         | `$effect(...)`                                  | Deferred (after tree traversal + render effects)             | Destroys all children |
| `ROOT_EFFECT`    | `mount()`, `$effect.root()`                     | Entry point for traversal                                    | N/A                   |
| `EAGER_EFFECT`   | `$inspect`, `$state.eager`                      | Synchronously when deps change                               | Destroys all children |
| `ASYNC`          | `async_derived`, async work                     | Runs once synchronously, then via async resolution           | N/A                   |

### `create_effect(type, fn, sync)`

1. Sets `parent = active_effect` (the currently executing effect)
2. Inherits `INERT` flag from parent if parent is inert
3. Creates the effect node with `DIRTY | CONNECTED` flags
4. If `sync`: executes immediately via `update_effect(effect)`
5. If not `sync`: calls `schedule_effect(effect)` to queue it
6. **Pruning optimization**: if a sync effect has no deps, no teardown, no DOM nodes, and a single (or no) child, the effect wrapper is discarded and replaced with its child

### `schedule_effect(effect)` — Climbing to the Root

Walks up the parent chain from the effect to the root:

1. For each `BRANCH_EFFECT` or `ROOT_EFFECT` ancestor:

- If already not `CLEAN`: bail out (this subtree is already scheduled)
- Otherwise: clear the `CLEAN` flag (mark as needing traversal)

2. At the root: push to `queued_root_effects`

**Special case**: During flushing, if we're scheduling from inside a block effect that's currently executing (the `active_effect`), bail out to prevent a double flush.

### `update_effect(effect)` — Executing an Effect

1. Set status to `CLEAN`
2. Destroy children:

- `BLOCK_EFFECT` / `MANAGED_EFFECT`: Only destroy non-branch children (`destroy_block_effect_children`)
- Others: Destroy all children (`destroy_effect_children`)

3. Execute previous teardown
4. Call `update_reaction(effect)` — runs `fn`, tracks deps, returns new teardown
5. Set `effect.wv = write_version`

## The Batch System

### What is a Batch?

A `Batch` is a unit of work that groups source mutations and their resulting effect updates. Every source write goes through `Batch.ensure()`, which creates a batch if none exists. The batch is then processed (traversed + flushed) either:

- Asynchronously via microtask (normal case)
- Synchronously via `flushSync()`

Key batch state:

- `current` — Map of `Source → current value` for all sources changed in this batch
- `previous` — Map of `Source → previous value` (before the batch's changes)
- `#commit_callbacks` — Set of functions to call when committing (branch DOM manipulation)
- `#dirty_effects` / `#maybe_dirty_effects` — deferred effects waiting for async work
- `#pending` / `#blocking_pending` — counters for in-flight async work
- `#skipped_branches` — branches to skip during traversal (with tracked dirty state)
- `is_fork` — whether this batch is a speculative fork

### How Scheduling Works

When a source is written (`internal_set`):

1. `source.v = value` — update the value immediately
2. `Batch.ensure()` — create batch if needed; schedule microtask for flush
3. `batch.capture(source, old_value)` — record old/new values (for fork support and rebasing)
4. `source.wv = increment_write_version()` — bump the write version
5. `mark_reactions(source, DIRTY)` — propagate dirtiness:

- Deriveds: flag as DIRTY/MAYBE_DIRTY, recursively mark their reactions
- Effects: flag as DIRTY, call `schedule_effect()` to queue root for traversal

6. Handle `untracked_writes` (for self-invalidating effects like `$effect(() => x++)`)
7. Flush eager effects if any (for `$inspect` and `$state.eager`)

### How Flushing Works

`flush_effects()` processes all queued root effects:

```
flush_effects()
  └─ while (queued_root_effects.length > 0)
       └─ batch.process(queued_root_effects)
            ├─ batch.apply()                        // set up batch_values for time travel
            ├─ #traverse_effect_tree(root)           // inline: block effects, render effects
            ├─ if deferred:
            │    └─ #defer_effects(...)              // store effects for later
            ├─ else:
            │    ├─ commit callbacks                 // branch creation/destruction
            │    ├─ #commit()                        // rebase other batches
            │    ├─ flush_queued_effects(render)     // deferred render effects
            │    └─ flush_queued_effects(effects)    // deferred $effect() effects
            └─ batch_values = null                   // clear time travel state
```

### Tree Traversal (`#traverse_effect_tree`)

Walks the effect tree depth-first starting from a root. For each effect:

1. **Skip if**: branch is CLEAN, effect is INERT, or effect is in `#skipped_branches`
2. **Branch effects** (BRANCH_EFFECT / ROOT_EFFECT): Clear CLEAN flag but don't execute — just descend into children
3. **Effects inside a pending boundary**: Defer to boundary's deferred effect set
4. `**EFFECT**`: Push onto `effects` array (executed later, after render effects)
5. `**RENDER_EFFECT` / `MANAGED_EFFECT**` (async mode): Push onto `render_effects` array (executed after commit callbacks)
6. **Block effects, sync render effects**: If `is_dirty(effect)`, execute immediately via `update_effect(effect)`, then descend into children

This means block effects (which determine DOM structure) always run before deferred effects (which update attributes/text). The tree walk ensures parent-before-child execution order.

### `flush_queued_effects(effects)` — Deferred Effect Execution

After tree traversal and commit callbacks, deferred effects are flushed:

1. For each effect: check `(DESTROYED | INERT) === 0` and `is_dirty(effect)`
2. Execute via `update_effect(effect)`
3. **Pruning**: if the effect ends up with no deps, no children, no DOM nodes, and no teardown, unlink it from the tree
4. **Eager block effects**: If the effect execution dirtied any block effects (via `eager_block_effects` set), process them immediately in ancestor-first order

### Commit Callbacks and Branch Lifecycle

Block effects like `{#if}` use `BranchManager` to manage DOM branches:

**During block effect execution** (`BranchManager.ensure(key, fn)`):

1. If the target branch doesn't exist yet, create it:

- **Initial render** (not deferred): Create branch directly in the DOM
- **Update** (deferred): Create branch offscreen in a `DocumentFragment`

2. Register which key this batch wants to show
3. If deferred:

- Skip non-target onscreen/offscreen branches via `batch.skip_effect(effect)`
- Unskip the target branch via `batch.unskip_effect(effect)`
- Register `batch.oncommit(this.#commit)` for later execution

**During commit** (`BranchManager.#commit()`):

1. Look up which key this batch requested
2. If the target is already onscreen: `resume_effect()` (cancel any outro)
3. If the target is offscreen: move its `DocumentFragment` into the DOM
4. For older batches: destroy their offscreen effects (they'll never commit)
5. For other onscreen branches: `pause_effect()` to outro/destroy them

### Pause/Resume (Transitions)

When a branch is removed but has outro transitions:

1. `pause_effect(branch)` → `pause_children()`:

- Sets `INERT` flag on the branch and all descendants
- Collects `TransitionManager` objects from `effect.nodes.t`
- Calls `.out(callback)` on each transition
- When all transitions complete: `destroy_effect(branch)`

2. If the condition reverses before transitions complete:

- `resume_effect(branch)` → `resume_children()`:
- Clears `INERT` flag
- If the effect was dirtied while paused (`(effect.f & CLEAN) === 0`): set `DIRTY` and `schedule_effect()`
- Calls `.in()` on transitions

### Skipped Branches in Batches

When a batch defers branch commits, non-active branches are "skipped":

1. `batch.skip_effect(effect)`: Adds branch to `#skipped_branches` map
2. During traversal: skipped branches are not entered
3. `reset_branch(effect, tracked)`: Walks the branch, recording dirty/maybe_dirty effects, then marks everything CLEAN
4. When a branch is unskipped (`batch.unskip_effect`): rescheduled all tracked dirty effects
5. At commit time: If the batch is deferred, `reset_branch` is called on remaining skipped branches

## Advanced Topics

### Cross-Batch Dirty State

Effects can be dirtied in one batch and need processing in another. This happens when:

- An effect is INERT when dirtied (skipped during traversal), and the batch commits
- A teardown during commit callbacks dirties new effects that belong to a subsequent batch

The `#commit()` method handles this by rebasing other batches when one commits. For each other batch, it finds sources that were changed and re-marks the corresponding async/block effects as dirty.

### Forks (Speculative Execution)

`fork(fn)` creates a batch with `is_fork = true` for speculative execution (e.g., data preloading on hover):

**Creation**:

1. Create a new batch, set `is_fork = true`
2. Run `fn()` synchronously via `flushSync` — state changes are captured
3. Revert all source values to their originals (`batch.previous`)
4. Return `{ commit, discard }` handles

**During fork processing**:

- `batch.apply()` sets `batch_values` to a `Map` that provides the fork's view of state
- Effects run and see fork values via `batch_values.get(signal)` in `get()`
- Other batches see the original values (time travel)
- Effects are deferred (`is_deferred()` returns true for forks)

**Committing a fork**:

1. Apply all source values from `batch.current`
2. Bump write versions so deriveds see the change
3. Flush eager effects
4. `batch.revive()` — reschedule all deferred effects, then flush

**Discarding a fork**:

1. Bump write versions (so MAYBE_DIRTY deriveds recheck)
2. Remove from `batches` set
3. Call `#discard_callbacks` to clean up effects

### Time Travel (`batch.apply()`)

When multiple batches exist, each needs to see its own view of state:

1. `batch_values = new Map(this.current)` — start with this batch's values
2. For each other batch: add their `previous` values for sources this batch doesn't touch
3. During `get()`: `batch_values.get(signal)` takes precedence over `signal.v`
4. After processing: `batch_values = null`

When a batch commits (`#commit()`), it rebases other batches:

- Earlier batches get their `current` values updated
- Effects that depend on changed sources are re-marked as dirty
- Those effects are re-traversed in each batch's context

### Async Deriveds and Boundaries

**Async deriveds** (`$derived` with `await`):

1. Create a regular `source` to hold the resolved value
2. Wrap the computation in an `async_effect`
3. Track pending state via `Boundary.update_pending_count()` and `batch.increment()/decrement()`
4. On resolution: `internal_set(signal, value)` — which triggers normal reactivity
5. Multiple re-runs: previous async runs are rejected with `STALE_REACTION`

**Context preservation** across `await`:

- `save(promise)` captures the reactive context (`active_effect`, `active_reaction`, `component_context`, `current_batch`) before an `await`
- Returns a thunk that restores context and returns the value
- Compiled as: `(await $.save(promise))()`

`**<svelte:boundary>` pending state\*\*:

- When `is_pending === true`, the boundary defers non-block effects during tree traversal
- Deferred effects are stored on the boundary and rescheduled when pending count reaches 0
- `is_rendered()` determines if async work is "blocking" (prevents batch commits until resolved)

### Eager Effects

`**$inspect` effects\*\* (EAGER_EFFECT):

- Collected in the `eager_effects` set during `mark_reactions`
- Flushed synchronously inside `internal_set` via `flush_eager_effects()`
- This ensures `$inspect` fires immediately when state changes

`**$state.eager(expr)**`:

1. Creates a version source and an eager effect
2. First run: computes the value synchronously
3. Subsequent runs: queues a version increment via microtask
4. The version increment triggers the containing render effect to re-run
5. On re-run: creates a new eager effect and recomputes

**Eager block effects** (during `flush_queued_effects`):

- When a deferred effect execution dirties a block effect (e.g., `$effect` changes state affecting `{#if}`), the block effect is added to `eager_block_effects`
- After each effect update, eager block effects are processed in ancestor-first order
- This ensures structural DOM changes happen promptly even during deferred effect flushing

### Self-Invalidating Effects

When an effect writes to a source it doesn't yet depend on (`$effect(() => x++)`):

1. The write is tracked in `untracked_writes` (during `update_reaction`)
2. After `fn()` completes, `schedule_possible_effect_self_invalidation()` checks if any untracked writes would affect this effect (via derived chains)
3. If so: marks the effect as DIRTY/MAYBE_DIRTY and schedules it
4. The infinite loop guard (1000 flush iterations) catches genuinely infinite self-invalidation

### Effect Cleanup During Destruction

When effects are destroyed (`destroy_effect`):

- `old_values` map provides the _pre-change_ values of sources so that teardown functions see consistent state
- For deriveds read during teardown: if they depend on changed values, they're re-executed with old values
- `is_destroying_effect` flag enables this special behavior in `get()`

### Dependency Cleanup and GC

When a reaction is removed from a dependency's `reactions` array:

- Uses swap-and-pop for O(1) removal
- If a derived's `reactions` array becomes empty:
  - Clears `CONNECTED` flag
  - Recursively removes it from _its_ deps' reactions
  - Destroys any effects owned by the derived
  - This cascading disconnection allows entire unused subgraphs to be GC'd

## Key Files

| File                                                | Purpose                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `reactivity/sources.js`                             | `source()`, `state()`, `set()`, `internal_set()`, `mark_reactions()`                                                                  |
| `reactivity/deriveds.js`                            | `derived()`, `async_derived()`, `execute_derived()`, `update_derived()`                                                               |
| `reactivity/effects.js`                             | `create_effect()`, `user_effect()`, `render_effect()`, `block()`, `branch()`, `pause_effect()`, `resume_effect()`, `destroy_effect()` |
| `reactivity/batch.js`                               | `Batch` class, `flushSync()`, `flush_effects()`, `schedule_effect()`, `fork()`, `eager()`                                             |
| `reactivity/status.js`                              | `set_signal_status()`, `update_derived_status()`                                                                                      |
| `reactivity/equality.js`                            | `equals()`, `safe_equals()`, `safe_not_equal()`                                                                                       |
| `reactivity/utils.js`                               | `defer_effect()`, `clear_marked()`                                                                                                    |
| `reactivity/async.js`                               | `flatten()`, `save()`, `capture()`, `unset_context()`                                                                                 |
| `runtime.js`                                        | `get()`, `is_dirty()`, `update_reaction()`, `update_effect()`, `untrack()`, `tick()`                                                  |
| `constants.js`                                      | All flag constants                                                                                                                    |
| `dom/blocks/branches.js`                            | `BranchManager` — coordinates branch creation/destruction with batches                                                                |
| `dom/blocks/if.js`, `each.js`, `key.js`, `await.js` | Block-level control flow using `BranchManager`                                                                                        |
| `dom/blocks/boundary.js`                            | `Boundary` class — pending state, effect deferral for async                                                                           |
