import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'sources.json'), 'utf8'));
const failures = [];

function fail(message) { failures.push(message); }
function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

if (manifest.repository !== 'https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK') fail('repository drift');
if (manifest.revision !== 'c6efa6bf7f2027b3ec94f28578bb5965eabb9e55') fail('pinned commit drift');
if (manifest.version !== 'AMD FidelityFX SDK 1.1.4') fail('SDK version drift');
if (manifest.status !== 'source-fixed-port-incomplete') fail('source status must remain source-fixed-port-incomplete');
if (manifest.hostDispatch.frameGeneration !== false) fail('frame generation must be excluded');
if (manifest.hostDispatch.independentSubmit !== false) fail('independent submit is forbidden');

for (const file of manifest.files) {
  const filePath = path.join(root, file.path);
  try {
    const bytes = await fs.readFile(filePath);
    const actual = sha256(bytes);
    if (actual !== file.sha256) fail(`digest mismatch: ${file.path}`);
  } catch {
    fail(`missing vendored source: ${file.path}`);
  }
}

const names = manifest.files.map(file => file.path.replaceAll('\\', '/'));
const expectedStages = [
  'prepare_inputs_pass', 'prepare_reactivity_pass', 'luma_pyramid_pass',
  'shading_change_pass', 'shading_change_pyramid_pass', 'accumulate_pass',
  'luma_instability_pass', 'rcas_pass',
];
for (const stage of expectedStages) {
  if (!names.some(name => name.includes(`/fsr3upscaler/ffx_fsr3upscaler_${stage}.hlsl`))) fail(`missing HLSL stage: ${stage}`);
  if (!names.some(name => name.includes(`/fsr3upscaler/ffx_fsr3upscaler_${stage}.glsl`))) fail(`missing GLSL stage: ${stage}`);
}
for (const name of names) {
  if (/\/fsr2(?:\/|_)/i.test(name) || /frameinterpolation/i.test(name) || /ffx_fsr3(?:\.h|\/)/i.test(name)) {
    fail(`forbidden FSR2/frame-generation source selected: ${name}`);
  }
}
if (manifest.stages.length !== 10) fail('stage mapping must contain all ten FSR3 upscaler stages');
if (!manifest.constants.fields.includes('deviceToViewDepth[4]')) fail('constant layout is incomplete');
if (manifest.resourceTable.length !== 49) fail(`resource table is incomplete: ${manifest.resourceTable.length}`);
if (manifest.resourceTable.find(entry => entry.name === 'COUNT')?.id !== 60) fail('resource identifier count drift');
if (manifest.constantBufferTable.length !== 4) fail('constant buffer identifier table is incomplete');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`FSR3 source validation passed (${manifest.files.length} files, ${manifest.stages.length} mapped stages)`);
