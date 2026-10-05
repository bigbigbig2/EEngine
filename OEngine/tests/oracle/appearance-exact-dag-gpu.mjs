import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import {
  compileExactAppearanceDag,
  planExactAppearanceLanes,
} from "../../.test-dist/material/ExactAppearanceDag.js";
import { lowerAppearanceWgsl } from "../../.test-dist/shaders/appearance_program.js";
import { APPEARANCE_EXACT_DAG_WGSL } from "../../.test-dist/shaders/appearance_exact_dag.js";
import { evaluateCompiledAppearance } from "../../.test-dist/material/AppearanceGraphEvaluation.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const fields = [
  "alpha",
  "metallic",
  "roughness",
  "occlusion",
  "ior",
  "specularWeight",
  "coatWeight",
  "coatRoughness",
  "normalTSValidity",
  "coatNormalTSValidity",
];

function programs() {
  const result = [];
  for (const op of [
    "add",
    "subtract",
    "multiply",
    "divide",
    "min",
    "max",
    "pow",
    "sin",
    "cos",
    "abs",
    "sqrt",
    "mix",
    "clamp",
  ]) {
    const graph = new AppearanceGraphBuilder();
    const a = graph.input("gain", 1, "dynamic", { low: 0, high: 2 });
    const b = graph.parameter("b", 0.4);
    const c = graph.constant(0.7);
    const unary = ["sin", "cos", "abs", "sqrt"].includes(op);
    const ternary = ["mix", "clamp"].includes(op);
    graph.output("roughness", graph.operation(op, ...[a, b, c].slice(0, unary ? 1 : ternary ? 3 : 2)));
    result.push({
      label: op,
      program: compileAppearanceGraph(graph.build()),
      inputs: { gain: [0.6] },
      sample: () => [],
    });
  }
  const graph = new AppearanceGraphBuilder();
  const uv0 = graph.input("uv0", 2, "surface", undefined, "uv0");
  const uv1 = graph.input("uv1", 2, "surface", undefined, "uv1");
  const uv2 = graph.input("uv2", 2, "surface", undefined, "uv2");
  const nonlinear = graph.operation("sin", graph.operation("add", uv0, uv1));
  const source = graph.texture(snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"), nonlinear);
  const nested = graph.texture(
    snapshotAppearanceTexture(new ShadeTexture(), "linear-rgb"),
    graph.operation("add", graph.swizzle(source, [0, 1]), uv2),
  );
  graph.output("baseColor", graph.swizzle(nested, [0, 1, 2]));
  graph.output("emissive", graph.swizzle(source, [0, 2, 1]));
  for (const name of fields) graph.output(name, graph.swizzle(source, [0]));
  result.push({
    label: "nested-3UV",
    program: compileAppearanceGraph(graph.build()),
    inputs: { uv0: [0.2, 0.3], uv1: [0.1, 0.2], uv2: [0.15, 0.25] },
    sample: (_binding, uv) => [uv[0], uv[1], Math.fround(uv[0] + uv[1]), 1],
  });
  return result;
}

/** Component feasibility oracle: actual new packed IR and production generic
 * WGSL, independent established CPU evaluator. Analytic sampler logs exact
 * nested C/X/Y footprints; resident/product hardware routing has separate tests.
 * This does not claim the full Surface producer/consumer cutover is complete. */
export async function runExactAppearanceDagGpuOracle(device) {
  const cases = programs();
  const allocations = [];
  const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
    const resource = device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    device.queue.writeBuffer(resource, 0, data);
    allocations.push(resource);
    return resource;
  };
  const source = /* wgsl */ `
struct Settings { count: u32, outputs: u32, lanes: u32, stride: u32, }
@group(0) @binding(0) var<storage, read> dag_code: array<u32>;
@group(0) @binding(1) var<storage, read_write> dag_values: array<vec4f>;
@group(0) @binding(2) var<storage, read> constants: array<f32>;
@group(0) @binding(3) var<storage, read> inputs: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> result: array<f32>;
@group(0) @binding(5) var<uniform> settings: Settings;
@group(0) @binding(6) var<storage, read_write> footprints: array<vec4f>;
var<private> item: u32;
fn appearance_dag_constant(index: u32) -> f32 { return constants[index]; }
fn appearance_dag_input(index: u32, semantic: u32, channel: u32, neighbors: bool) -> vec3f {
  let value = inputs[index][channel];
  if semantic == 0u || !neighbors { return vec3f(value); }
  return vec3f(value, value + select(0.0, 0.01, channel == 0u), value + select(0.0, 0.02, channel == 1u));
}
fn appearance_dag_sample(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  if index == 1u { footprints[item] = vec4f(dx, dy); }
  return vec4f(uv, uv.x + uv.y, 1.0);
}
fn appearance_dag_product(index: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  return vec4f(0.3, 0.4, 0.5, 1.0);
}
${APPEARANCE_EXACT_DAG_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.lanes { return; }
  for (var work = id.x; work < 129u; work += settings.lanes) {
    item = work;
    let lane = id.x * settings.stride;
    appearance_dag_evaluate(0u, settings.count, lane, 32767u);
    for (var output = 0u; output < settings.outputs; output++) {
      let at = settings.count * 8u + output * 4u;
      result[work * settings.outputs + output] = dag_values[lane + dag_code[at + 2u]].x;
    }
  }
}
`;
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: source }), entryPoint: "main" },
  });
  const reports = [];
  try {
    for (const fixture of cases) {
      const lowered = lowerAppearanceWgsl(fixture.program);
      const dag = compileExactAppearanceDag(fixture.program, lowered);
      const code = new Uint32Array(dag.instructions.length + dag.outputs.length);
      code.set(dag.instructions);
      code.set(dag.outputs, dag.instructions.length);
      const inputData = new Float32Array(Math.max(4, fixture.program.inputs.length * 4));
      fixture.program.inputs.forEach((input, index) => inputData.set(fixture.inputs[input.name], index * 4));
      const expectedFields = evaluateCompiledAppearance(fixture.program, {
        inputs: fixture.inputs,
        sample: fixture.sample,
      });
      const expected = [];
      for (let at = 0; at < dag.outputs.length; at += 4) {
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
        expected.push(expectedFields[names[dag.outputs[at]]][dag.outputs[at + 1]]);
      }
      for (const requested of [1, 7, 64]) {
        const plan = planExactAppearanceLanes(
          dag.liveSlots,
          device.limits.maxStorageBufferBindingSize,
          requested,
        );
        const outputCount = dag.outputs.length / 4;
        const output = buffer(new Float32Array(129 * outputCount));
        const log = buffer(new Float32Array(129 * 4));
        const resources = [
          buffer(code),
          buffer(new Float32Array(plan.bytes / 4)),
          buffer(Float32Array.from(lowered.constants)),
          buffer(inputData),
          output,
          buffer(
            new Uint32Array([dag.instructions.length / 8, outputCount, plan.lanes, dag.liveSlots]),
            GPUBufferUsage.UNIFORM,
          ),
          log,
        ];
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: resources.map((resource, binding) => ({ binding, resource: { buffer: resource } })),
        });
        const readback = device.createBuffer({
          size: output.size + log.size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        allocations.push(readback);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(plan.lanes / 64));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
        encoder.copyBufferToBuffer(log, 0, readback, output.size, log.size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const actual = new Float32Array(readback.getMappedRange());
        for (let work = 0; work < 129; work++)
          for (let field = 0; field < outputCount; field++) {
            const value = actual[work * outputCount + field];
            check(
              Number.isFinite(value) && Math.abs(value - expected[field]) <= 3e-6,
              `${fixture.label}/${requested}/${work}/${field}: ${value} != ${expected[field]}`,
            );
          }
        if (fixture.label === "nested-3UV") {
          const f = Math.fround;
          const center = [f(Math.sin(f(0.2 + 0.1))), f(Math.sin(f(0.3 + 0.2)))];
          const x = [f(Math.sin(f(f(0.2 + 0.01) + f(0.1 + 0.01)))), center[1]];
          const y = [center[0], f(Math.sin(f(f(0.3 + 0.02) + f(0.2 + 0.02))))];
          const footprint = [
            f(f(x[0] + f(0.15 + 0.01)) - f(center[0] + 0.15)),
            0,
            0,
            f(f(y[1] + f(0.25 + 0.02)) - f(center[1] + 0.25)),
          ];
          for (let axis = 0; axis < 4; axis++)
            check(
              Math.abs(actual[129 * outputCount + axis] - footprint[axis]) <= 1e-6,
              `nested footprint axis ${axis}`,
            );
        }
        readback.unmap();
        reports.push({
          label: fixture.label,
          lanes: plan.lanes,
          liveSlots: dag.liveSlots,
          instructions: dag.instructions.length / 8,
          outputs: outputCount,
          work: 129,
        });
      }
    }
    return {
      passed: true,
      scope:
        "complete arithmetic opcode and nested coordinate generic-component feasibility; not full B1/B2 adoption",
      reports,
    };
  } finally {
    for (const resource of allocations) resource.destroy();
  }
}
