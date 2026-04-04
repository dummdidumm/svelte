# Analysis: Merging Async Work Streams That Touch the Same Data

## The Idea

Today, when two async work streams are in flight simultaneously (e.g., two rapid button clicks that each trigger an async counter increment), they resolve one after the other — you see the counter go up twice, once per click.

The proposal: **what if two async work streams that write to the same data merge into one?** In the counter example, you'd see the counter go up once by 2, not twice by 1. The async work is "entangled" or "coalesced."

This document analyzes what this behavioral change would simplify in the reactive runtime.

---

## How It Works Today

When two async work streams are in flight simultaneously, they live in **separate `Batch` instances** tracked in the global `batches: Set<Batch>`. Each batch records its own `current` (new values) and `previous` (old values) Maps for every source it touches. This "always distinct" design creates a cascade of complexity to keep the batches consistent with each other:

1. **Time travel** (`batch.apply()`) — each batch builds an isolated view of state
2. **Rebasing** (`#commit()`) — when one batch commits, all other batches must be reconciled
3. **Per-batch branch tracking** (`BranchManager`) — different batches may want different DOM branches visible
4. **Skipped branch state tracking** — dormant branches must remember their dirty state for later revival
5. **Deferred effect coordination** — effects deferred in one batch may need to run after another commits

---

## What Could Be Simplified

### 1. Time Travel (`batch.apply()` + `batch_values`) — the biggest win

The entire time-travel mechanism exists so that each batch sees its own isolated view of state when multiple batches coexist. It involves:

- The **`batch_values: Map<Value, any>`** global variable
- **`Batch.apply()`** which builds a snapshot map by copying this batch's `current` values, then undoing other batches' changes via their `previous` maps
- A special path in **`get()`** (`runtime.js` ~line 663): `if (batch_values?.has(signal)) return batch_values.get(signal)`
- A guard in **`is_dirty()`** (~line 179-184) that prevents resetting `MAYBE_DIRTY` → `CLEAN` during time travel
- A guard in **`update_derived()`** (`deriveds.js` ~lines 385-393) that caches derived values in `batch_values` instead of updating `derived.v`
- **`batch_values?.delete(derived)`** in `mark_reactions` (`sources.js` ~line 351) to invalidate cached fork values

**If batches merge when they touch the same data, there is typically only one batch for the overlapping work.** Time travel is unnecessary when there's nothing to isolate. The `batch_values` global and all its scattered guards could be eliminated for the non-fork case.

### 2. Rebasing (`#commit()`) — ~80 lines of the most complex code

The `#commit()` method (`batch.js` lines 373-450) is the heart of cross-batch coordination. When a batch commits, it must "rebase" every other batch by:

1. Iterating all other batches to find overlapping sources
2. Updating earlier batches' `current` values to match
3. Finding effects that depend on *both* the committed batch's sources AND the other batch's sources (via `mark_effects`)
4. Re-traversing the effect tree in each other batch's context

This also requires two helper functions that exist solely for rebasing:

- **`mark_effects(value, sources, marked, checked)`** — `batch.js` lines 762-782 — walks the dependency graph to find async/block effects that straddle two batches
- **`depends_on(reaction, sources, checked)`** — `batch.js` lines 811-831 — recursive check whether a reaction depends on any of a set of sources

**If merging eliminates the "two batches both touching source X" scenario, all of `#commit()`'s rebasing logic, `mark_effects`, and `depends_on` become dead code.** That's roughly ~120 lines of deeply intricate graph-walking logic.

### 3. `BranchManager` Per-Batch Tracking — simpler branch lifecycle

`BranchManager` (`branches.js`) maintains a `#batches: Map<Batch, Key>` to track which key each batch wants visible. The `#commit` callback (lines 71-152) has to:

- Look up the key for the committing batch
- Destroy offscreen effects from *older* batches that will never commit
- Keep offscreen effects for *newer* batches that still need them
- Handle the `#discard` callback for fork cleanup

With merged batches, the common case is one batch per `BranchManager`. The multi-batch juggling — the offscreen/onscreen dance, the "destroy older but keep newer" logic — would collapse to a simpler single-batch model.

### 4. `#skipped_branches` State Tracking — simpler deferred branch handling

