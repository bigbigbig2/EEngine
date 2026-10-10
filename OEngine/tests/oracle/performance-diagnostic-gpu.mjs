import { vsmReceiverDemandDiagnosticWgsl } from "../../.test-dist/shaders/vsm_receiver_demand.js";

export async function runPerformanceDiagnosticGpuOracle(device) {
  const source = vsmReceiverDemandDiagnosticWgsl();
  const reduction = source.slice(source.indexOf("@group(0) @binding(7)"),
    source.indexOf("@compute @workgroup_size(64)", source.indexOf("@group(0) @binding(7)")));
  const code = /* wgsl */ `
const VSM_INVALID_SLOT: u32 = 0xffffffffu;
struct Constants { dimensions: vec4u, control: vec4u, }
@group(0) @binding(3) var<uniform> constants: Constants;
@group(0) @binding(4) var<storage, read_write> requested: array<atomic<u32>>;
fn diagnostic_receiver_page(id: vec3u) -> u32 {
  if (id.x >= constants.dimensions.x || id.y >= constants.dimensions.y || constants.control.z == 3u) {
    return VSM_INVALID_SLOT;
  }
  if (constants.control.z == 0u) { return 3u; }
  if (constants.control.z == 1u) { return id.y * constants.dimensions.x + id.x; }
  return (id.x % 2u) + ((id.x / 2u) % 2u) * 32u;
}
${reduction}
`;
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  if (info.messages.some((m) => m.type === "error")) throw new Error(JSON.stringify(info.messages));
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
  const constants = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const requested = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: 80, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 96, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 3, resource: { buffer: constants } }, { binding: 4, resource: { buffer: requested } },
    { binding: 7, resource: { buffer: output } },
  ] });
  const cases = [];
  try {
    for (let mode = 0; mode < 4; mode++) {
      device.queue.writeBuffer(constants, 0, new Uint32Array([10, 9, 0, 0, 0, 7, mode, 0]));
      const encoder = device.createCommandEncoder();
      encoder.clearBuffer(requested);
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(2, 2); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, 80);
      encoder.copyBufferToBuffer(requested, 0, readback, 80, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const actual = Array.from(new Uint32Array(readback.getMappedRange()));
      readback.unmap();
      const expected = [10, 9, 7, 4], bits = new Uint32Array(4);
      for (let gy = 0; gy < 2; gy++) for (let gx = 0; gx < 2; gx++) {
        const pages = [];
        for (let ly = 0; ly < 8; ly++) for (let lx = 0; lx < 8; lx++) {
          const x = gx * 8 + lx, y = gy * 8 + ly;
          if (x >= 10 || y >= 9 || mode === 3) continue;
          const page = mode === 0 ? 3 : mode === 1 ? y * 10 + x : (x % 2) + (Math.floor(x / 2) % 2) * 32;
          pages.push(page); bits[page >>> 5] |= 1 << (page & 31);
        }
        const unique = new Set(pages).size, words = new Set(pages.map((p) => p >>> 5)).size;
        expected.push(pages.length, unique, words, pages.length - unique);
      }
      expected.push(...bits);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ mode, actual, expected }));
      cases.push({ mode, workgroupRecords: actual.slice(4, 20), requested: actual.slice(20) });
    }
  } finally { readback.destroy(); output.destroy(); requested.destroy(); constants.destroy(); }
  return { passed: true, cases, covers: ["all duplicate", "all unique", "same/different bitset words", "partial groups", "empty groups", "reset across dispatches"] };
}
