# Tier 2 GPU oracle harness (`tools/gpu-oracle.mjs`)

Runs the repository's real-GPU oracles against a real `GPUAdapter`/`GPUDevice` in
Chrome stable. Exists because every `node --test` suite in this repository drives
a fake WebGPU device, and the three oracles under `OEngine/tests/oracle/` cannot
run under `node --test` at all — nothing there can supply a `GPUDevice`.

```bash
node tools/gpu-oracle.mjs environment-probe        # smoke: is a real GPU reachable?
node tools/gpu-oracle.mjs hzb-conservative        # strongest numeric oracle
node tools/gpu-oracle.mjs hzb-conservative --json  # machine-readable report
node tools/gpu-oracle.mjs --list                   # registered oracles
node tools/gpu-oracle.mjs --help
```

Exit codes: `0` oracle passed, `1` oracle failed or the run could not complete,
`2` CLI usage error (unknown flag or oracle name).

## What one run does

1. Starts a loopback static server (`node:http`, ephemeral port, 127.0.0.1) that
   serves only `OEngine/tests/`, `OEngine/.test-dist/` and the harness's own
   `/__gpu-oracle/` namespace. The oracles are served **unmodified**; the
   compiled JavaScript they import from `OEngine/.test-dist` already uses
   explicit `.js` extensions, so no bundler or transform is needed.
2. Launches Chrome stable through `playwright-core` (isolated throwaway profile,
   never the user's profile).
3. Loads `page/host.html`, whose import map maps the oracles' `node:assert/strict`
   import onto `page/assert-strict.mjs` (a browser shim with the strict semantics
   the oracles rely on; unimplemented methods throw instead of passing silently).
4. `page/host.mjs` obtains a real adapter/device, runs the registered export with
   that device inside `validation`/`out-of-memory`/`internal` error scopes, and
   publishes a JSON report on `window.__GPU_ORACLE__`.
5. The CLI prints oracle name, pass/fail, the oracle's own returned summary,
   elapsed ms, assertion text, browser console output, and Chrome's process log.
   A captured GPU error fails an otherwise-passing oracle; a fake device would
   hide exactly that.
6. Chrome and the server are closed on every path, including failures.

## Adding an oracle

One line in `registry.mjs`:

```js
{ name: "my-oracle", file: "OEngine/tests/oracle/my-oracle.mjs",
  url: "/OEngine/tests/oracle/my-oracle.mjs", entry: "runMyOracle" }
```

`entry` is called as `entry(device)`. No CLI, host-page or server change is
needed. Harness-side fixtures live under `self-test/` and are served from
`/__gpu-oracle/`.

## Transports

`--transport auto` (default) tries `launch`, then `cdp`:

- `launch` — canonical `chromium.launch()`, identical to the ADR-0014 validation
  host. Uses playwright-core's pipe transport and an isolated new context.
- `cdp` — spawns Chrome with `stdio: "ignore"` and attaches with
  `connectOverCDP()`. Needed where piped child stdio is forbidden, because
  playwright-core's `launch()` always adds `--remote-debugging-pipe` and offers
  no way to switch transports. Chrome's stdout/stderr are captured to a log file
  so GPU-process diagnostics survive; the CDP path reuses Chrome's default
  context, which a CDP-attached browser cannot duplicate.

Both transports pass `--no-sandbox` (playwright-core does the same by default):
without it Chrome's crashpad handler fails to start on hosts that restrict
process access.

## Known environment blocker

Chrome cannot start its IPC in a Windows _Low Mandatory Level_ / deny-only-SID
token (the DSH Windows sandbox is such a token). Chrome's own log shows

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : 拒绝访问。 (0x5)
ERROR:crashpad_client_win.cc:421] OpenProcess: 拒绝访问。 (0x5)
ERROR:network_sandbox.cc:518] Failed to grant sandbox access to ... : 拒绝访问。 (0x5)
```

`CreateNamedPipeW` for the Mojo channel is denied, so no renderer or GPU process
is created and WebGPU is unavailable. The harness reports this as
`failureKind: "environment-blocked"` with the offending log lines and a plain
explanation; run it from a normal (unsandboxed) terminal instead. Verified
identically on Chrome stable 154, Playwright Chromium 143 and
chrome-headless-shell 143 — it is the token, not the browser build.

## Self-check without Chrome

`node tools/gpu-oracle/self-test/host-contract-check.mjs` verifies the assert
shim differentially against `node:assert/strict`, the static server's
serving/allowed-path contract, and the host page's pass/fail/no-GPU/no-adapter/
GPU-error reporting contract (with a stub device — plumbing only, not GPU
evidence). It is not named `*.test.mjs` so repo-wide `node --test` discovery
never picks it up.
