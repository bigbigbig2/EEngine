// Synthetic triangle descriptor metadata only. Actual cooker tests consume the
// cooker-produced section and independently compare it with decoded pages.
export function attachTriangleQuerySection(descriptor, payloads) {
  descriptor.schemaVersion = 2;
  descriptor.runtimeProfile = "oengine-vg-v2-v3-decoded-query3";
  Object.defineProperty(descriptor, "querySection", {
    configurable: true,
    enumerable: true,
    get() {
      const assetCount = descriptor.assetRecords.byteLength / 128;
      const assets = new DataView(descriptor.assetRecords.buffer, descriptor.assetRecords.byteOffset);
      const groups = new DataView(descriptor.groupDirectory.buffer, descriptor.groupDirectory.byteOffset);
      const hierarchy = new DataView(descriptor.hierarchyNodes.buffer, descriptor.hierarchyNodes.byteOffset);
      const groupCounts = new Map();
      for (let at = 44; at < descriptor.hierarchyNodes.byteLength; at += 48) {
        const word = hierarchy.getUint32(at, true);
        if (word & 1) groupCounts.set((word >>> 1) & 0xffffff, (word >>> 25) + 1);
      }
      const clusters = [], roots = [], cut = [], pages = [], records = [], children = [];
      const primitives = [], vertices = [];
      for (let asset = 0; asset < assetCount; asset++) {
        let sourcePrimitive = 0;
        let coarsePrimitive = assets.getUint32(asset * 128 + 104, true);
        const record = [roots.length, 0, cut.length, 0, pages.length, 0, 0, 0];
        const pageSet = new Set();
        const begin = assets.getUint32(asset * 128 + 88, true);
        const count = assets.getUint32(asset * 128 + 92, true);
        const groupBegins = new Map();
        let nextCluster = clusters.length;
        for (let group = begin; group < begin + count; group++) {
          groupBegins.set(group, nextCluster);
          nextCluster += groupCounts.get(group) ?? 1;
        }
        const incoming = new Set();
        for (let group = begin; group < begin + count; group++) {
          for (let local = 0; local < (groupCounts.get(group) ?? 1); local++) {
            const pageId = groups.getUint32(group * 16, true);
            const payload = payloads instanceof Uint8Array ? payloads : payloads?.[pageId]?.page ?? payloads?.[pageId];
            const source = payload && new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const groupAt = groups.getUint32(group * 16 + 4, true);
            const meshletAt = groupAt + (source?.getUint32(groupAt + 48, true) ?? 64) + local * 48;
            const refine = source?.getUint32(meshletAt + 12, true) ?? 0xffffffff;
            const childBegin = children.length;
            if (refine !== 0xffffffff) {
              for (let child = 0; child < (groupCounts.get(refine) ?? 1); child++) {
                const childId = groupBegins.get(refine) + child;
                children.push(childId);
                incoming.add(childId);
              }
            } else {
              cut.push(clusters.length);
              pageSet.add(pageId);
            }
            const bounds = [];
            for (let axis = 0; axis < 6; axis++) {
              const fallback = new Float32Array([axis < 3 ? -0.5 : 0.5]);
              bounds.push(source?.getUint32(meshletAt + 24 + axis * 4, true) ??
                new Uint32Array(fallback.buffer)[0]);
            }
            clusters.push([pageId, group, local, source?.getUint16(meshletAt + 2, true) ?? 1,
              source?.getUint32(meshletAt + 16, true) ?? 0, source?.getUint8(groupAt + 47) ?? 0,
              refine === 0xffffffff ? 5 : 6, asset, ...bounds,
              refine === 0xffffffff ? 0 : source.getUint32(groupAt + 40, true),
              childBegin, children.length - childBegin, source?.getUint8(groupAt + 46) ?? 0,
              primitives.length, vertices.length]);
            for (let triangle = 0; triangle < (source?.getUint16(meshletAt + 2, true) ?? 1); triangle++) {
              primitives.push(refine === 0xffffffff ? sourcePrimitive++ : coarsePrimitive++);
            }
            for (let vertex = 0; vertex < (source?.getUint16(meshletAt, true) ?? 3); vertex++) {
              vertices.push(vertices.length);
            }
          }
        }
        for (let cluster = groupBegins.get(begin); cluster < nextCluster; cluster++) {
          if (!incoming.has(cluster)) roots.push(cluster);
        }
        pages.push(...[...pageSet].sort((a, b) => a - b));
        record[1] = roots.length - record[0];
        record[3] = cut.length - record[2];
        record[5] = pages.length - record[4];
        records.push(record);
      }
      const counts = [records.length, clusters.length, children.length, roots.length, cut.length, pages.length,
        primitives.length, vertices.length];
      const tables = [records.flat(), clusters.flat(), children, roots, cut, pages, primitives, vertices];
      const bytes = new Uint8Array(160 + tables.reduce((sum, table) => sum + table.length * 4, 0));
      const view = new DataView(bytes.buffer);
      [0x3251474f, 3, 160, bytes.length].forEach((word, index) => view.setUint32(index * 4, word, true));
      bytes.set(descriptor.recipeHash, 16);
      let cursor = 160;
      for (let table = 0; table < tables.length; table++) {
        view.setUint32(table < 6 ? 48 + table * 4 : 96 + (table - 6) * 4, counts[table], true);
        view.setUint32(table < 6 ? 72 + table * 4 : 104 + (table - 6) * 4, cursor, true);
        for (const word of tables[table]) {
          view.setUint32(cursor, word, true);
          cursor += 4;
        }
      }
      bytes.set(sha256(bytes.subarray(160)), 128);
      return bytes;
    },
  });
  return descriptor;
}

// Browser-compatible synchronous hashing for the synthetic descriptor getter.
// Production uses WebCrypto; this fixture must also run in browser GPU oracles.
function sha256(input) {
  const constants = new Uint32Array(64);
  const state = new Uint32Array(8);
  let primeIndex = 0;
  for (let candidate = 2; primeIndex < 64; candidate++) {
    let prime = true;
    for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
      if (candidate % divisor === 0) { prime = false; break; }
    }
    if (!prime) continue;
    if (primeIndex < 8) state[primeIndex] = (Math.sqrt(candidate) % 1) * 0x100000000;
    constants[primeIndex++] = (Math.cbrt(candidate) % 1) * 0x100000000;
  }
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, input.length * 8);
  view.setUint32(padded.length - 8, Math.floor(input.length / 0x20000000));
  const words = new Uint32Array(64);
  const rotate = (x, n) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] +
        (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, i) => { state[i] += word; });
  }
  const digest = new Uint8Array(32);
  const output = new DataView(digest.buffer);
  state.forEach((word, i) => output.setUint32(i * 4, word));
  return digest;
}
