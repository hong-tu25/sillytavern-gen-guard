/**
 * Standalone test runner for the Generation Guard extension.
 *
 * Mirrors the upstream `sillyflow-proxy` suite but is fully self-contained, so contributors can
 * verify the extension without cloning anything else:
 *
 *     node tests/run.mjs
 *
 * Everything runs in plain Node with no browser and no network. Timers and
 * `SillyTavern.getContext()` are injected, which makes every timing assertion deterministic
 * instead of flaky.
 *
 * @module tests/run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeClock } from './helpers/fake-clock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const extensionDir = path.join(repoRoot, 'extension');

/** Files shipped in both the repo root and `extension/`. */
const SHIPPED_FILES = ['manifest.json', 'index.js', 'settings.html'];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * @param {*} condition Value that must be truthy.
 * @param {string} message Failure explanation.
 * @returns {void}
 */
function ok(condition, message) {
    if (!condition) throw new Error(message);
}

/**
 * @param {*} actual Observed value.
 * @param {*} expected Expected value.
 * @param {string} message Failure explanation.
 * @returns {void}
 */
function equal(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
}

/**
 * @param {number} actual Observed number.
 * @param {number} lower Inclusive lower bound.
 * @param {string} message Failure explanation.
 * @returns {void}
 */
function atLeast(actual, lower, message) {
    if (!(actual >= lower)) throw new Error(`${message} (expected >= ${lower}, got ${actual})`);
}

/**
 * @param {number} actual Observed number.
 * @param {number} upper Inclusive upper bound.
 * @param {string} message Failure explanation.
 * @returns {void}
 */
function atMost(actual, upper, message) {
    if (!(actual <= upper)) throw new Error(`${message} (expected <= ${upper}, got ${actual})`);
}

/**
 * @param {string} haystack String to search.
 * @param {string} needle Required substring.
 * @param {string} message Failure explanation.
 * @returns {void}
 */
function contains(haystack, needle, message) {
    if (!String(haystack).includes(needle)) throw new Error(`${message}: ${JSON.stringify(needle)} not found`);
}

/**
 * @param {string} haystack String to search.
 * @param {string} needle Forbidden substring.
 * @param {string} message Failure explanation.
 * @returns {void}
 */
