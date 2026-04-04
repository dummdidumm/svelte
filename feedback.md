# Feedback: Difficulty Solving Issue #17595

## What's Hard About This Bug

### 1. Complex Timing Relationships

The core issue involves understanding the precise timing of:

- When async_effect runs during tree traversal
- When the promise callback (handler) executes
- When signals are updated and reactions are triggered
- The order in which sibling and nested effects execute

I'm struggling to understand when exactly the child's async_effect runs relative to:

- The parent condition's async_effect
- The if-block's re-evaluation
- The promise resolution callbacks

### 2. Distinguishing Valid vs Invalid Effect Execution

The bug requires skipping effects in ONE scenario but not another:

**Should skip (bug case):**

- Parent has `{#if active}` where condition uses `await`
- Child reads same state via props
- State changes from truthy to falsy
- Child shouldn't run with `undefined` props

**Should NOT skip (async-inner-after-outer test):**

- Parent has `{#if await foo()}`
- Child has `{await bar()}`
- Both read same state BUT via manually controlled promises
- Child SHOULD run when outer condition resolves

I cannot reliably distinguish these cases. My `pending` flag approach incorrectly blocks the second case.

### 3. Understanding Effect Tree Structure

I'm unclear on:

- The exact parent-child relationships between effects
- How `$.async` wrapper effects relate to async_derived effects
- Where block effects vs branch effects are in the hierarchy
- What `deps` array contains for different effect types

### 4. Understanding the Batch System

The batch.js file is 1000+ lines and I don't fully understand:

- How `#traverse_effect_tree` visits effects
- When effects are "already visited" vs "pending"
- How `schedule_effect` interacts with ongoing traversals
- The relationship between `mark_reactions` and tree traversal

## What Context Would Help

### 1. Effect Tree Visualization

A diagram showing the exact effect tree for the bug reproduction:

```
Root
└── $.async wrapper (outer)
    ├── async_effect (condition's async_derived)
    ├── $.if (block effect)
    │   └── branch effect (consequent)
    │       └── $.async wrapper (inner)
    │           └── Child component
    │               └── async_effect (child's async_derived)
```

### 2. Step-by-Step Trace

A detailed trace of what happens when `active` changes from `'some-id'` to `undefined`:

1. Which effects are marked dirty and in what order
2. Which effects run during tree traversal
3. When promise callbacks execute
4. When signals are updated

### 3. Invariants/Contracts

What are the rules that should ALWAYS hold?

- Should an async effect ever run if its containing branch might be destroyed?
- When is it safe for an async effect to read props?
- What guarantees should the batch system provide about effect ordering?

### 4. Similar Bug Fixes

Examples of previous bugs involving:

- Async effects and component unmounting
- Props becoming undefined during destruction
- Effects running in wrong order

### 5. Test Case Expectations

For `async-inner-after-outer`, a step-by-step explanation of what SHOULD happen:

1. Initial state: pending boundary shown
2. First shift click: what resolves, what renders
3. Second shift click: what resolves, what renders

### 6. Key Functions Documentation

Detailed documentation for:

- `async_derived` - when does it set signal value, what triggers re-runs
- `#traverse_effect_tree` - exact traversal order, when effects are skipped
- `schedule_effect` - what happens if called during traversal
- `is_dirty` - what makes an effect dirty, how is it cleared

## My Failed Approaches

1. **Synchronous handler for sync results** - Broke `async-with-sync-derived` because it changed timing assumptions
2. **Mark signal reactions as MAYBE_DIRTY** - Didn't work because `is_dirty` checks write version, not flags
3. **Mark block effects as DIRTY and schedule them** - By the time my code ran, the effect hierarchy was already being traversed
4. **Check if producer effect is DIRTY** - Producer is already CLEAN by the time we check (it ran earlier in traversal)
5. **Use `pending` flag on signal** - Incorrectly blocks effects that SHOULD run in `async-inner-after-outer`

## Root Cause (My Understanding)

The bug occurs because:

1. Both condition's async_derived and child's async_derived depend on `active`
2. When `active` changes, both async_effects are marked dirty
3. Tree traversal runs both effects
4. Condition's async_effect runs, schedules signal update for microtask
5. Child's async_effect runs BEFORE microtask, reads `active = undefined`
6. Microtask runs, updates condition signal, if-block re-evaluates, destroys branch
7. But child already ran with wrong value

The fix needs to delay child's async_effect until AFTER we know the branch will survive. But I can't figure out how to detect this without also blocking valid cases.

