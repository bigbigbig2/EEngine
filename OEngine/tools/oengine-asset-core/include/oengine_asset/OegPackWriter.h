#pragma once

#include "GeometryCooker.h"
#include "OegPackFormat.h"

#include <cstdint>
#include <string>
#include <vector>

namespace oengine::asset {

struct WrittenPackV3 {
    std::string path;
    Hash256 packId{};
    std::vector<std::uint32_t> sourceAssetIndices;
};

struct WriteSceneResultV3 {
    std::string scenePath;
    std::vector<WrittenPackV3> packs;
    CookEvidenceV3 evidence;
};

WriteSceneResultV3 CookAndWriteSceneV3(
    const std::string& inputPath,
    const std::string& outputDirectory,
    const GeometryCookRecipeV3& recipe,
    std::uint64_t targetShardBytes,
    std::uint32_t workerCount);

void ValidateOegPackV3File(const std::string& path, bool verifyPagePayloads);

}  // namespace oengine::asset
