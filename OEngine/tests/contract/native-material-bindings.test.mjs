import assert from "node:assert/strict";
import test from "node:test";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import {
  lowerNativeMaterial,
  nativeMaterialDynamicInputs
} from "../../.test-dist/shaders/native_material.js";
import {
  createNativeMaterialBindings,
  nativeMaterialCoverageProgram
} from "../../.test-dist/gpu/NativeMaterialBindings.js";
import { encodeGpuTextureRef } from "../../.test-dist/gpu/GpuTextureRefAbi.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

globalThis.GPUShaderStage = { COMPUTE: 4, FRAGMENT: 2 };
function fixture() {
  const texture = new ShadeTexture();
  const builder = new AppearanceGraphBuilder();
  const uv = builder.input("uv0", 2, "surface", undefined, "uv0");
  const sampled = builder.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv);
  builder.output(
    "alpha",
    builder.operation(
      "multiply",
      builder.swizzle(sampled, [3]),
      builder.input("time", 1, "dynamic", { low: 0, high: 2 })
    )
  );
  builder.output("unusedColor", builder.swizzle(sampled, [0, 1, 2]));
  const graph = compileAppearanceGraph(builder.build());
  const program = lowerNativeMaterial(graph);
  return {
    texture,
    graph,
    program,
    source: {
      graph,
      program,
      bindingSet: { id: 2, generation: 3, textureBanks: Array.from({ length: 9 }, (_, bank) => ({ bank })) },
      textureRoutingRefs: new Map([[texture, encodeGpuTextureRef(5, 257, 1)]]),
      textureMipRanges: new Map([[texture, [0, 4]]]),
      texturePublications: new Map([[texture, { slot: 10, generation: 7, revision: 2 }]]),
      obtainSampler: (descriptor) => ({ descriptor })
    }
  };
}

test("residency routes stay instance data; physical bank/sampler profiles define native programs", () => {
  const f = fixture();
  const a = createNativeMaterialBindings(f.source);
  const b = createNativeMaterialBindings({
    ...f.source,
    textureRoutingRefs: new Map([[f.texture, encodeGpuTextureRef(5, 131073, 2)]])
  });
  assert.equal(a.program.key, b.program.key);
  assert.notDeepEqual(a.program.constants, b.program.constants);
  const at = f.program.constants.length;
  const rebuilt = a.program.constants[at] | (a.program.constants[at + 1] << 16);
  assert.equal(rebuilt >>> 0, encodeGpuTextureRef(5, 257, 1));
  assert.equal(a.entries[0].resource, f.source.bindingSet.textureBanks[5]);
  assert.equal(a.bankMask, 1 << 5);
  assert.equal(a.routeConstantBytes, 28);
  assert.equal(a.group, 3);
  assert.notEqual(a.program.resourceRevision, b.program.resourceRevision);
  assert.equal(a.program.resourceRevision, createNativeMaterialBindings(f.source).program.resourceRevision);
  const c = createNativeMaterialBindings({
    ...f.source,
    textureRoutingRefs: new Map([[f.texture, encodeGpuTextureRef(6, 1)]])
  });
  // Resource count is identical, so bank selection must be included explicitly in the structural key.
  assert.notEqual(a.program.key, c.program.key);
});

test("dynamic snapshots validate ranges and widths and coverage retains live dynamic inputs", () => {
  const f = fixture();
  const data = nativeMaterialDynamicInputs(f.program, { time: [0.75] });
  const slot = f.program.inputs.findIndex((input) => input.name === "time");
  assert.equal(data[slot * 4], 0.75);
  assert.throws(() => nativeMaterialDynamicInputs(f.program, {}), /components/);
  assert.throws(() => nativeMaterialDynamicInputs(f.program, { time: [3] }), /range/);
  assert.throws(() => nativeMaterialDynamicInputs(f.program, { time: [1], uv0: [0, 0] }), /Unknown/);
  assert.ok(f.program.frequencies.includes("dynamic"));
  assert.ok(f.program.frequencies.includes("sample"));
  const alpha = nativeMaterialCoverageProgram(f.graph);
  assert.deepEqual(Object.keys(alpha.outputs), ["alpha"]);
  assert.equal(alpha.inputs.find((input) => input.name === "time").domain, "dynamic");
  assert.equal(lowerNativeMaterial(alpha).outputCount, 1);
});

test("constant normal Products use no texture resources and preserve the normal decode", () => {
  const field = { width: 3, constant: [0, 0, 0], format: null, contentKey: "isotropic-moment" };
  const graph = {
    instructions: Array.from({ length: 5 }, (_, channel) => ({
      kind: "normal-product",
      product: 0,
      channel,
      args: [],
      dependency: 0,
      coordinateDomains: [],
      filter: "constant"
    })),
    outputs: { normalTS: [0, 1, 2], roughness: [3], normalTSValidity: [4] },
    outputMasks: {},
    inputs: [],
    samples: [],
    products: [],
    productReads: [{ field, uv: null, asset: {}, sourceRoots: [] }]
  };
  const f = fixture();
  const bound = createNativeMaterialBindings({ ...f.source, graph, program: lowerNativeMaterial(graph) });
  assert.equal(bound.entries.length, 0);
  assert.equal(bound.productTextureCount, 0);
  assert.equal(bound.routeConstantBytes, 0);
  assert.match(bound.program.source, /appearance_decode_normal_moment/);
});

test("invalid physical routes and mismatched compiler products reject before GPU consumption", () => {
  const f = fixture();
  assert.throws(
    () => createNativeMaterialBindings({ ...f.source, textureRoutingRefs: new Map([[f.texture, 13]]) }),
    /physical/
  );
  assert.throws(
    () =>
      createNativeMaterialBindings({
        ...f.source,
        program: lowerNativeMaterial(nativeMaterialCoverageProgram(f.graph))
      }),
    /match/
  );
});