function excludes(haystack, needle, message) {
    if (String(haystack).includes(needle)) throw new Error(`${message}: ${JSON.stringify(needle)} present`);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CallRecorder
 * @property {number} stopGeneration
 * @property {number} activateSendButtons
 * @property {number} generate
 * @property {number} saveSettings
 * @property {string[]} logs
 * @property {{kind: string, msg: string}[]} notifications
 */

/**
 * Creates an isolated call recorder.
 *
 * Each environment must own its recorder: a shared module-level one would accumulate counts across
 * test cases and make every "nothing happened" assertion meaningless.
 *
 * @returns {CallRecorder} A fresh recorder.
 */
function createCalls() {
    return {
        stopGeneration: 0,
        activateSendButtons: 0,
        generate: 0,
        saveSettings: 0,
        logs: [],
        notifications: [],
    };
}

/**
 * Builds a fresh fake host plus controller, with its own call recorder.
 *
 * @param {object} [options] Options.
 * @param {Record<string, *>} [options.settings] Setting overrides.
 * @param {boolean} [options.running] Whether a generation starts out in progress.
 * @param {boolean} [options.stopGeneration] Whether the host provides `stopGeneration`.
 * @param {boolean} [options.eventSource] Whether the host provides an event source.
 * @returns {{clock: *, guard: *, state: *, calls: CallRecorder, extensionSettings: *}} Fake environment.
 */
function createEnv({ settings, running = true, stopGeneration = true, eventSource = true } = {}) {
    const clock = createFakeClock();
    const recorder = createCalls();
    const state = {
        streamingProcessor: /** @type {*} */ ({ isFinished: !running, result: '' }),
        chat: [{ mes: '' }],
    };
    const extensionSettings = { gen_guard: { ...(settings ?? {}) } };

    /**
     * @returns {*} A context shaped like the subset of `st-context.js` the guard may use.
     */
    function buildContext() {
        /** @type {Record<string, *>} */
        const ctx = {
            streamingProcessor: state.streamingProcessor,
            chat: state.chat,
            extensionSettings,
            generate: () => { recorder.generate += 1; },
            activateSendButtons: () => { recorder.activateSendButtons += 1; },
            saveSettingsDebounced: () => { recorder.saveSettings += 1; },
        };
        if (stopGeneration) {
            ctx.stopGeneration = () => {
                recorder.stopGeneration += 1;
                // Mirror the host: aborting stops the streaming processor, so the generation is no
                // longer running afterwards.
                state.streamingProcessor.isFinished = true;
            };
        }
        if (eventSource) {
            ctx.eventTypes = { STREAM_TOKEN_RECEIVED: 'stream_token_received' };
            ctx.eventSource = { on: () => { }, removeListener: () => { } };
        }
        return ctx;
    }

    const deps = {
        getContext: () => buildContext(),
        getSettings: () => extensionSettings.gen_guard,
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        log: message => { recorder.logs.push(String(message)); },
        notify: (kind, msg) => { recorder.notifications.push({ kind, msg: String(msg) }); },
    };

    return {
        clock,
        guard: module.createGenerationGuard(deps),
        state,
        calls: recorder,
        extensionSettings,
    };
}

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const module = await import(pathToFileURL(path.join(extensionDir, 'index.js')).href);

/**
 * Drives a simulated live stream in sub-stall increments so "alive" stays distinguishable from
 * "silent". Injecting progress only between whole stall windows would legitimately trip the rule.
 *
 * @param {*} env Fake environment.
 * @param {{result?: boolean, chat?: boolean, event?: boolean, steps?: number, stallMs?: number}} options Shape of the stream.
 * @returns {void}
 */
function simulateStream(env, { result = false, chat = false, event = false, steps = 6, stallMs = 5000 } = {}) {
    const step = Math.min(1200, Math.floor(stallMs / 2));
    for (let i = 1; i <= steps; i++) {
        env.clock.advance(step);
        if (result) env.state.streamingProcessor.result = 'r'.repeat(i);
        if (chat) env.state.chat[env.state.chat.length - 1].mes = 'c'.repeat(i);
        if (event || result || chat) env.guard.onProgress();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** @type {{id: string, name: string, run: () => void}[]} */
const tests = [];
/**
 * @param {string} id Test id.
 * @param {string} name Human-readable purpose.
 * @param {() => void} run Test body.
 * @returns {void}
 */
function test(id, name, run) {
    tests.push({ id, name, run });
}

// --- hidden grace abort ----------------------------------------------------
test('L01', 'hidden does not abort before the grace period', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(true);
    env.clock.advance(2999);
    equal(env.calls.stopGeneration, 0, 'must not abort early');
    equal(env.clock.pending(), 1, 'the grace timer must be armed');
});

test('L02', 'hidden aborts once when the grace period elapses', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(true);
    env.clock.advance(3000);
    equal(env.calls.stopGeneration, 1, 'must abort exactly once');
    equal(env.clock.pending(), 0, 'no timer may survive the abort');
});

test('L03', 'a generation finishing while hidden is not aborted', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(true);
    env.clock.advance(1500);
    env.state.streamingProcessor.isFinished = true;
    env.guard.onProgress();
    env.clock.advance(5000);
    equal(env.calls.stopGeneration, 0, 'finished in time => no abort');
});

test('L04', 'hiding while idle arms nothing', () => {
    const env = createEnv({ running: false });
    env.guard.onVisibilityChange(true);
    env.clock.advance(30000);
    equal(env.calls.stopGeneration, 0, 'idle must never abort');
    equal(env.clock.pending(), 0, 'idle must leave no timer');
});

test('L05', 'a cancelled grace period never fires', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(true);
    env.clock.advance(1500);
    env.state.streamingProcessor.isFinished = true;
    env.guard.onVisibilityChange(false);
    env.clock.advance(60000);
    equal(env.calls.stopGeneration, 0, 'cancelled grace must not fire');
    equal(env.clock.pending(), 0, 'cancellation must clear the timer');
});

