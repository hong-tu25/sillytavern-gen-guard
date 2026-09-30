/**
 * Deterministic virtual clock for gen-guard acceptance tests.
 *
 * Why a fake clock: the guard's behaviour is entirely expressed in elapsed time (a hidden grace
 * period and a visible stall period). Driving those with real timers would make the suite slow and
 * flaky, and would be unreliable on a sandboxed mobile-oriented codebase. This clock lets tests
 * assert the exact decision boundaries (`grace-1` vs `grace`) with zero sleeping.
 *
 * Semantics:
 *  - `schedule(fn, ms)` registers a callback but never runs it immediately, not even for `ms <= 0`;
 *    it becomes due at `now + max(0, ms)`. Tests must call `advance()` to make it run.
 *  - `advance(ms)` moves virtual time forward and fires every callback that becomes due, in
 *    due-time order, including callbacks scheduled *by* those callbacks inside the same window.
 *  - `cancel(handle)` removes a callback so it can never fire, even if already due.
 *
 * @module tests/helpers/fake-clock
 */

/**
 * @typedef {object} FakeClock
 * @property {() => number} now Current virtual time in milliseconds.
 * @property {(fn: () => void, ms: number) => object} schedule Registers a delayed callback.
 * @property {(handle: object) => void} cancel Cancels a previously scheduled callback.
 * @property {(ms: number) => number} advance Moves time forward, firing due callbacks.
 * @property {() => number} pending Number of callbacks still scheduled.
 * @property {() => number} fired Total number of callbacks executed.
 */

/**
 * Creates a virtual clock suitable for `GuardDeps.schedule` / `GuardDeps.cancel`.
 *
 * @param {number} [startAt] Initial virtual time.
 * @returns {FakeClock} Clock instance.
 */
export function createFakeClock(startAt = 1_000_000) {
    let currentTime = startAt;
    let sequence = 0;
    let fired = 0;

    /**
     * @type {Map<object, { due: number, fn: () => void, seq: number, cancelled: boolean }>}
     */
    const timers = new Map();

    /**
     * @param {() => void} fn Callback to run.
     * @param {number} ms Delay in milliseconds.
     * @returns {object} Opaque handle for `cancel`.
     */
    function schedule(fn, ms) {
        const handle = { id: `t${++sequence}` };
        timers.set(handle, {
            due: currentTime + Math.max(0, Number(ms) || 0),
            fn,
            seq: sequence,
            cancelled: false,
        });
        return handle;
    }

    /**
     * @param {object} handle Handle returned by `schedule`.
     * @returns {void}
     */
    function cancel(handle) {
        const entry = timers.get(handle);
        if (entry) entry.cancelled = true;
        timers.delete(handle);
    }

    /**
     * @param {number} ms Milliseconds to advance.
     * @returns {number} Number of callbacks executed.
     */
    function advance(ms) {
        const target = currentTime + Math.max(0, Number(ms) || 0);
        let executed = 0;

        // Loop because a fired callback may schedule another callback that is due within the
        // remaining window (e.g. stall detection re-arming itself).
        for (;;) {
            /** @type {{handle: object, entry: {due: number, fn: () => void, seq: number}}|null} */
            let next = null;
            for (const [handle, entry] of timers) {
                if (entry.cancelled || entry.due > target) continue;
                if (!next
                    || entry.due < next.entry.due
                    || (entry.due === next.entry.due && entry.seq < next.entry.seq)) {
                    next = { handle, entry };
                }
            }
            if (!next) break;

            timers.delete(next.handle);
            currentTime = Math.max(currentTime, next.entry.due);
            executed += 1;
            fired += 1;
            try {
                next.entry.fn();
            } catch (error) {
                // A throwing callback must not corrupt the clock; surface it to the test runner.
                throw new Error(`fake clock callback threw: ${error?.message ?? String(error)}`);
            }
        }

        currentTime = target;
        return executed;
    }

    return {
        now: () => currentTime,
        schedule,
        cancel,
        advance,
        pending: () => timers.size,
        fired: () => fired,
    };
}
