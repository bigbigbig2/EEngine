#pragma once

#include "GeometryCooker.h"
#include "OegPackFormat.h"

#include <cstdint>
#include <string>
#include <vector>

namespace oengine::asset {

struct WrittenPackV4 {
    std::string path;
    Hash256 packId{};
    std::vector<std::uint32_t> sourceAssetIndices;
};

struct WriteSceneResultV4 {
    std::string scenePath;
    std::vector<WrittenPackV4> packs;
    CookEvidenceV4 evidence;
};

WriteSceneResultV4 CookAndWriteSceneV4(
    const std::string& inputPath,
    const std::string& outputDirectory,
    const GeometryCookRecipeV4& recipe,
    std::uint64_t targetShardBytes,
    std::uint32_t workerCount);

void ValidateOegPackV4File(const std::string& path, bool verifyPagePayloads);

}  // namespace oengine::asset
