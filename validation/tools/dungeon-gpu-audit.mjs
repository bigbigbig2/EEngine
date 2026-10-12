// Called through Playwright addInitScript. Only the explicitly enabled
// diagnostic example receives these observers. No render algorithm is changed.
export function installDungeonGpuAudit(options = {}) {
  const temporalCaptureEnabled = options.temporalCapture === true;
  const shaderSources = [];
  const temporalGroups = new WeakMap();
  const temporalPasses = new WeakMap();
  const temporalCopies = new Map();
  let temporalArmed = false;
  let temporalReady = false;
  const records = [],
    byObject = new WeakMap(),
    views = new WeakMap();
  let device,
    latestVisibility,
    depthReceiverDiagnostics = false,
    peakBytes = 0,
    bytes = 0;
  const calls = [],
    hashes = [],
    nativeCostSlices = new Set();
  const capacityOwners = new Map();
  let ownersAtPeak = {};
  // Allocation ownership, not the pass that happens to use a pooled resource.
  function allocationOwner(label) {
    if (/^OEngine Geometry Product .* bank \d+$/.test(label)) return "geometry-banks";
    if (/^OEngine Geometry Product .*metadata heap/.test(label)) return "geometry-metadata";
    if (/^Geometry Page Demand readback/.test(label)) return "geometry-readback";
    if (!label) return "unlabelled-external";
    return label.split("/")[0];
  }
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
      allocationOwner: allocationOwner(value.label),
      // Cold diagnostic provenance for resources not labelled by their owner.
      // Retain the raw stack; an address/size heuristic is not ownership proof.
      ...(!value.label ? { allocationStack: new Error().stack } : {}),
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
    const owner = capacityOwners.get(record.allocationOwner) ?? { bytes: 0, peakBytes: 0, count: 0 };
    owner.bytes += size ?? 0;
    owner.count++;
    owner.peakBytes = Math.max(owner.peakBytes, owner.bytes);
    capacityOwners.set(record.allocationOwner, owner);
    if (bytes > peakBytes) {
      peakBytes = bytes;
      ownersAtPeak = Object.fromEntries([...capacityOwners].map(([name, owner]) => [name, owner.bytes]));
    }
  }
  for (const [method, kind] of [
    ["createBuffer", "buffer"],
    ["createTexture", "texture"]
  ]) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function (desc) {
      device = this;
      // Diagnostic-only readback of query identity and invalidation facts.
      let observedDesc =
        method === "createBuffer" && /(?:\/pageConstants$|^VSM\/[^/]+\/generation$)/.test(desc.label ?? "")
          ? { ...desc, usage: desc.usage | GPUBufferUsage.COPY_SRC }
          : desc;
      if (temporalCaptureEnabled) {
        if (method === "createTexture") {
          observedDesc = { ...observedDesc, usage: observedDesc.usage | GPUTextureUsage.COPY_SRC };
        } else if (!(observedDesc.usage & (GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE))) {
          observedDesc = { ...observedDesc, usage: observedDesc.usage | GPUBufferUsage.COPY_SRC };
        }
      }
      const value = original.call(this, observedDesc);
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
      if (method === "createShaderModule") {
        if (options.shaderCapture === true) shaderSources.push({ label: desc.label ?? "", code: desc.code });
        if (desc.label === "VSM/Directional Shadow Resolve" && desc.code.includes("depth_derived")) {
          depthReceiverDiagnostics = true;
        }
        const slice = /Native cost slice: (Q0|B0|[A-GK])\b/.exec(desc.code)?.[1];
        if (slice) nativeCostSlices.add(slice);
      }
      const at = performance.now();
      const value = original.call(this, desc);
      if (temporalCaptureEnabled && method === "createBindGroup") temporalGroups.set(value, desc.entries);
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
        const owner = capacityOwners.get(r.allocationOwner);
        owner.bytes -= r.bytes ?? 0;
        owner.count--;
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
  if (temporalCaptureEnabled) {
    const begin = GPUCommandEncoder.prototype.beginComputePass;
    GPUCommandEncoder.prototype.beginComputePass = function (desc = {}) {
      const pass = begin.call(this, desc);
      temporalPasses.set(pass, { encoder: this, label: desc.label, entries: null });
      return pass;
    };
    const bind = GPUComputePassEncoder.prototype.setBindGroup;
    GPUComputePassEncoder.prototype.setBindGroup = function (...args) {
      const record = temporalPasses.get(this);
      if (record && args[0] === 0) record.entries = temporalGroups.get(args[1]);
      return bind.apply(this, args);
    };
    const end = GPUComputePassEncoder.prototype.end;
    GPUComputePassEncoder.prototype.end = function () {
      end.call(this);
      const pass = temporalPasses.get(this);
      if (!temporalArmed || !pass?.entries) return;
      const fields = {
        "Native Temporal V2/Measure": [[0, "frame"], [1, "color"], [4, "seed"], [6, "weights"]],
        "Native Temporal V2/Exposure": [[2, "previousFrameInfo"]],
        "Native Temporal V2/Shading Pyramid": [[3, "previousLuma"], [5, "preExposure"], [6, "priorExposure"], [7, "response"]],
        "Native Temporal V2/Analyze": [[8, "identity"], [9, "previousIdentity"], [10, "previousDepth"], [13, "previousConfidence"]],
        "Native Temporal V2/Resolve": [[4, "previousColor"], [11, "previousLumaHistory"]],
      }[pass.label];
      if (!fields) return;
      for (const [binding, name] of fields) {
        if (temporalCopies.has(name)) continue;
        const entry = pass.entries.find((entry) => entry.binding === binding);
        if (!entry) throw new Error(`Temporal capture omits ${name}`);
        const sourceTexture = views.get(entry.resource);
        let metadata;
        if (sourceTexture) {
          const stride = { r8unorm: 1, r16float: 2, r32float: 4, rgba8unorm: 4, rgba16float: 8, rgba32float: 16, rgba32uint: 16 }[sourceTexture.format];
          if (!stride) throw new Error(`Temporal capture cannot encode ${sourceTexture.format}`);
          const bytesPerRow = Math.ceil(sourceTexture.width * stride / 256) * 256;
          metadata = { name, format: sourceTexture.format, width: sourceTexture.width, height: sourceTexture.height, stride, bytesPerRow, bytes: bytesPerRow * sourceTexture.height };
        } else {
          const sourceBuffer = entry.resource.buffer;
          const bytes = entry.resource.size ?? sourceBuffer.size - (entry.resource.offset ?? 0);
          metadata = { name, bytes, offset: entry.resource.offset ?? 0 };
        }
        const destination = device.createBuffer({ label: `Diagnostic/Temporal capture ${name}`, size: metadata.bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        if (sourceTexture) {
          pass.encoder.copyTextureToBuffer({ texture: sourceTexture }, { buffer: destination, bytesPerRow: metadata.bytesPerRow }, [metadata.width, metadata.height]);
        } else {
          pass.encoder.copyBufferToBuffer(entry.resource.buffer, metadata.offset, destination, 0, metadata.bytes);
        }
        temporalCopies.set(name, { destination, metadata });
      }
      if (pass.label === "Native Temporal V2/Resolve") {
        temporalArmed = false;
        temporalReady = true;
      }
    };
  }
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
    shaderSources: () => shaderSources,
    armTemporalCapture() {
      if (!temporalCaptureEnabled || temporalArmed || temporalCopies.size) throw new Error("Temporal capture is unavailable or already used");
      temporalArmed = true;
    },
    temporalCaptureStatus: () => ({ ready: temporalReady, products: [...temporalCopies.values()].map((entry) => entry.metadata) }),
    async readTemporalCapture(name) {
      if (!temporalReady) throw new Error("Temporal capture is incomplete");
      const entry = temporalCopies.get(name);
      if (!entry) throw new Error(`Temporal capture omits ${name}`);
      await entry.destination.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(entry.destination.getMappedRange());
      let encoded = "";
      for (let start = 0; start < data.length; start += 0x6000) encoded += btoa(String.fromCharCode(...data.subarray(start, start + 0x6000)));
      entry.destination.unmap();
      entry.destination.destroy();
      return encoded;
    },
    async nativeQueryStatistics() {
      const texture = live()
        .find((r) => r.label === "Diagnostic/Native VSM query keys")
        ?.ref.deref();
      if (!texture) throw new Error("Native query diagnostic product was not compiled");
      await device.queue.onSubmittedWorkDone();
      const pitch = Math.ceil((texture.width * 16) / 256) * 256;
      const layers = texture.depthOrArrayLayers;
      const bytes = pitch * texture.height * layers;
      const staging = device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const constants = live()
        .find((r) => /\/pageConstants$/.test(r.label))
        ?.ref.deref();
      if (!constants) {
        staging.destroy();
        throw new Error("Native query frame constants are unavailable");
      }
      const identityStaging = device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture },
          { buffer: staging, bytesPerRow: pitch, rowsPerImage: texture.height },
          [texture.width, texture.height, layers],
        );
        encoder.copyBufferToBuffer(constants, 0, identityStaging, 0, 256);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        await identityStaging.mapAsync(GPUMapMode.READ);
        const frameWords = new Uint32Array(identityStaging.getMappedRange());
        // VsmSamplingConstants: control starts at word 44, identity at 56;
        // words 60..63 are uniform padding, not an identity product.
        const frameIdentity = {
          generation: frameWords[45],
          projectionEpoch: frameWords[56],
          namespace: frameWords[57],
        };
        identityStaging.unmap();
        const words = new Uint32Array(staging.getMappedRange());
        const groupHistogram = {},
          queryEntropyHistogram = {},
          statuses = {},
          targetStatuses = {},
          globalFine = new Set(),
          globalResolved = new Set();
        let receivers = 0,
          sumUnique = 0,
          sumResolved = 0,
          groups = 0,
          sumSelectedClips = 0,
          sumPhysicalSlots = 0,
          sumWinnerKeys = 0,
          depthDerivedReceivers = 0,
          winnerLeaderMatches = 0;
        for (let gy = 0; gy < texture.height; gy += 8) {
          for (let gx = 0; gx < texture.width; gx += 8) {
            const fine = new Set(),
              resolved = new Set(),
              selectedClips = new Set(),
              physicalSlots = new Set(),
              winnerKeys = new Set();
            const winnerPlane = layers >= 3 ? (pitch * texture.height * 2) / 4 : null;
            const leaderIndex = (gy * pitch) / 4 + gx * 4;
            const leaderKey = winnerPlane === null ? null : words[winnerPlane + leaderIndex];
            let active = 0;
            for (let y = gy; y < Math.min(gy + 8, texture.height); y++) {
              for (let x = gx; x < Math.min(gx + 8, texture.width); x++) {
                const i = (y * pitch) / 4 + x * 4,
                  code = words[i + 3];
                if ((code & 0x80000000) === 0) continue;
                const r = i + (pitch * texture.height) / 4;
                const status = code & 15,
                  target = (code >>> 4) & 15,
                  level = (code >>> 8) & 15,
                  mip = (code >>> 12) & 15;
                const key = `${words[i]}:${words[i + 1] | 0}:${words[i + 2] | 0}`;
                const result = `${status}:${target}:${level}:${mip}:${words[r] | 0}:${words[r + 1] | 0}:${words[r + 2]}:${words[r + 3]}`;
                fine.add(key);
                resolved.add(result);
                selectedClips.add(words[i]);
                if (winnerPlane !== null) {
                  const winner = words[winnerPlane + i];
                  winnerKeys.add(winner);
                  if (winner === leaderKey) winnerLeaderMatches++;
                  if (depthReceiverDiagnostics && words[winnerPlane + i + 3] !== 0) depthDerivedReceivers++;
                }
                if (status === 0 || status === 1) {
                  physicalSlots.add(`${words[r + 2]}:${words[r + 3]}`);
                }
                globalFine.add(key);
                globalResolved.add(result);
                statuses[status] = (statuses[status] ?? 0) + 1;
                targetStatuses[target] = (targetStatuses[target] ?? 0) + 1;
                active++;
              }
            }
            const bucket = `${active}/${fine.size}/${resolved.size}`;
            groupHistogram[bucket] = (groupHistogram[bucket] ?? 0) + 1;
            const entropy = `${active}/${selectedClips.size}/${fine.size}/${resolved.size}/${physicalSlots.size}`;
            queryEntropyHistogram[entropy] = (queryEntropyHistogram[entropy] ?? 0) + 1;
            receivers += active;
            sumUnique += fine.size;
            sumResolved += resolved.size;
            sumSelectedClips += selectedClips.size;
            sumPhysicalSlots += physicalSlots.size;
            sumWinnerKeys += winnerKeys.size;
            groups++;
          }
        }
        staging.unmap();
        return {
          width: texture.width,
          height: texture.height,
          receivers,
          groups,
          sumUnique,
          sumResolved,
          sumSelectedClips,
          sumPhysicalSlots,
          sumWinnerKeys: layers >= 3 ? sumWinnerKeys : null,
          depthDerivedReceivers: layers >= 3 && depthReceiverDiagnostics ? depthDerivedReceivers : null,
          depthDerivedRatio: layers >= 3 && depthReceiverDiagnostics && receivers ? depthDerivedReceivers / receivers : null,
          winnerLeaderMatches: layers >= 3 ? winnerLeaderMatches : null,
          winnerLeaderMatchRatio: layers >= 3 && receivers ? winnerLeaderMatches / receivers : null,
          globalFine: globalFine.size,
          globalResolved: globalResolved.size,
          statuses,
          targetStatuses,
          duplicateRatio: receivers ? 1 - sumUnique / receivers : null,
          resolvedDuplicateRatio: receivers ? 1 - sumResolved / receivers : null,
          groupHistogram,
          queryEntropyHistogram,
          frameIdentity,
          note: "Full generation/epoch/namespace are common frame constants; timing invalid with K instrumentation.",
        };
      } finally {
        staging.destroy();
        identityStaging.destroy();
      }
    },
    snapshot: () => ({
      bytes,
      peakBytes,
      capacityOwners: Object.fromEntries([...capacityOwners].map(([name, owner]) => [name, { ...owner }])),
      ownersAtPeak,
      scope: "All observed explicit API buffer/texture capacities including upload and in-flight overlap; excludes canvas, pipeline/driver allocation and OS residency",
      undestroyedCollectedBytes: records.reduce((sum, r) => sum + (!r.destroyed && !r.ref.deref() ? r.bytes ?? 0 : 0), 0),
      calls,
      hashes,
      nativeCostSlices: [...nativeCostSlices],
      unknownFormats: records
        .filter((r) => !r.destroyed && r.bytes === null)
        .map((r) => r.format),
      resources: records.map(({ ref, ...r }) => ({ ...r, alive: !!ref.deref() }))
    }),
    async vsmHeaders(diagnostics) {
      if (!diagnostics) return null;
      await device.queue.onSubmittedWorkDone();
      const copies = [
        ["generation", diagnostics.generation, 0, 32],
        ["demand", diagnostics.pageDemand.buffer, 0, 16],
        ["allocationFailures", diagnostics.allocationFailure.buffer, 0, 32],
        ["dirtyHeader", diagnostics.dirtyPages.buffer, 0, 16],
        ["casterHeader", diagnostics.casterRecords.buffer, 0, 32]
      ];
      const casterDamages = live()
        .find((r) => r.label === "VSM/caster damages")
        ?.ref.deref();
      if (casterDamages) copies.push(["casterDamage", casterDamages, 0, 16]);
      const receiverGroups = live()
        .find((r) => r.label === "Diagnostic/VSM receiver workgroups")
        ?.ref.deref();
      if (receiverGroups) {
        const requested = live()
          .find((r) => r.label.endsWith("/requestedPages"))
          ?.ref.deref();
        const constants = live()
          .find((r) => r.label === "VSM/receiver demand constants")
          ?.ref.deref();
        if (!requested || !constants) throw new Error("VSM receiver diagnostic products are incomplete");
        copies.push(
          ["receiverWorkgroups", receiverGroups, 0, receiverGroups.size],
          ["receiverRequestedWords", requested, 0, requested.size],
          ["receiverConstants", constants, 0, constants.size]
        );
      }
      const result = {};
      for (const [label, source] of copies) {
        if ((source.usage & GPUBufferUsage.COPY_SRC) === 0) {
          throw new Error(`VSM diagnostic ${label} lacks COPY_SRC`);
        }
      }
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
