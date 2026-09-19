#pragma once

#include "GeometryCooker.h"
#include "Hash.h"
#include "OegPackFormat.h"

#include <array>
#include <cstdint>
#include <vector>

namespace oengine::asset {

struct DecodedGeometryPageV1 {
    std::vector<std::uint8_t> bytes;
    std::array<std::uint8_t, 16> decodedHash128{};
    std::uint32_t firstGroup = 0u;
    std::uint32_t groupCount = 0u;
    std::uint32_t usedBytes = 0u;
    std::uint8_t lodLevel = 0u;
    bool bootstrap = false;
};

/**
 * A page whose identity, Group assignment and byte layout are fixed, but whose
 * payload buffer has not been materialised yet.
 *
 * The plan is everything a descriptor needs: it can be produced without
 * allocating any 256 KiB page buffer. Materialisation is a separate step that
 * fills `bytes` from the retained Group payloads and must reproduce the exact
 * layout recorded here.
 */
struct DecodedGeometryPagePlanV1 {
    std::array<std::uint8_t, 16> decodedHash128{};
    std::uint32_t firstGroup = 0u;
    std::uint32_t groupCount = 0u;
    std::uint32_t usedBytes = 0u;
    std::uint8_t lodLevel = 0u;
    bool bootstrap = false;
};

/**
 * Producer-neutral V3-decoded Geometry Product *skeleton*: every descriptor
 * address (asset records, hierarchy, Group directory, page records, activation
 * cut) is final, while page payloads remain unallocated.
 *
 * This is the two-phase ABI's descriptor stage. Call
 * `MaterializeDecodedGeometryPageV1` to obtain an individual page.
 */
struct DecodedGeometryProductPlanV1 {
    std::vector<GeometryAssetRecordV3> assets;
    std::vector<std::uint32_t> roots;
    std::vector<GeometryHierarchyNodeV3> hierarchy;
    std::vector<GeometryGroupDirectoryV3> groups;
    std::vector<VertexFormatRecordV3> formats;
    std::vector<std::uint32_t> bootstrapPages;
    std::vector<DecodedGeometryPagePlanV1> pages;
};

/**
 * Deterministic page identity rolled up from the page's Group payloads.
 *
 * The identity covers each Group payload digest together with its GroupID and
 * payload length, fed in ascending GroupID order. It deliberately excludes
 * page padding and byte offsets, so identity can be computed before the page
 * payload buffer is materialised and is unaffected by layout padding.
 *
 * `payloads` must be ordered by ascending GroupID. `groupIds[i]` names the
 * Group whose payload digest is `payloadDigests[i]` with `payloadBytes[i]`
 * bytes. All three spans carry the same length.
 */
std::array<std::uint8_t, 16> ComputeGeometryPageIdentityV1(
    const std::vector<std::uint32_t>& groupIds,
    const std::vector<std::uint32_t>& payloadBytes,
    const std::vector<Hash256>& payloadDigests);

/** Producer-neutral V3-decoded Geometry Product before file-container encoding. */
struct DecodedGeometryProductV1 {
    std::vector<GeometryAssetRecordV3> assets;
    std::vector<std::uint32_t> roots;
    std::vector<GeometryHierarchyNodeV3> hierarchy;
    std::vector<GeometryGroupDirectoryV3> groups;
    std::vector<VertexFormatRecordV3> formats;
    std::vector<std::uint32_t> bootstrapPages;
    std::vector<DecodedGeometryPageV1> pages;
};

DecodedGeometryProductV1 AssembleDecodedGeometryProductV1(
    std::vector<CookedAssetV3> cooked);

/**
 * Descriptor-stage assembly: identical page packing and identity rollup as
 * `AssembleDecodedGeometryProductV1`, but no page payload buffer is allocated.
 *
 * `retainedGroups` receives the Group payloads in ascending GroupID order so a
 * later materialisation step can reconstruct any page byte-for-byte.
 */
DecodedGeometryProductPlanV1 PlanDecodedGeometryProductV1(
    std::vector<CookedAssetV3> cooked,
    std::vector<SerializedGroupV3>& retainedGroups);

/**
 * Payload-stage materialisation of one planned page.
 *
 * `retainedGroups[groupId]` must be the payload for Group `groupId` as produced
 * by `PlanDecodedGeometryProductV1`. The result must satisfy
 * `page.decodedHash128 == ComputeGeometryPageIdentityV1(...)` for the Groups the
 * plan assigns to this page.
 */
DecodedGeometryPageV1 MaterializeDecodedGeometryPageV1(
    const DecodedGeometryProductPlanV1& plan,
    const std::vector<SerializedGroupV3>& retainedGroups,
    std::uint32_t pageId);

}  // namespace oengine::asset
