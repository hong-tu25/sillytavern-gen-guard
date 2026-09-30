/**
 * Generation Guard (gen-guard) - a SillyTavern third-party extension.
 *
 * Problem it solves
 * -----------------
 * On mobile, backgrounding the browser while a stream is running can leave the client's
 * `await reader.read()` (`public/scripts/openai.js:3170`) pending forever. Because `Generate()`
 * settles its UI unlock through `.then(onSuccess, onError)` (`public/script.js:5453`), a promise
 * that never settles means neither handler runs, so `is_send_press` stays `true`
 * (`public/script.js:4986`) and the whole chat UI is locked until the page is reloaded.
 *
 * What this extension does
 * ------------------------
 *  1. On `visibilitychange` (hidden), wait `hiddenGraceMs` and then abort the generation, which
 *     makes that pending read fail immediately and lets the normal unlock path run.
 *  2. On returning to the foreground, if a generation is still marked in progress and has produced
 *     nothing for `stallMs`, abort and force the UI unlocked.
 *  3. It only notifies the user; it never retries on its own.
 *
 * Design constraints (see `sillyflow-proxy/specs/gen-guard/`)
 * ----------------------------------------------------------
 *  - `GC-1` never modify SillyTavern sources; this file is self-contained.
 *  - `GC-3` no static imports of host modules (they pull in jQuery/DOM), so the module must stay
 *    importable in a bare Node process for testing. Everything host-related goes through
 *    `SillyTavern.getContext()` and is resolved lazily.
 *  - `GC-4` zero runtime dependencies, no build step.
 *
 * @module gen-guard
 */

/** Unified prefix for every diagnostic line (AC-5.1). */
export const LOG_PREFIX = '[gen-guard]';

/**
 * Default settings. Mirrors `specs/gen-guard/30-config-contract.md` §2 exactly.
 * @type {Readonly<Record<string, *>>}
 */
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    hiddenGraceMs: 3000,
    stallMs: 5000,
    showToast: true,
    diagnostics: true,
});

/** Inclusive bounds used when clamping user input (`30-config-contract.md` §3). */
const BOUNDS = Object.freeze({
    hiddenGraceMs: { min: 0, max: 600000 },
    stallMs: { min: 1000, max: 600000 },
});

/** Name of the extension settings bucket inside `extension_settings`. */
export const SETTINGS_KEY = 'gen_guard';

/** DOM ids for the settings panel (AC-6.3). */
export const DOM_IDS = Object.freeze({
    enabled: '#gen_guard_enabled',
    hiddenGraceMs: '#gen_guard_hidden_grace',
    stallMs: '#gen_guard_stall_ms',
    showToast: '#gen_guard_show_toast',
    diagnostics: '#gen_guard_diagnostics',
});

/**
 * @typedef {object} GenGuardSettings
 * @property {boolean} enabled
 * @property {number} hiddenGraceMs
 * @property {number} stallMs
 * @property {boolean} showToast
 * @property {boolean} diagnostics
 */

/**
 * @typedef {object} GuardContext
 * @property {*} [streamingProcessor] Live streaming processor (read `.isFinished` / `.result`).
 * @property {*[]} [chat] Chat array; the last entry's `mes` is a progress source.
 * @property {() => unknown} [stopGeneration] Aborts the in-flight generation.
 * @property {() => void} [activateSendButtons] Force-unlocks the send UI.
 * @property {*} [eventSource] Host event emitter.
 * @property {*} [eventTypes] Host event-name table.
 */

/**
 * @typedef {object} GuardDeps
 * @property {() => GuardContext|null} getContext Lazily resolves the host context.
 * @property {() => GenGuardSettings} getSettings Current settings snapshot.
 * @property {(fn: () => void, ms: number) => *} schedule Injected timer registration.
 * @property {(handle: *) => void} cancel Injected timer cancellation.
 * @property {() => number} now Injected clock.
 * @property {(msg: string) => void} log Diagnostic sink (already gated by `diagnostics`).
 * @property {(kind: 'hidden'|'stall', msg: string) => void} notify User-visible sink (already gated).
 */

/**
 * Clamps a numeric setting into its documented range.
 * @param {*} value Raw value.
 * @param {{min: number, max: number}} bounds Inclusive bounds.
 * @param {number} fallback Value used when the input is not a finite number.
 * @returns {number} A finite, in-range number.
 */
