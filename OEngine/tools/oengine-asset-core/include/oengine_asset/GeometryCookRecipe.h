#pragma once

#include <cstdint>
#include <string>

namespace oengine::asset {

struct GeometryCookRecipeV4 {
    std::string instanceSemantics = "cast-receive-explicit-v1";
    std::string meshoptimizerRevision = "meshoptimizer-1.3-9e1f07b159d3";
    std::string hierarchyAlgorithmVersion = "nyx-hierarchy-v4.1-conservative-spheres";
    std::uint32_t meshletMaxVertices = 64u;
    std::uint32_t meshletMinTriangles = 32u;
    std::uint32_t meshletMaxTriangles = 128u;
    float coneWeight = 0.0f;
    float clusterSplitFactor = 2.0f;
    std::uint32_t groupTargetMeshlets = 32u;
    float simplifyTargetRatio = 0.5f;
    float simplifyFailureRatio = 0.51f;
    float simplifyUpdateFailureRatio = 0.85f;
    bool simplifyPermissive = true;
    bool simplifyWithUpdate = true;
    float attributeErrorScale = 1.0f;
    float minimumLodReduction = 0.01f;
    float lodErrorMergeFactor = 1.5f;
    std::uint32_t hierarchyFanout = 8u;
    std::uint32_t pageShift = 18u;
    std::string pagePackingAlgorithmVersion = "tier-locality-bounded-best-fit-16-v1";
    std::string pageCodecPolicy = "zstd-9-15-19-or-raw";
    std::string vertexProfileVersion = "static-pbr-soa-f32-v8";
    std::string positionQuantization = "float32-object-space";
    std::string queryProfile = "shared-meshlet-source-remap-cut-v3";
    std::uint64_t bootstrapGeometryBudgetBytes = 64ull * 1024ull * 1024ull;
    std::string bootstrapBudgetPolicy = "scene-decoded-payload-hard-fail-v1";
    std::uint32_t deterministicSeed = 0u;
    std::string floatMode = "ieee754-nearest-no-fast-math";
};

std::string CanonicalRecipeJson(const GeometryCookRecipeV4& recipe);
void ValidateRecipe(const GeometryCookRecipeV4& recipe);

}  // namespace oengine::asset