test('L06', 'hiddenGraceMs=0 aborts immediately', () => {
    const env = createEnv({ settings: { hiddenGraceMs: 0 } });
    env.guard.onVisibilityChange(true);
    env.clock.advance(0);
    equal(env.calls.stopGeneration, 1, 'zero grace aborts at once');
});

// --- visible stall fallback ------------------------------------------------
test('L07', 'no stall detection while idle', () => {
    const env = createEnv({ running: false });
    env.guard.onVisibilityChange(false);
    env.clock.advance(20000);
    equal(env.calls.stopGeneration, 0, 'idle must not abort');
    equal(env.clock.pending(), 0, 'idle must not arm a stall timer');
});

test('L08', 'a silent running generation is aborted and the UI unlocked', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(false);
    env.clock.advance(5000);
    equal(env.calls.stopGeneration, 1, 'silence must abort');
    atLeast(env.calls.activateSendButtons, 1, 'the UI must be force-unlocked');
});

test('L09', 'a stream that keeps producing survives many windows', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(false);
    simulateStream(env, { event: true, steps: 4 });
    env.clock.advance(5000);
    equal(env.calls.stopGeneration, 0, 'continuous progress must prevent an abort');
});

test('L10', 'completion stops the stall watchdog', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(false);
    env.clock.advance(2000);
    env.state.streamingProcessor.isFinished = true;
    env.guard.onProgress();
    env.clock.advance(20000);
    equal(env.calls.stopGeneration, 0, 'completed generation must not be aborted');
    equal(env.clock.pending(), 0, 'completion must clear timers');
});

test('L11', 'each progress source alone prevents a false abort', () => {
    for (const [label, options] of [
        ['result length change', { result: true }],
        ['chat message length change', { chat: true }],
        ['token events', { event: true }],
    ]) {
        const env = createEnv();
        env.guard.onVisibilityChange(false);
        simulateStream(env, { ...options, steps: 4 });
        env.clock.advance(5000);
        equal(env.calls.stopGeneration, 0, `progress via ${label} alone must prevent an abort`);
    }
});

test('L12', 'unlocking does not depend on stopGeneration existing', () => {
    const env = createEnv({ stopGeneration: false });
    env.guard.onVisibilityChange(false);
    env.clock.advance(5000);
    equal(env.calls.stopGeneration, 0, 'no stopGeneration is available here');
    atLeast(env.calls.activateSendButtons, 1, 'the UI must still be unlocked');
});

// --- idempotence and races -------------------------------------------------
test('L13', 'repeated hide/show events abort at most once', () => {
    const env = createEnv();
    for (let i = 0; i < 3; i++) {
        env.guard.onVisibilityChange(true);
        env.guard.onVisibilityChange(false);
    }
    env.clock.advance(60000);
    atMost(env.calls.stopGeneration, 1, 'a single generation may only be aborted once');
});

test('L14', 'disabled produces no side effects at all', () => {
    const env = createEnv({ settings: { enabled: false } });
    env.guard.onVisibilityChange(true);
    env.clock.advance(60000);
    env.guard.onVisibilityChange(false);
    env.clock.advance(60000);
    env.guard.onProgress();
    equal(env.calls.stopGeneration, 0, 'disabled must not abort');
    equal(env.calls.activateSendButtons, 0, 'disabled must not unlock');
    equal(env.calls.notifications.length, 0, 'disabled must not notify');
    equal(env.clock.pending(), 0, 'disabled must not leave timers');
});

test('L15', 'a disposed guard is inert', () => {
    const env = createEnv();
    env.guard.dispose();
    env.guard.onVisibilityChange(true);
    env.clock.advance(60000);
    env.guard.onProgress();
    equal(env.calls.stopGeneration, 0, 'disposed must do nothing');
    equal(env.clock.pending(), 0, 'dispose must clear timers');
});

test('L16', 'the latch re-arms for a second generation', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(true);
    env.clock.advance(3000);
    equal(env.calls.stopGeneration, 1, 'round 1 aborts');

    env.state.streamingProcessor.isFinished = true;
    env.guard.onProgress();
    env.state.streamingProcessor.isFinished = false; // new generation

    env.guard.onVisibilityChange(false);
    env.clock.advance(5000);
    equal(env.calls.stopGeneration, 2, 'round 2 must be able to abort again');
});

