# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-30

### Added

- **Grace abort on hide**: after the page becomes hidden, wait `hiddenGraceMs` (default 3000ms) and,
  if the generation has not finished, call `stopGeneration()` so the suspended stream read fails
  immediately and SillyTavern's normal unlock path runs.
- **Stall fallback on return**: when the page becomes visible again, abort and force-unlock if a
  generation is still marked running and has produced no content change or token event for
  `stallMs` (default 5000ms).
- **Progress sources**: content changes (`chat[last].mes`, `streamingProcessor.result`) and host
  `STREAM_TOKEN_RECEIVED` events all re-base the stall window, so a reasoning-only phase is not
  mistaken for a stall.
- **One-shot abort latch** re-armed on the `false -> true` generation transition, so the guard keeps
  working across successive generations in one session.
- **Settings panel** with five controls (enable, grace period, stall threshold, notifications,
  diagnostic logging), persisted to `extension_settings.gen_guard`.
- **Diagnostic logging** with a unified `[gen-guard]` prefix, on by default and switchable off.
- **Graceful degradation**: a missing `stopGeneration`, missing event source, or a
  `getContext()` that throws degrade to a no-op or an unlock-only path instead of breaking the host
  event loop.
- **Dependency-injected controller** so the entire timing logic is verified deterministically under
  plain Node — 31 logic cases plus 8 static-contract cases, no browser required.

### Notes

- No SillyTavern source files are modified; the extension is three self-contained files.
- It never retries a generation automatically; the user continues manually.
