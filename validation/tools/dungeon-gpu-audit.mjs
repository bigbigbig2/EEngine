// Called through Playwright addInitScript. Only the explicitly enabled
// diagnostic example receives these observers. No render algorithm is changed.
export function installDungeonGpuAudit() {
  const records = [],
    byObject = new WeakMap(),
    views = new WeakMap();
  let device,
    latestVisibility,
    peakBytes = 0,
    bytes = 0;
  const calls = [],
    hashes = [];
  const originalDigest = SubtleCrypto.prototype.digest;
  SubtleCrypto.prototype.digest = function (algorithm, data) {
    const record = {
      at: performance.now(),
      bytes: data.byteLength,
      algorithm: typeof algorithm === "string" ? algorithm : algorithm.name
    };
    hashes.push(record);
    const promise = originalDigest.call(this, algorithm, data);
    promise.then(
      () => {
        record.elapsedMs = performance.now() - record.at;
      },
      () => {
        record.failed = true;
      }
    );
    return promise;
  };
  function textureBytes(t) {
    const blocks = {
      "bc7-rgba-unorm": [4, 4, 16],
      "bc7-rgba-unorm-srgb": [4, 4, 16],
      "bc4-r-unorm": [4, 4, 8]
    };
    const pixel = {
      r8unorm: 1,
      r8uint: 1,
      r16float: 2,
      r16uint: 2,
      rg8unorm: 2,
      r32float: 4,
      r32uint: 4,
      rg16float: 4,
      rgba8unorm: 4,
      "rgba8unorm-srgb": 4,
      bgra8unorm: 4,
      "bgra8unorm-srgb": 4,
      rg32uint: 8,
      rg32float: 8,
      rgba16float: 8,
      rgba32float: 16,
      rgba32uint: 16,
      depth32float: 4,
      rg11b10ufloat: 4,
      rgb10a2unorm: 4
    };
    const b = blocks[t.format] ?? (pixel[t.format] ? [1, 1, pixel[t.format]] : null);
    if (!b) return null;
    let n = 0;
    for (let mip = 0; mip < t.mipLevelCount; mip++)
      n +=
        Math.ceil(Math.max(1, t.width >> mip) / b[0]) *
        Math.ceil(Math.max(1, t.height >> mip) / b[1]) *
        (t.dimension === "3d" ? Math.max(1, t.depthOrArrayLayers >> mip) : t.depthOrArrayLayers) *
        b[2] *
        t.sampleCount;
    return n;
  }
  function add(value, kind, desc) {
    const size = kind === "buffer" ? value.size : textureBytes(value);
    const record = {
      id: records.length,
      kind,
      label: value.label,
      bytes: size,
      usage: value.usage,
      destroyed: false,
      at: performance.now(),
      ref: new WeakRef(value),
      ...(kind === "texture"
        ? {
            width: value.width,
            height: value.height,
            depthOrArrayLayers: value.depthOrArrayLayers,
            format: value.format,
            mipLevelCount: value.mipLevelCount,
            sampleCount: value.sampleCount
          }
        : {})
    };
    records.push(record);
    byObject.set(value, record);
    bytes += size ?? 0;
    peakBytes = Math.max(peakBytes, bytes);
  }
  for (const [method, kind] of [
    ["createBuffer", "buffer"],
    ["createTexture", "texture"]
  ]) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function (desc) {
      device = this;
      const value = original.call(this, desc);
      add(value, kind, desc);
      return value;
    };
  }
  for (const method of [
    "createBindGroup",
    "createRenderPipeline",
    "createComputePipeline",
    "createShaderModule",
    "createRenderPipelineAsync",
    "createComputePipelineAsync"
  ]) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function (desc) {
      const at = performance.now();
      const value = original.call(this, desc);
      const record = { method, label: desc.label ?? "", at, hostMs: performance.now() - at };
      calls.push(record);
      if (method.endsWith("Async"))
        value.then(
          () => {
            record.resolvedMs = performance.now() - at;
          },
          () => {
            record.rejectedMs = performance.now() - at;
          }
        );
      return value;
    };
  }
  for (const proto of [GPUBuffer.prototype, GPUTexture.prototype]) {
    const original = proto.destroy;
    proto.destroy = function () {
      const r = byObject.get(this);
      if (r && !r.destroyed) {
        r.destroyed = true;
        bytes -= r.bytes ?? 0;
      }
      return original.call(this);
    };
  }
  const originalView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (desc) {
    const view = originalView.call(this, desc);
    views.set(view, this);
    return view;
  };
  const originalPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
    for (const a of desc.colorAttachments ?? []) {
      const t = a && views.get(a.view);
      if (t?.format === "r32uint") latestVisibility = new WeakRef(t);
    }
    return originalPass.call(this, desc);
  };
  function live() {
    return records.filter((r) => !r.destroyed && r.ref.deref());
  }
  window.dungeonGpuAudit = {
    snapshot: () => ({
      bytes,
      peakBytes,
      calls,
      hashes,
      unknownFormats: live()
        .filter((r) => r.bytes === null)
        .map((r) => r.format),
      resources: records.map(({ ref, ...r }) => ({ ...r, alive: !!ref.deref() }))
    }),
    async vsmHeaders(diagnostics) {
      if (!diagnostics) return null;
      await device.queue.onSubmittedWorkDone();
      const copies = [
        ["demand", diagnostics.pageDemand.buffer, 0, 16],
        ["allocationFailures", diagnostics.allocationFailure.buffer, 0, 32],
        ["dirtyHeader", diagnostics.dirtyPages.buffer, 0, 16],
        ["casterHeader", diagnostics.casterRecords.buffer, 0, 32]
      ];
      const result = {};
      const encoder = device.createCommandEncoder({ label: "Diagnostic/VSM headers (paused)" });
      const staging = copies.map(([label, source, offset, size]) => {
        const buffer = device.createBuffer({
          label: `Diagnostic/${label}`,
          size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        encoder.copyBufferToBuffer(source, offset, buffer, 0, size);
        return buffer;
      });
      device.queue.submit([encoder.finish()]);
      await Promise.all(staging.map((b) => b.mapAsync(GPUMapMode.READ)));
      for (let i = 0; i < staging.length; i++) {
        const buffer = staging[i];
        result[copies[i][0]] = Array.from(new Uint32Array(buffer.getMappedRange()));
        buffer.unmap();
        buffer.destroy();
      }
      return result;
    },
    async coverage(instanceBegin, modelInstanceCount) {
      // The caller pauses rendering and drains the queue before this separate
      // diagnostic copy; no readback participates in production work control.
      const texture = latestVisibility?.deref();
      const queue = live()
        .find((r) => r.label === "S1 Product MeshletWork queue")
        ?.ref.deref();
      if (!texture || !queue) throw new Error("Live VisibilityKey / MeshletWork unavailable");
      await device.queue.onSubmittedWorkDone();
      const pitch = Math.ceil((texture.width * 4) / 256) * 256;
      const pixels = device.createBuffer({
        label: "Diagnostic/coverage pixels",
        size: pitch * texture.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const work = device.createBuffer({
        label: "Diagnostic/coverage work",
        size: queue.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = device.createCommandEncoder({ label: "Diagnostic/coverage copy (paused)" });
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: pixels, bytesPerRow: pitch, rowsPerImage: texture.height },
        { width: texture.width, height: texture.height }
      );
      encoder.copyBufferToBuffer(queue, 0, work, 0, queue.size);
      device.queue.submit([encoder.finish()]);
      await Promise.all([pixels.mapAsync(GPUMapMode.READ), work.mapAsync(GPUMapMode.READ)]);
      const p = new Uint32Array(pixels.getMappedRange()),
        q = new Uint32Array(work.getMappedRange());
      const perInstance = {},
        perMaterial = {};
      let model = 0,
        other = 0,
        empty = 0,
        invalid = 0;
      const bounds = { minX: texture.width, minY: texture.height, maxX: -1, maxY: -1 };
      for (let y = 0; y < texture.height; y++)
        for (let x = 0; x < texture.width; x++) {
          const key = p[(y * pitch) / 4 + x];
          if (key === 0xffffffff) {
            empty++;
            continue;
          }
          const slot = key & 0xffffff;
          if (key === 0xfffffffe || key >>> 24 > 127 || slot >= q[1]) {
            invalid++;
            continue;
          }
          const instance = q[8 + slot * 6],
            material = q[8 + slot * 6 + 3];
          perInstance[instance] = (perInstance[instance] ?? 0) + 1;
          perMaterial[material] = (perMaterial[material] ?? 0) + 1;
          if (instance >= instanceBegin && instance < instanceBegin + modelInstanceCount) {
            model++;
            bounds.minX = Math.min(bounds.minX, x);
            bounds.minY = Math.min(bounds.minY, y);
            bounds.maxX = Math.max(bounds.maxX, x);
            bounds.maxY = Math.max(bounds.maxY, y);
          } else other++;
        }
      const queueHeader = Array.from(q.slice(0, 8));
      pixels.unmap();
      work.unmap();
      pixels.destroy();
      work.destroy();
      return {
        width: texture.width,
        height: texture.height,
        model,
        other,
        empty,
        invalid,
        ratio: model / (texture.width * texture.height),
        bounds,
        perInstance,
        perMaterial,
        queueHeader
      };
    }
  };
}