// --- notifications ---------------------------------------------------------
test('L17', 'a hidden-grace abort notifies with the right wording', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(true);
    env.clock.advance(3000);
    equal(env.calls.notifications.length, 1, 'exactly one notification');
    equal(env.calls.notifications[0].kind, 'hidden', 'the rule must be identified');
    contains(env.calls.notifications[0].msg, '后台', 'the message must mention the background');
    contains(env.calls.notifications[0].msg, '中止', 'the message must state it was aborted');
});

test('L18', 'stall and hidden notifications are distinguishable', () => {
    const hidden = createEnv();
    hidden.guard.onVisibilityChange(true);
    hidden.clock.advance(3000);
    const hiddenMsg = hidden.calls.notifications[0]?.msg ?? '';

    const stall = createEnv();
    stall.guard.onVisibilityChange(false);
    stall.clock.advance(5000);
    const stallMsg = stall.calls.notifications[0]?.msg ?? '';

    equal(stall.calls.notifications[0]?.kind, 'stall', 'the stall rule must be identified');
    contains(stallMsg, '解锁', 'the stall message must mention unlocking');
    ok(hiddenMsg !== stallMsg, 'the two rules must be distinguishable');
});

test('L19', 'showToast=false suppresses the notification but keeps the abort', () => {
    const env = createEnv({ settings: { showToast: false } });
    env.guard.onVisibilityChange(true);
    env.clock.advance(3000);
    equal(env.calls.stopGeneration, 1, 'the abort still happens');
    equal(env.calls.notifications.length, 0, 'no notification may be emitted');
});

test('L20', 'one abort produces exactly one notification', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(true);
    env.clock.advance(3000);
    env.guard.onVisibilityChange(true);
    env.guard.onVisibilityChange(false);
    env.clock.advance(30000);
    equal(env.calls.notifications.length, 1, 'a single abort notifies once');
});

test('L21', 'the guard never auto-retries', () => {
    for (const settings of [undefined, { enabled: false }, { showToast: false }]) {
        const env = createEnv({ settings });
        env.guard.onVisibilityChange(true);
        env.clock.advance(10000);
        env.guard.onVisibilityChange(false);
        env.clock.advance(10000);
        equal(env.calls.generate, 0, 'generate() must never be called');
    }
});

// --- diagnostics -----------------------------------------------------------
test('L22', 'diagnostics carry the unified prefix', () => {
    const env = createEnv({ settings: { diagnostics: true } });
    env.guard.onVisibilityChange(true);
    env.clock.advance(3000);
    atLeast(env.calls.logs.length, 1, 'diagnostics must log something');
    for (const line of env.calls.logs) contains(line, '[gen-guard]', 'every line must carry the prefix');
});

test('L23', 'diagnostics record the decision inputs', () => {
    const env = createEnv();
    env.guard.onVisibilityChange(true);
    env.clock.advance(3000);
    const joined = env.calls.logs.join('\n');
    for (const field of ['event=visibilitychange', 'check=hidden_grace', 'action=abort', 'reason=', 'hiddenGraceMs=']) {
        contains(joined, field, `diagnostics must record ${field}`);
    }

    const stall = createEnv();
    stall.guard.onVisibilityChange(false);
    stall.clock.advance(5000);
    const stallLog = stall.calls.logs.join('\n');
    contains(stallLog, 'silentMs=', 'the stall decision must record the observed silence');
    contains(stallLog, 'threshold=', 'the stall decision must record the threshold');
});

