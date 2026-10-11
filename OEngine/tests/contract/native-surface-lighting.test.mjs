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

test("full ten-material-texture profile retains all providers in one legal Native invocation", () => {
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
  assert.equal(plan.continuation, undefined);
  assert.equal(plan.descriptor.groups[3].length, 10);
  assert.doesNotMatch(plan.descriptor.source, /prior_native_hdr/);
  const fused = nativeSurfacePublicationDescriptors(program, material.slice(0, 9), profile, {
    maxSampledTexturesPerShaderStage: 16
  });
  assert.equal(fused.continuation, undefined);
});

test("native physical sun binds its parameters and consumes the published half LUT", () => {
  const parameters = {},
    transmittance = {},
    sampler = {};
  assert.deepEqual(nativeSurfacePhysicalSunEntries({ parameters, transmittance, sampler }), [
    { binding: 12, resource: { buffer: parameters } }
  ]);
  const layout = nativeSurfacePhysicalSunLayoutEntries();
  assert.equal(layout[0].buffer.type, "uniform");
  assert.equal(layout[0].buffer.minBindingSize, 48);
  assert.equal(layout.length, 1);
});

test("Physical Sun consumes VSM within Native and retains material normals for BRDF", () => {
  const graph = new AppearanceGraphBuilder();
  graph.output("baseColor", graph.constant([0.2, 0.3, 0.4]));
  graph.output("normalTS", graph.constant([0.7, 0.1, 0.7]));
  const program = lowerNativeMaterial(compileAppearanceGraph(graph.build()));
  const descriptor = nativeSurfaceDescriptor(program, [], {
    compact: true, productGeometry: true, unlit: false, reactive: true, physicalSun: true,
  });
  assert.match(descriptor.source, /vsm_sample_directional\(resolved_position/);
  assert.match(descriptor.source, /incident.color \*= sun_visibility/);
  assert.match(descriptor.source, /SurfaceGeometry\(mapped_normal/);
  assert.equal(descriptor.groups[1].some(entry => entry.binding === 9), true);
  assert.equal(descriptor.groups[1].find(entry => entry.binding === 10).texture.sampleType, "depth");
});
