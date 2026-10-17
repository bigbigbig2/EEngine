// Synthetic triangle descriptor metadata only. Actual cooker tests consume the
// cooker-produced section and independently compare it with decoded pages.
export function attachTriangleQuerySection(descriptor, payloads) {
  descriptor.schemaVersion = 2;
  descriptor.runtimeProfile = "oengine-vg-v2-v3-decoded-query2";
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
      for (let asset = 0; asset < assetCount; asset++) {
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
            for (let axis = 0; axis < 6; axis++) bounds.push(source?.getUint32(meshletAt + 24 + axis * 4, true) ?? 0);
            clusters.push([pageId, group, local, source?.getUint16(meshletAt + 2, true) ?? 1,
              source?.getUint32(meshletAt + 16, true) ?? 0, source?.getUint8(groupAt + 47) ?? 0,
              refine === 0xffffffff ? 5 : 6, asset, ...bounds,
              refine === 0xffffffff ? 0 : source.getUint32(groupAt + 40, true),
              childBegin, children.length - childBegin, source?.getUint8(groupAt + 46) ?? 0, 0, 0]);
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
      const counts = [records.length, clusters.length, children.length, roots.length, cut.length, pages.length];
      const tables = [records.flat(), clusters.flat(), children, roots, cut, pages];
      const bytes = new Uint8Array(128 + tables.reduce((sum, table) => sum + table.length * 4, 0));
      const view = new DataView(bytes.buffer);
      [0x3251474f, 2, 128, bytes.length].forEach((word, index) => view.setUint32(index * 4, word, true));
      bytes.set(descriptor.recipeHash, 16);
      let cursor = 128;
      for (let table = 0; table < tables.length; table++) {
        view.setUint32(48 + table * 4, counts[table], true);
        view.setUint32(72 + table * 4, cursor, true);
        for (const word of tables[table]) {
          view.setUint32(cursor, word, true);
          cursor += 4;
        }
      }
      return bytes;
    },
  });
  return descriptor;
}
