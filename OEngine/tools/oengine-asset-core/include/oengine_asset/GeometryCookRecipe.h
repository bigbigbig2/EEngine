#pragma once

#include <cstdint>
#include <string>

namespace oengine::asset {

struct GeometryCookRecipeV3 {
    std::string meshoptimizerRevision = "nyx-bc7e5b1e51f6-meshoptimizer-0.25-a05dfed026d1";
    std::string hierarchyAlgorithmVersion = "nyx-hierarchy-v3.0";
    std::uint32_t meshletMaxVertices = 64u;
    std::uint32_t meshletMinTriangles = 32u;
    std::uint32_t meshletMaxTriangles = 128u;
    float coneWeight = 0.0f;
    float clusterSplitFactor = 2.0f;
    std::uint32_t groupTargetMeshlets = 32u;
    float simplifyTargetRatio = 0.5f;
    float simplifyFailureRatio = 0.51f;
    float simplifySloppyFailureRatio = 0.85f;
    bool simplifyPermissive = true;
    bool sloppyFallback = true;
    float sloppyErrorFactor = 2.0f;
    float minimumLodReduction = 0.01f;
    float lodErrorMergeFactor = 1.5f;
    std::uint32_t hierarchyFanout = 8u;
    std::uint32_t pageShift = 18u;
    std::string pagePackingAlgorithmVersion = "tier-locality-bounded-best-fit-16-v1";
    std::string pageCodecPolicy = "lz4-or-raw";
    std::uint32_t rawCodecThresholdBytes = 256u;
    std::string vertexProfileVersion = "static-pbr-page-local-v3";
    std::string positionQuantization = "meshlet-aabb-u16";
    std::uint64_t bootstrapGeometryBudgetBytes = 64ull * 1024ull * 1024ull;
    std::string bootstrapBudgetPolicy = "scene-decoded-payload-hard-fail-v1";
    std::uint32_t deterministicSeed = 0u;
    std::string floatMode = "ieee754-nearest-no-fast-math";
};

std::string CanonicalRecipeJson(const GeometryCookRecipeV3& recipe);
void ValidateRecipe(const GeometryCookRecipeV3& recipe);

}  // namespace oengine::asset
