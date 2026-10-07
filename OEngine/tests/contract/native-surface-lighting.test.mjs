import test from "node:test";
import assert from "node:assert/strict";
import "../webgpu-test-globals.mjs";
import {
  nativeSurfacePhysicalSunEntries,
  nativeSurfacePhysicalSunLayoutEntries
} from "../../.test-dist/shaders/native_surface_lighting.js";
import {
  nativeSurfacePublicationDescriptors,
  nativeSurfaceDescriptor
} from "../../.test-dist/shaders/native_surface.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";

test("native Surface consumes the graph compiler's base and coat Product direction validity outputs", () => {
  const graph = new AppearanceGraphBuilder();
  graph.output("normalTS", graph.constant([1, 0, 0]));
  graph.output("normalTSValidity", graph.constant(0));
  graph.output("coatNormalTS", graph.constant([0, 1, 0]));
  graph.output("coatNormalTSValidity", graph.constant(0));
  const program = lowerNativeMaterial(compileAppearanceGraph(graph.build()));
  const shader = nativeSurfaceDescriptor(program, [], {
    compact: false,
    productGeometry: false,
    unlit: false,
    reactive: false
  }).source;
  for (const output of ["normalTSValidity", "coatNormalTSValidity"]) {
    assert.ok(shader.includes(`values[${program.outputs[output][0]}u] > 0.5`));
  }
});

test("full ten-material-texture profile retains all providers through a finite native sun continuation", () => {
  const graph = new AppearanceGraphBuilder();
  graph.output("baseColor", graph.constant([0.2, 0.3, 0.4]));
  const program = lowerNativeMaterial(compileAppearanceGraph(graph.build()));
  const material = Array.from({ length: 10 }, (_, binding) => ({
    binding,
    visibility: 4,
    texture: { sampleType: "float", viewDimension: "2d-array" }
  }));
  const profile = { compact: true, productGeometry: true, unlit: false, reactive: true, physicalSun: true };
  const plan = nativeSurfacePublicationDescriptors(program, material, profile, {
    maxSampledTexturesPerShaderStage: 16
  });
  const count = (descriptor) => descriptor.groups.flat().filter((entry) => entry.texture).length;
  assert.equal(count(plan.descriptor), 16);
  assert.equal(count(plan.continuation), 14);
  assert.equal(plan.descriptor.groups[3].length, 10);
  assert.equal(plan.continuation.groups[3].length, 10);
  assert.equal(
    plan.continuation.groups[0].find((entry) => entry.binding === 7).storageTexture.access,
    "write-only"
  );
  assert.ok(plan.continuation.groups[0].some((entry) => entry.binding === 9));
  assert.equal(
    plan.continuation.groups[0].some((entry) => entry.binding === 8),
    false
  );
  assert.match(plan.continuation.source, /textureLoad\(prior_native_hdr/);
  const fused = nativeSurfacePublicationDescriptors(program, material.slice(0, 9), profile, {
    maxSampledTexturesPerShaderStage: 16
  });
  assert.equal(fused.continuation, undefined);
});

test("native physical sun binds the actual atmosphere provider without storage or private copies", () => {
  const parameters = {},
    transmittance = {},
    sampler = {};
  assert.deepEqual(nativeSurfacePhysicalSunEntries({ parameters, transmittance, sampler }), [
    { binding: 12, resource: { buffer: parameters } },
    { binding: 13, resource: transmittance },
    { binding: 14, resource: sampler }
  ]);
  const layout = nativeSurfacePhysicalSunLayoutEntries();
  assert.equal(layout[0].buffer.type, "uniform");
  assert.equal(layout[0].buffer.minBindingSize, 48);
  assert.equal(layout[1].texture.sampleType, "float");
  assert.equal(layout[2].sampler.type, "filtering");
});
