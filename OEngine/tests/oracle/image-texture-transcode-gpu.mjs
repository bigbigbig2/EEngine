import assert from "node:assert/strict";
import { ImageTextureTranscoder, imageGpuFormat } from "../../.test-dist/gpu/ImageTextureTranscoder.js";
import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { readImageTextureDirectory } from "../../.test-dist/assets/ImageTextureProduct.js";
import { imageTextureHash } from "../../.test-dist/assets/ImageTextureProduct.js";

const local = "/.local/extreme-web-asset/";
const shaderNames = {
  "bc7-rgb": "spark_bc7_rgb.wgsl",
  "bc7-rgba": "spark_bc7_rgba.wgsl",
  "bc5-rg": "spark_bc5_rg.wgsl",
  "bc4-r": "spark_bc4_r.wgsl",
  utils: "utils.wgsl"
};
const check = (value, message) => {
  if (!value) throw new Error(message);
};

function command(device) {
  const encoder = device.createCommandEncoder();
  const observers = [];
  return {
    gpu_encoder: encoder,
    observeSubmission(observer) {
      observers.push(observer);
    },
    submit() {
      device.queue.submit([encoder.finish()]);
      const fence = device.queue.onSubmittedWorkDone();
      for (const observer of observers) observer.submitted(fence);
      return fence;
    },
    abort() {
      for (const observer of observers) observer.aborted(new Error("oracle deliberate abort"));
    }
  };
}
function textureRead(
  device,
  encoder,
  texture,
  { layer = 0, x = 0, y = 0, width = texture.width, height = texture.height, format = texture.format } = {}
) {
  const bc = format.startsWith("bc"),
    unit = bc ? 4 : 1,
    bytes = bc ? (format.startsWith("bc4") ? 8 : 16) : 4;
  const rows = Math.ceil(height / unit),
    rowBytes = Math.ceil(width / unit) * bytes,
    pitch = Math.ceil(rowBytes / 256) * 256;
  const buffer = device.createBuffer({
    size: pitch * rows,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  encoder.copyTextureToBuffer(
    { texture, origin: { x, y, z: layer } },
    { buffer, bytesPerRow: pitch },
    { width: Math.ceil(width / unit) * unit, height: rows * unit }
  );
  return async () => {
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange()),
      result = new Uint8Array(rowBytes * rows);
    for (let row = 0; row < rows; row++)
      result.set(source.subarray(row * pitch, row * pitch + rowBytes), row * rowBytes);
    buffer.unmap();
    buffer.destroy();
    return result;
  };
}
function targets(device, directory, item) {
  const count = directory.planes[item.plane].mips === "runtime" ? directory.mipCount : 1;
  const result = [];
  let width = item.width,
    height = item.height;
  for (let level = 0; level < count; level++) {
    // Physical block storage independent of each logical level; exercise nonzero layer/origin/mip.
    const w = Math.ceil(width / 4) * 4,
      h = Math.ceil(height / 4) * 4;
    const texture = device.createTexture({
      size: [(w + 4) * 2, (h + 4) * 2, 3],
      mipLevelCount: 2,
      format: imageGpuFormat(directory.planes[item.plane].semantic),
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING
    });
    result.push({ texture, mip: 1, layer: 2, x: 4, y: 4, width, height });
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
  return result;
}
async function sampled(device, destination) {
  const module = device.createShaderModule({
    code: `
@group(0) @binding(0) var image: texture_2d_array<f32>;
@group(0) @binding(1) var<storage,read_write> output: array<vec4f>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${destination.width}u || id.y >= ${destination.height}u) { return; }
  output[id.y * ${destination.width}u + id.x] = textureLoad(image, vec2i(id.xy) + vec2i(4), 2, 1);
}`
  });
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" }
  });
  const output = device.createBuffer({
    size: destination.width * destination.height * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const read = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: destination.texture.createView({ dimension: "2d-array" }) },
        { binding: 1, resource: { buffer: output } }
      ]
    })
  );
  pass.dispatchWorkgroups(Math.ceil(destination.width / 8), Math.ceil(destination.height / 8));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, read, 0, output.size);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const values = new Float32Array(read.getMappedRange().slice(0));
  read.unmap();
  read.destroy();
  output.destroy();
  check(values.every(Number.isFinite), "Sampled BC material data must be finite");
  return values;
}
async function nativePngPixels(url) {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none"
  });
  const frame = new VideoFrame(bitmap, { timestamp: 0 });
  const data = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
  await frame.copyTo(data, { format: "RGBA" });
  frame.close();
  bitmap.close();
  return data;
}

