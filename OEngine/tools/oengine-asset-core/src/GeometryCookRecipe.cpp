#include "oengine_asset/GeometryCookRecipe.h"
#include "oengine_asset/GeometryAbi.h"

#include <cmath>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace oengine::asset {

void ValidateRecipe(const GeometryCookRecipeV3& r) {
    if (r.meshletMaxVertices < 3u || r.meshletMaxVertices > 128u) throw std::runtime_error("meshletMaxVertices must be in [3,128]");
    if (r.meshletMinTriangles == 0u || r.meshletMinTriangles > r.meshletMaxTriangles) throw std::runtime_error("meshletMinTriangles must be in [1,max]");
    if (r.meshletMaxTriangles == 0u || r.meshletMaxTriangles > 128u) throw std::runtime_error("meshletMaxTriangles must be in [1,128]");
    if (r.groupTargetMeshlets == 0u || r.groupTargetMeshlets > 128u) throw std::runtime_error("groupTargetMeshlets must be in [1,128]");
    if (!(r.simplifyTargetRatio > 0.0f && r.simplifyTargetRatio < 1.0f)) throw std::runtime_error("simplifyTargetRatio must be in (0,1)");
    if (r.simplifyFailureRatio < r.simplifyTargetRatio || r.simplifyFailureRatio > 1.0f) throw std::runtime_error("simplifyFailureRatio is invalid");
    if (r.hierarchyFanout != 8u) throw std::runtime_error("V3 hierarchy fanout must be 8");
    if (r.pageShift != kGeometryPageShiftV3) throw std::runtime_error("V3 pageShift must be 18");
    if (r.pagePackingAlgorithmVersion != "tier-locality-bounded-best-fit-16-v1") throw std::runtime_error("unsupported V3 page packing algorithm");
    if (r.pageCodecPolicy != "lz4-or-raw") throw std::runtime_error("V3 codec policy must be lz4-or-raw");
    if (r.positionQuantization != "meshlet-aabb-u16") throw std::runtime_error("V3 position quantization must be meshlet-aabb-u16");
    if (r.bootstrapBudgetPolicy != "scene-decoded-payload-hard-fail-v1") throw std::runtime_error("unsupported bootstrap budget policy");
    if (r.floatMode != "ieee754-nearest-no-fast-math") throw std::runtime_error("unsupported floatMode");
}

std::string CanonicalRecipeJson(const GeometryCookRecipeV3& r) {
    ValidateRecipe(r);
    std::ostringstream o;
    o << std::setprecision(9)
      << "{\"bootstrapBudgetPolicy\":\"" << r.bootstrapBudgetPolicy
      << "\",\"bootstrapGeometryBudgetBytes\":" << r.bootstrapGeometryBudgetBytes
      << ",\"clusterSplitFactor\":" << r.clusterSplitFactor
      << ",\"coneWeight\":" << r.coneWeight
      << ",\"deterministicSeed\":" << r.deterministicSeed
      << ",\"floatMode\":\"" << r.floatMode
      << "\",\"groupTargetMeshlets\":" << r.groupTargetMeshlets
      << ",\"hierarchyAlgorithmVersion\":\"" << r.hierarchyAlgorithmVersion
      << "\",\"hierarchyFanout\":" << r.hierarchyFanout
      << ",\"lodErrorMergeFactor\":" << r.lodErrorMergeFactor
      << ",\"meshletMaxTriangles\":" << r.meshletMaxTriangles
      << ",\"meshletMaxVertices\":" << r.meshletMaxVertices
      << ",\"meshletMinTriangles\":" << r.meshletMinTriangles
      << ",\"meshoptimizerRevision\":\"" << r.meshoptimizerRevision
      << "\",\"minimumLodReduction\":" << r.minimumLodReduction
      << ",\"pageCodecPolicy\":\"" << r.pageCodecPolicy
      << "\",\"pagePackingAlgorithmVersion\":\"" << r.pagePackingAlgorithmVersion
      << "\",\"pageShift\":" << r.pageShift
      << ",\"positionQuantization\":\"" << r.positionQuantization
      << "\",\"rawCodecThresholdBytes\":" << r.rawCodecThresholdBytes
      << ",\"simplifyFailureRatio\":" << r.simplifyFailureRatio
      << ",\"simplifyPermissive\":" << (r.simplifyPermissive ? "true" : "false")
      << ",\"simplifySloppyFailureRatio\":" << r.simplifySloppyFailureRatio
      << ",\"simplifyTargetRatio\":" << r.simplifyTargetRatio
      << ",\"sloppyErrorFactor\":" << r.sloppyErrorFactor
      << ",\"sloppyFallback\":" << (r.sloppyFallback ? "true" : "false")
      << ",\"vertexProfileVersion\":\"" << r.vertexProfileVersion << "\"}";
    return o.str();
}

}  // namespace oengine::asset
