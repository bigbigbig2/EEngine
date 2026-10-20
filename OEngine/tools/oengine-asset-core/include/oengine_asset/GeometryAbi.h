#pragma once

#include "GeometryLayoutV4.generated.h"
#include <array>
#include <cstddef>
#include <cstdint>

namespace oengine::asset {

inline constexpr std::uint32_t kInvalidId = 0xffffffffu;
inline constexpr std::uint32_t kGeometryPageShiftV4 = 18u;
inline constexpr std::uint32_t kGeometryPageBytesV4 = 1u << kGeometryPageShiftV4;
inline constexpr std::uint32_t kGeometryBankBytesV4 = 128u * 1024u * 1024u;
inline constexpr std::uint32_t kGeometrySlotsPerBankV4 =
    kGeometryBankBytesV4 / kGeometryPageBytesV4;

enum GeometryAttributeMaskV4 : std::uint16_t {
    kAttributePosition = 1u << 0u,
    kAttributeNormal = 1u << 1u,
    kAttributeTangent = 1u << 2u,
    kAttributeUv0 = 1u << 3u,
    kAttributeUv1 = 1u << 4u,
    kAttributeColor = 1u << 5u,
};

enum GeometryGroupFlagsV4 : std::uint32_t {
    kGroupBootstrap = 1u << 0u,
    kGroupOpaque = 1u << 1u,
    kGroupMask = 1u << 2u,
    kGroupBlend = 1u << 3u,
    kGroupTwoSided = 1u << 4u,
    kGroupSimplificationFallback = 1u << 5u,
};

enum GeometryMeshletFlagsV4 : std::uint32_t {
    kMeshletOpaque = 1u << 0u,
    kMeshletMask = 1u << 1u,
    kMeshletBlend = 1u << 2u,
    kMeshletTwoSided = 1u << 3u,
    kMeshletCastsShadow = 1u << 4u,
};

struct GeometryHierarchyNodeV4 {
    float boundsSphere[4];
    float bboxMin[3];
    float bboxMax[3];
    float maxParentError;
    std::uint32_t packedNodeData;
};

struct GeometryGroupDirectoryV4 {
    std::uint32_t pageId;
    std::uint32_t offsetInDecodedPage;
    std::uint32_t payloadBytes;
    std::uint32_t flags;
};

struct VertexFormatRecordV4 {
    std::uint16_t streamBytesPerVertex; // Sum of stream widths, not an interleaved stride.
    std::uint16_t attributeMask;
    std::uint8_t positionOffset;
    std::uint8_t normalOffset;
    std::uint8_t tangentOffset;
    std::uint8_t uv0Offset;
    std::uint8_t uv1Offset;
    std::uint8_t colorOffset;
    std::uint8_t positionEncoding; // 2 = component SoA Float32 x/y/z
    std::uint8_t tangentSignEncoding; // 0 absent, 1 exact +/-1 bits, 2 retained SNORM16
    std::uint8_t reserved[4];
};

inline constexpr VertexFormatRecordV4 GeometryVertexFormatV4(
    std::uint16_t mask, std::uint8_t signEncoding) {
    VertexFormatRecordV4 format{};
    format.attributeMask = mask;
    format.normalOffset = layout_v4::vertex_normalOffset;
    std::uint8_t cursor = layout_v4::vertex_optionalStreamBegin;
    const auto take = [&](std::uint16_t flag) constexpr -> std::uint8_t {
        if (!(mask & flag)) return 255u;
        const auto offset = cursor;
        cursor += layout_v4::vertex_optionalStreamWidth;
        return offset;
    };
    format.tangentOffset = take(kAttributeTangent);
    format.uv0Offset = take(kAttributeUv0);
    format.uv1Offset = take(kAttributeUv1);
    format.colorOffset = take(kAttributeColor);
    format.positionEncoding = layout_v4::vertex_positionEncoding;
    format.tangentSignEncoding = signEncoding;
    format.streamBytesPerVertex = cursor + (signEncoding == 2u ? 2u : 0u);
    return format;
}

inline constexpr bool IsGeometryVertexFormatV4(const VertexFormatRecordV4& format) {
    if ((format.attributeMask & 3u) != 3u || (format.attributeMask & ~63u) != 0u ||
        ((format.attributeMask & kAttributeTangent) ?
            format.tangentSignEncoding != 1u && format.tangentSignEncoding != 2u :
            format.tangentSignEncoding != 0u)) return false;
    const auto expected = GeometryVertexFormatV4(format.attributeMask, format.tangentSignEncoding);
    return format.streamBytesPerVertex == expected.streamBytesPerVertex &&
        format.positionOffset == expected.positionOffset && format.normalOffset == expected.normalOffset &&
        format.tangentOffset == expected.tangentOffset && format.uv0Offset == expected.uv0Offset &&
        format.uv1Offset == expected.uv1Offset && format.colorOffset == expected.colorOffset &&
        format.positionEncoding == expected.positionEncoding &&
        format.reserved[0] == 0u && format.reserved[1] == 0u &&
        format.reserved[2] == 0u && format.reserved[3] == 0u;
}

inline constexpr std::uint32_t GeometryVertexPayloadBytes(
    std::uint32_t count, const VertexFormatRecordV4& format) {
    const auto bytes = count * format.streamBytesPerVertex +
        (format.tangentSignEncoding == 1u ? (count + 7u) / 8u : 0u);
    return (bytes + 3u) & ~3u;
}

struct GroupHeaderV4 {
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

struct MeshletHeaderV4 {
    std::uint8_t vertexCount;
    std::uint8_t triangleCount;
    std::uint16_t flags;
    std::uint32_t vertexByteOffset;
    std::uint32_t triangleByteOffset;
    std::uint32_t refineGroupId;
    std::uint32_t materialId;
    float bboxMin[3];
    float bboxMax[3];
};

constexpr std::uint32_t PackInternalNodeV4(
    std::uint32_t childStartIndex, std::uint32_t childCount) {
    return ((childStartIndex & 0x07ffffffu) << 1u) |
           ((childCount & 0x0fu) << 28u);
}

constexpr std::uint32_t PackGroupLeafV4(
    std::uint32_t groupIndex, std::uint32_t meshletCount) {
    return 1u | ((groupIndex & 0x00ffffffu) << 1u) |
           (((meshletCount - 1u) & 0x7fu) << 25u);
}

constexpr bool IsGroupLeafV4(std::uint32_t packed) {
    return (packed & 1u) != 0u;
}
static_assert(sizeof(GeometryHierarchyNodeV4) == 48u);
static_assert(offsetof(GeometryHierarchyNodeV4, maxParentError) == 40u);
static_assert(offsetof(GeometryHierarchyNodeV4, packedNodeData) == 44u);
static_assert(sizeof(GeometryGroupDirectoryV4) == 16u);
static_assert(sizeof(VertexFormatRecordV4) == 16u);
static_assert(sizeof(GroupHeaderV4) == 64u);
static_assert(offsetof(GroupHeaderV4, meshletHeaderOffset) == 48u);
static_assert(sizeof(MeshletHeaderV4) == layout_v4::meshletHeaderBytes);
static_assert(offsetof(MeshletHeaderV4, bboxMin) == 20u);
static_assert(kGeometrySlotsPerBankV4 == 512u);
static_assert(offsetof(MeshletHeaderV4, vertexCount) == layout_v4::meshlet_vertexCount);
static_assert(offsetof(MeshletHeaderV4, triangleCount) == layout_v4::meshlet_triangleCount);
static_assert(offsetof(MeshletHeaderV4, flags) == layout_v4::meshlet_flags);
static_assert(offsetof(MeshletHeaderV4, vertexByteOffset) == layout_v4::meshlet_vertexByteOffset);
static_assert(offsetof(MeshletHeaderV4, triangleByteOffset) == layout_v4::meshlet_triangleByteOffset);
static_assert(offsetof(MeshletHeaderV4, refineGroupId) == layout_v4::meshlet_refineGroupId);
static_assert(offsetof(MeshletHeaderV4, materialId) == layout_v4::meshlet_materialId);
static_assert(offsetof(MeshletHeaderV4, bboxMin) == layout_v4::meshlet_bboxMin);
static_assert(offsetof(MeshletHeaderV4, bboxMax) == layout_v4::meshlet_bboxMax);

}  // namespace oengine::asset