function clampNumber(value, bounds, fallback) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, numeric));
}

/**
 * Normalises arbitrary stored settings into a valid settings object.
 *
 * Must tolerate `null`, `undefined` and non-objects without throwing (AC-8.5) because it runs
 * against persisted user data of unknown shape.
 *
 * @param {*} raw Stored value.
 * @returns {GenGuardSettings} Valid settings.
 */
export function normaliseSettings(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        enabled: source.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(source.enabled),
        hiddenGraceMs: source.hiddenGraceMs === undefined
            ? DEFAULT_SETTINGS.hiddenGraceMs
            : clampNumber(source.hiddenGraceMs, BOUNDS.hiddenGraceMs, 0),
        stallMs: source.stallMs === undefined
            ? DEFAULT_SETTINGS.stallMs
            : clampNumber(source.stallMs, BOUNDS.stallMs, DEFAULT_SETTINGS.stallMs),
        showToast: source.showToast === undefined ? DEFAULT_SETTINGS.showToast : Boolean(source.showToast),
        diagnostics: source.diagnostics === undefined ? DEFAULT_SETTINGS.diagnostics : Boolean(source.diagnostics),
    };
}

/**
 * Decides whether a generation is still running.
 *
 * `isGenerating()` is NOT exposed to extensions (`public/scripts/st-context.js` has no such export),
 * but `streamingProcessor` IS exported and is a live binding, so it is the supported signal.
 *
 * @param {GuardContext|null|undefined} ctx Host context.
 * @returns {boolean} True when a stream is believed to be in progress.
 */
export function isGenerating(ctx) {
    const processor = ctx?.streamingProcessor;
    if (!processor) return false;
    return processor.isFinished !== true;
}

/**
 * Builds a cheap signature of everything that changes while tokens stream in.
 *
 * @param {GuardContext|null|undefined} ctx Host context.
 * @returns {string} Signature; any change means the generation made progress.
 */
export function progressSignature(ctx) {
    const processor = ctx?.streamingProcessor;
    const chat = ctx?.chat;
    const lastMessage = Array.isArray(chat) && chat.length > 0 ? chat[chat.length - 1] : null;
    const messageLength = typeof lastMessage?.mes === 'string' ? lastMessage.mes.length : -1;
    const resultLength = typeof processor?.result === 'string' ? processor.result.length : -1;
    return `${messageLength}|${resultLength}`;
}

/**
 * Creates the generation guard controller.
 *
 * All side effects are injected, which keeps the timing logic deterministic and testable without a
 * browser (see `specs/gen-guard/40-test-spec.md`).
 *
 * @param {GuardDeps} deps Injected dependencies.
 * @returns {{ onVisibilityChange: (isHidden: boolean) => void, onPageShow: () => void, onProgress: () => void, dispose: () => void }} Controller.
 */
