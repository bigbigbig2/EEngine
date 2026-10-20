const base = "/.local/web-asset-u0/";
let instance;
let geometry;
const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((v) => v.toString(16).padStart(2, "0")).join("");
self.onmessage = async ({ data }) => {
  try {
    if (data.kind === "init") {
      const started = performance.now();
      const { default: create } = await import(base + "xubc7.mjs");
      const loaded = performance.now();
      const binary = await (await fetch(base + "xubc7.wasm")).arrayBuffer();
      const fetched = performance.now();
      instance = await create({ wasmBinary: binary });
      self.postMessage({ id: data.id, importMs: loaded - started, fetchMs: fetched - loaded, initMs: performance.now() - fetched,
        wasmHash: await sha(binary), memoryBytes: instance.HEAPU8.length, logicalBlockBytes: instance._u0_logical_block_bytes() });
      return;
    }
    if (data.kind === "zstd") {
      if (!geometry) {
        const { default: create } = await import(base + "geometry.mjs");
        geometry = await create({ wasmBinary: await (await fetch(base + "geometry.wasm")).arrayBuffer() });
      }
      const bytes = new Uint8Array(data.bytes), size = data.outputSize;
      if (!Number.isInteger(size) || size <= 0 || size > 256 * 1024 || !bytes.length || bytes.length > 512 * 1024) {
        self.postMessage({ id: data.id, status: 0 }); return;
      }
      const p = geometry._malloc(bytes.length), q = geometry._malloc(size);
      if (!p || !q) { if (p) geometry._free(p); if (q) geometry._free(q); throw new Error("Zstd probe allocation failed"); }
      try {
        geometry.HEAPU8.set(bytes, p);
        const times = []; let status = 0;
        for (let i = 0; i < (data.iterations ?? 1); i++) {
          const start = performance.now();
          for (let j = 0; j < (data.batch ?? 1); j++) {
            status = geometry._u0_decompress(1, p, bytes.length, q, size, 4);
            if (!status) break;
          }
          times.push((performance.now() - start) / (data.batch ?? 1));
          if (!status) break;
        }
        const output = status ? geometry.HEAPU8.slice(q, q + size) : new Uint8Array();
        self.postMessage({ id: data.id, status, times, memoryBytes: geometry.HEAPU8.length, bytes: output.buffer }, [output.buffer]);
      } finally { geometry._free(q); geometry._free(p); }
      return;
    }
    const bytes = new Uint8Array(data.bytes), { width, height } = data;
    if (![width, height].every((v) => Number.isInteger(v) && v > 0 && v <= 512) ||
        bytes.length > 32 * Math.ceil(width / 4) * Math.ceil(height / 4) + 4096) {
      self.postMessage({ id: data.id, status: 0 }); return;
    }
    const outputSize = Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
    const p = instance._malloc(bytes.length || 1), q = instance._malloc(outputSize || 16);
    if (!p || !q) { if (p) instance._free(p); if (q) instance._free(q); throw new Error("Probe input allocation failed"); }
    try {
      const held = data.forceLowMemory ? instance._malloc(9 * 1024 * 1024) : 0;
      if (data.forceLowMemory && !held) throw new Error("OOM probe reservation unavailable");
      instance.HEAPU8.set(bytes, p);
      const times = [];
      let status = 0;
      for (let i = 0; i < (data.iterations ?? 1); i++) {
        const start = performance.now();
        status = instance._u0_decode(p, bytes.length, width, height, q, outputSize);
        times.push(performance.now() - start);
        if (!status) break;
      }
      if (held) instance._free(held);
      const output = status ? instance.HEAPU8.slice(q, q + outputSize) : new Uint8Array();
      self.postMessage({ id: data.id, status, times, memoryBytes: instance.HEAPU8.length, bytes: output.buffer }, [output.buffer]);
    } finally { instance._free(q); instance._free(p); }
  } catch (error) { self.postMessage({ id: data.id, error: { message: error.message, stack: error.stack } }); }
};
