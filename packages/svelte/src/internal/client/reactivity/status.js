/** @import { Derived, Signal } from '#client' */
import { CLEAN, CONNECTED, MAYBE_DIRTY } from '#client/constants';
import { set_status } from './batch.js';

/**
 * @param {Signal} signal
 * @param {number} status
 */
export function set_signal_status(signal, status) {
	set_status(signal, status);
}

/**
 * Set a derived's status to CLEAN or MAYBE_DIRTY based on its connection state.
 * @param {Derived} derived
 */
export function update_derived_status(derived) {
	// Only mark as MAYBE_DIRTY if disconnected and has dependencies.
	if ((derived.f & CONNECTED) !== 0 || derived.deps === null) {
		set_signal_status(derived, CLEAN);
	} else {
		set_signal_status(derived, MAYBE_DIRTY);
	}
}