export function createGenerationGuard(deps) {
    const { getContext, getSettings, schedule, cancel, now, log, notify } = deps;

    /**
     * Reads the host context defensively.
     *
     * `getContext()` can throw (a host-side failure) or return anything; every consumer below must
     * be able to treat an unreadable context as "no generation is running" rather than propagating
     * the failure into the host's event loop (AC-8.5, AC-5.4).
     *
     * @returns {GuardContext|null} Context, or null when it cannot be read.
     */
    function safeContext() {
        try {
            return getContext() ?? null;
        } catch {
            return null;
        }
    }

    /** @type {boolean} */
    let hidden = false;
    /** @type {*|null} */
    let graceHandle = null;
    /** @type {*|null} */
    let stallHandle = null;
    /** @type {number} */
    let lastProgressAt = 0;
    /** @type {string} */
    let lastSignature = '';
    /**
     * One-shot latch per generation so a single generation can only ever be aborted once,
     * no matter how many events arrive (AC-3.1).
     * @type {boolean}
     */
    let abortedThisGeneration = false;
    /**
     * Previous value of "a generation is running", used to detect a *new* generation starting so the
     * one-shot latch can be re-armed (AC-3.5).
     * @type {boolean}
     */
    let wasGenerating = false;
    /** @type {boolean} */
    let disposed = false;

    /**
     * @param {string} message Diagnostic line.
     * @returns {void}
     */
    function trace(message) {
        log(`${LOG_PREFIX} ${message}`);
    }

    /**
     * @returns {GenGuardSettings} Current normalised settings.
     */
    function settings() {
        return normaliseSettings(getSettings?.());
    }

    /**
     * @returns {void}
     */
    function clearGrace() {
        if (graceHandle !== null) {
            cancel(graceHandle);
            graceHandle = null;
        }
    }

    /**
     * Re-arms the one-shot latch whenever a new generation begins.
     *
     * Without this, a guard that aborted one generation would stay inert for the rest of the
     * session. The reliable edge is the `false -> true` transition of the generation state, because
     * the content signature can legitimately be identical at the start of two generations.
     *
     * @returns {boolean} Current generation state.
     */
    function trackGenerationTransition() {
        const generatingNow = isGenerating(safeContext());
        if (generatingNow && !wasGenerating) {
            abortedThisGeneration = false;
            lastSignature = '';
        }
        wasGenerating = generatingNow;
        return generatingNow;
    }

    /**
     * @returns {void}
     */
    function clearStall() {
        if (stallHandle !== null) {
            cancel(stallHandle);
            stallHandle = null;
        }
    }

    /**
     * Clears both timers and the progress bookkeeping.
     * @returns {void}
     */
    function clearAll() {
        clearGrace();
        clearStall();
    }

    /**
     * Records the current progress signature as "just progressed".
     * @returns {void}
     */
    function stampProgress() {
        const ctx = safeContext();
        lastSignature = progressSignature(ctx);
        lastProgressAt = now();
    }

    /**
     * Detects whether the generation produced anything since the last sample.
     * @returns {boolean} True when the signature changed.
     */
    function hasProgressed() {
        const ctx = safeContext();
        if (!isGenerating(ctx)) return true;
        const signature = progressSignature(ctx);
        if (signature !== lastSignature) {
            lastSignature = signature;
            lastProgressAt = now();
            return true;
        }
        return false;
    }

    /**
     * Reports a stall/abort decision to the user.
     * @param {'hidden'|'stall'} kind Which rule fired.
     * @param {string} detail Human-readable detail.
     * @returns {void}
     */
    function notifyAbort(kind, detail) {
        const config = settings();
        if (!config.showToast) return;
        notify(kind, kind === 'hidden'
            ? `已中止后台中的生成：页面隐藏超过 ${config.hiddenGraceMs}ms 仍未完成。${detail}`
            : `已解锁卡死的生成：回到前台后 ${config.stallMs}ms 无任何新内容。${detail}`);
    }

    /**
     * Aborts the current generation and force-unlocks the UI.
     *
     * Order is contractual (`20-interface-contract.md` §3): abort first so the pending read rejects,
     * then unconditionally unlock so the UI recovers even if `stopGeneration` is unavailable.
     *
     * @param {'hidden'|'stall'} kind Which rule triggered the abort.
     * @returns {boolean} True when an abort was performed.
     */
    function abortGeneration(kind) {
        const ctx = safeContext();
        if (abortedThisGeneration || disposed) return false;
        if (!isGenerating(ctx)) return false;

        abortedThisGeneration = true;
        clearAll();

        const reason = kind === 'hidden' ? 'hidden_grace_elapsed' : 'visible_stall_detected';
        trace(`action=abort reason=${reason} kind=${kind} stallMs=${settings().stallMs} hiddenGraceMs=${settings().hiddenGraceMs}`);

        if (typeof ctx?.stopGeneration === 'function') {
            try {
                ctx.stopGeneration();
            } catch (error) {
                console.warn(`${LOG_PREFIX} stopGeneration threw; continuing with unlock`, error);
            }
        } else {
            console.warn(`${LOG_PREFIX} ctx.stopGeneration unavailable; unlocking without aborting upstream`);
        }

        // Unconditional fallback: this is what actually clears `is_send_press` and
        // `body[data-generating]` in the host (`public/script.js:7075-7080`).
        if (typeof ctx?.activateSendButtons === 'function') {
            try {
                ctx.activateSendButtons();
            } catch (error) {
                console.warn(`${LOG_PREFIX} activateSendButtons threw`, error);
            }
        }

        notifyAbort(kind, '可手动点击「继续」接着写。');
        return true;
    }

    /**
     * Starts the visible-state stall watchdog.
     * @returns {void}
     */
    function armStallCheck() {
        clearStall();
        if (disposed || hidden) return;
        // A disabled guard must not arm anything: `onProgress()` can still be invoked by a token
        // listener that was registered before the user disabled the extension.
        if (!settings().enabled) return;
        if (!trackGenerationTransition()) return;

        const config = settings();
        // A non-positive threshold would abort a healthy stream on the next tick, so refuse to arm.
        if (!(config.stallMs > 0)) return;

        stampProgress();
        stallHandle = schedule(() => {
            stallHandle = null;
            if (disposed || hidden) return;
            if (!isGenerating(safeContext())) return;

            const silentFor = now() - lastProgressAt;
            trace(`check=stall silentMs=${Math.round(silentFor)} threshold=${config.stallMs}`);

            // A stall is defined as *no observed activity* for a full window. Both content changes
            // and token events re-base `lastProgressAt`, so neither alone can mask a real stall.
            if (hasProgressed() || silentFor < config.stallMs) {
                // Activity arrived while we were waiting; keep watching instead of aborting.
                armStallCheck();
                return;
            }
            abortGeneration('stall');
        }, config.stallMs);
    }

    /**
     * @returns {void}
     */
    function onProgress() {
        if (disposed) return;
        const config = settings();
        if (!config.enabled) return;
        // Any observed activity re-bases the current measurement window: token events count as
        // progress even when they change no visible content (e.g. a reasoning-only phase).
        lastSignature = progressSignature(safeContext());
        lastProgressAt = now();
        if (!abortedThisGeneration && !hidden && stallHandle === null) {
            armStallCheck();
        }
    }

    /**
     * @param {boolean} isHidden Whether the document is now hidden.
     * @returns {void}
     */
    function onVisibilityChange(isHidden) {
        if (disposed) return;
        const wasHidden = hidden;
        hidden = Boolean(isHidden);
        const config = settings();

        trace(`event=visibilitychange hidden=${hidden} wasHidden=${wasHidden} generating=${isGenerating(safeContext())} hiddenGraceMs=${config.hiddenGraceMs}`);

        if (!config.enabled) {
            clearAll();
            return;
        }

        if (hidden) {
            clearStall();
            if (!isGenerating(safeContext())) return;
            clearGrace();
            graceHandle = schedule(() => {
                graceHandle = null;
                if (disposed || !hidden) return;
                trace(`check=hidden_grace elapsedMs=${settings().hiddenGraceMs} generating=${isGenerating(safeContext())}`);
                abortGeneration('hidden');
            }, config.hiddenGraceMs);
            return;
        }

        // Became visible: a pending grace abort is no longer wanted.
        clearGrace();
        // A stream that survived the background trip is fine: let it finish.
        if (!isGenerating(safeContext())) return;
        armStallCheck();
    }

    /**
     * bfcache / foreground restore entry point.
     * @returns {void}
     */
    function onPageShow() {
        if (disposed) return;
        trace('event=pageshow');
        onVisibilityChange(typeof document !== 'undefined' && document?.hidden === true);
    }

    /**
     * @returns {void}
     */
    function dispose() {
        disposed = true;
        clearAll();
    }

    return { onVisibilityChange, onPageShow, onProgress, dispose };
}

