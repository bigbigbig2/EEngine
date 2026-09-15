import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../tests/webgpu-test-globals.mjs";

import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  GPU_SPARSE_SHADING_REQUIRED_LIMITS
} from "../.test-dist/gpu/GpuSparseShadingCapability.js";
import {
  createGpuSparseShadingPipelineDescriptor,
  GPU_SHADING_OUTPUT_DEPENDENCY
} from "../.test-dist/gpu/GpuSparseShadingPipelineContract.js";
import {
  GPU_SHADING_PROGRAM,
  GPU_SHADING_PROGRAM_NAMES,
  shadingProgramUsesTextures
} from "../.test-dist/gpu/GpuShadingProgramAbi.js";
import { gpuShadingProgramSpecialization } from
  "../.test-dist/gpu/GpuShadingProgramOracle.js";
import { createSparseShadingShaderVariant } from
  "../.test-dist/shaders/sparse_shading_resolve.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputArg = process.argv.indexOf("--output");
const output = path.resolve(
  root,
  outputArg >= 0 && process.argv[outputArg + 1]
    ? process.argv[outputArg + 1]
    : "benchmarks/adr-0015-receiver-source-audit.json"
);

const plan = createGpuSparseShadingCapabilityPlan({
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: GPU_SPARSE_SHADING_REQUIRED_LIMITS,
  info: { subgroupMinSize: 4, subgroupMaxSize: 128 }
});
const capability = captureGpuSparseShadingCapabilityRecord(plan, {
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: GPU_SPARSE_SHADING_REQUIRED_LIMITS,
  textureFormatFeatures: ["texture-formats-tier1"],
  formatProfile: "desktop-tier1-v1"
});

const O = GPU_SHADING_OUTPUT_DEPENDENCY;
const fixtures = [
  { name: "unlit-factor", programId: GPU_SHADING_PROGRAM.UnlitFactor, outputMask: 0 },
  { name: "pbr-factor-ibl", programId: GPU_SHADING_PROGRAM.PbrFactor, outputMask: O.EnvironmentIBL },
  { name: "pbr-orm-ibl", programId: GPU_SHADING_PROGRAM.PbrOrm, outputMask: O.EnvironmentIBL },
  {
    name: "pbr-normal-velocity",
    programId: GPU_SHADING_PROGRAM.PbrNormal,
    outputMask: O.ShadingSurfaceLite | O.Velocity
  },
  {
    name: "pbr-generic-wide",
    programId: GPU_SHADING_PROGRAM.PbrGeneric,
    outputMask: O.ShadingSurfaceLite | O.DiffuseSurfaceLite | O.Velocity | O.EnvironmentIBL
  }
];

const entries = fixtures.flatMap((fixture) => ["direct-single-bin", "sparse-microtile"].map(
  (executionMode) => inspectFixture(fixture, executionMode)
));

const report = {
  schemaVersion: 1,
  generatedBy: "tools/audit-adr-0015-receiver.mjs",
  method: {
    source: "production createSparseShadingShaderVariant output",
    bindingCheck: "WGSL @group/@binding pairs must equal the concrete descriptor",
    readCheck: "material.payload field and slot-specific texture access scan",
    limitation: "GPU timing and final visual comparison are deferred to the post-stage manual acceptance"
  },
  capabilityFingerprint: capability.fingerprint,
  entryCount: entries.length,
  entries,
  decision: {
    slotSpecificMaterialAccess: "retain",
    rationale:
      "Fixed material programs now emit only their used UV transform and sampler accessor; PbrOrm emits slot 2 only.",
    textureBankReadSet: "retain-existing-publication-mask",
    samplerBindingMask: "defer-without-a-published-sampler-class-signature",
    largeTriangleSetupCache: "keep-disabled",
    setupRationale:
      "Source and binding evidence alone do not prove triangle setup is the dominant GPU cost; no extra producer, buffer, dispatch, or fallback is enabled.",
    performanceClaim: "none-until-final-manual-acceptance"
  }
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${path.relative(root, output)} (${entries.length} receiver variants)\n`);

function inspectFixture(fixture, executionMode) {
  const descriptor = createGpuSparseShadingPipelineDescriptor({
    programId: fixture.programId,
    textureBindingSetId: shadingProgramUsesTextures(fixture.programId) ? 1 : 0,
    outputDependencyMask: fixture.outputMask,
    shadowSamplingEnabled: fixture.programId >= GPU_SHADING_PROGRAM.PbrFactor,
    executionMode,
    textureBankMask: 1,
    capability
  });
  const source = createSparseShadingShaderVariant(descriptor).source;
  const bindingPairs = uniqueMatches(source, /@group\((\d+)\)\s+@binding\((\d+)\)/gu,
    (match) => `${match[1]}:${match[2]}`);
  const expectedBindingPairs = descriptor.groups.flatMap((group) =>
    group.bindings.map((binding) => `${binding.group}:${binding.binding}`));
  assert.deepEqual(bindingPairs, [...new Set(expectedBindingPairs)].sort());

  const materialPayloadFields = uniqueMatches(
    source,
    /material\.payload\.([a-zA-Z0-9_]+)/gu,
    (match) => match[1]
  );
  const textureSlots = uniqueMatches(
    source,
    /fn sparse_transform_uv_(\d)\(/gu,
    (match) => Number(match[1])
  );
  const routeSlots = uniqueMatches(
    source,
    /sparse_texture_route_valid\(material_slot,\s*(\d)u/gu,
    (match) => Number(match[1])
  );
  const specialization = gpuShadingProgramSpecialization(
    fixture.programId,
    fixture.outputMask
  );
  if (fixture.programId === GPU_SHADING_PROGRAM.PbrOrm) {
    assert.deepEqual(textureSlots, [2]);
    assert.deepEqual(routeSlots, [2]);
    for (const forbidden of [
      "uv_offset_scale", "uv_rotation",
      "normal_uv_offset_scale", "normal_uv_rotation",
      "emissive_uv_offset_scale", "emissive_uv_rotation"
    ]) assert.equal(materialPayloadFields.includes(forbidden), false, forbidden);
    assert.equal(source.includes("material.payload.flags&"), false);
  }
  if (!specialization.publishesVelocity) {
    assert.equal(source.includes("shading_view.previous_view_projection*"), false);
    assert.equal(source.includes("oengine_instance_previous_from_current(instance)"), false);
  }

  return {
    name: fixture.name,
    programId: fixture.programId,
    programName: GPU_SHADING_PROGRAM_NAMES[fixture.programId],
    executionMode,
    outputDependencyMask: fixture.outputMask,
    sourceBytes: Buffer.byteLength(source),
    specialization,
    bindingPairs,
    bindingNames: descriptor.groups.flatMap((group) => group.bindings.map((binding) => binding.name)),
    materialPayloadFields,
    textureSlots,
    routeSlots,
    readsPreviousTransform: source.includes("shading_view.previous_view_projection*"),
    usesMaterialConditionalTextureFlags: source.includes("material.payload.flags&")
  };
}

function uniqueMatches(source, pattern, transform) {
  return [...new Set([...source.matchAll(pattern)].map(transform))].sort((left, right) =>
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right))
  );
}
