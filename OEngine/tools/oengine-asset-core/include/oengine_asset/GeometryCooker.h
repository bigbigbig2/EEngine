#pragma once

#include "GeometryAbi.h"
#include "GeometryCookRecipe.h"
#include "Hash.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace oengine::asset {

struct CanonicalVertex {
    float position[3]{};
    float normal[3]{0.0f, 0.0f, 1.0f};
    float tangent[4]{1.0f, 0.0f, 0.0f, 1.0f};
    float uv0[2]{};
    float uv1[2]{};
    float color[4]{1.0f, 1.0f, 1.0f, 1.0f};
};

struct MaterialDomain {
    std::uint32_t materialId = kInvalidId;
    std::uint32_t meshletFlags = kMeshletOpaque | kMeshletCastsShadow;
    std::uint16_t attributeMask = kAttributePosition | kAttributeNormal;
    std::vector<CanonicalVertex> vertices;
    std::vector<std::uint32_t> indices;
};

struct CanonicalGeometryAsset {
    std::string sourceName;
    Hash256 sourceHash{};
    float boundsSphere[4]{};
    float boundsMin[3]{};
    float boundsMax[3]{};
    std::vector<MaterialDomain> domains;
};

struct SceneInstanceV3 {
    std::uint32_t assetIndex = 0u;
    std::array<float, 16> worldTransform{};
    std::uint32_t flags = 0u;
};

struct ImportedSceneV3 {
    std::vector<CanonicalGeometryAsset> assets;
    std::vector<SceneInstanceV3> instances;
};

struct CookEvidenceV3 {
    std::uint64_t sourceBytes = 0u;
    std::uint64_t uniqueGeometryBytes = 0u;
    std::uint64_t leafMeshlets = 0u;
    std::uint64_t parentMeshlets = 0u;
    std::uint64_t groups = 0u;
    std::uint64_t hierarchyNodes = 0u;
    std::uint64_t hierarchyBytes = 0u;
    std::uint64_t pageCount = 0u;
    std::uint64_t compressedPageBytes = 0u;
    std::uint64_t decodedPageBytes = 0u;
    std::uint64_t wastedPaddingBytes = 0u;
    std::uint64_t bootstrapPageCount = 0u;
    std::uint64_t bootstrapGeometryBytes = 0u;
    std::uint64_t serializedVertexBytes = 0u;
    std::uint64_t uniqueReferencedVertexBytes = 0u;
    std::uint64_t simplificationFallbackGroups = 0u;
    double meanPageFill = 0.0;
    double p50PageFill = 0.0;
    double p95PageFill = 0.0;
    double vertexDuplicationRatio = 0.0;
    double cookWallMilliseconds = 0.0;
    std::uint64_t peakWorkingBytes = 0u;
};

/** Merges per-asset cook evidence; shared by the Native writer and the WASM ABI. */
inline void AddEvidence(CookEvidenceV3& target, const CookEvidenceV3& source) {
    target.sourceBytes += source.sourceBytes;
    target.uniqueGeometryBytes += source.uniqueGeometryBytes;
    target.leafMeshlets += source.leafMeshlets; target.parentMeshlets += source.parentMeshlets;
    target.groups += source.groups; target.hierarchyNodes += source.hierarchyNodes; target.hierarchyBytes += source.hierarchyBytes;
    target.pageCount += source.pageCount; target.compressedPageBytes += source.compressedPageBytes;
    target.decodedPageBytes += source.decodedPageBytes; target.wastedPaddingBytes += source.wastedPaddingBytes;
    target.bootstrapPageCount += source.bootstrapPageCount; target.bootstrapGeometryBytes += source.bootstrapGeometryBytes;
    target.serializedVertexBytes += source.serializedVertexBytes;
    target.uniqueReferencedVertexBytes += source.uniqueReferencedVertexBytes;
    target.simplificationFallbackGroups += source.simplificationFallbackGroups;
    target.cookWallMilliseconds += source.cookWallMilliseconds;
    target.peakWorkingBytes = std::max(target.peakWorkingBytes, source.peakWorkingBytes);
}

struct SerializedGroupV3 {
    std::vector<std::uint8_t> bytes;
    std::uint32_t flags = 0u;
    std::uint8_t lodLevel = 0u;
    std::uint32_t localStableId = 0u;
};

struct CookedAssetV3 {
    Hash256 assetId{};
    float boundsSphere[4]{};
    float boundsMin[3]{};
    float boundsMax[3]{};
    std::uint32_t sourceTriangleCount = 0u;
    std::uint32_t leafMeshletCount = 0u;
    std::uint32_t totalMeshletCount = 0u;
    std::vector<std::uint32_t> rootNodeIndices;
    std::vector<GeometryHierarchyNodeV3> hierarchy;
    std::vector<SerializedGroupV3> groups;
    std::vector<VertexFormatRecordV3> vertexFormats;
};

ImportedSceneV3 ImportGltfCanonical(const std::string& path);
CookedAssetV3 CookGeometryAssetV3(
    const CanonicalGeometryAsset& source,
    const GeometryCookRecipeV3& recipe,
    CookEvidenceV3& evidence);

}  // namespace oengine::asset
