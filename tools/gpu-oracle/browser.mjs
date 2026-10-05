// Chrome launch + playwright-core attachment for the GPU oracle harness.
//
// Two transports, because the canonical one is not always available:
//
//   "launch"  chromium.launch() — the canonical path, identical to
//             validation/src/runner/run-case.mjs. Uses playwright-core's pipe
//             transport (`--remote-debugging-pipe`) and an isolated new context.
//
//   "cdp"     spawn Chrome directly with `stdio: "ignore"`, let it open
//             `--remote-debugging-port=0`, read the DevToolsActivePort file and
//             attach with chromium.connectOverCDP(). Needed where piped child
//             stdio is forbidden: playwright-core's launch() then fails with
//             `spawn EPERM` before Chrome starts, and launch() offers no option
//             to switch transports. Chrome's stdout/stderr go to a log file so
//             GPU-process diagnostics survive, and Chrome's default context is
//             reused (a CDP-attached browser cannot create a second one).
//
// `auto` tries "launch" first and falls back to "cdp".
//
// Chrome switches for the "cdp" path are curated from playwright-core's own
// chromiumSwitches(): connecting over CDP does not get them for free, and
// without --disable-component-extensions-with-background-pages Chrome's
// component extensions attach unresponsive targets that make the attach time
// out. --no-sandbox is required for the same reason playwright-core passes it:
// without it Chrome's crashpad handler launch fails on hosts that restrict
// process access.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const PROFILE_PREFIX = "gpu-oracle-profile-";

const CDP_SWITCHES = [
  "--disable-field-trial-config",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,OptimizationHints",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-sync",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-first-run",
  "--no-default-browser-check",
  "--no-service-autorun",
  "--password-store=basic",
  "--use-mock-keychain",
  "--no-sandbox",
];

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * Known environment failures, so a blocked host produces an actionable message
 * instead of a bare timeout.
 */
const ENVIRONMENT_SIGNATURES = Object.freeze([
  {
    pattern: /platform_channel\.cc:\d+\] Check failed/i,
    hint: "Chrome could not create its Mojo IPC channel (CreateNamedPipeW denied). Chrome needs a token that can create pipes with a DACL; a Low-integrity or deny-only-SID token cannot start Chrome's multi-process IPC, so no renderer or GPU process exists and WebGPU is unavailable.",
  },
  {
    pattern: /crash server failed to launch|crashpad_client_win.*OpenProcess/i,
    hint: "Chrome's crashpad handler could not be started (OpenProcess denied). Restricting process access breaks Chrome startup.",
  },
  {
    pattern: /Failed to grant sandbox access/i,
    hint: "Chrome could not modify the ACL of its own profile directories (SetNamedSecurityInfo denied).",
  },
]);

export function explainChromeLog(log) {
  if (!log) return null;
  return ENVIRONMENT_SIGNATURES.filter(({ pattern }) => pattern.test(log)).map(({ hint }) => hint);
}

function logTail(path, limit = 4000) {
  try {
    return readFileSync(path, "utf8").slice(-limit);
  } catch {
    return "";
  }
}

function decorate(error, log, transport) {
  const wrapped = new Error(`${transport}: ${error.message}`);
  wrapped.chromeProcessLog = log || null;
  return wrapped;
}

