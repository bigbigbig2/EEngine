import assert from "node:assert/strict";
import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { Fsr3ShadingChangePyramidPass } from "../../.test-dist/render/passes/fsr3/Fsr3ShadingChangePyramidPass.js";
import { SOURCE_WGSL } from "./fixtures/fsr3-shading-reference.mjs";

export async function runFsr3ShadingPyramidGpuOracle(device) {
  const reference = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: SOURCE_WGSL }), entryPoint: "main" },
  });
  const reader = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var scratch: texture_2d<f32>;
@group(0) @binding(1) var mip: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> values: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(scratch);
  if id.x >= size.x * size.y { return; }
  let xy = vec2i(vec2u(id.x % size.x, id.x / size.x));
  values[id.x * 2u] = textureLoad(scratch, xy, 0);
  values[id.x * 2u + 1u] = textureLoad(mip, xy, 0);
}`,
      }),
      entryPoint: "main",
    },
  });
  const cases = [];
  for (const [width, height] of [
    [8, 8],
    [17, 9],
    [65, 33],
    [130, 79],
  ]) {
    for (const phase of [0, 1, 2]) {
      const owned = [];
      const texture = (w, h, format) => {
        const result = device.createTexture({
          size: [w, h],
          format,
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
        owned.push(result);
        return result;
      };
      const buffer = (size, usage) => {
        const result = device.createBuffer({ size, usage });
        owned.push(result);
        return result;
      };
      try {
        const motion = texture(width, height, "rgba32float"),
          current = texture(width, height, "r32float"),
          previous = texture(width, height, "r32float"),
          exposure = texture(1, 1, "r32float");
        const currentValues = new Float32Array(width * height),
          previousValues = new Float32Array(width * height),
          motionValues = new Float32Array(width * height * 4);
        for (let i = 0; i < currentValues.length; i++) {
          currentValues[i] = phase === 0 ? 0 : i % 11 === 0 ? 0.00002 : 0.2 + ((i * 17) % 257) / 37;
          previousValues[i] = phase === 0 ? 0 : 0.1 + ((i * 31) % 239) / 51;
          motionValues[i * 4] = phase === 2 ? ((i % 7) - 3) / width : 0;
          motionValues[i * 4 + 1] = phase === 2 ? (i % 13 === 0 ? 2 : -1 / height) : 0;
        }
        device.queue.writeTexture({ texture: current }, currentValues, { bytesPerRow: width * 4 }, [
          width,
          height,
        ]);
        device.queue.writeTexture({ texture: previous }, previousValues, { bytesPerRow: width * 4 }, [
          width,
          height,
        ]);
        device.queue.writeTexture({ texture: motion }, motionValues, { bytesPerRow: width * 16 }, [
          width,
          height,
        ]);
        device.queue.writeTexture(
          { texture: exposure },
          new Float32Array([phase === 1 ? 1.7 : 0]),
          {},
          [1, 1],
        );
        const constants = buffer(160, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        const bytes = new ArrayBuffer(160),
          ints = new Int32Array(bytes),
          floats = new Float32Array(bytes);
        ints.set([width, height, width, height]);
        floats.set(phase === 2 ? [0.37, -0.29, -0.17, 0.43] : [0, 0, 0, 0], 16);
        floats[29] = phase === 1 ? 0.75 : 1;
        device.queue.writeBuffer(constants, 0, bytes);
        const dstWidth = Math.ceil(width / 2),
          dstHeight = Math.ceil(height / 2),
          size = dstWidth * dstHeight * 32;
        const expectedScratch = texture(dstWidth, dstHeight, "rgba32float"),
          expectedMip = texture(dstWidth, dstHeight, "rg16float"),
          output = buffer(size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
          actualRead = buffer(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
          expectedRead = buffer(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        const graph = new FrameGraph("FSR3 shading lane mapping oracle"),
          owner = new Fsr3ShadingChangePyramidPass(device);
        let actualScratch;
        const create = owner.createTexture.bind(owner);
        owner.createTexture = (...args) => {
          const result = create(...args);
          if (args[1].endsWith("scratch0")) actualScratch = result;
          return result;
        };
        const imported = (name, resource) => graph.import_resource(name, { kind: "imported" }, resource);
        const mips = owner.addToGraph(graph, {
          width,
          height,
          dilatedMotion: imported("motion", motion),
          currentLuma: imported("current", current),
          previousLuma: imported("previous", previous),
          exposure: imported("exposure", exposure),
          constants: imported("constants", constants),
        });
        const read = (encoder, scratch, mip, target) => {
          const pass = encoder.beginComputePass();
          pass.setPipeline(reader);
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: reader.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: scratch.createView() },
                { binding: 1, resource: mip.createView() },
                { binding: 2, resource: { buffer: output } },
              ],
            }),
          );
          pass.dispatchWorkgroups(Math.ceil((dstWidth * dstHeight) / 64));
          pass.end();
          encoder.copyBufferToBuffer(output, 0, target, 0, size);
        };
        const consume = graph.add("read complete source products", {}, (_, resources, context) =>
          read(context.encoder, resources.get(actualScratch), resources.get(mips[0]), actualRead),
        );
        consume.read(actualScratch);
        consume.read(mips[0]);
        consume.make_side_effect();
        let complete;
        const completion = new Promise((resolve) => {
          complete = resolve;
        });
        const encoder = device.createCommandEncoder();
        graph.execute(new FrameGraphContext({ device, encoder, completion }));
        const pass = encoder.beginComputePass();
        pass.setPipeline(reference);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: reference.getBindGroupLayout(0),
            entries: [
              motion.createView(),
              current.createView(),
              previous.createView(),
              exposure.createView(),
              { buffer: constants },
              expectedScratch.createView(),
              expectedMip.createView(),
            ].map((resource, binding) => ({ binding, resource })),
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(dstWidth / 8), Math.ceil(dstHeight / 8));
        pass.end();
        read(encoder, expectedScratch, expectedMip, expectedRead);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        complete();
        await Promise.all([actualRead, expectedRead].map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
        const actual = new Float32Array(actualRead.getMappedRange()),
          expected = new Float32Array(expectedRead.getMappedRange());
        for (let i = 0; i < actual.length; i++)
          assert.equal(actual[i], expected[i], `${width}x${height} phase${phase} word${i}`);
        actualRead.unmap();
        expectedRead.unmap();
        cases.push({ width, height, phase, comparedWords: size / 4, maximumError: 0 });
      } finally {
        await device.queue.onSubmittedWorkDone();
        owned.forEach((resource) => resource.destroy());
      }
    }
  }
  return { status: "passed", cases, reference: "frozen SDK 1.1.4 source, per-lane serial 2x2 execution" };
}