The `skip_effect`/`unskip_effect` mechanism (`batch.js` lines 152-179) plus `reset_branch` (lines 931-950) exist to handle branches that are "dormant" in one batch but active in another. Each skipped branch tracks its dirty/maybe_dirty child effects so they can be rescheduled if the branch comes back. With fewer concurrent batches, fewer branches need to be skipped and tracked.

### 5. `#dirty_effects` / `#maybe_dirty_effects` Interaction Between Batches

Both `Batch` and `Boundary` maintain their own sets of deferred dirty/maybe_dirty effects. The `revive()` method (`batch.js` lines 487-499) reschedules these when a batch is ready. The cross-batch interaction (effects deferred in one batch, needing to run after another batch commits) would be eliminated.

### 6. `batches` Set Size and Iteration — less multi-batch overhead everywhere

The global `batches: Set<Batch>` is iterated in `apply()`, `#commit()`, and checked in size comparisons. With merging, the set would typically contain just 1 entry (or 1 per independent data island), reducing the O(batches) overhead in these hot paths.

---

## What Would NOT Be Simplified

| Area | Why it stays |
|---|---|
| **Core reactivity graph** | Sources, deriveds, effects, `mark_reactions`, `is_dirty`, version tracking — all unchanged |
| **Effect tree structure and traversal** | `#traverse_effect_tree`, `schedule_effect`, the tree-walk algorithm — unchanged |
| **Dependency tracking** | `get()`, `update_reaction()`, `skipped_deps` optimization — unchanged |
| **Async derived mechanics** | `async_derived`, pending/blocking counting, `STALE_REACTION` rejection — still needed |
| **Boundary pending state** | `update_pending_count`, the pending snippet show/hide — still needed |
| **Pause/resume transitions** | Entirely orthogonal to batch management |
| **Fork-specific code** | Forks intentionally create isolated speculative batches — they'd still need isolation, but could become the *only* case that does |

---

## What Would Need to Be Added

The **merging mechanism** itself: when `internal_set` is called and the source is already tracked by another in-flight batch, the current batch would need to absorb that other batch (or vice versa). This is conceptually simpler than rebasing — it's a set union of sources/effects and a combination of pending counts — but it is a new code path.

Key questions for the merge mechanism:
- How to combine `#pending` / `#blocking_pending` counts from two batches
- How to merge `#dirty_effects` / `#maybe_dirty_effects` sets
- How to unify `#commit_callbacks` and `#discard_callbacks`
- How to handle the case where one batch is deferred and the other is not

---

## Rough Magnitude of Simplification

| Area | Lines affected | Nature of change |
|---|---|---|
| `batch_values` + `apply()` | ~50 lines | Eliminate for non-fork case |
| `#commit()` rebasing | ~80 lines | Eliminate entirely |
| `mark_effects` + `depends_on` | ~70 lines | Eliminate entirely |
| `BranchManager` multi-batch | ~40 lines | Simplify significantly |
| `#skipped_branches` tracking | ~30 lines | Simplify |
| Scattered `batch_values` guards | ~15 lines across `get`, `is_dirty`, `update_derived`, `mark_reactions` | Remove guards |
| **Total** | **~250-300 lines** | Most complex code in the batch system |

These are not just any 250-300 lines — they are the hardest-to-reason-about code in the batch system, the parts that deal with multiple concurrent batches seeing different views of reality.

---

## Conclusion

The "always distinct" design forces the system to maintain parallel realities (time travel), reconcile them (rebasing), and coordinate branch visibility across them (BranchManager per-batch maps). **Merging work streams on shared data would collapse these parallel realities into one**, eliminating the need for time travel, rebasing, and multi-batch branch coordination entirely.

The fork mechanism would become the *sole* consumer of batch isolation, and could potentially be refactored into a cleaner separate path. The net effect would be a significantly simpler `Batch` class with less global state.

The trade-off is a semantic change: users see one coalesced update instead of sequential ones.

---

## Fork Simplification Under the Merged Model

### The key insight

Today, forks and regular async work streams use the **same `Batch` infrastructure** and participate in the **same multi-batch coordination**. A fork is "just another batch" in the `batches` set, competing for time-travel slots, being rebased, tracked in `BranchManager`, etc.

Under the merged model, regular async work streams that touch the same data coalesce into a single batch. This means **forks become the only case where multiple batches coexist**. This makes forks conceptually clearer: they're not "one of many parallel realities" but rather "a speculative overlay on top of the single reality."

### Current fork lifecycle

