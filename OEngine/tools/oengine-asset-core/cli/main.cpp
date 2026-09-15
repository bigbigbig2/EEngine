#include "oengine_asset/OegPackWriter.h"

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

std::uint64_t ParseU64(const std::string& value, const char* name) {
    std::size_t consumed = 0u;
    const std::uint64_t result = std::stoull(value, &consumed, 10);
    if (consumed != value.size()) throw std::runtime_error(std::string(name) + " must be an unsigned integer");
    return result;
}

float ParseFloat(const std::string& value, const char* name) {
    std::size_t consumed = 0u;
    const float result = std::stof(value, &consumed);
    if (consumed != value.size()) throw std::runtime_error(std::string(name) + " must be a number");
    return result;
}

void PrintUsage() {
    std::cerr
        << "oengine-asset-cooker <scene.glb|scene.gltf> --out <directory> [options]\n"
        << "oengine-asset-cooker validate <pack.oegpack> [--metadata-only]\n"
        << "Options:\n"
        << "  --threads N                 bounded geometry build concurrency\n"
        << "  --shard-bytes N             target compressed pack shard size\n"
        << "  --meshlet-vertices N        cook profile, maximum 128\n"
        << "  --meshlet-triangles N       cook profile, maximum 128\n"
        << "  --group-meshlets N          target Nyx partition size\n"
        << "  --simplify-ratio X          attribute-aware simplification target\n"
        << "  --bootstrap-budget N        maximum decoded bootstrap bytes\n"
        << "  --raw-threshold N           choose raw page when LZ4 saves fewer than N bytes\n";
}

}  // namespace

int main(int argc, char** argv) {
    try {
        if (argc < 2) { PrintUsage(); return 2; }
        if (std::string(argv[1]) == "validate") {
            if (argc < 3) { PrintUsage(); return 2; }
            const bool metadataOnly = argc >= 4 && std::string(argv[3]) == "--metadata-only";
            oengine::asset::ValidateOegPackV3File(argv[2], !metadataOnly);
            std::cout << "{\"valid\":true,\"path\":\"" << argv[2] << "\"}\n";
            return 0;
        }
        const std::string input = argv[1];
        std::string output;
        std::uint32_t threads = std::max(1u, std::thread::hardware_concurrency());
        std::uint64_t shardBytes = 256ull * 1024ull * 1024ull;
        oengine::asset::GeometryCookRecipeV3 recipe;
        for (int i = 2; i < argc; ++i) {
            const std::string option = argv[i];
            if (i + 1 >= argc) throw std::runtime_error("missing value for " + option);
            const std::string value = argv[++i];
            if (option == "--out") output = value;
            else if (option == "--threads") threads = std::uint32_t(ParseU64(value, "threads"));
            else if (option == "--shard-bytes") shardBytes = ParseU64(value, "shard-bytes");
            else if (option == "--meshlet-vertices") recipe.meshletMaxVertices = std::uint32_t(ParseU64(value, "meshlet-vertices"));
            else if (option == "--meshlet-triangles") recipe.meshletMaxTriangles = std::uint32_t(ParseU64(value, "meshlet-triangles"));
            else if (option == "--group-meshlets") recipe.groupTargetMeshlets = std::uint32_t(ParseU64(value, "group-meshlets"));
            else if (option == "--simplify-ratio") recipe.simplifyTargetRatio = ParseFloat(value, "simplify-ratio");
            else if (option == "--bootstrap-budget") recipe.bootstrapGeometryBudgetBytes = ParseU64(value, "bootstrap-budget");
            else if (option == "--raw-threshold") recipe.rawCodecThresholdBytes = std::uint32_t(ParseU64(value, "raw-threshold"));
            else throw std::runtime_error("unknown option: " + option);
        }
        if (output.empty()) throw std::runtime_error("--out is required");
        if (threads == 0u) throw std::runtime_error("--threads must be positive");
        const auto result = oengine::asset::CookAndWriteSceneV3(input, output, recipe, shardBytes, threads);
        const auto& e = result.evidence;
        std::string scenePath = result.scenePath;
        std::replace(scenePath.begin(), scenePath.end(), '\\', '/');
        std::cout << "{\"scene\":\"" << scenePath << "\",\"packs\":" << result.packs.size()
                  << ",\"sourceBytes\":" << e.sourceBytes << ",\"uniqueGeometryBytes\":" << e.uniqueGeometryBytes
                  << ",\"leafMeshlets\":" << e.leafMeshlets << ",\"parentMeshlets\":" << e.parentMeshlets
                  << ",\"groups\":" << e.groups << ",\"hierarchyNodes\":" << e.hierarchyNodes
                  << ",\"hierarchyBytes\":" << e.hierarchyBytes << ",\"pageCount\":" << e.pageCount
                  << ",\"compressedPageBytes\":" << e.compressedPageBytes << ",\"decodedPageBytes\":" << e.decodedPageBytes
                  << ",\"compressionRatio\":" << (e.decodedPageBytes == 0u ? 0.0 : double(e.compressedPageBytes) / double(e.decodedPageBytes))
                  << ",\"wastedPaddingBytes\":" << e.wastedPaddingBytes << ",\"bootstrapPageCount\":" << e.bootstrapPageCount
                  << ",\"bootstrapGeometryBytes\":" << e.bootstrapGeometryBytes << ",\"meanPageFill\":" << e.meanPageFill
                  << ",\"p50PageFill\":" << e.p50PageFill << ",\"p95PageFill\":" << e.p95PageFill
                  << ",\"pageFillWarning\":" << (e.meanPageFill < 0.70 ? "true" : "false")
                  << ",\"vertexDuplicationRatio\":" << e.vertexDuplicationRatio
                  << ",\"simplificationFallbackGroups\":" << e.simplificationFallbackGroups
                  << ",\"cookWallMilliseconds\":" << e.cookWallMilliseconds
                  << ",\"peakWorkingBytes\":" << e.peakWorkingBytes << "}\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "oengine-asset-cooker: " << error.what() << "\n";
        return 1;
    }
}
