import { access } from "node:fs/promises";
import path from "node:path";

const CHROME_ARGS = Object.freeze(["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]);

export async function chromeLaunchCandidates({ allowChromiumFallback = false } = {}) {
  const candidates = [];
  const configured = process.env.OENGINE_CHROME_PATH;
  if (configured !== undefined && configured.trim() !== "") {
    if (!await fileExists(configured)) {
      throw new Error(`OENGINE_CHROME_PATH does not exist: ${configured}`);
    }
    candidates.push(executableCandidate("OENGINE_CHROME_PATH", path.resolve(configured)));
  }

  candidates.push(Object.freeze({
    id: "chrome-channel",
    label: "Playwright channel: chrome",
    realChrome: true,
    launchOptions: Object.freeze({ channel: "chrome", args: CHROME_ARGS })
  }));

  for (const executablePath of knownChromePaths()) {
    if (await fileExists(executablePath) &&
        !candidates.some((entry) => entry.launchOptions.executablePath === executablePath)) {
      candidates.push(executableCandidate("known-local-chrome", executablePath));
    }
  }

  if (allowChromiumFallback) {
    candidates.push(Object.freeze({
      id: "playwright-chromium",
      label: "Playwright Chromium fallback",
      realChrome: false,
      launchOptions: Object.freeze({ args: CHROME_ARGS })
    }));
  }
  return Object.freeze(candidates);
}

function executableCandidate(id, executablePath) {
  return Object.freeze({
    id,
    label: executablePath,
    realChrome: true,
    launchOptions: Object.freeze({ executablePath, args: CHROME_ARGS })
  });
}

function knownChromePaths() {
  if (process.platform === "win32") {
    return [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

