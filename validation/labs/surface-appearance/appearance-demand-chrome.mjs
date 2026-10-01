import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const root = resolve('.'), out = resolve('.local/validation/surface-appearance/appearance-demand-chrome.json');
await mkdir(resolve(out, '..'), { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><script type="importmap">{"imports":{"gl-matrix":"/OEngine/node_modules/gl-matrix/esm/index.js"}}</script><title>Appearance demand GPU diagnostic</title>'); return;
    }
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep) || !/\.(js|mjs)$/.test(pathname)) throw new Error('Unsupported resource');
    response.setHeader('Content-Type', 'application/javascript'); response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const report = { evidenceRole: 'diagnostic', accepted: false, headless: false, passed: false };
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false,
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--no-sandbox', '--unsafely-disable-devtools-self-xss-warnings'] });
  report.browser = browser.version(); const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  Object.assign(report, await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware adapter required');
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 16 } });
    const errors = []; let disposing = false, lost = null;
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    void device.lost.then(info => { if (!disposing) lost = { reason: info.reason, message: info.message }; });
    try {
      const { runAppearanceDemandFixture } = await import('/validation/labs/surface-appearance/appearance-demand-fixture.mjs');
      const result = await runAppearanceDemandFixture(device);
      if (errors.length || lost) throw new Error(JSON.stringify({ errors, lost }));
      return { ...result, apiErrors: errors, deviceLost: lost, adapter: { vendor: adapter.info.vendor,
        architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } };
    } finally { disposing = true; device.destroy(); }
  }));
} catch (error) { report.passed = false; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally { await writeFile(out, JSON.stringify(report, null, 2)); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(report, null, 2));
