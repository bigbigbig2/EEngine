import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const upstream = path.join(root, 'upstream');
const output = path.join(root, 'sources.json');

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filePath));
    else files.push(filePath);
  }
  return files;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const stageFiles = {
  prepareInputs: 'ffx_fsr3upscaler_prepare_inputs_pass',
  prepareReactivity: 'ffx_fsr3upscaler_prepare_reactivity_pass',
  lumaPyramid: 'ffx_fsr3upscaler_luma_pyramid_pass',
  shadingChange: 'ffx_fsr3upscaler_shading_change_pass',
  shadingChangePyramid: 'ffx_fsr3upscaler_shading_change_pyramid_pass',
  reproject: 'ffx_fsr3upscaler_accumulate_pass',
  accumulate: 'ffx_fsr3upscaler_accumulate_pass',
  upsample: 'ffx_fsr3upscaler_accumulate_pass',
  lumaInstability: 'ffx_fsr3upscaler_luma_instability_pass',
  rcas: 'ffx_fsr3upscaler_rcas_pass',
};

const files = [];
for (const filePath of await walk(upstream)) {
  const bytes = await fs.readFile(filePath);
  const relative = path.relative(root, filePath).replaceAll(path.sep, '/');
  const upstreamPath = relative.replace(/^upstream\//, '');
  files.push({ path: relative, upstreamPath, sha256: sha256(bytes) });
}

const resourceHeader = await fs.readFile(
  path.join(upstream, 'sdk/include/FidelityFX/gpu/fsr3upscaler/ffx_fsr3upscaler_resources.h'),
  'utf8',
);
const resourceTable = [...resourceHeader.matchAll(/^#define\s+FFX_FSR3UPSCALER_RESOURCE_IDENTIFIER_([A-Z0-9_]+)\s+([0-9]+)/gm)]
  .map(match => ({ name: match[1], id: Number(match[2]) }));
const constantBufferTable = [...resourceHeader.matchAll(/^#define\s+FFX_FSR3UPSCALER_CONSTANTBUFFER_IDENTIFIER_([A-Z0-9_]+)\s+([0-9]+)/gm)]
  .map(match => ({ name: match[1], id: Number(match[2]) }));

const manifest = {
  schemaVersion: 1,
  status: 'source-fixed-port-incomplete',
  repository: 'https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK',
  revision: 'c6efa6bf7f2027b3ec94f28578bb5965eabb9e55',
  version: 'AMD FidelityFX SDK 1.1.4',
  profile: 'FSR3 Upscaler only; Frame Generation is excluded',
  sourceSubset: {
    host: 'sdk/src/components/fsr3upscaler/ffx_fsr3upscaler.cpp',
    gpuHeaders: 'sdk/include/FidelityFX/gpu/fsr3upscaler',
    hlslEntries: 'sdk/src/backends/dx12/shaders/fsr3upscaler',
    glslEntries: 'sdk/src/backends/vk/shaders/fsr3upscaler',
    compileRecipe: 'sdk/include/FidelityFX/gpu/fsr3upscaler/CMakeCompileFSR3UpscalerShaders.txt',
  },
  licenses: [
    'upstream/LICENSE.txt',
    'upstream/docs/license.md',
    'upstream/sdk/LICENSE.txt',
  ],
  stages: [
    { id: 'prepare-inputs', sourceFunction: 'PrepareInputs', entryStem: stageFiles.prepareInputs, hostPass: 'FFX_FSR3UPSCALER_PASS_PREPARE_INPUTS' },
    { id: 'prepare-reactivity', sourceFunction: 'PrepareReactivity', entryStem: stageFiles.prepareReactivity, hostPass: 'FFX_FSR3UPSCALER_PASS_PREPARE_REACTIVITY' },
    { id: 'luma-pyramid', sourceFunction: 'ComputeAutoExposure plus SPD luminance reduction', entryStem: stageFiles.lumaPyramid, hostPass: 'FFX_FSR3UPSCALER_PASS_LUMA_PYRAMID' },
    { id: 'shading-change', sourceFunction: 'ShadingChange', entryStem: stageFiles.shadingChange, hostPass: 'FFX_FSR3UPSCALER_PASS_SHADING_CHANGE' },
    { id: 'shading-change-pyramid', sourceFunction: 'ComputeShadingChangePyramid', entryStem: stageFiles.shadingChangePyramid, hostPass: 'FFX_FSR3UPSCALER_PASS_SHADING_CHANGE_PYRAMID' },
    { id: 'reproject', sourceFunction: 'ComputeReprojectedUVs/ReprojectHistoryColor', entryStem: stageFiles.reproject, hostPass: 'internal to accumulate' },
    { id: 'accumulate', sourceFunction: 'Accumulate', entryStem: stageFiles.accumulate, hostPass: 'FFX_FSR3UPSCALER_PASS_ACCUMULATE or _ACCUMULATE_SHARPEN' },
    { id: 'upsample', sourceFunction: 'ComputeUpsampledColorAndWeight', entryStem: stageFiles.upsample, hostPass: 'internal to accumulate' },
    { id: 'luma-instability', sourceFunction: 'LumaInstability', entryStem: stageFiles.lumaInstability, hostPass: 'FFX_FSR3UPSCALER_PASS_LUMA_INSTABILITY' },
    { id: 'rcas', sourceFunction: 'RCAS', entryStem: stageFiles.rcas, hostPass: 'FFX_FSR3UPSCALER_PASS_RCAS (optional sharpening)' },
  ],
  hostDispatch: {
    source: 'sdk/src/components/fsr3upscaler/ffx_fsr3upscaler.cpp',
    mainOrder: [
      'PREPARE_INPUTS',
      'LUMA_PYRAMID',
      'SHADING_CHANGE_PYRAMID',
      'SHADING_CHANGE',
      'PREPARE_REACTIVITY',
      'LUMA_INSTABILITY',
      'ACCUMULATE or ACCUMULATE_SHARPEN',
      'RCAS when sharpening is enabled',
    ],
    separateDispatch: 'GENERATE_REACTIVE is exposed by ffxFsr3UpscalerContextGenerateReactiveDescription',
    frameGeneration: false,
    independentSubmit: false,
  },
  constants: {
    source: 'sdk/src/components/fsr3upscaler/ffx_fsr3upscaler_private.h',
    struct: 'Fsr3UpscalerConstants',
    fields: [
      'renderSize[2]', 'previousFrameRenderSize[2]', 'upscaleSize[2]', 'previousFrameUpscaleSize[2]',
      'maxRenderSize[2]', 'maxUpscaleSize[2]', 'deviceToViewDepth[4]', 'jitterOffset[2]',
      'previousFrameJitterOffset[2]', 'motionVectorScale[2]', 'downscaleFactor[2]',
      'motionVectorJitterCancellation[2]', 'tanHalfFOV', 'jitterPhaseCount', 'deltaTime',
      'deltaPreExposure', 'viewSpaceToMetersFactor', 'frameIndex', 'velocityFactor',
      'reactivenessScale', 'shadingChangeScale', 'accumulationAddedPerFrame', 'minDisocclusionAccumulation',
    ],
  },
  resourceTable,
  constantBufferTable,
  files,
};

await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