/** Canonical path: playwright-core launches and owns the browser process. */
async function launchWithPlaywright({ chromium, executablePath, headless, extraArgs }) {
  const browser = await chromium.launch({ executablePath, headless, args: [...extraArgs] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  let closed = false;
  return {
    transport: "launch",
    contextMode: "isolated-new-context",
    browser,
    context,
    page,
    chromeVersion: browser.version(),
    chromeArgs: null,
    chromeLogPath: null,
    readChromeLog: () => "",
    onProcessExit: (handler) => browser.once("disconnected", handler),
    async close() {
      if (closed) return;
      closed = true;
      try {
        await browser.close();
      } catch {}
    },
  };
}

/** Pipe-free path: spawn Chrome ourselves (stdio ignored) and attach over CDP. */
async function launchWithCdpAttach({
  chromium,
  executablePath,
  headless,
  extraArgs,
  startupTimeoutMs,
  connectTimeoutMs,
}) {
  const profileDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  const chromeLogPath = join(profileDir, "chrome-process.log");
  const logFd = openSync(chromeLogPath, "a");
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    ...CDP_SWITCHES,
    ...extraArgs,
    ...(headless ? ["--headless", "--hide-scrollbars", "--mute-audio"] : []),
    "about:blank",
  ];
  const child = spawn(executablePath, args, {
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    detached: false,
  });
  const exited = new Promise((resolvePromise) =>
    child.once("exit", (code, signal) => resolvePromise({ code, signal })),
  );
  let exitState = null;
  let spawnError = null;
  exited.then((state) => {
    exitState = state;
  });
  child.once("error", (error) => {
    spawnError = error;
  });

  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + startupTimeoutMs;
  let endpoint = null;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      // Chrome holds the file briefly while writing it; EBUSY/EPERM here is
      // transient and must not abort the launch.
      try {
        const [port, wsPath] = readFileSync(portFile, "utf8").split("\n");
        if (port?.trim() && wsPath?.trim()) {
          endpoint = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
          break;
        }
      } catch {}
    }
    if (exitState !== null || spawnError !== null) break;
    await sleep(150);
  }
  if (endpoint === null) {
    const log = logTail(chromeLogPath);
    await Promise.race([exited, sleep(2000)]);
    await killChrome(child, exited, logFd, profileDir);
    throw decorate(
      new Error(
        `Chrome exposed no DevTools endpoint within ${startupTimeoutMs} ms (exit ${exitState === null ? "still running" : JSON.stringify(exitState)}, spawn error ${spawnError?.message ?? "none"})`,
      ),
      log,
      "cdp",
    );
  }
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: connectTimeoutMs });
  } catch (error) {
    const log = logTail(chromeLogPath);
    await killChrome(child, exited, logFd, profileDir);
    throw decorate(
      new Error(`connectOverCDP(${endpoint}) failed: ${error.message.split("\n")[0]}`),
      log,
      "cdp",
    );
  }
  // Chrome was launched with about:blank, so its default context and page exist.
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  let closed = false;
  return {
    transport: "cdp",
    contextMode: "chrome-default-context",
    browser,
    context,
    page,
    endpoint,
    chromeVersion: browser.version(),
    chromeArgs: args,
    chromeLogPath,
    processId: child.pid,
    readChromeLog: () => logTail(chromeLogPath),
    processExited: () => exitState !== null,
    onProcessExit: (handler) => child.once("exit", handler),
    async close() {
      if (closed) return;
      closed = true;
      await killChrome(child, exited, logFd, profileDir);
      try {
        await browser.close();
      } catch {}
    },
  };
}

/**
 * @param {{chromium: any, executablePath: string, headless: boolean, transport?: "auto"|"launch"|"cdp", extraArgs?: readonly string[], startupTimeoutMs?: number, connectTimeoutMs?: number, onAttempt?: (attempt: {transport: string, ok: boolean, message?: string}) => void}} options
 */
export async function launchChrome({
  chromium,
  executablePath,
  headless,
  transport = "auto",
  extraArgs = [],
  startupTimeoutMs = 30_000,
  connectTimeoutMs = 20_000,
  onAttempt,
}) {
  const order = transport === "auto" ? ["launch", "cdp"] : [transport];
  const attempts = [];
  let lastError = null;
  for (const mode of order) {
    try {
      const launched =
        mode === "launch"
          ? await launchWithPlaywright({ chromium, executablePath, headless, extraArgs })
          : await launchWithCdpAttach({
              chromium,
              executablePath,
              headless,
              extraArgs,
              startupTimeoutMs,
              connectTimeoutMs,
            });
      launched.launchAttempts = attempts;
      onAttempt?.({ transport: mode, ok: true });
      return launched;
    } catch (error) {
      lastError = error;
      attempts.push({
        transport: mode,
        ok: false,
        message: error.message,
        chromeProcessLog: error.chromeProcessLog ?? null,
      });
      onAttempt?.({
        transport: mode,
        ok: false,
        message: error.message,
        chromeProcessLog: error.chromeProcessLog ?? null,
      });
    }
  }
  const failure = new Error(lastError?.message ?? "no transport available");
  failure.attempts = attempts;
  failure.chromeProcessLog = lastError?.chromeProcessLog ?? null;
  throw failure;
}

async function killChrome(child, exited, logFd, profileDir) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([exited, sleep(1500)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    // Chrome's helper processes hold the profile directory; take the tree down.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await Promise.race([exited, sleep(1500)]);
  }
  try {
    closeSync(logFd);
  } catch {}
  // Only ever remove the throwaway profile this module created in the OS temp dir.
  const resolvedProfile = resolve(profileDir);
  if (resolvedProfile.startsWith(resolve(tmpdir())) && basename(resolvedProfile).startsWith(PROFILE_PREFIX)) {
    try {
      rmSync(resolvedProfile, { recursive: true, force: true });
    } catch {}
  }
}
