#include "MeshletBuilder.h"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

namespace PSOFlags {
enum : std::uint16_t { kHasPosition = 0x001, kHasNormal = 0x002 };
}

namespace {

struct Summary {
    std::size_t groups = 0;
    std::size_t hierarchy = 0;
    std::size_t meshlets = 0;
    std::size_t triangles = 0;
    std::size_t vertexBytes = 0;
    std::size_t indexBytes = 0;
    float maxError = 0.0f;
    std::size_t infiniteErrors = 0;
    bool semanticErrors = true;
    bool boundsOrdered = true;
};

Summary summarize(const MeshletBuildProducts& product) {
    Summary summary;
    summary.groups = product.Groups.size();
    summary.hierarchy = product.Hierarchy.size();
    for (const auto& node : product.Hierarchy) {
        if (std::isnan(node.MaxParrentError) || node.MaxParrentError < 0.0f) summary.semanticErrors = false;
        if (std::isinf(node.MaxParrentError)) ++summary.infiniteErrors;
        else summary.maxError = std::max(summary.maxError, node.MaxParrentError);
        for (int axis = 0; axis < 3; ++axis) {
            summary.boundsOrdered = summary.boundsOrdered && node.BBoxMin[axis] <= node.BBoxMax[axis];
        }
    }
    for (const auto& group : product.Groups) {
        summary.vertexBytes += group.Blob.size();
        summary.indexBytes += group.Metadata.UncompressedSize;
        if (group.Blob.size() < sizeof(Renderer::GroupHeader)) {
            summary.boundsOrdered = false;
            continue;
        }
        Renderer::GroupHeader header{};
        std::memcpy(&header, group.Blob.data(), sizeof(header));
        summary.meshlets += header.MeshletCount;
        const std::size_t headerBytes = sizeof(Renderer::GroupHeader);
        const std::size_t meshletBytes = sizeof(Renderer::MeshletHeader) * header.MeshletCount;
        if (headerBytes + meshletBytes > group.Blob.size()) {
            summary.boundsOrdered = false;
            continue;
        }
        for (std::size_t index = 0; index < header.MeshletCount; ++index) {
            Renderer::MeshletHeader meshlet{};
            std::memcpy(&meshlet, group.Blob.data() + headerBytes + index * sizeof(meshlet), sizeof(meshlet));
            summary.triangles += static_cast<std::size_t>(meshlet.TriangleCountMinusOne) + 1;
            for (int axis = 0; axis < 3; ++axis) {
                summary.boundsOrdered = summary.boundsOrdered && meshlet.BBoxMin[axis] <= meshlet.BBoxMax[axis];
            }
        }
    }
    return summary;
}

bool equalProduct(const MeshletBuildProducts& left, const MeshletBuildProducts& right) {
    if (left.Groups.size() != right.Groups.size() || left.Hierarchy.size() != right.Hierarchy.size()) return false;
    if (std::memcmp(left.Hierarchy.data(), right.Hierarchy.data(), left.Hierarchy.size() * sizeof(Renderer::HierarchyNode)) != 0) return false;
    for (std::size_t index = 0; index < left.Groups.size(); ++index) {
        const auto& a = left.Groups[index];
        const auto& b = right.Groups[index];
        if (a.Metadata.SizeBytes != b.Metadata.SizeBytes ||
            a.Metadata.UncompressedSize != b.Metadata.UncompressedSize ||
            a.Metadata.PageIndex != b.Metadata.PageIndex ||
            a.Metadata.OffsetInPage != b.Metadata.OffsetInPage ||
            a.Blob != b.Blob) return false;
    }
    return true;
}

void buildGrid(std::vector<std::uint8_t>& vertices, std::vector<std::uint32_t>& indices, std::uint32_t size) {
    constexpr std::uint32_t stride = 16;
    vertices.resize(static_cast<std::size_t>(size) * size * stride);
    for (std::uint32_t y = 0; y < size; ++y) {
        for (std::uint32_t x = 0; x < size; ++x) {
            const std::size_t vertex = static_cast<std::size_t>(y) * size + x;
            const float px = static_cast<float>(x) * 0.125f;
            const float py = static_cast<float>(y) * 0.125f;
            const float pz = static_cast<float>(x % 5u) * 0.0625f + static_cast<float>(y % 7u) * 0.03125f;
            std::memcpy(vertices.data() + vertex * stride + 0, &px, sizeof(float));
            std::memcpy(vertices.data() + vertex * stride + 4, &py, sizeof(float));
            std::memcpy(vertices.data() + vertex * stride + 8, &pz, sizeof(float));
            const std::uint32_t packedNormal = 0x3ffu | (0x3ffu << 10) | (0x3ffu << 20);
            std::memcpy(vertices.data() + vertex * stride + 12, &packedNormal, sizeof(packedNormal));
        }
    }
    indices.reserve(static_cast<std::size_t>(size - 1) * (size - 1) * 6);
    for (std::uint32_t y = 0; y + 1 < size; ++y) {
        for (std::uint32_t x = 0; x + 1 < size; ++x) {
            const std::uint32_t a = y * size + x;
            const std::uint32_t b = a + 1;
            const std::uint32_t c = a + size;
            const std::uint32_t d = c + 1;
            indices.insert(indices.end(), {a, b, d, a, d, c});
        }
    }
}

void buildAttributeSeamGrid(std::vector<std::uint8_t>& vertices, std::vector<std::uint32_t>& indices, std::uint32_t size) {
    constexpr std::uint32_t stride = 16;
    const std::uint32_t baseVertexCount = size * size;
    vertices.resize(static_cast<std::size_t>(baseVertexCount) * 2u * stride);
    for (std::uint32_t y = 0; y < size; ++y) {
        for (std::uint32_t x = 0; x < size; ++x) {
            const std::uint32_t vertex = y * size + x;
            const float px = static_cast<float>(x) * 0.125f;
            const float py = static_cast<float>(y) * 0.125f;
            const float pz = static_cast<float>(x % 5u) * 0.0625f + static_cast<float>(y % 7u) * 0.03125f;
            for (std::uint32_t copy = 0; copy < 2; ++copy) {
                const std::size_t output = static_cast<std::size_t>(copy * baseVertexCount + vertex) * stride;
                std::memcpy(vertices.data() + output + 0, &px, sizeof(float));
                std::memcpy(vertices.data() + output + 4, &py, sizeof(float));
                std::memcpy(vertices.data() + output + 8, &pz, sizeof(float));
                const std::uint32_t packedNormal = copy == 0
                    ? 0x3ffu | (0x3ffu << 10) | (0x3ffu << 20)
                    : 0u;
                std::memcpy(vertices.data() + output + 12, &packedNormal, sizeof(packedNormal));
            }
        }
    }
    indices.reserve(static_cast<std::size_t>(size - 1) * (size - 1) * 6);
    for (std::uint32_t y = 0; y + 1 < size; ++y) {
        for (std::uint32_t x = 0; x + 1 < size; ++x) {
            const std::uint32_t a = y * size + x;
            const std::uint32_t b = a + 1;
            const std::uint32_t c = a + size;
            const std::uint32_t d = c + 1;
            indices.insert(indices.end(), {a, b, d, baseVertexCount + a, baseVertexCount + d, baseVertexCount + c});
        }
    }
}

std::string json(
    const Summary& summary, bool deterministic, bool emptyRejected,
    const Summary& seamFallback, const Summary& seamNoFallback, bool sloppyFallbackObserved) {
    std::ostringstream out;
    out << std::setprecision(9)
        << "{\"groups\":" << summary.groups
        << ",\"hierarchy\":" << summary.hierarchy
        << ",\"meshlets\":" << summary.meshlets
        << ",\"triangles\":" << summary.triangles
        << ",\"vertexBytes\":" << summary.vertexBytes
        << ",\"indexBytes\":" << summary.indexBytes
        << ",\"maxFiniteError\":" << summary.maxError
        << ",\"infiniteErrors\":" << summary.infiniteErrors
        << ",\"semanticErrors\":" << (summary.semanticErrors ? "true" : "false")
        << ",\"boundsOrdered\":" << (summary.boundsOrdered ? "true" : "false")
        << ",\"deterministic\":" << (deterministic ? "true" : "false")
        << ",\"emptyInputRejected\":" << (emptyRejected ? "true" : "false")
        << ",\"seamFallbackGroups\":" << seamFallback.groups
        << ",\"seamFallbackMeshlets\":" << seamFallback.meshlets
        << ",\"seamNoFallbackGroups\":" << seamNoFallback.groups
        << ",\"seamNoFallbackMeshlets\":" << seamNoFallback.meshlets
        << ",\"sloppyFallbackObserved\":" << (sloppyFallbackObserved ? "true" : "false")
        << "}\n";
    return out.str();
}

} // namespace