// --- settings --------------------------------------------------------------
test('L24', 'defaults are back-filled and clamped', () => {
    const ctx = { extensionSettings: {}, saveSettingsDebounced: () => { } };
    const settings = module.readSettings(ctx);
    equal(settings.enabled, true, 'enabled default');
    equal(settings.hiddenGraceMs, 3000, 'hiddenGraceMs default');
    equal(settings.stallMs, 5000, 'stallMs default');
    equal(settings.showToast, true, 'showToast default');
    equal(settings.diagnostics, true, 'diagnostics default');
    ok(ctx.extensionSettings.gen_guard, 'defaults must be persisted');

    for (const junk of [null, undefined, 42, 'x', [], true]) {
        equal(module.normaliseSettings(junk).hiddenGraceMs, 3000, `junk ${JSON.stringify(junk)} must fall back`);
    }
    equal(module.normaliseSettings({ hiddenGraceMs: -5 }).hiddenGraceMs, 0, 'negative grace clamps to 0');
    equal(module.normaliseSettings({ hiddenGraceMs: 1e9 }).hiddenGraceMs, 600000, 'grace is capped');
    equal(module.normaliseSettings({ stallMs: 10 }).stallMs, 1000, 'stall floor is 1000');
    equal(module.normaliseSettings({ stallMs: 1e9 }).stallMs, 600000, 'stall is capped');
    equal(module.normaliseSettings({ stallMs: 'abc' }).stallMs, 5000, 'non-numeric stall falls back');
});

test('L25', 'stored values survive and writes persist', () => {
    const ctx = { extensionSettings: { gen_guard: { hiddenGraceMs: 999 } }, saveSettingsDebounced: () => { } };
    const read = module.readSettings(ctx);
    equal(read.hiddenGraceMs, 999, 'stored value must not be overwritten');
    equal(read.stallMs, 5000, 'missing keys are filled around it');

    let saved = 0;
    const writable = { extensionSettings: {}, saveSettingsDebounced: () => { saved += 1; } };
    const written = module.writeSettings(writable, { stallMs: 2500, enabled: false });
    equal(written.stallMs, 2500, 'patch stored');
    equal(saved, 1, 'saveSettingsDebounced called once');
    equal(module.readSettings(writable).stallMs, 2500, 'value round-trips');
});

// --- degradation -----------------------------------------------------------
test('L26', 'an unreadable context never throws', () => {
    const clock = createFakeClock();
    const guard = module.createGenerationGuard({
        getContext: () => { throw new Error('host exploded'); },
        getSettings: () => module.DEFAULT_SETTINGS,
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        log: () => { },
        notify: () => { },
    });
    guard.onVisibilityChange(true);
    clock.advance(3000);
    guard.onVisibilityChange(false);
    clock.advance(10000);
    guard.onProgress();
    guard.dispose();
    equal(clock.pending(), 0, 'an unreadable context must not leave timers');
});

test('L27', 'a host without an event source still works', () => {
    const env = createEnv({ eventSource: false });
    env.guard.onVisibilityChange(false);
    env.clock.advance(5000);
    equal(env.calls.stopGeneration, 1, 'the guard must work without an event source');
    atLeast(env.calls.activateSendButtons, 1, 'unlock still happens');
});

test('L28', 'isGenerating reflects the streaming processor', () => {
    equal(module.isGenerating({ streamingProcessor: { isFinished: false } }), true, 'running counts as generating');
    equal(module.isGenerating({ streamingProcessor: { isFinished: true } }), false, 'finished does not count');
    equal(module.isGenerating({}), false, 'missing processor does not count');
    equal(module.isGenerating(null), false, 'missing context does not count');
});

test('L29', 'the timer budget stays bounded', () => {
    const idle = createEnv({ running: false });
    idle.guard.onVisibilityChange(false);
    idle.clock.advance(60000);
    equal(idle.clock.pending(), 0, 'idle leaves no timers');

    const hidden = createEnv();
    hidden.guard.onVisibilityChange(true);
    equal(hidden.clock.pending(), 1, 'at most one grace timer');
    hidden.clock.advance(3000);
    equal(hidden.clock.pending(), 0, 'grace timer cleared after firing');

    const visible = createEnv();
    visible.guard.onVisibilityChange(false);
    equal(visible.clock.pending(), 1, 'at most one stall timer');
    visible.clock.advance(5000);
    equal(visible.clock.pending(), 0, 'stall timer cleared after firing');
});

// --- packaging / static contract ------------------------------------------
test('S01', 'manifest is valid and declares its hooks', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    for (const field of ['display_name', 'loading_order', 'requires', 'optional', 'js', 'author', 'version']) {
        ok(field in manifest, `manifest must declare "${field}"`);
    }
    equal(manifest.js, 'index.js', 'js must point at index.js');
    equal(manifest.hooks?.activate, 'activate', 'hooks.activate must be declared');
    equal(manifest.hooks?.disable, 'onDisable', 'hooks.disable must be declared');
});

