/** @import { Derived, Effect, Value } from '#client' */
import { CLEAN, DERIVED, DIRTY, MAYBE_DIRTY, WAS_MARKED } from '#client/constants';
import { get_status, set_status } from './batch.js';

/**
 * @param {Value[] | null} deps
 */
function clear_marked(deps) {
	if (deps === null) return;

	for (const dep of deps) {
		if ((dep.f & DERIVED) === 0 || (dep.f & WAS_MARKED) === 0) {
			continue;
		}

		dep.f ^= WAS_MARKED;

		clear_marked(/** @type {Derived} */ (dep).deps);
	}
}

/**
 * @param {Effect} effect
 * @param {Set<Effect>} dirty_effects
 * @param {Set<Effect>} maybe_dirty_effects
 */
export function defer_effect(effect, dirty_effects, maybe_dirty_effects) {
	const status = get_status(effect);
	if ((status & DIRTY) !== 0) {
		dirty_effects.add(effect);
	} else if ((status & MAYBE_DIRTY) !== 0) {
		maybe_dirty_effects.add(effect);
	}

	// Since we're not executing these effects now, we need to clear any WAS_MARKED flags
	// so that other batches can correctly reach these effects during their own traversal
	clear_marked(effect.deps);

	// mark as clean so they get scheduled if they depend on pending async state
	set_status(effect, CLEAN);
}
