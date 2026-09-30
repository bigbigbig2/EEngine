#pragma once
#include "GeometryCooker.h"
#include <cstring>
#include <map>
#include <numeric>
#include <set>
#include <string>

namespace oengine::asset {
constexpr std::uint32_t kSurfacePrimitiveBytes = 32u;
struct SourceSurfaceDomains {
    std::map<std::string, std::set<std::uint32_t>> corners;
    std::vector<std::uint32_t> triangleDomains;
};
inline std::string SurfaceCornerKey(const CanonicalVertex& vertex, std::uint32_t orientation) {
    std::string key(reinterpret_cast<const char*>(&vertex), sizeof(vertex));
    key.append(reinterpret_cast<const char*>(&orientation), sizeof(orientation));
    return key;
}
inline std::uint32_t SurfaceUvOrientation(const CanonicalVertex& first,
    const CanonicalVertex& second, const CanonicalVertex& third, std::uint16_t mask) {
    std::uint32_t result = 0u;
    for (std::uint32_t uv = 0; uv < 2u; ++uv) {
        if (!(mask & (uv == 0u ? kAttributeUv0 : kAttributeUv1))) continue;
        const auto* begin = uv == 0u ? first.uv0 : first.uv1;
        const auto* middle = uv == 0u ? second.uv0 : second.uv1;
        const auto* end = uv == 0u ? third.uv0 : third.uv1;
        const float determinant = (middle[0] - begin[0]) * (end[1] - begin[1]) -
            (middle[1] - begin[1]) * (end[0] - begin[0]);
        const std::uint32_t sign = determinant > 0.0f ? 1u : determinant < 0.0f ? 2u : 3u;
        result |= sign << (uv * 2u);
    }
    return result;
}
inline SourceSurfaceDomains BuildSourceSurfaceDomains(const MaterialDomain& source, std::uint32_t domainBase = 0u) {
    const auto count = std::uint32_t(source.indices.size() / 3u);
    std::vector<std::uint32_t> parents(count);
    std::iota(parents.begin(), parents.end(), 0u);
    auto root = [&](std::uint32_t triangle) {
        while (parents[triangle] != triangle) triangle = parents[triangle];
        return triangle;
    };
    struct Edge { std::uint32_t triangle; bool forward; };
    std::map<std::pair<std::string, std::string>, std::vector<Edge>> edges;
    for (std::uint32_t triangle = 0; triangle < count; ++triangle) {
        const auto orientation = SurfaceUvOrientation(source.vertices[source.indices[triangle * 3u]],
            source.vertices[source.indices[triangle * 3u + 1u]], source.vertices[source.indices[triangle * 3u + 2u]], source.attributeMask);
        for (std::uint32_t corner = 0; corner < 3u; ++corner) {
            auto begin = SurfaceCornerKey(source.vertices[source.indices[triangle * 3u + corner]], orientation);
            auto end = SurfaceCornerKey(source.vertices[source.indices[triangle * 3u + (corner + 1u) % 3u]], orientation);
            const bool forward = begin < end;
            if (begin == end) continue;
            if (!forward) std::swap(begin, end);
            edges[{begin, end}].push_back({triangle, forward});
        }
    }
    for (const auto& [key, edge] : edges) {
        if (edge.size() != 2u || edge[0].forward == edge[1].forward) continue;
        parents[root(edge[1].triangle)] = root(edge[0].triangle);
    }
    SourceSurfaceDomains result;
    result.triangleDomains.resize(count);
    for (std::uint32_t triangle = 0; triangle < count; ++triangle) {
        const auto domain = domainBase + root(triangle) + 1u;
        result.triangleDomains[triangle] = domain;
        const auto orientation = SurfaceUvOrientation(source.vertices[source.indices[triangle * 3u]],
            source.vertices[source.indices[triangle * 3u + 1u]], source.vertices[source.indices[triangle * 3u + 2u]], source.attributeMask);
        for (std::uint32_t corner = 0; corner < 3u; ++corner)
            result.corners[SurfaceCornerKey(source.vertices[source.indices[triangle * 3u + corner]], orientation)].insert(domain);
    }
    return result;
}
}