/**
 * Reads (and back-fills) the extension settings from the host context.
 *
 * @returns {GenGuardSettings} Normalised settings, persisting defaults on first use (AC-6.1).
 */
export function getGenGuardSettings() {
    return readSettings(resolveContext());
}

/**
 * Reads settings from an explicit context (test seam; avoids needing a Node `SillyTavern` global).
 *
 * @param {*} ctx Host context providing `extensionSettings`.
 * @returns {GenGuardSettings} Normalised settings, back-filled into the context bucket.
 */
export function readSettings(ctx) {
    const bucket = ctx?.extensionSettings;
    if (!bucket || typeof bucket !== 'object') return normaliseSettings(undefined);

    const existing = bucket[SETTINGS_KEY];
    const normalised = normaliseSettings(existing);
    // Persist any missing/invalid fields once, without clobbering values the user already set.
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        bucket[SETTINGS_KEY] = { ...normalised };
    } else {
        let needsWrite = false;
        for (const key of Object.keys(normalised)) {
            if (existing[key] !== normalised[key]) needsWrite = true;
        }
        if (needsWrite) bucket[SETTINGS_KEY] = { ...existing, ...normalised };
    }
    return normaliseSettings(bucket[SETTINGS_KEY]);
}

/**
 * Writes a settings patch into an explicit context (test seam mirroring the panel's behaviour).
 *
 * @param {*} ctx Host context providing `extensionSettings`.
 * @param {Partial<GenGuardSettings>} patch Fields to update.
 * @returns {GenGuardSettings} The normalised settings that were stored.
 */