int main() {
    std::vector<std::uint8_t> vertices;
    std::vector<std::uint32_t> indices;
    buildGrid(vertices, indices, 33);

    MeshletBuildArgs args{};
    args.VBData = vertices.data();
    args.IBData = reinterpret_cast<unsigned char*>(indices.data());
    args.vertexCount = 33 * 33;
    args.indexCount = static_cast<std::uint32_t>(indices.size());
    args.vertexStride = 16;
    args.psoFlags = PSOFlags::kHasPosition | PSOFlags::kHasNormal;
    // Match OEngine's frozen default recipe while running Nyx's unmodified
    // MeshletBuilder implementation. ADR-0016 permits recipe values to vary;
    // the differential must compare the same recipe, not force Nyx defaults.
    args.settings.MaxMeshletVertices = 64;
    args.settings.bValidateBuild = true;
    args.settings.bOutputDebugInfo = false;

    const MeshletBuildProducts first = MeshletBuilder::Build(args);
    const MeshletBuildProducts second = MeshletBuilder::Build(args);
    std::vector<std::uint8_t> seamVertices;
    std::vector<std::uint32_t> seamIndices;
    buildAttributeSeamGrid(seamVertices, seamIndices, 33);
    MeshletBuildArgs fallbackArgs = args;
    fallbackArgs.VBData = seamVertices.data();
    fallbackArgs.IBData = reinterpret_cast<unsigned char*>(seamIndices.data());
    fallbackArgs.vertexCount = 33 * 33 * 2;
    fallbackArgs.indexCount = static_cast<std::uint32_t>(seamIndices.size());
    fallbackArgs.settings.bSimplifyFallbackSloppy = true;
    const MeshletBuildProducts fallbackProduct = MeshletBuilder::Build(fallbackArgs);
    MeshletBuildArgs noFallbackArgs = fallbackArgs;
    noFallbackArgs.settings.bSimplifyFallbackSloppy = false;
    const MeshletBuildProducts noFallbackProduct = MeshletBuilder::Build(noFallbackArgs);
    MeshletBuildArgs empty{};
    const MeshletBuildProducts rejected = MeshletBuilder::Build(empty);
    const Summary summary = summarize(first);
    const Summary fallbackSummary = summarize(fallbackProduct);
    const Summary noFallbackSummary = summarize(noFallbackProduct);
    const bool deterministic = equalProduct(first, second);
    const bool emptyRejected = rejected.Groups.empty() && rejected.Hierarchy.empty();
    const bool sloppyFallbackObserved = !equalProduct(fallbackProduct, noFallbackProduct);
    if (summary.groups == 0 || summary.hierarchy == 0 || summary.meshlets == 0 ||
        !summary.semanticErrors || !summary.boundsOrdered || !deterministic || !emptyRejected || !sloppyFallbackObserved) {
        std::cerr << json(summary, deterministic, emptyRejected, fallbackSummary, noFallbackSummary, sloppyFallbackObserved);
        return 2;
    }
    std::cout << json(summary, deterministic, emptyRejected, fallbackSummary, noFallbackSummary, sloppyFallbackObserved);
    return 0;
}
