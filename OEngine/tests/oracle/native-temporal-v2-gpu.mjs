import assert from "node:assert/strict";
import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { Fsr3UpscalerRuntime } from "../../.test-dist/render/passes/fsr3/Fsr3UpscalerRuntime.js";
import { Fsr3UpscalerRuntime as BeforeRuntime } from "./fixtures/native-temporal-before-c6e8d31d.mjs";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";

// One actual chain per encoder. The reference is test-only; inputs are analytic
// in unjittered screen space and independent of either temporal implementation.
export async function runNativeTemporalV2GpuOracle(device) {
  const depthPipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: {
      module: device.createShaderModule({
        code: `
@vertex fn main(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}`,
      }),
      entryPoint: "main",
    },
    fragment: {
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var depth:texture_2d<f32>;
@fragment fn main(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
 return textureLoad(depth,vec2i(p.xy),0).x;
}`,
      }),
      entryPoint: "main",
      targets: [],
    },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });
  const reader = await device.createComputePipelineAsync({
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        code: `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> values:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let s=textureDimensions(source);if(id.x>=s.x*s.y){return;}
 values[id.x]=textureLoad(source,vec2i(vec2u(id.x%s.x,id.x/s.x)),0);
}`,
      }),
      entryPoint: "main",
    },
  });
  const cases = [];
  const gateFailures = [];
  const HALF_COMPARISON_FLOOR = 2 ** -10;
  async function sequence(name, width, height, frames, evaluate, controls = () => ({})) {
    const owned = [];
    const tex = (format, usage = 0) => {
      const t = device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | usage,
      });
      owned.push(t);
      return t;
    };
    const buf = (size, usage) => {
      const b = device.createBuffer({ size, usage });
      owned.push(b);
      return b;
    };
    const color = tex("rgba16float"),
      motion = tex("rg32float"),
      facts = tex("rgba8unorm"),
      sourceDepth = tex("r32float");
    const depth = device.createTexture({
      size: [width, height],
      format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    owned.push(depth);
    const exposure = buf(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const priorExposure = buf(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const values = buf(width * height * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const target = buf(width * height * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const depthGroup = device.createBindGroup({
      layout: depthPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sourceDepth.createView() }],
    });
    const runtimes = [new BeforeRuntime(device), new Fsr3UpscalerRuntime(device)];
    const errors = [[], []],
      outputs = [[], []],
      frameSummaries = [],
      golds = [],
      states = [];
    let prior = { jitter: [0, 0], offset: [0, 0], preExposure: 1 };
    try {
      for (let f = 0; f < frames; f++) {
        const state = { jitter: [0, 0], offset: [0, 0], preExposure: 1, ...controls(f) };
        const pixels = new Uint16Array(width * height * 4),
          m = new Float32Array(width * height * 2),
          flags = new Uint8Array(width * height * 4),
          depths = new Float32Array(width * height);
        const gold = new Float64Array(width * height * 3);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const c = evaluate(
              x + 0.5 - state.jitter[0] - state.offset[0],
              y + 0.5 - state.jitter[1] - state.offset[1],
              f,
            );
            pixels.set(
              [
                floatToHalf(c[0] * state.preExposure),
                floatToHalf(c[1] * state.preExposure),
                floatToHalf(c[2] * state.preExposure),
                floatToHalf(1),
              ],
              i * 4,
            );
            const velocity = state.motionAt?.(x + 0.5 - state.jitter[0], y + 0.5 - state.jitter[1]) ?? [
              state.offset[0] - prior.offset[0],
              state.offset[1] - prior.offset[1],
            ];
            m.set(
              [
                (velocity[0] + state.jitter[0] - prior.jitter[0]) / width,
                (velocity[1] + state.jitter[1] - prior.jitter[1]) / height,
              ],
              i * 2,
            );
            flags.set(
              [state.reactive ?? 0, state.invalid ? 0 : 255, state.replacement ? 255 : 0, 255],
              i * 4,
            );
            depths[i] = c[3] ?? 0.5;
            // 8x8 analytic target except the separate large-coordinate numeric
            // comparison, which is explicitly not an AA quality golden.
            const subSamples = name.startsWith("full-resolution") ? 1 : 8;
            for (let sy = 0; sy < subSamples; sy++)
              for (let sx = 0; sx < subSamples; sx++) {
                const q = evaluate(
                  x + (sx + 0.5) / subSamples - state.offset[0],
                  y + (sy + 0.5) / subSamples - state.offset[1],
                  f,
                );
                for (let k = 0; k < 3; k++) gold[i * 3 + k] += q[k] / (subSamples * subSamples);
              }
          }
        device.queue.writeTexture({ texture: color }, pixels, { bytesPerRow: width * 8 }, [width, height]);
        device.queue.writeTexture({ texture: motion }, m, { bytesPerRow: width * 8 }, [width, height]);
        device.queue.writeTexture({ texture: facts }, flags, { bytesPerRow: width * 4 }, [width, height]);
        device.queue.writeTexture({ texture: sourceDepth }, depths, { bytesPerRow: width * 4 }, [
          width,
          height,
        ]);
        device.queue.writeBuffer(exposure, 0, new Float32Array([state.preExposure, 0, 0, 0]));
        device.queue.writeBuffer(priorExposure, 0, new Float32Array([prior.preExposure, 0, 0, 0]));
        for (let r = 0; r < 2; r++) {
          const runtime = runtimes[r];
          runtime.prepareFrame(
            { writeBuffer: (b, o, data) => device.queue.writeBuffer(b, o, data) },
            {
              renderWidth: width,
              renderHeight: height,
              outputWidth: width,
              outputHeight: height,
              jitter: state.jitter,
              cameraNear: 0.1,
              cameraFar: 1000,
              cameraFovY: Math.PI / 3,
              cameraInfiniteFar: false,
              frameTimeMs: 1000 / 60,
              reset: f === 0 || state.reset === true,
            },
          );
          const graph = new FrameGraph(`Native Temporal ${name}/${r}/${f}`);
          const imported = (name, resource) => graph.import_resource(name, { kind: "imported" }, resource);
          const output = runtime.addToGraph(
            graph,
            {
              color: imported("color", color),
              depth: imported("depth", depth),
              motion: imported("motion", motion),
              reactiveMask: imported("facts", facts),
              validityMask: imported("validity", facts),
              preExposure: imported("pre-exposure", exposure),
              priorExposure: imported("prior-exposure", priorExposure),
              width,
              height,
              outputWidth: width,
              outputHeight: height,
            },
            (_name, resolve) => resolve(runtime),
          );
          const consume = graph.add("read output", {}, (_data, resources, context) => {
            const pass = context.encoder.beginComputePass();
            pass.setPipeline(reader);
            pass.setBindGroup(
              0,
              device.createBindGroup({
                layout: reader.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: resources.get(output).createView() },
                  { binding: 1, resource: { buffer: values } },
                ],
              }),
            );
            pass.dispatchWorkgroups(Math.ceil((width * height) / 64));
            pass.end();
            context.encoder.copyBufferToBuffer(values, 0, target, 0, width * height * 16);
          });
          consume.read(output);
          consume.make_side_effect();
          const compiled = graph.compile();
          const encoder = device.createCommandEncoder();
          const transients = [];
          const command = {
            gpu_encoder: encoder,
            beginComputePass: (descriptor) => encoder.beginComputePass(descriptor),
            copyBufferToBuffer: (...args) => encoder.copyBufferToBuffer(...args),
            allocateTransientBufferAndLoad(data, usage) {
              const b = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
              new Uint8Array(b.getMappedRange()).set(new Uint8Array(data));
              b.unmap();
              transients.push(b);
              return b;
            },
          };
          const dp = encoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
              view: depth.createView(),
              depthClearValue: 0,
              depthLoadOp: "clear",
              depthStoreOp: "store",
            },
          });
          dp.setPipeline(depthPipeline);
          dp.setBindGroup(0, depthGroup);
          dp.draw(3);
          dp.end();
          let finish;
          const completion = new Promise((resolve) => {
            finish = resolve;
          });
          compiled.execute(new FrameGraphContext({ device, encoder: command, completion }));
          device.queue.submit([encoder.finish()]);
          const gpuDone = device.queue.onSubmittedWorkDone();
          runtime.commit(gpuDone);
          await gpuDone;
          finish();
          await target.mapAsync(GPUMapMode.READ);
          const result = new Float32Array(target.getMappedRange()).slice();
          target.unmap();
          compiled.destroy();
          transients.forEach((b) => b.destroy());
          let sq = 0,
            energy = 0,
            maxError = 0;
          for (let y = 2; y < height - 2; y++)
            for (let x = 2; x < width - 2; x++)
              for (let k = 0; k < 3; k++) {
                const i = y * width + x,
                  actual = result[i * 4 + k] / state.preExposure,
                  expected = gold[i * 3 + k];
                assert.ok(Number.isFinite(actual), `${name} frame ${f} non-finite ${r}/${i}/${k}`);
                const d = actual - expected;
                sq += d * d;
                energy += expected * expected;
                maxError = Math.max(maxError, Math.abs(d));
              }
          errors[r].push(Math.sqrt(sq / Math.max(energy, 1e-20)));
          outputs[r].push(result);
          frameSummaries.push({
            frame: f,
            path: r === 0 ? "before" : "native",
            normalizedRmse: errors[r].at(-1),
            maxError,
          });
        }
        golds.push(gold);
        states.push(state);
        prior = state;
      }
      const start = frames > 8 ? 16 : 0;
      const beforeRmse = errors[0].slice(start).reduce((a, b) => a + b) / (frames - start);
      const nativeRmse = errors[1].slice(start).reduce((a, b) => a + b) / (frames - start);
      const samePhase = outputs.map((series) => {
        let sq = 0,
          energy = 0;
        for (let f = Math.max(start, 8); f < frames; f++)
          for (let y = 2; y < height - 2; y++)
            for (let x = 2; x < width - 2; x++)
              for (let k = 0; k < 3; k++) {
                const i = (y * width + x) * 4 + k;
                const d = series[f][i] - series[f - 8][i];
                sq += d * d;
                energy += series[f][i] ** 2;
              }
        return Math.sqrt(sq / Math.max(energy, 1e-20));
      });
      cases.push({ name, width, height, frames, frameSummaries, beforeRmse, nativeRmse, samePhase });
      if (nativeRmse > beforeRmse + HALF_COMPARISON_FLOOR)
        gateFailures.push(`${name}: HDR RMSE ${nativeRmse} > ${beforeRmse}`);
      if (name.startsWith("static") && samePhase[1] > samePhase[0] + HALF_COMPARISON_FLOOR)
        gateFailures.push(`${name}: static phase residual ${samePhase[1]} > ${samePhase[0]}`);
      const rois = name.startsWith("full-resolution")
        ? [
            ["far-edge-HDR", 1850, 1050, 1919, 1079],
            ["interior", 2, 2, width - 2, height - 2],
          ]
        : name.includes("thin")
          ? [
              ["wire", 22, 2, 27, height - 2],
              ["horizontal-wire", 2, 16, width - 2, 21],
              ["siemens", 34, 4, 60, 44],
            ]
          : name.includes("local-patch")
            ? [
                ["patch", 22, 18, 28, 24],
                ["patch-neighborhood", 18, 14, 32, 28],
              ]
            : name.includes("highlight")
              ? [
                  ["emitter", 21, 20, 28, 27],
                  ["dark-neighborhood", 18, 17, 31, 30],
                ]
              : [["interior", 2, 2, width - 2, height - 2]];
      const roiMetrics = [];
      for (const [roi, x0, y0, x1, y1] of rois) {
        const metrics = [0, 1].map((r) => {
          let sq = 0,
            energy = 0,
            displaySq = 0,
            displayEnergy = 0,
            actualSum = 0,
            goldSum = 0,
            phaseSq = 0,
            phaseEnergy = 0;
          for (let f = start; f < frames; f++)
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++)
                for (let k = 0; k < 3; k++) {
                  const i = y * width + x,
                    v = outputs[r][f][i * 4 + k] / states[f].preExposure,
                    g = golds[f][i * 3 + k];
                  sq += (v - g) ** 2;
                  energy += g * g;
                  // Explicit diagnostic display curve; linear HDR remains primary.
                  const dv = v / (1 + v),
                    dg = g / (1 + g);
                  displaySq += (dv - dg) ** 2;
                  displayEnergy += dg * dg;
                  actualSum += v;
                  goldSum += g;
                  if (name.startsWith("static") && f >= start + 8) {
                    const priorV = outputs[r][f - 8][i * 4 + k] / states[f - 8].preExposure;
                    phaseSq += (v - priorV) ** 2;
                    phaseEnergy += v * v;
                  }
                }
          return {
            hdrRmse: Math.sqrt(sq / Math.max(energy, 1e-20)),
            displayRmse: Math.sqrt(displaySq / Math.max(displayEnergy, 1e-20)),
            energyError: Math.abs(actualSum - goldSum) / Math.max(goldSum, 1e-20),
            phaseResidual: Math.sqrt(phaseSq / Math.max(phaseEnergy, 1e-20)),
          };
        });
        roiMetrics.push({ roi, before: metrics[0], native: metrics[1] });
        for (const metric of Object.keys(metrics[0])) {
          if (metrics[1][metric] > metrics[0][metric] + HALF_COMPARISON_FLOOR)
            gateFailures.push(`${name}/${roi}/${metric}: ${metrics[1][metric]} > ${metrics[0][metric]}`);
        }
        // An average cannot hide a single-frame ghost or delayed light response.
        const response = [];
        for (let f = start; f < frames; f++) {
          const perFrame = [0, 1].map((r) => {
            let sq = 0,
              energy = 0;
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++)
                for (let k = 0; k < 3; k++) {
                  const i = y * width + x;
                  const actual = outputs[r][f][i * 4 + k] / states[f].preExposure;
                  const expected = golds[f][i * 3 + k];
                  sq += (actual - expected) ** 2;
                  energy += expected ** 2;
                }
            return Math.sqrt(sq / Math.max(energy, 1e-20));
          });
          response.push({ frame: f, before: perFrame[0], native: perFrame[1] });
          if (perFrame[1] > perFrame[0] + HALF_COMPARISON_FLOOR)
            gateFailures.push(`${name}/${roi}/frame-${f}: ${perFrame[1]} > ${perFrame[0]}`);
        }
        roiMetrics.at(-1).response = response;
      }
      cases.at(-1).roiMetrics = roiMetrics;
      if (name.startsWith("uniform")) {
        for (let r = 0; r < 2; r++)
          for (let f = 0; f < frames; f++)
            assert.ok(errors[r][f] < 0.003, `${name}/${r}/${f} uniform error ${errors[r][f]}`);
      }
    } finally {
      runtimes.forEach((r) => r.destroy());
      await device.queue.onSubmittedWorkDone();
      await Promise.resolve();
      owned.forEach((r) => r.destroy());
    }
  }
  for (const [w, h, hdr] of [
    [8, 8, 0.5],
    [17, 9, 128],
    [33, 17, 8192],
  ]) {
    await sequence(
      `uniform-${hdr}`,
      w,
      h,
      4,
      () => [hdr, hdr * 0.25, hdr * 0.7],
      (f) => ({ preExposure: f >= 2 ? 0.25 : 1 }),
    );
  }
  const halton = (b, i) => {
    let v = 0,
      k = 1;
    while (i > 0) {
      k /= b;
      v += (i % b) * k;
      i = Math.floor(i / b);
    }
    return v;
  };
  const jitter = (f) => [halton(2, (f % 8) + 1) - 0.5, halton(3, (f % 8) + 1) - 0.5];
  const grid = (x, y) => {
    const wire = Math.abs(x - 24.25) < 0.23 || Math.abs(y - 17.75) < 0.23;
    const angle = Math.atan2(y - 24, x - 40);
    const radial = x > 32 ? 0.5 + 0.5 * Math.sin(angle * 36) : 0.1;
    const v = wire ? 4 : 0.05 + radial * 0.7;
    return [v, v * 0.65, v * 0.2];
  };
  await sequence("static-thin-siemens", 64, 48, 48, grid, (f) => ({ jitter: jitter(f) }));
  const smooth = (x, y) => {
    const v = 0.4 + 0.25 * Math.sin(x * 0.6) * Math.cos(y * 0.7);
    return [v, v * 0.8, v * 0.3];
  };
  await sequence("motion-slow-stop", 64, 48, 48, smooth, (f) => ({
    jitter: jitter(f),
    offset: [f < 16 ? 0 : f < 32 ? (f - 16) * 0.25 : 4, 0],
  }));
  await sequence("motion-fast-reverse-stop", 64, 48, 48, grid, (f) => ({
    jitter: jitter(f),
    offset: [f < 16 ? 0 : f < 24 ? (f - 16) * 2.1 : f < 32 ? (32 - f) * 2.1 : 0, 0],
  }));
  await sequence(
    "light-step-ramp",
    64,
    48,
    48,
    (x, y, f) => {
      const c = smooth(x, y),
        g = f < 16 ? 1 : f < 24 ? 4 : 4 - (f - 24) * 0.1;
      return c.map((v) => v * g);
    },
    (f) => ({ jitter: jitter(f) }),
  );
  await sequence(
    "light-local-patch-step",
    64,
    48,
    48,
    (x, y, f) => {
      const c = smooth(x, y),
        g = f >= 16 && x > 22 && x < 28 && y > 18 && y < 24 ? 4 : 1;
      return c.map((v) => v * g);
    },
    (f) => ({ jitter: jitter(f) }),
  );
  await sequence("exposure-step", 64, 48, 48, smooth, (f) => ({
    jitter: jitter(f),
    preExposure: f < 16 ? 1 : f < 32 ? 0.125 : 4,
  }));
  await sequence(
    "HDR-isolated-highlight",
    64,
    48,
    48,
    (x, y) => {
      const v = Math.abs(x - 24.25) < 0.6 && Math.abs(y - 23.75) < 0.6 ? 4096 : 0.1;
      return [v, v * 0.25, v * 0.7];
    },
    (f) => ({ jitter: jitter(f) }),
  );
  const fgOffset = (f) => (f < 16 ? 0 : f < 28 ? (f - 16) * 1.5 : 18);
  await sequence(
    "foreground-disocclusion-stop",
    64,
    48,
    48,
    (x, y, f) => {
      const foreground = x > 12 + fgOffset(f) && x < 26 + fgOffset(f) && y > 8 && y < 40;
      return foreground ? [2, 0.15, 0.1, 0.8] : [0.1 + 0.03 * Math.sin(x), 0.15, 0.2, 0.2];
    },
    (f) => ({
      jitter: jitter(f),
      motionAt: (x, y) =>
        x > 12 + fgOffset(f) && x < 26 + fgOffset(f) && y > 8 && y < 40
          ? [fgOffset(f) - fgOffset(Math.max(0, f - 1)), 0]
          : [0, 0],
    }),
  );
  const zoom = (f) => (f < 16 ? 1 : f < 32 ? 1 + (f - 16) * 0.01 : 1.16);
  await sequence(
    "dolly-plane",
    64,
    48,
    48,
    (x, y, f) => smooth(32 + (x - 32) / zoom(f), 24 + (y - 24) / zoom(f)),
    (f) => ({
      jitter: jitter(f),
      motionAt: (x, y) => [
        (x - 32) * (1 - zoom(Math.max(0, f - 1)) / zoom(f)),
        (y - 24) * (1 - zoom(Math.max(0, f - 1)) / zoom(f)),
      ],
    }),
  );
  await sequence("replacement-invalid-reactive-reset", 33, 17, 32, smooth, (f) => ({
    jitter: jitter(f),
    invalid: f === 17,
    replacement: f === 20,
    reactive: f === 23 ? 255 : 0,
    reset: f === 27,
  }));
  await sequence("external-jitter-partial", 17, 9, 4, smooth, (f) => ({
    jitter: f % 2 ? [2.7, -1.2] : [-1.3, 2.4],
  }));
  await sequence("external-jitter-thin-partial", 65, 49, 32, grid, (f) => ({
    jitter: f % 2 ? [2.7, -1.2] : [-1.3, 2.4],
  }));
  await sequence(
    "full-resolution-numeric-roundoff",
    1920,
    1080,
    4,
    (x, y) => {
      const c = smooth(x, y);
      const gain = Math.abs(x - 1900.25) < 0.6 && Math.abs(y - 1060.75) < 0.6 ? 8192 : 1;
      return c.map((v) => v * gain);
    },
    (f) => ({ jitter: jitter(f) }),
  );
  assert.equal(gateFailures.length, 0, JSON.stringify({ gateFailures, cases }));
  return {
    status: "passed",
    cases,
    qualityGate:
      "Analytic 8x8 pixel reference; per-sequence HDR RMSE and static same-phase residual, old + 2^-10 half comparison floor.",
  };
}
