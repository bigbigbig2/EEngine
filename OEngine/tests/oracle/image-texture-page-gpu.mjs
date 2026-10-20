import assert from "node:assert/strict";
import { ImageTextureTranscoder } from "../../.test-dist/gpu/ImageTextureTranscoder.js";
import { CookedAssetPreparation } from "../../.test-dist/assets/codec/CookedAssetPreparation.js";
import { readImageTextureDirectory, imageTextureHash } from "../../.test-dist/assets/ImageTextureProduct.js";
import { ImageTexturePages } from "../../.test-dist/assets/ImageTexturePages.js";
import { ImageTextureSource } from "../../.test-dist/assets/ImageTextureSource.js";

const local = "/.local/extreme-web-asset/";
function command(device) {
  const observers = [];
  const gpu_encoder = device.createCommandEncoder();
  return {
    gpu_encoder,
    observeSubmission(observer) {
      observers.push(observer);
    },
    submit() {
      device.queue.submit([gpu_encoder.finish()]);
      const fence = device.queue.onSubmittedWorkDone();
      for (const observer of observers) observer.submitted(fence);
      return fence;
    },
    abort() {
      for (const observer of observers) observer.aborted(new Error("page oracle abort"));
    }
  };
}
function readTexture(device, encoder, texture, width, height, compressed = false, origin = [0, 0, 0]) {
  const row = compressed ? Math.ceil(width / 4) * 16 : width * 4;
  const rows = compressed ? Math.ceil(height / 4) : height;
  const pitch = Math.ceil(row / 256) * 256;
  const buffer = device.createBuffer({
    size: pitch * rows,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  encoder.copyTextureToBuffer({ texture, origin }, { buffer, bytesPerRow: pitch }, [width, height]);
  return async () => {
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange());
    const output = new Uint8Array(row * rows);
    for (let y = 0; y < rows; y++) output.set(bytes.subarray(y * pitch, y * pitch + row), y * row);
    buffer.unmap();
    buffer.destroy();
    return output;
  };
}
const address = (value, size, mode) => {
  if (mode === "clamp-to-edge") return Math.max(0, Math.min(size - 1, value));
  const cycle = Math.floor(value / size);
  const position = value - cycle * size;
  return mode === "repeat" || cycle % 2 === 0 ? position : size - position - 1;
};

export async function runImageTexturePageGpuF16(device) {
  return runImageTexturePageGpu(device, "f16");
}

export async function runImageTexturePageGpu(device, precision = "f32") {
  const attribution = document.createElement("p");
  attribution.textContent =
    "Powered by spark.js - local engine evaluation only. Downstream users are bound by https://ludicon.com/sparkjs/eula.html";
  document.body.prepend(attribution);
  const identity = await (await fetch(local + "sources.json")).json();
  const shaders = {};
  for (const [variant, name] of Object.entries({
    "bc7-rgb": "spark_bc7_rgb.wgsl",
    "bc7-rgba": "spark_bc7_rgba.wgsl",
    "bc5-rg": "spark_bc5_rg.wgsl",
    "bc4-r": "spark_bc4_r.wgsl",
    utils: "utils.wgsl"
  })) {
    const bytes = new Uint8Array(
      await (await fetch(local + "sources/spark/src/shaders/" + name)).arrayBuffer()
    );
    assert.equal(await imageTextureHash(bytes), identity.sources.spark.files["src/shaders/" + name]);
    shaders[variant] = new TextDecoder().decode(bytes);
  }
  const source = { revision: identity.sources.spark.revision, scope: "local-evaluation", shaders };
  const transcoder = await ImageTextureTranscoder.create(device, source, { precision });
  const { default: Spark } = await import(local + "sources/spark/src/spark.js");
  const spark = await Spark.create(device, { cacheTempResources: false });
  const preparation = new CookedAssetPreparation({ maxWorkers: 2, maxEncodedBytes: 16 * 1024 * 1024 });
  const session = preparation.openSession();
  let pagesChecked = 0;
  let exactTexelBytes = 0;
  let maxDependencies = 0;
  let overlapBlocks = 0;
  let exactCoverageBytes = 0;
  let pressureChecks = 0;
  try {
    const fixtures = await (await fetch(local + "e2-page-fixtures/cases.json")).json();
    for (const fixture of fixtures) {
      const url = new URL(local + "e2-page-fixtures/" + fixture.name + "/directory.json", location.href).href;
      const directoryBytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const imageSource = await ImageTextureSource.open(
        url,
        await imageTextureHash(directoryBytes),
        directoryBytes.length,
        undefined,
        preparation
      );
      const index = imageSource.pages;
      for (const mip of [0, 8]) {
        const page = index.page(1, mip, 0, 0);
        const leases = await imageSource.readPage(page);
        const sourceBytes = leases.map((lease) => new Uint8Array(lease.result.bytes).slice());
        const texture = device.createTexture({
          size: [152, 152, 2],
          format: "r8unorm",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
        });
        const cmd = command(device);
        assert.equal(
          transcoder.recordPage(cmd, leases, page, { texture, mip: 0, layer: 1, x: 4, y: 4 }),
          "recorded"
        );
        const read = device.createBuffer({
          size: 256 * 144,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        cmd.gpu_encoder.copyTextureToBuffer(
          { texture, origin: [4, 4, 1] },
          { buffer: read, bytesPerRow: 256 },
          [144, 144]
        );
        await cmd.submit();
        await read.mapAsync(GPUMapMode.READ);
        const result = new Uint8Array(read.getMappedRange());
        const plane = index.directory.planes[1];
        for (let y = 0; y < 144; y++) {
          for (let x = 0; x < 144; x++) {
            const sx = address(x - 8, page.logicalWidth, plane.addressU);
            const sy = address(y - 8, page.logicalHeight, plane.addressV);
            const owner = leases.findIndex(
              (lease) =>
                sx >= lease.item.x &&
                sy >= lease.item.y &&
                sx < lease.item.x + lease.item.width &&
                sy < lease.item.y + lease.item.height
            );
            assert.ok(owner >= 0);
            const item = leases[owner].item;
            assert.equal(
              result[y * 256 + x],
              sourceBytes[owner][(sy - item.y) * item.width + sx - item.x],
              "exact R8 addressed coverage"
            );
            exactCoverageBytes++;
          }
        }
        read.unmap();
        read.destroy();
        texture.destroy();
        assert.equal(preparation.evidence().credit.used.total, 0);
      }
      let previousBlocks;
      for (const [mip, x, y] of [
        [0, 0, 0],
        [0, 1, 0],
        [0, 3, 3],
        [0, 1, 1],
        [3, 0, 0],
        [8, 0, 0]
      ]) {
        const page = index.page(0, mip, x, y);
        maxDependencies = Math.max(maxDependencies, page.owners.length);
        const leases = await imageSource.readPage(page);
        assert.equal(leases.length, page.owners.length);
        const output = device.createTexture({
          size: [152, 152, 2],
          format: "bc7-rgba-unorm",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING
        });
        const cmd = command(device);
        // Read each independent browser-uploaded owner before the production assembler.
        const ownerReads = [];
        const uploaded = [];
        for (const lease of leases) {
          const texture = device.createTexture({
            size: [lease.item.width, lease.item.height],
            format: "rgba8unorm",
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
          });
          device.queue.copyExternalImageToTexture(
            { source: lease.result.image },
            { texture, colorSpace: "srgb", premultipliedAlpha: false },
            [lease.item.width, lease.item.height]
          );
          ownerReads.push(readTexture(device, cmd.gpu_encoder, texture, lease.item.width, lease.item.height));
          uploaded.push(texture);
        }
        let assembledRead;
        assert.equal(
          transcoder.recordPage(
            cmd,
            leases,
            page,
            { texture: output, mip: 0, layer: 1, x: 4, y: 4 },
            (encoder, _upload, mips) => {
              assembledRead = readTexture(device, encoder, mips[0], 144, 144);
            }
          ),
          "recorded"
        );
        const blockRead = readTexture(device, cmd.gpu_encoder, output, 144, 144, true, [4, 4, 1]);
        await cmd.submit();
        const ownerBytes = await Promise.all(ownerReads.map((read) => read()));
        const assembled = await assembledRead();
        const expected = new Uint8Array(144 * 144 * 4);
        const plane = index.directory.planes[0];
        for (let dy = 0; dy < 144; dy++) {
          for (let dx = 0; dx < 144; dx++) {
            const sx = address(x * 128 + dx - 8, page.logicalWidth, plane.addressU);
            const sy = address(y * 128 + dy - 8, page.logicalHeight, plane.addressV);
            const ownerIndex = leases.findIndex(
              (lease) =>
                sx >= lease.item.x &&
                sy >= lease.item.y &&
                sx < lease.item.x + lease.item.width &&
                sy < lease.item.y + lease.item.height
            );
            assert.ok(ownerIndex >= 0);
            const item = leases[ownerIndex].item;
            const offset = ((sy - item.y) * item.width + sx - item.x) * 4;
            for (let c = 0; c < 4; c++) {
              expected[(dy * 144 + dx) * 4 + c] = plane.constants[c] ?? ownerBytes[ownerIndex][offset + c];
            }
          }
        }
        assert.deepEqual(assembled, expected, fixture.name + " exact addressed owner texels");
        exactTexelBytes += expected.length;
        const input = device.createTexture({
          size: [144, 144],
          format: "rgba8unorm",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
        });
        device.queue.writeTexture({ texture: input }, expected, { bytesPerRow: 144 * 4 }, [144, 144]);
        const donorOutput = device.createTexture({
          size: [144, 144],
          format: "bc7-rgba-unorm",
          usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
        });
        await spark.encodeTexture(input, {
          format: "bc7-rgb",
          mips: false,
          srgb: false,
          outputTexture: donorOutput
        });
        const donorCommand = command(device);
        const donorRead = readTexture(device, donorCommand.gpu_encoder, donorOutput, 144, 144, true);
        await donorCommand.submit();
        const blocks = await blockRead();
        assert.deepEqual(blocks, await donorRead(), "page complete faithful donor BC output");
        if (mip === 0 && x === 0 && y === 0) {
          previousBlocks = blocks;
        }
        if (mip === 0 && x === 1 && y === 0) {
          // 128-texel interior shifts by exactly 32 BC blocks. The 16-texel
          // overlapping gutter/interior must be byte-identical, not just similar.
          for (let row = 0; row < 36; row++) {
            assert.deepEqual(
              previousBlocks.subarray((row * 36 + 32) * 16, (row * 36 + 36) * 16),
              blocks.subarray(row * 36 * 16, (row * 36 + 4) * 16),
              "adjacent page overlapping blocks have one decoded owner"
            );
            overlapBlocks += 4;
          }
        }
        assert.equal(preparation.evidence().credit.used.total, 0);
        for (const texture of [...uploaded, output, input, donorOutput]) texture.destroy();
        pagesChecked++;
      }
      const pressured = await ImageTextureTranscoder.create(device, source, {
        precision,
        maxRgbaBytes: Math.floor((index.page(0, 0, 0, 0).decodedBytes + 144 * 144 * 4) * 1.5)
      });
      const pressurePage = index.page(0, 0, 0, 0);
      const a = await imageSource.readPage(pressurePage);
      const b = await imageSource.readPage(pressurePage);
      const target = device.createTexture({
        size: [144, 144],
        format: "bc7-rgba-unorm",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
      });
      const destination = { texture: target, mip: 0, layer: 0, x: 0, y: 0 };
      const first = command(device);
      const second = command(device);
      assert.equal(pressured.recordPage(first, a, pressurePage, destination), "recorded");
      assert.equal(pressured.recordPage(second, b, pressurePage, destination), "needs-drain");
      assert.ok(preparation.evidence().credit.used.ready > 0, "backpressure keeps complete CPU inputs live");
      first.abort();
      assert.equal(pressured.recordPage(second, b, pressurePage, destination), "recorded");
      await second.submit();
      assert.equal(pressured.evidence().busySlots, 0);
      assert.equal(preparation.evidence().credit.used.total, 0);
      pressured.dispose();
      assert.equal(pressured.evidence().rgbaBytes, 0);
      assert.equal(pressured.evidence().scratchBytes, 0);
      target.destroy();
      pressureChecks++;
      imageSource.close();
      assert.equal(preparation.evidence().imageDirectoryBytes, 0);
    }
    assert.equal(maxDependencies, 16);
    return {
      scope: "E2 isolated owner assembly, not production cutover",
      precision,
      pagesChecked,
      maxDependencies,
      exactTexelBytes,
      overlapBlocks,
      exactCoverageBytes,
      pressureChecks
    };
  } finally {
    preparation.closeSession(session);
    preparation.dispose();
    transcoder.dispose();
  }
}