```
fork(fn)
  ├── Batch.ensure() with is_fork = true
  ├── batch_values = new Map()              // enter time-travel mode
  ├── flushSync(fn)                         // run fn, capture changes, traverse effects
  │   ├── internal_set → batch.capture()    // record current/previous values
  │   ├── mark_reactions → schedule_effect  // dirty propagation
  │   └── batch.process()
  │       ├── batch.apply()                 // TIME TRAVEL: iterate all batches to build isolated view
  │       ├── #traverse_effect_tree         // run block effects, defer others
  │       └── is_deferred() → true          // stash effects in #dirty_effects/#maybe_dirty_effects
  ├── revert source.v to previous values
  └── return { commit, discard }

commit()
  ├── is_fork = false
  ├── apply values: source.v = batch.current.get(source)
  ├── bump write versions
  ├── flushSync → flush eager effects
  ├── batch.revive()                        // reschedule deferred effects
  │   └── batch.flush()
  │       └── batch.process()
  │           ├── batch.apply()             // TIME TRAVEL again
  │           ├── #traverse_effect_tree
  │           ├── #commit()                 // REBASE all other batches
  │           └── flush_queued_effects
  └── await settled

discard()
  ├── bump write versions (for MAYBE_DIRTY deriveds)
  ├── batches.delete(batch)
  └── batch.discard() → #discard_callbacks
```

### What fork code touches today that could change

#### 1. `apply()` — from N-batch iteration to simple overlay

**Current** (`batch.js` lines 536-553):
```js
apply() {
    if (!async_mode_flag || (!this.is_fork && batches.size === 1)) return;

    // build isolated view: start with our values...
    batch_values = new Map(this.current);

    // ...then undo EVERY other batch's changes
    for (const batch of batches) {
        if (batch === this) continue;
        for (const [source, previous] of batch.previous) {
            if (!batch_values.has(source)) {
                batch_values.set(source, previous);
            }
        }
    }
}
```

**Under merged model**: There is at most one other batch (the single real batch), and if it exists, it hasn't committed yet — its values are already on the sources. The fork just needs to overlay its own values:

```js
apply() {
    if (!this.is_fork) return;   // only forks need this
    batch_values = new Map(this.current);
    // done — source.v already has the correct "real world" value
    // for anything the fork didn't touch
}
```

The "iterate all other batches to undo their changes" loop disappears entirely. This is possible because in the merged model, there aren't multiple non-fork batches with conflicting `previous` values that need undoing.

#### 2. `#commit()` — from general rebase to targeted fork update

**Current** (`batch.js` lines 373-450): When ANY batch commits, it iterates ALL other batches, finds overlapping sources, calls `mark_effects`/`depends_on` to find straddling effects, re-traverses each batch's effect tree. This is ~80 lines of the most complex code.

**Under merged model**: When the real batch commits, the only "other batches" are forks. The interaction is one-directional (real → fork) and simpler:

```js
#commit() {
    if (batches.size > 1) {
        for (const batch of batches) {
            if (batch === this || !batch.is_fork) continue;

            // For sources the real batch changed that the fork also changed:
            // update the fork's "previous" baseline so discard restores correctly
            for (const [source, value] of this.current) {
                if (batch.current.has(source)) {
                    batch.previous.set(source, value);
                }
            }

            // The fork's effects that depend on committed sources
            // will naturally re-evaluate on the fork's next process(),
            // because source.wv was bumped and is_dirty() will catch it
        }
    }

    this.committed = true;
    batches.delete(this);
}
```

The `mark_effects` function (lines 762-782) and `depends_on` function (lines 811-831) — ~70 lines — become unnecessary. The fork doesn't need explicit re-dirtying because:

- When the real batch commits, `source.wv` is already bumped from the original `internal_set`
- The fork's deferred effects will check `is_dirty()` when revived, which compares `dep.wv > reaction.wv`
- If a source changed after the fork's effects last ran, `is_dirty` returns true naturally

When a **fork** commits (`is_fork` set to `false`, values applied), it becomes the real batch. No rebasing needed — there are no other non-fork batches to reconcile with.

#### 3. `update_derived()` — fork guard stays but is cleaner