export function writeSettings(ctx, patch) {
    const bucket = ctx?.extensionSettings;
    if (!bucket || typeof bucket !== 'object') return normaliseSettings(patch);
    const current = readSettings(ctx);
    const next = normaliseSettings({ ...current, ...patch });
    bucket[SETTINGS_KEY] = next;
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    return next;
}

/**
 * Resolves `SillyTavern.getContext()` defensively.
 * @returns {*|null} Host context, or null when unavailable.
 */
function resolveContext() {
    try {
        const host = typeof SillyTavern !== 'undefined' ? SillyTavern : undefined;
        if (!host || typeof host.getContext !== 'function') return null;
        return host.getContext();
    } catch (error) {
        console.warn(`${LOG_PREFIX} getContext() threw`, error);
        return null;
    }
}

/** @type {ReturnType<typeof createGenerationGuard>|null} */
let controller = null;
/** @type {(() => void)|null} */
let detachListeners = null;

/**
 * Builds the production dependency set around the real host context.
 * @returns {GuardDeps} Dependencies wired to SillyTavern.
 */
function buildProductionDeps() {
    return {
        getContext: resolveContext,
        getSettings: () => getGenGuardSettings(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: handle => clearTimeout(handle),
        now: () => Date.now(),
        log: message => {
            if (!getGenGuardSettings().diagnostics) return;
            console.debug(`${LOG_PREFIX} ${message}`);
        },
        notify: (kind, message) => {
            try {
                if (typeof toastr !== 'undefined' && typeof toastr.warning === 'function') {
                    toastr.warning(message, kind === 'hidden' ? 'Generation Guard' : 'Generation Guard');
                }
            } catch (error) {
                console.warn(`${LOG_PREFIX} notify failed`, error);
            }
        },
    };
}

/**
 * Host hook: installs the guard. Idempotent (AC-3.3).
 * @returns {void}
 */
export function activate() {
    try {
        if (controller) return;

        const settingsNow = getGenGuardSettings();
        const deps = buildProductionDeps();
        controller = createGenerationGuard(deps);

        const onVisibility = () => {
            try {
                controller?.onVisibilityChange(typeof document !== 'undefined' && document?.hidden === true);
            } catch (error) {
                console.warn(`${LOG_PREFIX} visibility handler failed`, error);
            }
        };
        const onPageShow = () => {
            try {
                controller?.onPageShow();
            } catch (error) {
                console.warn(`${LOG_PREFIX} pageshow handler failed`, error);
            }
        };
        const onToken = () => {
            try {
                controller?.onProgress();
            } catch (error) {
                console.warn(`${LOG_PREFIX} progress handler failed`, error);
            }
        };

        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibility);
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('pageshow', onPageShow);
        }

        // Token events are a progress source; absence must not break the guard (AC-8.3).
        const ctx = resolveContext();
        const tokenEvent = ctx?.eventTypes?.STREAM_TOKEN_RECEIVED;
        if (ctx?.eventSource && typeof ctx.eventSource.on === 'function' && tokenEvent) {
            ctx.eventSource.on(tokenEvent, onToken);
        }

        detachListeners = () => {
            try {
                if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                    document.removeEventListener('visibilitychange', onVisibility);
                }
                if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                    window.removeEventListener('pageshow', onPageShow);
                }
                const current = resolveContext();
                const currentTokenEvent = current?.eventTypes?.STREAM_TOKEN_RECEIVED;
                if (current?.eventSource && typeof current.eventSource.removeListener === 'function' && currentTokenEvent) {
                    current.eventSource.removeListener(currentTokenEvent, onToken);
                }
            } catch (error) {
                console.warn(`${LOG_PREFIX} detach failed`, error);
            }
        };

        renderSettingsPanel(deps).catch(error => {
            reportProblem('设置面板渲染失败', error);
        });

        if (settingsNow.diagnostics) {
            console.debug(`${LOG_PREFIX} activated (hiddenGraceMs=${settingsNow.hiddenGraceMs}, stallMs=${settingsNow.stallMs})`);
        }
    } catch (error) {
        reportProblem('扩展启动失败', error);
    }
}