---

## Retrospective: What Would Have Helped Me Reach the Fix Faster

### 1. Inspect Generated Code FIRST

**What I did:** Spent hours modifying runtime code (batch.js, deriveds.js, sources.js) trying to fix timing/ordering issues.

**What I should have done:** Immediately look at the `_output` folder to see what code the compiler generated for the reproduction.

If I had compared:

```javascript
// Generated (WRONG):
$.async(node, [$$promises[1]], [() => $.get(active)], (node, $$condition) => {
    if ($.get($$condition)) $$render(consequent);
});

// Expected (CORRECT):
$.async(node, [$$promises[1]], void 0, (node) => {
    if ($.get(active)) $$render(consequent);
});
```

I would have immediately seen that `$.get(active)` was being wrapped in an async_derived unnecessarily.

**Lesson:** For reactivity bugs, always check if the generated code is correct BEFORE assuming the runtime is wrong.

### 2. Understand the Distinction Between `is_async()` and `has_await`

I didn't realize these were semantically different:

- `is_async()` → true if expression has **blockers** (needs to wait for async context)
- `has_await` → true if expression **contains `await**` (is inherently async)

The bug was using `is_async()` to decide whether to wrap in `async_derived`, when it should use `has_await`.

**Lesson:** When working with unfamiliar code, trace through the helper functions to understand exactly what they test for.

### 3. Recognize Compiler vs Runtime Issues

**Symptoms that misled me:**

- "Props are undefined" → sounds like a reactivity/ordering issue
- "Async derived re-evaluates on unmount" → sounds like effect lifecycle issue
- Test failures in batch traversal → sounds like runtime scheduling issue

**The actual problem:** The compiler was generating wrong code.

**Clues I missed:**

- The condition `$.get(active)` has no `await` - why would it need `async_derived`?
- The `{#if active}` block's condition is synchronous - it just reads a state

**Lesson:** When runtime fixes keep failing or causing regressions, consider that the runtime might be correct and the generated code is wrong.

### 4. Understand What `$.async`'s Expressions Array Does

I didn't fully understand that passing an expression to `$.async`'s third argument causes it to be wrapped in `async_derived` via the `flatten` function:

```javascript
// In async.js flatten():
for (var i = 0; i < expressions.length; i++) {
    var signal = async_derived(expressions[i]); // <-- THIS is what creates async_derived
    values.push(signal);
}
```

If the expression doesn't need `async_derived` wrapping (because it's synchronous), it shouldn't be in this array.

**Lesson:** When debugging, trace the data flow through helper functions to understand side effects.

### 5. Start From the Issue Description

The issue title was: "Async derived in child component re-evaluates with undefined props on unmount when parent has async derived"

Key insight I missed: "when **parent** has async derived" - the bug is triggered by the PARENT having async, not the child's expression being async.

This suggests the child's expression is being treated as async when it shouldn't be.

**Lesson:** Re-read the issue description after initial investigation. Fresh eyes might catch clues you missed.

### 6. Use Test-Driven Debugging

Instead of trying to understand the entire batch system, I should have:

1. Created a minimal reproduction
2. Added logging to see what code paths are hit
3. Compared with a working case (e.g., remove parent's async derived)
4. Identified exactly where behavior diverges

**Lesson:** Narrow down the problem systematically rather than trying to understand everything at once.

### 7. Check What Other Block Visitors Do

If I had noticed that IfBlock, EachBlock, KeyBlock, HtmlTag, and SvelteElement all had similar `is_async()` checks, I might have questioned whether the pattern itself was correct.

**Lesson:** When fixing a pattern, check if the same pattern appears elsewhere and whether it has the same issue.

---

## Summary: The Fastest Path to the Fix

1. **Reproduce** → Create test case
2. **Inspect output** → Look at `_output` folder
3. **Compare** → What was generated vs what should be generated
4. **Trace backwards** → Which compiler code generated the wrong output
5. **Fix** → Change the condition from `is_async()` to `has_await` where appropriate

Total time this path would take: ~30 minutes instead of multiple hours.

The key mistake was assuming the runtime was buggy when the compiler was generating incorrect code for a specific edge case.

---

## Runtime Insights: What I Learned About the Batch System

### 1. The `skipped_effects` Mechanism

**Purpose:** Tracks branches that are marked for destruction but haven't been destroyed yet.

**Location:** `packages/svelte/src/internal/client/reactivity/batch.js`

**How it works:**

- When a branch's condition becomes falsy (temporarily), the branch is added to `skipped_effects`
- During batch traversal, effects in `skipped_effects` are skipped (not executed)
- When the batch commits, skipped branches are destroyed
- If a branch's condition becomes truthy again, it's removed from `skipped_effects` ("survives")

**Key methods:**

```javascript
batch.skip_effect(effect)   // Mark branch for destruction
batch.unskip_effect(effect) // Branch survives, cancel destruction
```

### 2. The Branch Survival Edge Case

**The problem (from PR #17581):** When a branch is marked for destruction, its child effects are reset to CLEAN to prevent them from running in a "doomed" branch.

**The edge case:** If the branch "survives" (condition changes back to truthy), those effects are now CLEAN but should actually run. Since the source that triggered the change was already marked dirty BEFORE the CLEAN reset, no new dirty marking occurs, so the effects never run.

**The fix:** Track which effects were dirty/maybe_dirty before resetting them. If the branch survives, restore their status AND call `schedule_effect()` to ensure they get re-run.

```javascript
// skipped_effects is a Map, not a Set
skipped_effects = new Map<Effect, { d: Effect[], m: Effect[] }>();

// When skipping, track dirty effects
skip_effect(effect) {
    var tracked = { d: [], m: [] };
    this.skipped_effects.set(effect, tracked);
    reset_branch(effect, tracked); // Populates tracked.d and tracked.m
}

// When unskipping, restore and reschedule
unskip_effect(effect) {
    var tracked = this.skipped_effects.get(effect);
    if (tracked) {
        this.skipped_effects.delete(effect);
        for (var e of tracked.d) {
            set_signal_status(e, DIRTY);
            schedule_effect(e);  // CRITICAL: must also schedule!
        }
        // ... same for tracked.m with MAYBE_DIRTY
    }
}
```

### 3. `set_signal_status` vs `schedule_effect`

**Critical insight:** Setting an effect's status to DIRTY is NOT enough to make it run. You must ALSO call `schedule_effect()`.

- `set_signal_status(effect, DIRTY)` → Changes the effect's flags
- `schedule_effect(effect)` → Adds effect to the queue of effects to run

**When to use which:**

- During normal reactivity (source changes), `mark_reactions` handles both
- When manually rescheduling effects, you MUST call both

### 4. Effect Flags: DIRTY vs MAYBE_DIRTY vs CLEAN


| Flag        | Meaning                        | When set                                 |
| ----------- | ------------------------------ | ---------------------------------------- |
| DIRTY       | Effect definitely needs to run | Source it depends on changed             |
| MAYBE_DIRTY | Effect might need to run       | Derived it depends on might have changed |
| CLEAN       | Effect doesn't need to run     | Effect ran and is up-to-date             |


`**is_dirty(effect)` logic:**

1. If DIRTY → return true
2. If MAYBE_DIRTY → check if any dependency's write version > effect's write version
3. Otherwise → return false

### 5. Deferred Mode (`is_deferred()`)

The batch system has two modes:

- **Immediate mode:** Effects run synchronously during `process()`
- **Deferred mode:** Effects are queued for later (async boundaries, forks)

```javascript
is_deferred() {
    return this.is_fork || this.#blocking_pending > 0;
}
```

In deferred mode, effects go into `#deferred_effects` and are flushed later.

### 6. The `#traverse_effect_tree` Method

This is the heart of the batch system. It:

1. Visits effects depth-first
2. Skips CLEAN branches (nothing dirty inside)
3. Skips effects in `skipped_effects`
4. Runs BLOCK_EFFECT and ASYNC effects immediately
5. Collects other effects for later execution

**Key insight:** Block effects (like `$.each`) run DURING traversal, which means they can modify `skipped_effects` while traversal is ongoing. This is why `unskip_effect` needs to reschedule effects immediately.

### 7. Where Branch Skipping Happens

**branches.js (`BranchManager`):**

- Used by `$.if` blocks
- Manages onscreen/offscreen branches
- Calls `skip_effect`/`unskip_effect` when conditions change

**each.js:**

- Used by `{#each}` blocks
- Manages items that appear/disappear
- Calls `skip_effect`/`unskip_effect` when items are removed/re-added

### 8. Debugging Tips for Runtime Issues

1. **Add logging in `skip_effect`/`unskip_effect**` to see branch lifecycle
2. **Check `effect.f` flags** to see if effects are DIRTY/MAYBE_DIRTY/CLEAN
3. **Log in `#traverse_effect_tree**` to see traversal order
4. **Use `is_deferred()**` to understand which code path is taken
5. **Check if `schedule_effect` is called** when manually rescheduling

### 9. The Two-Part Fix Pattern

Many reactivity bugs require fixes in BOTH compiler AND runtime:


| Layer    | What to check                   | Example issue                |
| -------- | ------------------------------- | ---------------------------- |
| Compiler | Is the generated code correct?  | `is_async()` vs `has_await`  |
| Runtime  | Is the execution order correct? | Branch survival rescheduling |


**Process:**

1. Check generated code first (compiler)
2. If generated code is correct, check runtime
3. If both seem correct, check their interaction

---

## File Reference: Key Files for Reactivity Bugs


| File                                                                   | Purpose                             |
| ---------------------------------------------------------------------- | ----------------------------------- |
| `packages/svelte/src/internal/client/reactivity/batch.js`              | Batch processing, effect scheduling |
| `packages/svelte/src/internal/client/dom/blocks/branches.js`           | Branch management for if blocks     |
| `packages/svelte/src/internal/client/dom/blocks/each.js`               | Each block item management          |
| `packages/svelte/src/internal/client/reactivity/deriveds.js`           | Derived signals, async_derived      |
| `packages/svelte/src/internal/client/reactivity/sources.js`            | Source signals, mark_reactions      |
| `packages/svelte/src/internal/client/runtime.js`                       | is_dirty, schedule helpers          |
| `packages/svelte/src/compiler/phases/3-transform/client/visitors/*.js` | Code generation for each block type |


---

## Retrospective: Debugging Hydration Issues (Issue #17261)

### The Bug

Items in an `{#each}` block were being duplicated during hydration when using experimental async with multiple top-level statements (an `await` followed by a synchronous variable).

### What Made This Bug Hard

#### 1. Multiple Interacting Systems

The bug involved the interaction between:

- **Async blocks** - Handle `await` expressions with blockers
- **Each blocks** - Have special hydration logic to detect server/client mismatches
- **Hydration markers** - `<!--[-->` and `<!--]-->` comments that mark block boundaries

Understanding each system individually wasn't enough; the bug was in their interaction.

#### 2. The Each Block's End Marker Check

The each block has a check at the start of each iteration:

```javascript
if (hydrate_node.data === HYDRATION_END) {
    set_hydrating(false);  // Assumes server rendered fewer items
}
```

I didn't know about this check initially. It's designed to detect when SSR rendered fewer items than the client expects, but it was being triggered incorrectly by the inner async block's end marker.

#### 3. Understanding Hydration Pointer Movement

Tracing where `hydrate_node` points at each step was difficult:

- `hydrate_next()` advances to the next sibling
- `skip_nodes(false)` finds the end marker but doesn't move `hydrate_node`
- Component's `append()` calls `hydrate_next()`

The bug was that after an async block's early return path, `hydrate_node` was left at the end marker `<!--]-->`, which triggered the each block's "fewer items" check.

### What Would Have Helped

#### 1. Check the Rendered HTML Structure First

Looking at `_output/async_rendered.html` revealed the nested marker structure:

```html
<!--[--><!--[--><!--[--><!--[--><p>item 1</p><!--]--><!--[--><p>item 2</p><!--]-->...
```

Understanding this structure earlier would have clarified why the hydration pointer position mattered.

#### 2. Add Hydration State Logging Immediately

The bug became clear once I added:

```javascript
console.log('async start, hydrating=', hydrating, 'hydrate_node=', 
    hydrate_node?.nodeType === 8 ? `<!--${hydrate_node.data}-->` : hydrate_node?.nodeName);
```

This showed that `hydrating` was being set to `false` between items.

#### 3. Search for `set_hydrating(false)` Calls

A grep for `set_hydrating(false)` immediately reveals all places where hydration can be disabled. The each block's check (line 246 in each.js) was the culprit:

```javascript
if (hydrate_node.data === HYDRATION_END) {
    set_hydrating(false);
}
```

#### 4. Compare Early Return vs Normal Async Path

The async block has two code paths:

- **Early return** (blockers settled): Runs `fn(node)` synchronously
- **Normal path** (blockers pending): Uses `flatten()` callback

Comparing these revealed the early return path was missing proper hydration cleanup.

### Key Insight: Hydration Marker Ownership

Each async block "owns" a pair of markers: `<!--[-->...<!--]-->`. After the block's content runs, `hydrate_node` must be positioned **past** the end marker, so:

1. The next sibling block starts at the correct position
2. The each block doesn't see an end marker and think "fewer items rendered"

The fix:

```javascript
if (was_hydrating) {
    skip_nodes(false);   // Ensure we're at the end marker
    hydrate_next();      // Advance past it for the next block
}
```

### Debugging Checklist for Hydration Issues

1. **Check `_output/async_rendered.html**` - See the actual marker structure
2. **Grep for `set_hydrating(false)**` - Find what can disable hydration
3. **Add logging for `hydrate_node` position** - Track pointer movement
4. **Compare SSR output vs client result** - Identify where divergence happens
5. **Check if issue is hydrate-only** - Use `mode: ['hydrate']` in test
6. **Trace the early return paths** - These often have different/missing logic

### File Reference: Key Files for Hydration Bugs


| File                                                      | Purpose                                          |
| --------------------------------------------------------- | ------------------------------------------------ |
| `packages/svelte/src/internal/client/dom/hydration.js`    | `hydrate_node`, `hydrate_next()`, `skip_nodes()` |
| `packages/svelte/src/internal/client/dom/blocks/async.js` | Async block hydration handling                   |
| `packages/svelte/src/internal/client/dom/blocks/each.js`  | Each block's end marker check (line ~240)        |
| `packages/svelte/src/internal/server/renderer.js`         | Server-side marker generation (`async_block`)    |
| `_output/async_rendered.html`                             | Actual SSR output with markers                   |


---

## Retrospective: Hydration Mismatch with `$derived(await...)` + `bind:this` (Issue #17608)

### The Bug

When combining `$derived(await ...)` with `{@attach}` and `bind:this` on a component, hydration failed with a mismatch error. The issue occurred specifically when:

1. A component has async derived state
2. The component passes that state to a child via `{@attach}`
3. Another component has `bind:this` that depends on the async state

### What Made This Bug Hard

#### 1. Two Independent Root Causes

The bug required understanding TWO separate issues that combined to cause the failure:

**Server-side issue:** `bind:this` was being skipped entirely when checking for async blockers:

```javascript
// Server was doing this:
} else if (attribute.type === 'BindDirective' && attribute.name !== 'this') {
    optimiser.check_blockers(...)  // bind:this SKIPPED!
```

**Client-side issue:** Even with matching markers, `reset()` was failing because async blocks left `hydrate_node` at `<!--]-->` instead of advancing to the slot marker `<!---->`.

#### 2. Understanding the Slot Marker System

The key insight was understanding how slot markers work:

**Server generates:**

```html
<div><!--[--><Inner content><!--]--><!----></div>
     ^async start          ^async end  ^slot marker
```

**Client template:**

```javascript
var root = $.from_html(`<div><!></div>`);
//                           ^^ becomes <!---->
```

The `<!---->` (empty comment) is a slot marker that corresponds to `<!>` in the client template. After content is processed, `hydrate_node` should be at this marker for `reset()` to succeed.

#### 3. The `$.append` vs `$.async` Asymmetry

In normal (non-async) cases, `$.append()` calls `hydrate_next()` to advance past content. But when `$.async` defers (blockers not settled), no `$.append` runs because the content hasn't executed yet. So `hydrate_node` stays at the async end marker `<!--]-->`, not the slot marker `<!---->`.

#### 4. Why Initial Compile-Time Fix Attempts Failed

Initial attempts to add `$.next()` **inside** the `$.async` callback failed because:

- When `$.async` defers (blockers not settled), the callback doesn't run immediately
- So `$.next()` inside the callback doesn't execute during hydration
- The `$.reset()` call happens BEFORE the async callback runs

### Key Insights

#### 1. Server/Client Parity for Directive Handling

Both server and client compilers must handle directives consistently. The server was treating `bind:this` differently from `{@attach}`:

```javascript
// Server AttachTag handling (correct):
} else if (attribute.type === 'AttachTag') {
    optimiser.check_blockers(attribute.metadata.expression);
}

// Server bind:this handling (was missing blocker check):
} else if (attribute.type === 'BindDirective' && attribute.name !== 'this') {
    optimiser.check_blockers(...)  // Skipped bind:this!
}
```

The comment for AttachTag even explains why: "on the client they might generate a surrounding blocker function which generates extra comments, and to prevent hydration mismatches we therefore have to account for them here."

The same logic applies to `bind:this`.

#### 2. The `reset()` Function's Role

`reset(node)` serves two purposes:

1. Check that `hydrate_node` has no remaining siblings (within the parent element)
2. Reset `hydrate_node` to the parent element for subsequent operations

When async blocks are nested in slots, the async end marker `<!--]-->` has the slot marker `<!---->` as its sibling. After `$.async` runs (even when deferring), `hydrate_node` is at the end marker, but `reset()` sees the slot marker as an unexpected sibling.

#### 3. Compile-Time Fix: Add `$.next()` AFTER (not inside) `$.async`

The working compile-time fix adds `$.next()` **after** the `$.async` call, not inside the callback:

```javascript
// WRONG - inside callback, doesn't run when deferring:
$.async($$anchor, blockers, void 0, ($$anchor) => {
    MyComponent($$anchor, {...});
    $.next();  // NOT called when deferring!
});

// CORRECT - after async call, always runs:
$.async($$anchor, blockers, void 0, ($$anchor) => {
    MyComponent($$anchor, {...});
});
$.next();  // Always runs, advances past slot marker
```

This works because:

- `$.async` always sets `hydrate_node` to the end marker (even when deferring)
- `$.next()` after the call advances past the slot marker
- `reset()` then sees no remaining siblings and succeeds

#### 4. When to Apply the Fix

The fix should be applied when a static component wrapped in `$.async` is the **sole child** of its parent Fragment. This covers:

- Single component in a slot
- Single component in an each block body
- Single component in any other parent context

### The Fix Pattern

**Server-side:** Ensure directive handling parity (in `server/visitors/shared/component.js`)

```javascript
} else if (attribute.type === 'BindDirective') {
    optimiser.check_blockers(attribute.metadata.expression);
    if (attribute.name === 'this') {
        continue;  // bind:this is client-only, but we checked blockers above
    }
    // ... rest of binding handling
}
```

**Client-side (compile-time):** Centralized fix in `build_component` (in `client/visitors/shared/component.js`)

```javascript
if (async_values || blockers) {
    const async_call = b.stmt(b.call('$.async', ...));

    // Check if this component is the sole non-whitespace child of its parent
    if (node.type === 'Component') {
        const parent = context.path.at(-1);
        if (parent?.type === 'Fragment') {
            const siblings = parent.nodes.filter(
                (n) => n.type !== 'Text' || n.data.trim() !== ''
            );
            if (siblings.length === 1 && siblings[0] === node) {
                return b.block([async_call, b.stmt(b.call('$.next'))]);
            }
        }
    }

    return async_call;
}
```

This is much cleaner than handling each parent case separately - the fix is centralized in `build_component` and uses `context.path` to check if the component is the sole child.

### Debugging Checklist for Server/Client Hydration Mismatches

1. **Check both server AND client generated code** - The mismatch might be in either place
2. **Look for directive handling asymmetry** - Server and client compilers should handle directives consistently
3. **Understand the marker structure** - `<!--[-->...<!--]-->` for async blocks, `<!---->` for slots
4. **Trace `hydrate_node` movement** - Where is it after each operation?
5. **Compare with similar working cases** - e.g., `{@attach}` worked, `bind:this` didn't - why?
6. **Check for early return paths** - Async blocks have fast paths (settled blockers) vs deferred paths

### File Reference: Additional Files for This Bug Type


| File                                                                                  | Purpose                                                              |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/svelte/src/compiler/phases/3-transform/server/visitors/shared/component.js` | Server component compilation, directive handling                     |
| `packages/svelte/src/compiler/phases/3-transform/client/visitors/shared/component.js` | Client component compilation, slot serialization, `$.async` wrapping |
| `packages/svelte/src/compiler/phases/3-transform/client/visitors/EachBlock.js`        | Each block compilation, body handling                                |
| `packages/svelte/src/internal/client/dom/blocks/async.js`                             | `$.async` runtime, sets `hydrate_node` to end marker when deferring  |


### Summary: Fastest Path to Fix This Bug Type

1. **Check `_output/rendered.html**` - See actual server output
2. **Check client `_output/*.svelte.js**` - See what client expects
3. **Compare marker structures** - Do they match?
4. **If markers don't match:** Check server compiler for the directive/attribute in question
5. **If markers match but hydration fails:** Check `hydrate_node` position after `$.async` calls
6. **Key insight:** `$.async` sets `hydrate_node` to end marker when deferring - subsequent code may need `$.next()` to advance past slot markers
7. **Compile-time fix preferred:** Add `$.next()` AFTER `$.async` (not inside callback) in specific patterns (single component in slot/each body)