**Current** (`deriveds.js` lines 362-393):
```js
// in a fork, we don't update the underlying value, just `batch_values`.
if (!current_batch?.is_fork || derived.deps === null) {
    derived.v = value;
}

// During time traveling we don't want to reset the status so that
// traversal of the graph in the other batches still happens
if (batch_values !== null) {
    if (effect_tracking() || current_batch?.is_fork) {
        batch_values.set(derived, value);
    }
} else {
    update_derived_status(derived);
}
```

**Under merged model**: The fork guard in the first block stays — forks still can't write to `derived.v` directly. But the `batch_values !== null` check in the second block becomes clearer: `batch_values` is non-null **only** when processing a fork. The "time traveling" comment becomes "fork overlay" — one concept instead of a general multi-batch one.

```js
if (!current_batch?.is_fork || derived.deps === null) {
    derived.v = value;
}

if (current_batch?.is_fork) {
    batch_values.set(derived, value);
} else {
    update_derived_status(derived);
}
```

#### 4. `is_dirty()` — guard simplifies

**Current** (`runtime.js` lines 179-184):
```js
if (
    (flags & CONNECTED) !== 0 &&
    // During time traveling we don't want to reset the status so that
    // traversal of the graph in the other batches still happens
    batch_values === null
) {
    set_signal_status(reaction, CLEAN);
}
```

**Under merged model**: `batch_values !== null` means "we're inside a fork." The guard still applies (a fork shouldn't mark things CLEAN because the real batch needs them dirty too), but the reasoning is simpler: "don't clean up during fork processing" rather than "don't clean up during time travel across N batches."

#### 5. `update_reaction()` — fork guard stays

**Current** (`runtime.js` lines 258-266):
```js
// Don't remove reactions during fork;
// they must remain for when fork is discarded
var is_fork = current_batch?.is_fork;

if (new_deps !== null) {
    if (!is_fork) {
        remove_reactions(reaction, skipped_deps);
    }
```

This stays as-is. Forks still need to preserve reaction links so that discard works correctly.

#### 6. `BranchManager` — from N-batch map to real+fork

**Current**: `#batches: Map<Batch, Key>` can have N entries. The `#commit` callback iterates all entries, destroys older batch offscreen effects, keeps newer ones.

**Under merged model**: `#batches` has at most 2 entries: the real batch and a fork. The "destroy older, keep newer" loop simplifies to: "if committing the real batch, update the fork's branch; if committing a fork, it becomes the real branch."

The `#discard` callback stays — forks can still be discarded and their offscreen effects destroyed.

#### 7. `is_deferred()` — stays but `is_fork` is the primary case

```js
is_deferred() {
    return this.is_fork || this.#blocking_pending > 0;
}
```

Under the merged model, `this.is_fork` is the only reason a batch would be "deferred due to isolation." `#blocking_pending > 0` handles the single real batch waiting for async work. The two cases are now clearly distinct rather than conflated.

### What fork code stays unchanged

| Code | Why |
|---|---|
| `fork()` creation flow | Still creates a batch, runs `flushSync(fn)`, reverts values |
| `commit()` value application | Still applies `batch.current` values, bumps `wv`, flushes eager effects |
| `discard()` cleanup | Still bumps `wv`, removes from `batches`, calls `#discard_callbacks` |
| `revive()` | Still reschedules deferred effects |
| `batch.capture()` | Still records current/previous values |
| `mark_eager_effects()` | Still needed for fork commit to trigger `$state.eager()` |
| `batch_values` in `get()` | Still needed — fork overlay must intercept reads |

### Summary

| Aspect | Current (N-batch) | Merged model (1 real + forks) |
|---|---|---|
| `apply()` | Iterate all batches, build composite view | `batch_values = new Map(this.current)` |
| `#commit()` | ~80-line rebase loop over all batches | ~15-line fork baseline update |
| `mark_effects` + `depends_on` | ~70 lines, needed for cross-batch effect discovery | Eliminated — `is_dirty` handles it naturally |
| `batch_values` semantics | "Time travel across N parallel realities" | "Fork overlay on single reality" |
| `BranchManager` | N-batch map with complex lifecycle | At most 2 entries (real + fork) |
| `is_deferred()` | Conflates fork isolation + async pending | Two clearly distinct cases |

The fork mechanism would shift from being "one of many parallel realities competing for consistency" to being "a speculative overlay on top of the single truth." This makes the code easier to reason about, eliminates the general N-batch coordination machinery, and reduces the `Batch` class's responsibility to: (1) manage a single stream of real work, and (2) optionally host a fork overlay.
