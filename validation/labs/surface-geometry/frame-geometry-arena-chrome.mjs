// Component diagnostic: actual owners and one-binding shader in installed,
// headed Chrome. This is not a Showcase frame or a performance acceptance.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "../../node_modules/playwright-core/index.mjs";

const root = resolve("."), artifacts = resolve(".local/validation/surface-geometry");
await mkdir(artifacts, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>EEngine shared geometry arena diagnostic</title><h1>Shared geometry: actual Chrome GPU execution</h1>"); return; }
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep) || !(/\.(js|mjs)$/.test(path))) throw new Error("Unsupported resource");
    response.setHeader("Content-Type", "application/javascript"); response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const report = { evidenceRole: "diagnostic", component: "FrameGeometryArena/SingleBindingWinner", headless: false, passed: false };
try {
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: false, args: [],
    ignoreDefaultArgs: ["--enable-unsafe-swiftshader", "--no-sandbox", "--unsafely-disable-devtools-self-xss-warnings"] });
  report.browser = browser.version(); const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { FrameGeometryArena } = await import("/OEngine/.test-dist/render/FrameGeometryArena.js");
    const { WinnerPrimitiveInterpolation } = await import("/OEngine/.test-dist/render/surface/WinnerPrimitiveInterpolation.js");
    const { winnerPrimitiveArenaConsumerWgsl } = await import("/OEngine/.test-dist/shaders/winner_primitive_work.js");
    const { ResourceAccounting } = await import("/OEngine/.test-dist/debug/profiling/ResourceAccounting.js");
    const { homogeneousInterpolationReference } = await import("/OEngine/tests/helpers/homogeneous-interpolation-reference.mjs");
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    check(adapter && !adapter.info.isFallbackAdapter, "Hardware WebGPU adapter required");
    const device = await adapter.requestDevice(), errors = [], resources = [], accounting = new ResourceAccounting();
    let disposing = false, lost = null, winner;
    device.addEventListener("uncapturederror", event => errors.push(event.error.message));
    void device.lost.then(info => { if (!disposing) lost = { reason: info.reason, message: info.message }; });
    const arenaOwner = new FrameGeometryArena(device, accounting);
    const buffer = (dataOrSize, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) => {
      const b = device.createBuffer({ size: typeof dataOrSize === "number" ? dataOrSize : dataOrSize.byteLength, usage }); resources.push(b);
      if (typeof dataOrSize !== "number") device.queue.writeBuffer(b, 0, dataOrSize); return b;
    };
    const pipeline = async code => {
      const module = device.createShaderModule({ code }), info = await module.getCompilationInfo();
      check(!info.messages.some(m => m.type === "error"), JSON.stringify(info.messages));
      return device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    };
    const map = async (b, TypedArray) => { await b.mapAsync(GPUMapMode.READ); const values = new TypedArray(b.getMappedRange().slice(0)); b.unmap(); return values; };
    const cases = [], result = { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter }, cases };
    try {
      device.pushErrorScope("validation");
      winner = await WinnerPrimitiveInterpolation.create(device, { observe: true, accounting });
      const consume = await pipeline(`${winnerPrimitiveArenaConsumerWgsl()}
struct FrameView { viewport: vec2u, frame_at: u32, directory_at: u32, }
struct Result { weights: vec4f, dx: vec4f, dy: vec4f, }
@group(0) @binding(0) var<uniform> view: FrameView;
@group(0) @binding(1) var<storage, read> asset_metadata_heap: array<u32>;
@group(1) @binding(0) var visibility: texture_2d<u32>;
@group(1) @binding(1) var<storage, read_write> result: array<Result>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= view.viewport) { return; }
  let key = textureLoad(visibility, vec2i(id.xy), 0).x;
  let value = winner_arena_interpolate_key(key, vec2f(id.xy) + vec2f(0.5), vec2f(view.viewport), view.frame_at, view.directory_at);
  result[id.y * view.viewport.x + id.x] = Result(vec4f(value.weights, f32(value.flags)), vec4f(value.dx, 0.0), vec4f(value.dy, 0.0));
}`);
      const rasterModule = device.createShaderModule({ code: `
@group(0) @binding(0) var<storage, read> clips: array<vec4f>;
struct Vertex { @builtin(position) position: vec4f, @location(0) basis: vec3f, }
@vertex fn vertex(@builtin(vertex_index) id: u32) -> Vertex { var b = vec3f(0.0); b[id] = 1.0; return Vertex(clips[id], b); }
struct Fragment { @location(0) key: u32, @location(1) basis: vec4f, }
@fragment fn fragment(v: Vertex) -> Fragment { return Fragment(0u, vec4f(v.basis, 1.0)); }
` });
      const raster = await device.createRenderPipelineAsync({ layout: "auto", vertex: { module: rasterModule, entryPoint: "vertex" },
        fragment: { module: rasterModule, entryPoint: "fragment", targets: [{ format: "r32uint" }, { format: "rgba32float" }] },
        primitive: { topology: "triangle-list", cullMode: "none" } });
      const compilationError = await device.popErrorScope(); check(!compilationError, compilationError?.message);
      const base = [[-0.8, -0.7, 0.2, 1], [0.9, -0.5, 0.5, 1.5], [-0.1, 1.3, 0.9, 2]];
      const fixtures = [{ name: "perspective/resize/abort", clips: base, frames: 3 },
        { name: "near-clip", clips: [[-0.8, -0.7, -0.5, 1], ...base.slice(1)] },
        { name: "zero-w", clips: [[-0.5, -0.4, -0.5, 0], ...base.slice(1)] },
        { name: "negative-w", clips: [[-0.5, -0.4, -0.8, -0.3], ...base.slice(1)] }];
      for (const [fixtureIndex, fixture] of fixtures.entries()) {
        const width = fixtureIndex ? 80 : 64, height = fixtureIndex ? 48 : 32;
        const metadata = new Uint32Array(Array.from({ length: 59 }, (_, i) => (0xabc00000 + i) >>> 0));
        const arena = arenaOwner.prepare(buffer(metadata), metadata.byteLength, { workCapacity: 1, vertexCapacity: 3, triangleCapacity: 1,
          dictionaryCapacity: 16, coefficientCapacity: 8, probeLimit: 8, maxBytes: 16384 });
        device.queue.writeBuffer(arena.buffer, arena.sourceDirectory.offset, new Uint32Array([1, 0x7fffffff, 3, 1, 0, 0, 3, 1]));
        device.queue.writeBuffer(arena.buffer, arena.clips.offset, new Float32Array(fixture.clips.flat()));
        device.queue.writeBuffer(arena.buffer, arena.triangles.offset, new Uint32Array([0x020100]));
        const texture = format => { const t = device.createTexture({ size: [width, height], format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }); resources.push(t); return t; };
        const visibility = texture("r32uint"), basis = texture("rgba32float");
        const allocation = winner.prepare({ width, height, visibility: visibility.createView(), geometry: { directory: arena.sourceDirectory, clips: arena.clips, triangles: arena.triangles },
          storage: arena, budget: { dictionaryCapacity: 16, coefficientCapacity: 8, probeLimit: 8, maxBytes: 1024 } });
        const output = buffer(width * height * 48), rb = buffer(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        const row = Math.ceil(width * 16 / 256) * 256, basisRead = buffer(row * height, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        const metadataRead = buffer(metadata.byteLength, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        const rasterGroup = device.createBindGroup({ layout: raster.getBindGroupLayout(0), entries: [{ binding: 0, resource: arena.clips }] });
        const view = buffer(new Uint32Array([width, height, arena.layout.header.offset / 4, arena.sourceDirectory.offset / 4]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        const group = device.createBindGroup({ layout: consume.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: view } }, { binding: 1, resource: { buffer: arena.buffer } }] });
        const outputGroup = device.createBindGroup({ layout: consume.getBindGroupLayout(1), entries: [{ binding: 0, resource: visibility.createView() }, { binding: 1, resource: { buffer: output } }] });
        // An abandoned encoder is never submitted or committed.
        arenaOwner.encodeMetadataPublication(device.createCommandEncoder(), arena);
        for (let frame = 0; frame < (fixture.frames ?? 1); frame++) {
          device.pushErrorScope("validation"); const encoder = device.createCommandEncoder();
          const commit = arenaOwner.encodeMetadataPublication(encoder, arena);
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: visibility.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 } },
            { view: basis.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
          pass.setPipeline(raster); pass.setBindGroup(0, rasterGroup); pass.draw(3); pass.end();
          winner.encode(encoder, allocation);
          const compute = encoder.beginComputePass(); compute.setPipeline(consume); compute.setBindGroup(0, group); compute.setBindGroup(1, outputGroup);
          compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); compute.end();
          encoder.copyBufferToBuffer(output, 0, rb, 0, output.size); encoder.copyBufferToBuffer(arena.buffer, 0, metadataRead, 0, metadata.byteLength);
          encoder.copyTextureToBuffer({ texture: basis }, { buffer: basisRead, bytesPerRow: row }, [width, height]);
          device.queue.submit([encoder.finish()]); const error = await device.popErrorScope(); check(!error, error?.message); commit();
          const [values, hardware, meta] = await Promise.all([map(rb, Float32Array), map(basisRead, Float32Array), map(metadataRead, Uint32Array)]);
          check(meta.every((v, i) => v === metadata[i]), "Immutable metadata changed");
          let pixels = 0, maxSolveError = 0, maxGradientError = 0, maxHardwareError = 0;
          const clips = fixture.clips.map(p => p.map(Math.fround));
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 12, h = y * row / 4 + x * 4;
            if (!hardware[h + 3]) { check(values[at + 3] === 0, "Uncovered pixel must be invalid"); continue; }
            pixels++; const ref = homogeneousInterpolationReference(clips, [x + 0.5, y + 0.5], [width, height]);
            check(values[at + 3] === ref.flags, "Interpolation validity mismatch");
            for (let c = 0; c < 3; c++) {
              maxSolveError = Math.max(maxSolveError, Math.abs(values[at + c] - ref.weights[c]));
              maxHardwareError = Math.max(maxHardwareError, Math.abs(values[at + c] - hardware[h + c]));
              maxGradientError = Math.max(maxGradientError, Math.abs(values[at + 4 + c] - ref.dx[c]), Math.abs(values[at + 8 + c] - ref.dy[c]));
            }
          }
          check(pixels > 20 && maxSolveError < 0.00001 && maxGradientError < 0.000015 && maxHardwareError < 0.0003,
            JSON.stringify({ pixels, maxSolveError, maxGradientError, maxHardwareError }));
          cases.push({ name: fixture.name, frame, width, height, pixels, maxSolveError, maxGradientError, maxHardwareError,
            arenaBytes: arena.layout.byteLength, winnerOwnedBytes: allocation.byteLength });
        }
        winner.release(allocation); arenaOwner.release(arena);
      }
      check(errors.length === 0 && lost === null, JSON.stringify({ errors, lost }));
      check(accounting.snapshot().totalBytes === 0, "Arena and winner physical resources leaked");
      return { ...result, apiErrors: errors, deviceLost: lost, ownerBytesAfterRelease: accounting.snapshot().totalBytes, passed: true };
    } catch (error) { return { ...result, passed: false, error: String(error.stack ?? error), apiErrors: errors, deviceLost: lost }; }
    finally { disposing = true; winner?.destroy(); arenaOwner.destroy(); for (const r of resources) r.destroy(); device.destroy(); }
  });
  Object.assign(report, result); if (!report.passed) throw new Error(report.error ?? "Chrome arena GPU diagnostic failed");
} catch (error) { report.error = String(error.stack ?? error); throw error; }
finally { await writeFile(resolve(artifacts, "frame-geometry-arena-chrome.json"), JSON.stringify(report, null, 2));
  await browser?.close(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(report, null, 2));