/**
 * Host hook: removes every listener and timer (AC-3.4).
 * @returns {void}
 */
export function onDisable() {
    try {
        controller?.dispose();
        controller = null;
        detachListeners?.();
        detachListeners = null;
    } catch (error) {
        console.warn(`${LOG_PREFIX} onDisable failed`, error);
    }
}

/**
 * Reports a problem in a way a phone user can actually notice.
 *
 * A silent `console.warn` is useless on mobile, where there is no console by default — which is
 * exactly how a broken settings panel can go unnoticed. Every degraded path therefore surfaces a
 * toast as well.
 *
 * @param {string} context Short description of what failed.
 * @param {unknown} [error] Underlying error.
 * @returns {void}
 */
function reportProblem(context, error) {
    const detail = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error ?? '');
    console.warn(`${LOG_PREFIX} ${context}`, error);
    try {
        if (typeof toastr !== 'undefined' && typeof toastr.error === 'function') {
            toastr.error(`[gen-guard] ${context}${detail ? `：${detail}` : ''}`, 'Generation Guard', { timeOut: 15000 });
        }
    } catch {
        // Reporting must never itself throw into the host's activation path.
    }
}

/**
 * Builds the settings panel markup inline.
 *
 * Used as a fallback when the `settings.html` template cannot be fetched, so the panel is not
 * hostage to template loading. `settings.html` and this markup must stay in sync; the test suite
 * asserts the five control ids exist.
 *
 * @returns {string} Panel HTML.
 */
function buildInlineSettingsHtml() {
    return `
<div id="gen_guard_container" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Generation Guard</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small>手机端浏览器退到后台时，流式读取可能永久挂起，导致整个聊天界面被锁死。
            本扩展会在后台超时后主动中止生成，并在回到前台时兜底解锁界面。</small>
            <label class="checkbox_label" for="gen_guard_enabled">
                <input id="gen_guard_enabled" type="checkbox" />
                <span>启用 Generation Guard</span>
            </label>
            <label for="gen_guard_hidden_grace">后台宽限期（毫秒）</label>
            <input id="gen_guard_hidden_grace" type="number" min="0" max="600000" step="500" class="text_pole" />
            <small>页面隐藏后等待多久才中止生成。设为 0 表示隐藏即中止。</small>
            <label for="gen_guard_stall_ms">卡死判定阈值（毫秒）</label>
            <input id="gen_guard_stall_ms" type="number" min="1000" max="600000" step="500" class="text_pole" />
            <small>回到前台后，若这么长时间内没有任何新内容，则判定为卡死并解锁。</small>
            <label class="checkbox_label" for="gen_guard_show_toast">
                <input id="gen_guard_show_toast" type="checkbox" />
                <span>显示提示</span>
            </label>
            <label class="checkbox_label" for="gen_guard_diagnostics">
                <input id="gen_guard_diagnostics" type="checkbox" />
                <span>诊断日志</span>
            </label>
            <small>本扩展不会自动重试生成。中止后请手动点击「继续」。</small>
        </div>
    </div>
</div>`;
}

/**
 * Adds a wand-menu entry so the panel can be reached on mobile without hunting through settings.
 *
 * The wand menu is the one UI reachable in a single tap on a phone, so a shortcut there is the
 * difference between "settings exist" and "settings are findable".
 *
 * @returns {void}
 */
function addWandMenuEntry() {
    try {
        if (typeof $ === 'undefined') return;
        const menu = $('#extensionsMenu');
        if (menu.length === 0 || $('#gen_guard_wand_entry').length > 0) return;

        const entry = $('<div id="gen_guard_wand_entry" class="list-group-item flex-container flexGap5 interactive_discard"></div>')
            .attr('title', '打开 Generation Guard 设置')
            .append('<div class="fa-solid fa-shield-halved extensionsMenuExtensionButton"></div>')
            .append('<span>Generation Guard</span>');

        entry.on('click', () => {
            const panel = document.getElementById('gen_guard_container');
            if (panel) {
                panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                $(panel).find('.inline-drawer-content').slideDown();
                return;
            }
            // The panel is missing: say so explicitly instead of failing silently.
            reportProblem('未找到设置面板，请重新加载页面后重试');
        });

        menu.append(entry);
    } catch (error) {
        reportProblem('菜单入口创建失败', error);
    }
}

