import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { packAppearanceDagPublication } from "../../.test-dist/gpu/GpuAppearanceDagAbi.js";
import { appearancePublicationExactDescriptor } from "../../.test-dist/shaders/appearance_publication_exact.js";
import { APPEARANCE_CLOSURE_KEY_WGSL } from "../../.test-dist/shaders/appearance_closure_key.js";

/** Component oracle: actual publication update -> exact key reader. Geometry
 * input values are fixture data; this does not claim Surface cache consumption. */
export async function runAppearanceClosureKeyGpuOracle(device) {
  const graph = new AppearanceGraphBuilder();
  const uv = graph.input("uv0", 2, "surface", undefined, "uv0");
  const coordinate = graph.operation("sin", graph.operation("sin", uv));
  const sampled = graph.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), coordinate);
  graph.output(
    "roughness",
    graph.operation("multiply", graph.swizzle(sampled, [1]), graph.parameter("gain", 2)),
  );
  const program = compileAppearanceGraph(graph.build());
  const lowered = lowerAppearanceWgsl(program);
  const constants = 0;
  const inputs = lowered.constants.length;
  const routes = inputs + program.inputs.length * 4;
  const palette = routes + 16;
  const versions = palette + 64;
  const uniform = versions + 2;
  const packed = packAppearanceDagPublication(
    [
      {
        program,
        lowered,
        constantBase: 0,
        inputBase: 0,
        routeBase: 0,
        textureBindingSetId: 0,
      },
    ],
    1024 * 1024,
    1024 * 1024,
    uniform,
  );
  const exportPlan = packed.code[2];
  const closure = packed.code[exportPlan + 8];
  const words = packed.code[closure + 2];
  const metadata = new Uint32Array(uniform + packed.uniformWords);
  metadata.set(new Uint32Array(Float32Array.from(lowered.constants).buffer), constants);
  const route = new Uint32Array([
    0xffffffff, 1, 0, 17, 0, 0, 0x3f800000, 0x3f800000, 0x3f800000, 0, 0, 0, 0, 0, 0, 0x3f800000,
  ]);
  metadata.set(route, routes);
  metadata.set([31, 1], versions);
  metadata[packed.uniformFlagBase] = 3;
  const points = new Uint32Array(new Float32Array([0.1, 0.2, 0, 0, 0.3, 0.4, 0, 0, 0.5, 0.6, 0, 0]).buffer);
  const gainSlot =
    lowered.instructionConstantSlots[program.instructions.findIndex((node) => node.kind === "parameter")];
  const allocated = [];
  const buffer = (size, usage, data) => {
    const value = device.createBuffer({ size: Math.max(4, size), usage: usage | GPUBufferUsage.COPY_DST });
    allocated.push(value);
    if (data) device.queue.writeBuffer(value, 0, data);
    return value;
  };
  try {
    const code = buffer(packed.code.byteLength, GPUBufferUsage.STORAGE, packed.code);
    const values = buffer(metadata.byteLength, GPUBufferUsage.STORAGE, metadata);
    const scratch = buffer(packed.liveWords * 4, GPUBufferUsage.STORAGE);
    const camera = buffer(4096, GPUBufferUsage.UNIFORM);
    const geometry = buffer(points.byteLength, GPUBufferUsage.STORAGE, points);
    const parameters = buffer(
      48,
      GPUBufferUsage.UNIFORM,
      new Uint32Array([
        1,
        palette,
        constants,
        inputs,
        1,
        packed.liveWords,
        1,
        0,
        routes,
        packed.productBankWords,
        0,
        versions,
      ]),
    );
    const output = buffer(words * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(words * 4, GPUBufferUsage.MAP_READ);
    const publication = appearancePublicationExactDescriptor(false);
    const update = device.createComputePipeline({
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: publication.source }),
        entryPoint: publication.entryPoint,
      },
    });
    const keySource = `
struct KeySettings { constants: u32, inputs: u32, routes: u32, reserved: u32, }
@group(0) @binding(0) var<storage, read> dag_code: array<u32>;
@group(0) @binding(1) var<storage, read> dag_metadata: array<u32>;
@group(0) @binding(2) var<storage, read> points: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> output: array<u32>;
@group(0) @binding(4) var<uniform> settings: KeySettings;
var<private> dag_entry: u32;
fn geometry_input(semantic: u32, point: u32) -> vec4f {
  return points[(semantic - 1u) * 3u + point];
}
${APPEARANCE_CLOSURE_KEY_WGSL}
@compute @workgroup_size(64)
fn capture(@builtin(global_invocation_id) id: vec3u) {
  let plan = dag_code[dag_code[2u] + 8u];
  if id.x < dag_code[plan + 2u] {
    output[id.x] = appearance_closure_key_word(31u, plan, id.x);
  }
}`;
    const key = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: keySource }), entryPoint: "capture" },
    });
    const keySettings = buffer(16, GPUBufferUsage.UNIFORM, new Uint32Array([constants, inputs, routes, 0]));
    const bind = (pipeline, buffers) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    const updateGroup = bind(update, [code, values, scratch, parameters, camera]);
    const keyGroup = bind(key, [code, values, geometry, output, keySettings]);
    const cases = [];
    async function capture(label, expectedGain) {
      const encoder = device.createCommandEncoder();
      for (const [pipeline, group] of [
        [update, updateGroup],
        [key, keyGroup],
      ]) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
      }
      encoder.copyBufferToBuffer(output, 0, readback, 0, words * 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = new Uint32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      // Independent expected sequence from this authored scalar closure:
      // namespace/handle, U(CXY), V(CXY), complete route, GPU-updated gain.
      const gain = new Uint32Array(new Float32Array([expectedGain]).buffer)[0];
      const expected = [
        31,
        packed.code[closure],
        points[0],
        points[4],
        points[8],
        points[1],
        points[5],
        points[9],
        ...route,
        gain,
      ];
      if (actual.length !== expected.length || actual.some((word, index) => word !== expected[index])) {
        throw new Error(
          `${label}: exact key mismatch: ${JSON.stringify([...actual])} vs ${JSON.stringify(expected)}`,
        );
      }
      cases.push({ label, words: actual.length });
      return actual;
    }
    const initial = await capture("published uniform and original CXY", 2);
    metadata[gainSlot] = new Uint32Array(new Float32Array([7]).buffer)[0];
    metadata[packed.uniformFlagBase] = 2;
    device.queue.writeBuffer(values, 0, metadata);
    const changedGain = await capture("parameter update reaches GPU key", 7);
    if (changedGain.every((word, index) => word === initial[index]))
      throw new Error("Parameter change was invisible");
    points[4] += 1;
    device.queue.writeBuffer(geometry, 0, points);
    await capture("one ULP in X footprint remains distinct", 7);
    route[3] += 1;
    device.queue.writeBuffer(values, routes * 4, route);
    await capture("resident content revision reaches key", 7);
    device.queue.writeBuffer(camera, 0, new Float32Array([19, 23, 29, 31]));
    await capture("unrelated camera data does not enter UV key", 7);
    return {
      passed: true,
      scope: "publication and key reader component only; no Surface cache claim",
      cases,
    };
  } finally {
    for (const resource of allocated) resource.destroy();
  }
}