export async function runImageTextureTranscodeGpuF16(device) {
  return runImageTextureTranscodeGpu(device, "f16");
}

export async function runImageTextureTranscodeGpu(device, precision = "f32") {
  const attribution = document.createElement("p");
  const attributionLink = document.createElement("a");
  attributionLink.href = "https://ludicon.com/sparkjs/";
  attributionLink.textContent = "Powered by spark.js";
  attribution.append(
    attributionLink,
    " - local engine evaluation only; downstream users are bound by the Spark EULA."
  );
  const licenseLink = document.createElement("a");
  licenseLink.href = "https://ludicon.com/sparkjs/eula.html";
  licenseLink.textContent = " Spark EULA";
  attribution.append(licenseLink);
  document.body.prepend(attribution);
  const sourceIdentity = await (await fetch(local + "sources.json")).json();
  const shaders = {};
  for (const [variant, name] of Object.entries(shaderNames)) {
    const bytes = new Uint8Array(
      await (await fetch(local + "sources/spark/src/shaders/" + name)).arrayBuffer()
    );
    check(
      (await imageTextureHash(bytes)) === sourceIdentity.sources.spark.files["src/shaders/" + name],
      "Pinned upstream shader changed"
    );
    shaders[variant] = new TextDecoder().decode(bytes);
  }
  const source = { revision: sourceIdentity.sources.spark.revision, scope: "local-evaluation", shaders };
  const { default: Spark } = await import("/.local/extreme-web-asset/sources/spark/src/spark.js");
  const spark = await Spark.create(device, { cacheTempResources: false });
  const transcoder = await ImageTextureTranscoder.create(device, source, { precision });
  const preparation = new CookedAssetPreparation({ maxWorkers: 2, maxEncodedBytes: 16 * 1024 * 1024 });
  const session = preparation.openSession();
  const cases = await (await fetch(local + "e1-fixtures/cases.json")).json();
  const results = [];
  let donorComparisons = 0,
    exactChecks = 0;
  for (const fixture of cases) {
    const baseUrl = new URL(local + "e1-fixtures/" + fixture.name + "/directory.json", location.href).href;
    const directory = readImageTextureDirectory(new Uint8Array(await (await fetch(baseUrl)).arrayBuffer()));
    await transcoder.prepare(directory.planes);
    for (const item of directory.items) {
      const plane = directory.planes[item.plane];
      const lease = await preparation.readImageItem(session, directory, item.id, baseUrl);
      const cmd = command(device);
      if (item.kind === "exact") {
        const texture = device.createTexture({
          size: [item.width + 3, item.height + 2, 2],
          format: "r8unorm",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
        });
        const expected = new Uint8Array(lease.result.bytes).slice();
        transcoder.recordExact(cmd, lease, { texture, mip: 0, layer: 1, x: 3, y: 2 });
        const pitch = 256,
          read = device.createBuffer({
            size: pitch * item.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
          });
        cmd.gpu_encoder.copyTextureToBuffer(
          { texture, origin: { x: 3, y: 2, z: 1 } },
          { buffer: read, bytesPerRow: pitch },
          { width: item.width, height: item.height }
        );
        await cmd.submit();
        await read.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(read.getMappedRange());
        for (let row = 0; row < item.height; row++)
          for (let x = 0; x < item.width; x++)
            assert.equal(bytes[row * pitch + x], expected[row * item.width + x], "exact coverage");
        exactChecks += expected.length;
        read.unmap();
        read.destroy();
        texture.destroy();
        continue;
      }
      const destinations = targets(device, directory, item);
      let readUpload, readCanonical;
      const decoder = new ImageDecoder({
        data: await (await fetch(new URL(item.uri, baseUrl))).arrayBuffer(),
        type: "image/avif",
        colorSpaceConversion: "none",
        preferAnimation: false
      });
      const decodedFrame = (await decoder.decode({ frameIndex: 0, completeFramesOnly: true })).image;
      const decoded = new Uint8Array(decodedFrame.allocationSize({ format: "RGBA" }));
      await decodedFrame.copyTo(decoded, { format: "RGBA" });
      decodedFrame.close();
      decoder.close();
      check(
        transcoder.record(cmd, lease, destinations, (encoder, upload, mips) => {
          readUpload = textureRead(device, encoder, upload);
          readCanonical = textureRead(device, encoder, mips[0]);
        }) === "recorded",
        "Record should be admitted"
      );
      const reads = destinations.map((destination) => {
        const pitch =
          Math.ceil((Math.ceil(destination.width / 4) * (plane.target === "bc4-r" ? 8 : 16)) / 256) * 256;
        const rows = Math.ceil(destination.height / 4),
          rowBytes = Math.ceil(destination.width / 4) * (plane.target === "bc4-r" ? 8 : 16);
        const buffer = device.createBuffer({
          size: pitch * rows,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        cmd.gpu_encoder.copyTextureToBuffer(
          { texture: destination.texture, mipLevel: 1, origin: { x: 4, y: 4, z: 2 } },
          { buffer, bytesPerRow: pitch },
          { width: Math.ceil(destination.width / 4) * 4, height: rows * 4 }
        );
        return async () => {
          await buffer.mapAsync(GPUMapMode.READ);
          const source = new Uint8Array(buffer.getMappedRange()),
            out = new Uint8Array(rowBytes * rows);
          for (let r = 0; r < rows; r++)
            out.set(source.subarray(r * pitch, r * pitch + rowBytes), r * rowBytes);
          buffer.unmap();
          buffer.destroy();
          return out;
        };
      });
      check(transcoder.evidence().busySlots === 1, "Scratch must remain busy before submission");
      await cmd.submit();
      const upload = await readUpload(),
        canonical = await readCanonical();
      // Decode->external copy must not alter any byte. Independent browser VideoFrame copyTo.
      if (plane.semantic !== "color-rgba") {
        assert.deepEqual([...upload], [...decoded], fixture.name + " decoded/upload byte identity");
      } else {
        // The independent VideoFrame->RGBA diagnostic conversion has different transparent
        // RGB rounding from the ImageBitmap upload; it is not a straight-RGB byte oracle.
        // Check alpha here and independent constant straight-RGB preservation separately.
        for (let pixel = 3; pixel < upload.length; pixel += 4)
          assert.equal(upload[pixel], decoded[pixel], "decoded/upload straight alpha");
      }
      for (let index = 0; index < canonical.length; index++) {
        const constant = plane.constants[index % 4];
        assert.equal(
          canonical[index],
          constant === null ? upload[index] : constant,
          "canonical constants restored"
        );
      }
      // Stock donor receives exactly the same restored base texels; no project shader generates expected BC.
      // Use the source texture directly so browser decode does not repeat premultiplication.
      if (item.width % 4 === 0 && item.height % 4 === 0) {
        const input = device.createTexture({
          size: [item.width, item.height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
        });
        device.queue.writeTexture(
          { texture: input },
          canonical,
          { bytesPerRow: item.width * 4 },
          { width: item.width, height: item.height }
        );
        const donorOutput = device.createTexture({
          size: [item.width, item.height],
          mipLevelCount: plane.mips === "runtime" ? directory.mipCount : 1,
          format: imageGpuFormat(plane.semantic),
          usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
        });
        const donor = await spark.encodeTexture(input, {
          format: plane.target,
          srgb: plane.semantic.startsWith("color-"),
          normal: plane.semantic === "normal-xy",
          mips: plane.mips === "runtime",
          mipmapCount: plane.mips === "runtime" ? directory.mipCount : 1,
          mipsAlphaScale: plane.alphaScales,
          outputTexture: donorOutput,
          outputMipLevel: 0
        });
        const encoder = device.createCommandEncoder();
        const donorReads = [];
        for (let level = 0; level < destinations.length; level++) {
          const d = destinations[level],
            row = Math.ceil(d.width / 4) * (plane.target === "bc4-r" ? 8 : 16),
            pitch = Math.ceil(row / 256) * 256,
            rows = Math.ceil(d.height / 4);
          const read = device.createBuffer({
            size: pitch * rows,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
          });
          encoder.copyTextureToBuffer(
            { texture: donor, mipLevel: level },
            { buffer: read, bytesPerRow: pitch },
            { width: Math.ceil(d.width / 4) * 4, height: rows * 4 }
          );
          donorReads.push({ read, row, pitch, rows });
        }
        device.queue.submit([encoder.finish()]);
        for (let level = 0; level < destinations.length; level++) {
          const { read, row, pitch, rows } = donorReads[level];
          await read.mapAsync(GPUMapMode.READ);
          const data = new Uint8Array(read.getMappedRange()),
            expected = new Uint8Array(row * rows);
          for (let r = 0; r < rows; r++) expected.set(data.subarray(r * pitch, r * pitch + row), r * row);
          assert.deepEqual(
            [...(await reads[level]())],
            [...expected],
            fixture.name + " stock donor BC mip " + level
          );
          read.unmap();
          read.destroy();
          donorComparisons++;
        }
        donor.destroy();
        input.destroy();
      } else {
        for (const read of reads) await read();
      }
      const samples = await sampled(device, destinations[0]);
      if (plane.semantic === "normal-xy") {
        for (let i = 0; i < samples.length; i += 4) {
          const x = samples[i] * 2 - 1,
            y = samples[i + 1] * 2 - 1,
            z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
          check(Number.isFinite(z) && z >= 0, "BC5 reconstructs positive normal hemisphere");
        }
      }
      results.push({
        name: fixture.name,
        item: item.id,
        mips: destinations.length,
        format: imageGpuFormat(plane.semantic)
      });
      for (const d of destinations) d.texture.destroy();
    }
  }
  // Actual parallel preparation and scratch held by two unsubmitted commands cannot overwrite one another.
  const url = new URL(local + "e1-fixtures/data-rgb-high/directory.json", location.href).href;
  const directory = readImageTextureDirectory(new Uint8Array(await (await fetch(url)).arrayBuffer()));
  const [a, b] = await Promise.all([
    preparation.readImageItem(session, directory, 0, url),
    preparation.readImageItem(session, directory, 0, url)
  ]);
  const ca = command(device),
    cb = command(device),
    da = targets(device, directory, directory.items[0]),
    db = targets(device, directory, directory.items[0]);
  transcoder.record(ca, a, da);
  transcoder.record(cb, b, db);
  check(transcoder.evidence().busySlots === 2, "Unsubmitted commands need exclusive slots");
  ca.abort();
  check(transcoder.evidence().busySlots === 1, "Abort returns only its own slot");
  await cb.submit();
  check(transcoder.evidence().busySlots === 0, "Submission fence retires remaining slot");
  for (const d of [...da, ...db]) d.texture.destroy();
  const scalarUrl = new URL(local + "e1-fixtures/scalar-r-high/directory.json", location.href).href;
  const scalarDir = readImageTextureDirectory(new Uint8Array(await (await fetch(scalarUrl)).arrayBuffer()));
  const [rgbLease, scalarLease] = await Promise.all([
    preparation.readImageItem(session, directory, 0, url),
    preparation.readImageItem(session, scalarDir, 0, scalarUrl)
  ]);
  const rgbCommand = command(device),
    scalarCommand = command(device);
  const rgbDest = targets(device, directory, directory.items[0]),
    scalarDest = targets(device, scalarDir, scalarDir.items[0]);
  let rgbUpload, scalarUpload;
  transcoder.record(rgbCommand, rgbLease, rgbDest, (encoder, upload) => {
    rgbUpload = textureRead(device, encoder, upload);
  });
  transcoder.record(scalarCommand, scalarLease, scalarDest, (encoder, upload) => {
    scalarUpload = textureRead(device, encoder, upload);
  });
  // Submit opposite to recording order: independent uploads/uniforms must not alias.
  await scalarCommand.submit();
  await rgbCommand.submit();
  const rgbBytes = await rgbUpload(),
    scalarBytes = await scalarUpload();
  check(
    rgbBytes.some((value, index) => value !== scalarBytes[index]),
    "Two different unsubmitted images preserve independent backing"
  );
  for (let index = 0; index < scalarBytes.length; index += 4) {
    assert.equal(
      scalarBytes[index],
      scalarBytes[index + 1],
      "Scalar replicated channel survives parallel upload"
    );
    assert.equal(
      scalarBytes[index],
      scalarBytes[index + 2],
      "Scalar replicated channel survives parallel upload"
    );
  }
  for (const d of [...rgbDest, ...scalarDest]) d.texture.destroy();
  const retry = await preparation.readImageItem(session, directory, 0, url);
  retry.close();
  retry.close();
  const abort = new AbortController();
  const pending = preparation.readImageItem(session, directory, 0, url, abort.signal);
  abort.abort();
  let cancelled = false;
  try {
    await pending;
  } catch {
    cancelled = true;
  }
  check(cancelled, "Cancelled preparation must reject");
  const malformed = structuredClone(directory);
  malformed.items[0].sha256 = "0".repeat(64);
  let corrupt = false;
  try {
    await preparation.readImageItem(session, malformed, 0, url);
  } catch {
    corrupt = true;
  }
  check(corrupt, "Corrupt source must fail before decode");
  check(preparation.evidence().credit.used.total === 0, "All CPU credits returned");
  const small = await ImageTextureTranscoder.create(device, source, { precision, maxRgbaBytes: 2400 });
  await small.prepare(directory.planes);
  const [first, second] = await Promise.all([
    preparation.readImageItem(session, directory, 0, url),
    preparation.readImageItem(session, directory, 0, url)
  ]);
  const firstCmd = command(device),
    secondCmd = command(device),
    firstDest = targets(device, directory, directory.items[0]),
    secondDest = targets(device, directory, directory.items[0]);
  check(small.record(firstCmd, first, firstDest) === "recorded", "One complete task fits bounded pool");
  check(
    small.record(secondCmd, second, secondDest) === "needs-drain",
    "Pool pressure must return needs-drain without consuming ready lease"
  );
  firstCmd.abort();
  check(
    small.record(secondCmd, second, secondDest) === "recorded",
    "Drain permits retry using still-live ready lease"
  );
  secondCmd.abort();
  small.dispose();
  for (const d of [...firstDest, ...secondDest]) d.texture.destroy();
  const tooSmall = await ImageTextureTranscoder.create(device, source, { precision, maxRgbaBytes: 8 });
  const oversized = await preparation.readImageItem(session, directory, 0, url),
    tooCmd = command(device),
    tooDest = targets(device, directory, directory.items[0]);
  let oom = false;
  try {
    tooSmall.record(tooCmd, oversized, tooDest);
  } catch {
    oom = true;
  }
  check(oom, "Impossible complete task rejects before GPU allocation");
  oversized.close();
  tooCmd.abort();
  tooSmall.dispose();
  for (const d of tooDest) d.texture.destroy();
  // Independent constant-image alpha test: no lossy-RGB tolerance and transparent RGB is not zeroed.
  const alphaDirUrl = new URL(local + "e1-fixtures/alpha-constant/directory.json", location.href).href;
  const alphaDir = readImageTextureDirectory(new Uint8Array(await (await fetch(alphaDirUrl)).arrayBuffer()));
  await transcoder.prepare(alphaDir.planes);
  const alphaLease = await preparation.readImageItem(session, alphaDir, 0, alphaDirUrl),
    alphaCmd = command(device),
    alphaDest = targets(device, alphaDir, alphaDir.items[0]);
  let alphaRead;
  transcoder.record(alphaCmd, alphaLease, alphaDest, (encoder, upload) => {
    alphaRead = textureRead(device, encoder, upload);
  });
  await alphaCmd.submit();
  const alphaPixels = await alphaRead();
  for (let i = 0; i < alphaPixels.length; i += 4)
    assert.deepEqual(
      [...alphaPixels.subarray(i, i + 4)],
      [255, 0, 0, 128],
      "Straight transparent RGB/alpha retained"
    );
  for (const d of alphaDest) d.texture.destroy();
  const fragment = await ImageTextureTranscoder.create(device, source, { precision, mipProfile: "fragment" });
  await fragment.prepare(directory.planes);
  const fragmentLease = await preparation.readImageItem(session, directory, 0, url),
    fragmentCmd = command(device),
    fragmentDest = targets(device, directory, directory.items[0]);
  check(
    fragment.record(fragmentCmd, fragmentLease, fragmentDest) === "recorded",
    "Fragment host profile records complete RGB mips"
  );
  await fragmentCmd.submit();
  await sampled(device, fragmentDest[0]);
  fragment.dispose();
  for (const d of fragmentDest) d.texture.destroy();
  const alphaRejected = await preparation.readImageItem(session, alphaDir, 0, alphaDirUrl),
    alphaRejectCmd = command(device),
    alphaRejectDest = targets(device, alphaDir, alphaDir.items[0]);
  const fragmentReject = await ImageTextureTranscoder.create(device, source, {
    precision,
    mipProfile: "fragment"
  });
  let unsupported = false;
  try {
    fragmentReject.record(alphaRejectCmd, alphaRejected, alphaRejectDest);
  } catch {
    unsupported = true;
  }
  check(unsupported, "Fragment alpha semantics require provided chain, not silently simplified filtering");
  alphaRejected.close();
  alphaRejectCmd.abort();
  fragmentReject.dispose();
  for (const d of alphaRejectDest) d.texture.destroy();
  const retired = await preparation.readImageItem(session, directory, 0, url);
  preparation.releaseImageDirectory(session, directory);
  let closed = false;
  try {
    transcoder.record(command(device), retired, []);
  } catch {
    closed = true;
  }
  check(closed, "Source retirement invalidates ready lease");
  const restarted = await preparation.readImageItem(session, directory, 0, url);
  restarted.close();
  const ended = preparation.openSession(),
    unfinished = preparation.readImageItem(ended, directory, 0, url);
  preparation.closeSession(ended);
  let sessionCancelled = false;
  try {
    await unfinished;
  } catch {
    sessionCancelled = true;
  }
  check(sessionCancelled, "Session retirement cancels incomplete decode");
  const replacementAdapter = await navigator.gpu.requestAdapter();
  const lostDevice = await replacementAdapter.requestDevice({
    requiredFeatures: ["texture-compression-bc", ...(precision === "f16" ? ["shader-f16"] : [])]
  });
  const lossOwner = await ImageTextureTranscoder.create(lostDevice, source, { precision });
  await lossOwner.prepare(directory.planes);
  const lossLease = await preparation.readImageItem(session, directory, 0, url);
  const lossCommand = command(lostDevice),
    lossDest = targets(lostDevice, directory, directory.items[0]);
  lossOwner.record(lossCommand, lossLease, lossDest);
  lostDevice.destroy();
  await lostDevice.lost;
  await Promise.resolve();
  check(
    lossOwner.evidence().rgbaBytes === 0 && lossOwner.evidence().scratchBytes === 0,
    "Device loss retires unsubmitted scratch"
  );
  lossCommand.abort();
  for (const d of lossDest) d.texture.destroy();
  const evidence = transcoder.evidence();
  transcoder.dispose();
  preparation.closeSession(session);
  preparation.dispose();
  spark.dispose();
  check(
    transcoder.evidence().rgbaBytes === 0 && transcoder.evidence().scratchBytes === 0,
    "GPU scratch released on disposal"
  );
  return {
    scope: "E1 isolated local evaluation; no production adoption or quality/performance qualification",
    precision: transcoder.precision,
    products: cases.length,
    imageItems: results.length,
    donorComparisons,
    exactChecks,
    results,
    evidence,
    lifecycle: {
      parallelUnsubmitted: true,
      abort: true,
      fence: true,
      retry: true,
      cancel: true,
      corrupt: true,
      needsDrain: true,
      oom: true,
      straightAlpha: true,
      fragmentProfile: true,
      sourceRetire: true,
      sessionRetire: true,
      deviceLoss: true,
      cpuCreditZero: true,
      gpuScratchZero: true
    }
  };
}
