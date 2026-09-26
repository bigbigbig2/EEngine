import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

// returnOnExit avoids the upstream CLI's forced process.exit during Windows WASI teardown.
const wasi = new WASI({ version: 'preview1',
  args: ['naga', relative(process.cwd(), process.argv[2]).replaceAll('\\', '/')],
  preopens: { '.': process.cwd() }, returnOnExit: true });
const module = await WebAssembly.compile(await readFile(new URL('./node_modules/naga-wasi-cli/wasi/naga.wasm', import.meta.url)));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
process.exitCode = wasi.start(instance);
