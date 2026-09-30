# Generation Guard

**Fixes the mobile bug where SillyTavern locks up after the browser is backgrounded during streaming.**

[![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-7c3aed)](https://github.com/SillyTavern/SillyTavern)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)](LICENSE)

[中文](README.md)

---

## The problem

On mobile, backgrounding the browser (lock screen, app switch, screen off) while a stream is
running leaves the UI **permanently frozen** on return:

- Cannot send, regenerate, continue, or impersonate
- Cannot start a new chat or open chat history
- A page reload is the only way out

Termux simultaneously prints a pair of lines:

```
Streaming request in progress
Streaming request finished
```

## Root cause

Once the page is hidden, the client-side stream read can hang forever:

| Step | Where |
| --- | --- |
| Stream read has no timeout | `await reader.read()` — `public/scripts/openai.js:3170` |
| `Generate()` only unwinds via promise settlement | `.then(onSuccess, onError)` — `public/script.js:5453` |
| If that promise never settles, neither handler runs | `public/script.js:5396`, `3875` |
| So `is_send_press` stays `true` forever | set at `public/script.js:4986`, reset only at `5699` |
| `is_send_press === true` gates nearly every action | `public/script.js:1739`, `11598-11659` |

The client contains **no** `visibilitychange` / `pagehide` handling, so nothing detects or recovers.

## What this extension does

It cuts that path **without modifying a single line of SillyTavern**:

1. **Grace abort on hide** — after the page is hidden, wait `hiddenGraceMs` (default 3000ms); if the
   generation has not finished, call `stopGeneration()`. The pending read fails immediately and the
   host's normal unlock path runs.
2. **Stall fallback on return** — if a generation is still marked running and has produced nothing
   (no content change, no token event) for `stallMs` (default 5000ms), abort again and force the UI
   unlocked.
3. **Notify only, never retry** — so no API quota is spent behind your back.

> Generation state is read from `streamingProcessor.isFinished`, because SillyTavern does **not**
> expose `isGenerating()` to extensions (`public/scripts/st-context.js`).

## Install

### Option 1 — manual (no git, no network required)

1. Download this repository (`Code` → `Download ZIP`) and take `index.js`, `manifest.json`,
   `settings.html` from it
2. Place them in `SillyTavern/public/scripts/extensions/third-party/gen-guard/`
3. **Reload the SillyTavern page** — the extension list is scanned on page load
4. Open the **Extensions** panel → enable **Generation Guard**

The resulting layout must be exactly:

```
SillyTavern/public/scripts/extensions/third-party/gen-guard/
├── manifest.json
├── index.js
└── settings.html
```

⚠️ The extra `gen-guard` folder is required. Dropping the three files directly into `third-party/`
will **not** work: SillyTavern discovers third-party extensions as "subfolder containing a
manifest.json".

### Option 2 — one-liner (Termux / Linux)

```bash
git clone https://github.com/<you>/sillytavern-gen-guard /tmp/gen-guard
mkdir -p ~/SillyTavern/public/scripts/extensions/third-party/gen-guard
cp /tmp/gen-guard/{manifest.json,index.js,settings.html} \
   ~/SillyTavern/public/scripts/extensions/third-party/gen-guard/
```

### Option 3 — via SillyTavern's "Install extension"

Use the repository's Git URL in **Extensions → Install extension**, then reload and enable it.
`index.js`, `manifest.json` and `settings.html` sit at the repository root so SillyTavern can pull
them directly.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| Enable Generation Guard | on | Master switch; disabling clears every timer immediately |
| Background grace period (ms) | `3000` | How long to wait after hiding before aborting. **0 = abort as soon as hidden** |
| Stall threshold (ms) | `5000` | How long with no new content before declaring a stall on return (min 1000) |
| Show notifications | on | Toast on abort/unlock |
| Diagnostic logging | on | `[gen-guard]` lines in the browser console |

### Tuning

- **Still freezing** → lower the grace period (e.g. `1000`) or set it to `0`
- **Healthy generations being interrupted** → raise the grace period (e.g. `10000`) or the stall threshold
- **Debugging** → keep diagnostics on and watch for:

```
[gen-guard] event=visibilitychange hidden=true wasHidden=false generating=true hiddenGraceMs=3000
[gen-guard] action=abort reason=hidden_grace_elapsed kind=hidden
```

## Companion setup (Termux / Android)

The extension only fixes client state. If the Termux process itself is frozen, the server still
stalls. Recommended alongside it:

- `termux-wake-lock`
- Disable battery optimisation for Termux; allow background execution
- Avoid locking the screen mid-generation

## Known limits

- Does **not** fix the server-side roots: `src/util.js` stream forwarding lacks a write timeout and
  heartbeat, and has a "listener attached after the stream ended" race. A complete fix requires
  patching SillyTavern itself.
- **Never retries automatically** — tap Continue after an abort.
- No multi-tab coordination: with two tabs generating at once, the background tab's abort will kill
  the foreground tab's generation.

## Development

Zero dependencies, no build step, plain ES module. The test suite injects the timer and
`SillyTavern.getContext()`, so the entire timing logic is verified deterministically under plain
Node — no browser needed.

```bash
node tests/run.mjs
```

Covers 30 logic cases (grace boundaries, stall fallback, idempotence, races, notifications,
one-tap continue, diagnostics, degradation) and 11 static-contract cases (manifest fields, panel
controls, no network access, no static imports, duplicate-copy parity, ESM marker, zero
dependencies, inline-fallback parity, failure visibility) — 41 in total.

> `extension/package.json` only declares `{"type": "module"}` so Node 18 parses `index.js` as an ES
> module. Node 22+ sniffs module syntax and therefore hides this problem, which is why the CI
> matrix tests both. The **repository root deliberately has no `package.json`** so that
> SillyTavern's "Install extension" flow copies only the extension files.

## License

[AGPL-3.0-or-later](LICENSE), matching the [SillyTavern](https://github.com/SillyTavern/SillyTavern)
main project.
