// Frozen local f933660a mixed-triangle cache body, retained only as a cost reference.
// Current identity encoding, materials and lighting are supplied by production.
export const mixedCacheBody =
  "  var cache_slot = select(0xffffffffu, 0u, tile_broadcast);\n  if (!tile_broadcast) {\n    if (lane_active && lane_key != OENGINE_VISIBILITY_KEY_EMPTY) {\n      let h = (lane_key * 2654435761u) >> 29u;\n      for (var probe = 0u; probe < 8u; probe++) {\n        let idx = (h + probe) & 7u;\n        let cur = atomicLoad(&wg_cache_keys[idx]);\n        if (cur == lane_key) {\n          cache_slot = idx;\n          break;\n        }\n        if (cur == OENGINE_VISIBILITY_KEY_EMPTY) {\n          let res = atomicCompareExchangeWeak(&wg_cache_keys[idx], OENGINE_VISIBILITY_KEY_EMPTY, lane_key);\n          if (res.exchanged || res.old_value == lane_key) {\n            cache_slot = idx;\n            break;\n          }\n        }\n      }\n    }\n    workgroupBarrier();\n    if (lane < 8u) {\n      let slot_key = atomicLoad(&wg_cache_keys[lane]);\n      if (slot_key != OENGINE_VISIBILITY_KEY_EMPTY && meshlet_work.header.generation == settings.dimensions.w) {\n        let slot_decoded = oengine_visibility_key_resolve(slot_key, meshlet_work.header.generation, meshlet_work.header.written_count);\n        if (slot_decoded.valid != 0u &&\n            slot_decoded.meshlet_work_slot < min(meshlet_work.header.capacity, arrayLength(&meshlet_work.elements))) {\n          let slot_work = meshlet_work.elements[slot_decoded.meshlet_work_slot];\n          if (slot_work.instance_slot < arrayLength(&frame_instances) &&\n              frame_instances[slot_work.instance_slot].generation == settings.dimensions.w &&\n              slot_work.material_slot_or_range < arrayLength(&native_directory)) {\n            let slot_entry = native_directory[slot_work.material_slot_or_range];\n            if (slot_entry.execution_bin == route.x && slot_entry.program_index != 0xffffffffu) {\n              let slot_instance = frame_instances[slot_work.instance_slot];\n              let slot_resolved = geometry_complete_resolved(slot_decoded, slot_work, slot_instance);\n              wg_cache_work[lane] = slot_work;\n              wg_cache_entry[lane] = slot_entry;\n              wg_cache_instance_source[lane] = slot_instance.source;\n              wg_cache_corners[lane] = geometry_complete_attributes(slot_resolved, slot_instance);\n              wg_cache_valid[lane] = 1u;\n            }\n          }\n        }\n      }\n    }\n    workgroupBarrier();\n    if (cache_slot < 8u && wg_cache_valid[cache_slot] == 0u) {\n      cache_slot = 0xffffffffu;\n    }\n  }\n";

export function withEightSlotCache(source) {
  if (source.includes("var<workgroup> wg_cache_keys")) return source;
  const declaration = "  let cache_slot = select(0xffffffffu, 0u, tile_broadcast);";
  if (!source.includes(declaration)) throw new Error("Eight-slot reference no longer matches Native");
  source = source.replace(declaration, mixedCacheBody);
  source = source.replace(/(var<workgroup> wg_cache_\w+: array<[^>]+), 1>;/g, "$1, 8>;");
  source = source.replace(
    "var<workgroup> wg_tile_broadcast: u32;",
    "var<workgroup> wg_tile_broadcast: u32;\nvar<workgroup> wg_cache_keys: array<atomic<u32>, 8>;\nvar<workgroup> wg_cache_valid: array<u32, 8>;",
  );
  source = source.replace("let cache_hit = cache_slot == 0u;", "let cache_hit = cache_slot < 8u;");
  const main = source.indexOf("fn main("),
    open = source.indexOf("{", main);
  return (
    source.slice(0, open + 1) +
    "\n  if lane < 8u { atomicStore(&wg_cache_keys[lane], OENGINE_VISIBILITY_KEY_EMPTY); wg_cache_valid[lane] = 0u; }\n" +
    source.slice(open + 1)
  );
}