test('S02', 'settings.html exposes every control', () => {
    const html = fs.readFileSync(path.join(extensionDir, 'settings.html'), 'utf8');
    for (const id of ['gen_guard_enabled', 'gen_guard_hidden_grace', 'gen_guard_stall_ms', 'gen_guard_show_toast', 'gen_guard_diagnostics']) {
        contains(html, `id="${id}"`, `settings.html must expose ${id}`);
    }
});

test('S03', 'the extension makes no network requests and has no static imports', () => {
    const source = fs.readFileSync(path.join(extensionDir, 'index.js'), 'utf8');
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'import(', 'http://', 'https://', 'cdn.']) {
        excludes(source, forbidden, 'the extension must be fully offline');
    }
    equal(/^\s*import\s/m.test(source), false, 'no static import statement is allowed');
});

test('S04', 'the mobile-safe triggers and host APIs are used', () => {
    const source = fs.readFileSync(path.join(extensionDir, 'index.js'), 'utf8');
    for (const required of [
        'visibilitychange', 'pageshow', 'addEventListener', 'removeEventListener',
        'getContext', 'stopGeneration', 'activateSendButtons', 'streamingProcessor',
    ]) {
        contains(source, required, `index.js must use ${required}`);
    }
    excludes(source, '.generate(', 'the guard must never invoke generate');
    excludes(source, 'location.reload', 'the guard must never reload the page');
});

test('S05', 'the extension directory holds exactly the three shipped files', () => {
    const entries = fs.readdirSync(extensionDir).sort();
    equal(entries.length, 3, `expected exactly three files, found: ${entries.join(', ')}`);
    for (const name of SHIPPED_FILES) ok(entries.includes(name), `${name} must exist`);
});

test('S06', 'the root and extension copies are byte-identical', () => {
    // Two copies exist so that (a) SillyTavern's "Install extension" flow can pull the repo root
    // and (b) a human downloading the ZIP gets a ready-made folder. Drift between them would ship
    // a stale extension, so this is enforced by test.
    for (const name of SHIPPED_FILES) {
        const rootCopy = fs.readFileSync(path.join(repoRoot, name));
        const nestedCopy = fs.readFileSync(path.join(extensionDir, name));
        ok(rootCopy.equals(nestedCopy), `${name} differs between the repository root and extension/`);
    }
});

test('S07', 'required repository files are present', () => {
    for (const name of ['README.md', 'README.en.md', 'README.zh-TW.md', 'LICENSE', 'CHANGELOG.md', '.gitignore']) {
        ok(fs.existsSync(path.join(repoRoot, name)), `${name} must exist at the repository root`);
    }
    const license = fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');
    contains(license, 'GNU AFFERO GENERAL PUBLIC LICENSE', 'LICENSE must be the AGPL text');
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    contains(readme, 'third-party/gen-guard', 'README must document the install path');
    contains(readme, 'gen-guard', 'README must name the install folder');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const onlyIndex = process.argv.findIndex(arg => arg.startsWith('--only'));
const only = onlyIndex >= 0 ? (process.argv[onlyIndex].split('=')[1] ?? null) : null;

let passed = 0;
let failed = 0;

console.log('========================================');
console.log(' Generation Guard - standalone test suite');
console.log(` node    : ${process.version} (${process.platform}/${process.arch})`);
console.log(` target  : ${path.relative(repoRoot, extensionDir)}/index.js`);
console.log(` filter  : ${only ?? '(none)'}`);
console.log('========================================');

for (const entry of tests) {
    if (only && !entry.id.startsWith(only)) continue;
    try {
        entry.run();
        passed += 1;
        console.log(`  [PASS] ${entry.id}  ${entry.name}`);
    } catch (error) {
        failed += 1;
        console.log(`  [FAIL] ${entry.id}  ${entry.name}`);
        console.log(`         ${String(error?.message ?? error).split('\n').join('\n         ')}`);
    }
}

console.log('========================================');
console.log(` total ${passed + failed}  passed ${passed}  failed ${failed}`);
console.log('========================================');

process.exitCode = failed > 0 ? 1 : 0;
