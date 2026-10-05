import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { packAppearanceDagPublication } from "../../.test-dist/gpu/GpuAppearanceDagAbi.js";

function productSource(width = 45) {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  graph.output("roughness", graph.swizzle(uv, [0]));
  graph.output("alpha", graph.swizzle(uv, [1]));
  const original = compileAppearanceGraph(graph.build());
  const payload = new Uint8Array(width * width * 2);
  const view = new DataView(payload.buffer);
  for (let pixel = 0; pixel < width * width; pixel++)
    view.setUint16(pixel * 2, 0x3000 + (pixel % 4096), true);
  const tailWidth = Math.floor(width / 2);
  const tail = new Uint8Array(tailWidth * tailWidth * 2);
  const tailView = new DataView(tail.buffer);
  for (let pixel = 0; pixel < tailWidth * tailWidth; pixel++) tailView.setUint16(pixel * 2, 0x3800, true);
  const field = {
    name: "roughness",
    width: 1,
    contentKey: "field",
    format: "r16float",
    mips: [
      { width, height: width, payload },
      { width: tailWidth, height: tailWidth, payload: tail },
    ],
  };
  const asset = {
    runtime: { manifest: { assetId: "asset" } },
    domainMin: [-1, 2],
    domainMax: [1, 4],
    fields: [field],
  };
  const program = {
    ...original,
    instructions: [
      ...original.instructions,
      {
        kind: "product",
        args: [],
        product: 0,
        channel: 0,
        dependency: 1,
        coordinateDomains: ["uv0"],
        filter: "affine",
      },
    ],
    outputs: { roughness: [original.instructions.length] },
    productReads: [{ asset, field, uv: [0, 1], source: original, sourceRoots: [0] }],
  };
  return {
    program,
    lowered: lowerAppearanceWgsl(program),
    constantBase: 0,
    routeBase: 0,
    inputBase: 0,
    textureBindingSetId: 0,
  };
}

test("product identity stays data, complete odd-sized mips cross a fixed bank boundary bit-for-bit", () => {
  const source = productSource();
  const packed = packAppearanceDagPublication([source, source], 3000);
  assert.equal(packed.products.length, 2);
  assert.equal(packed.productBankWords, 750);
  const data = new Uint8Array(packed.products[0].byteLength + packed.products[1].byteLength);
  data.set(new Uint8Array(packed.products[0].buffer));
  data.set(new Uint8Array(packed.products[1].buffer), packed.products[0].byteLength);
  const mip = source.program.productReads[0].field.mips[0];
  assert.deepEqual(data.subarray(0, mip.payload.byteLength), mip.payload);
  const next = Math.ceil(mip.payload.byteLength / 4) * 4;
  assert.deepEqual(data.subarray(next, next + 968), source.program.productReads[0].field.mips[1].payload);
  assert.equal(data.byteLength, next + 968, "same immutable asset is not duplicated for each material");
  assert.throws(() => packAppearanceDagPublication([source], 2000), /code\/product storage/);
});

test("complete field outputs retain all 25 channels and distinct constant/input bases", () => {
  const graph = new AppearanceGraphBuilder();
  const widths = [3, 1, 1, 1, 1, 3, 3, 1, 1, 3, 1, 1, 3, 1, 1];
  const names = [
    "baseColor",
    "alpha",
    "metallic",
    "roughness",
    "occlusion",
    "emissive",
    "normalTS",
    "ior",
    "specularWeight",
    "specularColor",
    "coatWeight",
    "coatRoughness",
    "coatNormalTS",
    "normalTSValidity",
    "coatNormalTSValidity",
  ];
  names.forEach((name, field) =>
    graph.output(
      name,
      graph.parameter(
        name,
        Array.from({ length: widths[field] }, (_, channel) => field + channel / 10),
      ),
    ),
  );
  const program = compileAppearanceGraph(graph.build());
  const lowered = lowerAppearanceWgsl(program);
  const source = { program, lowered, constantBase: 17, routeBase: 31, inputBase: 9, textureBindingSetId: 3 };
  const packed = packAppearanceDagPublication([source], 65536);
  assert.equal(packed.code[3], 25);
  assert.equal(packed.code[5], 17);
  assert.equal(packed.code[6], 31);
  assert.equal(packed.code[7], 9);
  assert.equal(packed.code[8], 3);
  assert.equal(packed.code[12], 32767);
});
