# Batch-Scoped Effect Dirty State Summary

## Changes made

- Reused batch-scoped sets (`_dirty`, `_maybe_dirty`) for deferred effects, removing the duplicate deferred-only sets in `Batch`.
- Added a skip-aware revive path so deferred effects are only re-queued when their branch is not currently skipped.
- Restored deferred tracking for inline-run block effects by re-adding them to `_maybe_dirty` after `update_effect` when the batch is deferred.
- Removed `solo: true` from `packages/svelte/tests/runtime-runes/samples/async-block-rerun/_config.js` after confirming the fix.

## Files touched

- `packages/svelte/src/internal/client/reactivity/batch.js`
- `packages/svelte/tests/runtime-runes/samples/async-block-rerun/_config.js`

## Tests run

- `pnpm test runtime-runes`

## Remaining work

- Decide whether boundary-local deferred sets (`Boundary.#dirty_effects` / `#maybe_dirty_effects`) should also be consolidated with batch-scoped sets or kept separate for correctness.
- Revisit the `is_effect_dirty` fallback (bitwise flag check) and the cross-batch MAYBE_DIRTY propagation gaps to see if it can be removed safely.
- Validate other deferral/skip paths (e.g., `reset_branch`, `defer_effect`, `unskip_effect`) against batch-scoped sets, and simplify where safe.
- Consider whether `_dirty_branches` should be updated for any additional paths that only rely on CLEAN flags today.

## Potential pitfalls

- **Deferred block effects**: if block effects run inline during traversal while deferred, they can appear CLEAN unless re-added to `_maybe_dirty`. The current fix relies on this re-add behavior; removing it will likely regress async block reruns.
- **Skipped branches**: re-queueing effects under skipped branches can cause incorrect DOM updates or hydration mismatches. The skip-aware revive logic avoids this, but other reschedule paths might still bypass it.
- **Cross-batch stale flags**: effects marked MAYBE_DIRTY in a previous batch but not present in current batch sets still rely on flag fallback. Removing fallback too early could skip necessary derived updates.
- **Boundary deferral**: boundaries still track their own deferred sets; if merged with batch sets, ensure pending snippet behavior and replays are not altered.