/**
 * Renders the settings panel into the extensions drawer.
 *
 * Uses event delegation so repeated `activate()` calls cannot stack duplicate handlers
 * (`30-config-contract.md` §5).
 *
 * @param {GuardDeps} deps Dependency set (used only for the diagnostic log sink).
 * @returns {Promise<void>} Resolves once rendering completes.
 */
async function renderSettingsPanel(deps) {
    if (typeof $ === 'undefined') return;

    const ctx = resolveContext();

    /** @type {string} */
    let html;
    try {
        if (ctx && typeof ctx.renderExtensionTemplateAsync === 'function') {
            html = await ctx.renderExtensionTemplateAsync('third-party/gen-guard', 'settings');
        } else {
            html = buildInlineSettingsHtml();
        }
    } catch (error) {
        // Template loading must never block the panel: fall back to the inline markup.
        console.warn(`${LOG_PREFIX} settings template unavailable; using inline markup`, error);
        html = buildInlineSettingsHtml();
    }

    if (!html) {
        html = buildInlineSettingsHtml();
    }

    const existing = $('#gen_guard_container');
    if (existing.length === 0) {
        // Prefer the standard extensions drawer; fall back to the first settings container present.
        const target = $('#extensions_settings2').length > 0
            ? $('#extensions_settings2')
            : ($('#extensions_settings').length > 0 ? $('#extensions_settings') : $('body'));
        target.append(html);
    }

    if ($('#gen_guard_container').length === 0) {
        reportProblem('设置面板未能插入页面，可能是酒馆版本不兼容');
        return;
    }

    const settingsNow = getGenGuardSettings();
    $('#gen_guard_enabled').prop('checked', settingsNow.enabled);
    $('#gen_guard_hidden_grace').val(settingsNow.hiddenGraceMs);
    $('#gen_guard_stall_ms').val(settingsNow.stallMs);
    $('#gen_guard_show_toast').prop('checked', settingsNow.showToast);
    $('#gen_guard_diagnostics').prop('checked', settingsNow.diagnostics);

    // Delegated handlers: safe across repeated activation.
    $(document)
        .off('input.genGuard change.genGuard')
        .on('input.genGuard change.genGuard', DOM_IDS.enabled, function () {
            persist({ enabled: Boolean($(this).prop('checked')) });
        })
        .on('input.genGuard change.genGuard', DOM_IDS.hiddenGraceMs, function () {
            persist({ hiddenGraceMs: Number($(this).val()) });
        })
        .on('input.genGuard change.genGuard', DOM_IDS.stallMs, function () {
            persist({ stallMs: Number($(this).val()) });
        })
        .on('input.genGuard change.genGuard', DOM_IDS.showToast, function () {
            persist({ showToast: Boolean($(this).prop('checked')) });
        })
        .on('input.genGuard change.genGuard', DOM_IDS.diagnostics, function () {
            persist({ diagnostics: Boolean($(this).prop('checked')) });
        });

    addWandMenuEntry();

    deps?.log?.(`${LOG_PREFIX} settings panel ready`);
}

/**
 * Persists a settings patch (AC-6.4).
 * @param {Partial<GenGuardSettings>} patch Fields to update.
 * @returns {void}
 */
function persist(patch) {
    try {
        const ctx = resolveContext();
        if (!ctx?.extensionSettings) return;
        const current = getGenGuardSettings();
        const next = normaliseSettings({ ...current, ...patch });
        ctx.extensionSettings[SETTINGS_KEY] = next;

        // Disabling must take effect immediately, and re-enabling must restore the guard
        // (`30-config-contract.md` §6). Both directions keep the controller in sync with the setting.
        if (next.enabled === false) {
            controller?.dispose();
            controller = null;
        } else if (next.enabled === true && controller === null) {
            activate();
        }

        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    } catch (error) {
        console.warn(`${LOG_PREFIX} persist failed`, error);
    }
}

export default { activate, onDisable, DEFAULT_SETTINGS, normaliseSettings, isGenerating, createGenerationGuard, readSettings, writeSettings };
