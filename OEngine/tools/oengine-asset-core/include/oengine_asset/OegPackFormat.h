#pragma once

#include "GeometryAbi.h"

#include <array>
#include <cstddef>
#include <cstdint>

namespace oengine::asset {

inline constexpr std::array<std::uint8_t, 8> kOegPackMagicV3 = {
    'O', 'E', 'G', 'P', 'A', 'C', 'K', 0};
inline constexpr std::uint32_t kOegPackFormatMajorV3 = 3u;
inline constexpr std::uint32_t kOegPackFormatMinorV3 = 0u;
inline constexpr std::uint32_t kOegPackEndianMarker = 0x01020304u;
inline constexpr std::uint32_t kOegPackHeaderBytesV3 = 256u;

enum GeometryPageCodecV3 : std::uint32_t {
    kPageCodecRaw256K = 0u,
    kPageCodecLz4Block = 1u,
    kPageCodecMeshoptReserved = 2u,
    kPageCodecGpuExperimentalReserved = 3u,
};

struct OegPackHeaderV3 {
    std::uint8_t magic[8];
    std::uint32_t formatMajor;
    std::uint32_t formatMinor;
    std::uint32_t endianMarker;
    std::uint32_t headerBytes;
    std::uint32_t pageShift;
    std::uint32_t pageBytes;
    std::uint32_t flags;
    std::uint32_t defaultCodec;
    std::uint32_t assetCount;
    std::uint32_t rootNodeIndexCount;
    std::uint32_t hierarchyNodeCount;
    std::uint32_t groupCount;
    std::uint32_t pageCount;
    std::uint32_t vertexFormatCount;
    std::uint32_t bootstrapPageCount;
    std::uint32_t reserved0;
    std::uint64_t assetDirectoryOffset;
    std::uint64_t rootNodeIndexOffset;
    std::uint64_t hierarchyOffset;
    std::uint64_t groupDirectoryOffset;
    std::uint64_t pageDirectoryOffset;
    std::uint64_t vertexFormatOffset;
    std::uint64_t bootstrapPageOffset;
    std::uint64_t pageBlobOffset;
    std::uint64_t fileBytes;
    std::uint8_t recipeHash[32];
    std::uint8_t packContentHash[32];
    std::uint8_t reserved[48];
};

struct GeometryAssetRecordV3 {
    std::uint8_t assetId[32];
    float boundsSphere[4];
    float boundsMin[3];
    float boundsMax[3];
    std::uint32_t rootNodeBegin;
    std::uint32_t rootNodeCount;
    std::uint32_t hierarchyBegin;
    std::uint32_t hierarchyCount;
    std::uint32_t groupBegin;
    std::uint32_t groupCount;
    std::uint32_t bootstrapPageBegin;
    std::uint32_t bootstrapPageCount;
    std::uint32_t sourceTriangleCount;
    std::uint32_t leafMeshletCount;
    std::uint32_t totalMeshletCount;
    std::uint32_t flags;
    std::uint32_t reserved[2];
};

struct GeometryPageDirectoryV3 {
    std::uint64_t compressedFileOffset;
    std::uint32_t compressedBytes;
    std::uint32_t decodedBytes;
    std::uint32_t firstGroup;
    std::uint32_t groupCount;
    std::uint32_t codec;
    std::uint32_t flags;
    std::uint8_t decodedContentHash128[16];
    std::uint32_t compressedChecksum;
    std::uint32_t reserved0;
    std::uint64_t reserved1;
};

static_assert(sizeof(OegPackHeaderV3) == 256u);
static_assert(offsetof(OegPackHeaderV3, assetDirectoryOffset) == 72u);
static_assert(offsetof(OegPackHeaderV3, recipeHash) == 144u);
static_assert(sizeof(GeometryAssetRecordV3) == 128u);
static_assert(sizeof(GeometryPageDirectoryV3) == 64u);
static_assert(offsetof(GeometryPageDirectoryV3, decodedContentHash128) == 32u);

}  // namespace oengine::asset
