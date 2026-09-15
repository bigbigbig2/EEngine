#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace oengine::asset {

inline constexpr std::uint32_t kInvalidId = 0xffffffffu;
inline constexpr std::uint32_t kGeometryPageShiftV3 = 18u;
inline constexpr std::uint32_t kGeometryPageBytesV3 = 1u << kGeometryPageShiftV3;
inline constexpr std::uint32_t kGeometryBankBytesV3 = 128u * 1024u * 1024u;
inline constexpr std::uint32_t kGeometrySlotsPerBankV3 =
    kGeometryBankBytesV3 / kGeometryPageBytesV3;

enum GeometryAttributeMaskV3 : std::uint16_t {
    kAttributePosition = 1u << 0u,
    kAttributeNormal = 1u << 1u,
    kAttributeTangent = 1u << 2u,
    kAttributeUv0 = 1u << 3u,
    kAttributeUv1 = 1u << 4u,
    kAttributeColor = 1u << 5u,
};

enum GeometryGroupFlagsV3 : std::uint32_t {
    kGroupBootstrap = 1u << 0u,
    kGroupOpaque = 1u << 1u,
    kGroupMask = 1u << 2u,
    kGroupBlend = 1u << 3u,
    kGroupTwoSided = 1u << 4u,
    kGroupSimplificationFallback = 1u << 5u,
};

enum GeometryMeshletFlagsV3 : std::uint32_t {
    kMeshletOpaque = 1u << 0u,
    kMeshletMask = 1u << 1u,
    kMeshletBlend = 1u << 2u,
    kMeshletTwoSided = 1u << 3u,
    kMeshletCastsShadow = 1u << 4u,
};

struct GeometryHierarchyNodeV3 {
    float boundsSphere[4];
    float bboxMin[3];
    float bboxMax[3];
    float maxParentError;
    std::uint32_t packedNodeData;
};

struct GeometryGroupDirectoryV3 {
    std::uint32_t pageId;
    std::uint32_t offsetInDecodedPage;
    std::uint32_t payloadBytes;
    std::uint32_t flags;
};

struct VertexFormatRecordV3 {
    std::uint16_t strideBytes;
    std::uint16_t attributeMask;
    std::uint8_t positionOffset;
    std::uint8_t normalOffset;
    std::uint8_t tangentOffset;
    std::uint8_t uv0Offset;
    std::uint8_t uv1Offset;
    std::uint8_t colorOffset;
    std::uint8_t reserved[6];
};

struct GroupHeaderV3 {
    float boundsSphere[4];
    float bboxMin[3];
    float bboxMax[3];
    float parentError;
    std::uint16_t meshletCount;
    std::uint8_t lodLevel;
    std::uint8_t vertexFormatId;
    std::uint32_t meshletHeaderOffset;
    std::uint32_t triangleDataOffset;
    std::uint32_t vertexDataOffset;
    std::uint32_t payloadBytes;
};

struct MeshletHeaderV3 {
    std::uint16_t vertexCount;
    std::uint16_t triangleCount;
    std::uint32_t vertexByteOffset;
    std::uint32_t triangleByteOffset;
    std::uint32_t refineGroupId;
    std::uint32_t materialId;
    std::uint32_t flags;
    float bboxMin[3];
    float bboxMax[3];
};

constexpr std::uint32_t PackInternalNodeV3(
    std::uint32_t childStartIndex, std::uint32_t childCount) {
    return ((childStartIndex & 0x07ffffffu) << 1u) |
           ((childCount & 0x0fu) << 28u);
}

constexpr std::uint32_t PackGroupLeafV3(
    std::uint32_t groupIndex, std::uint32_t meshletCount) {
    return 1u | ((groupIndex & 0x00ffffffu) << 1u) |
           (((meshletCount - 1u) & 0x7fu) << 25u);
}

constexpr bool IsGroupLeafV3(std::uint32_t packed) {
    return (packed & 1u) != 0u;
}

static_assert(sizeof(GeometryHierarchyNodeV3) == 48u);
static_assert(offsetof(GeometryHierarchyNodeV3, maxParentError) == 40u);
static_assert(offsetof(GeometryHierarchyNodeV3, packedNodeData) == 44u);
static_assert(sizeof(GeometryGroupDirectoryV3) == 16u);
static_assert(sizeof(VertexFormatRecordV3) == 16u);
static_assert(sizeof(GroupHeaderV3) == 64u);
static_assert(offsetof(GroupHeaderV3, meshletHeaderOffset) == 48u);
static_assert(sizeof(MeshletHeaderV3) == 48u);
static_assert(offsetof(MeshletHeaderV3, bboxMin) == 24u);
static_assert(kGeometrySlotsPerBankV3 == 512u);

}  // namespace oengine::asset
