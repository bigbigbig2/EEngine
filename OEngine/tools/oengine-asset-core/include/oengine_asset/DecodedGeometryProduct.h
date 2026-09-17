#pragma once

#include "GeometryCooker.h"
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

}  // namespace oengine::asset
