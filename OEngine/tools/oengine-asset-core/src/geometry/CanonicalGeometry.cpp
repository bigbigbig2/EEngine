#include "oengine_asset/CanonicalGeometry.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace oengine::asset {
namespace {

void AddU32(Sha256Builder& hash, std::uint32_t value) {
    const std::uint8_t bytes[4] = {
        std::uint8_t(value), std::uint8_t(value >> 8u),
        std::uint8_t(value >> 16u), std::uint8_t(value >> 24u)};
    hash.Add(bytes, sizeof(bytes));
}

void AddF32(Sha256Builder& hash, float value) {
    std::uint32_t bits = 0u;
    std::memcpy(&bits, &value, sizeof(bits));
    AddU32(hash, bits);
}

void ValidateDomain(const MaterialDomain& domain) {
    constexpr std::uint16_t kKnownAttributes =
        kAttributePosition | kAttributeNormal | kAttributeTangent |
        kAttributeUv0 | kAttributeUv1 | kAttributeColor;
    constexpr std::uint32_t kKnownMeshletFlags =
        kMeshletOpaque | kMeshletMask | kMeshletBlend |
        kMeshletTwoSided | kMeshletCastsShadow;
    if (domain.vertices.size() < 3u || domain.indices.empty() || domain.indices.size() % 3u != 0u) {
        throw std::runtime_error("canonical geometry domain is not a triangle list");
    }
    if ((domain.attributeMask & (kAttributePosition | kAttributeNormal)) !=
        (kAttributePosition | kAttributeNormal) ||
        (domain.attributeMask & ~kKnownAttributes) != 0u) {
        throw std::runtime_error("canonical geometry attribute mask is invalid");
    }
    const std::uint32_t alphaModes = domain.meshletFlags &
        (kMeshletOpaque | kMeshletMask | kMeshletBlend);
    if ((domain.meshletFlags & ~kKnownMeshletFlags) != 0u ||
        alphaModes == 0u || (alphaModes & (alphaModes - 1u)) != 0u) {
        throw std::runtime_error("canonical geometry material flags are invalid");
    }
    for (const CanonicalVertex& vertex : domain.vertices) {
        const auto finite = [](const float* values, std::size_t count) {
            return std::all_of(values, values + count, [](float value) {
                return std::isfinite(value);
            });
        };
        if (!finite(vertex.position, 3u) || !finite(vertex.normal, 3u) ||
            !finite(vertex.tangent, 4u) || !finite(vertex.uv0, 2u) ||
            !finite(vertex.uv1, 2u) || !finite(vertex.color, 4u)) {
            throw std::runtime_error("canonical geometry contains non-finite vertex data");
        }
    }
    for (std::uint32_t index : domain.indices) {
        if (index >= domain.vertices.size()) {
            throw std::runtime_error("canonical geometry index exceeds vertex count");
        }
    }
}

}  // namespace

void GenerateCanonicalNormalsV3(MaterialDomain& domain) {
    for (CanonicalVertex& vertex : domain.vertices) {
        vertex.normal[0] = vertex.normal[1] = vertex.normal[2] = 0.0f;
    }
    for (std::size_t i = 0u; i < domain.indices.size(); i += 3u) {
        CanonicalVertex& a = domain.vertices[domain.indices[i]];
        CanonicalVertex& b = domain.vertices[domain.indices[i + 1u]];
        CanonicalVertex& c = domain.vertices[domain.indices[i + 2u]];
        const float ab[3] = {
            b.position[0] - a.position[0], b.position[1] - a.position[1],
            b.position[2] - a.position[2]};
        const float ac[3] = {
            c.position[0] - a.position[0], c.position[1] - a.position[1],
            c.position[2] - a.position[2]};
        const float normal[3] = {
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0]};
        for (std::uint32_t axis = 0u; axis < 3u; ++axis) {
            a.normal[axis] += normal[axis];
            b.normal[axis] += normal[axis];
            c.normal[axis] += normal[axis];
        }
    }
    for (CanonicalVertex& vertex : domain.vertices) {
        const float length = std::sqrt(
            vertex.normal[0] * vertex.normal[0] +
            vertex.normal[1] * vertex.normal[1] +
            vertex.normal[2] * vertex.normal[2]);
        if (length > 1e-20f) {
            vertex.normal[0] /= length;
            vertex.normal[1] /= length;
            vertex.normal[2] /= length;
        } else {
            vertex.normal[2] = 1.0f;
        }
    }
    domain.attributeMask |= kAttributeNormal;
}

void FinalizeCanonicalGeometryAssetV3(CanonicalGeometryAsset& asset) {
    if (asset.domains.empty()) throw std::runtime_error("canonical geometry asset has no domains");
    float minimum[3] = {
        std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::infinity()};
    float maximum[3] = {-minimum[0], -minimum[1], -minimum[2]};
    for (const MaterialDomain& domain : asset.domains) {
        ValidateDomain(domain);
        for (const CanonicalVertex& vertex : domain.vertices) {
            for (std::uint32_t axis = 0u; axis < 3u; ++axis) {
                minimum[axis] = std::min(minimum[axis], vertex.position[axis]);
                maximum[axis] = std::max(maximum[axis], vertex.position[axis]);
            }
        }
    }
    float center[3]{};
    for (std::uint32_t axis = 0u; axis < 3u; ++axis) {
        center[axis] = 0.5f * (minimum[axis] + maximum[axis]);
    }
    float radius = 0.0f;
    for (const MaterialDomain& domain : asset.domains) {
        for (const CanonicalVertex& vertex : domain.vertices) {
            const float dx = vertex.position[0] - center[0];
            const float dy = vertex.position[1] - center[1];
            const float dz = vertex.position[2] - center[2];
            radius = std::max(radius, std::sqrt(dx * dx + dy * dy + dz * dz));
        }
    }
    std::copy(minimum, minimum + 3, asset.boundsMin);
    std::copy(maximum, maximum + 3, asset.boundsMax);
    asset.boundsSphere[0] = center[0];
    asset.boundsSphere[1] = center[1];
    asset.boundsSphere[2] = center[2];
    asset.boundsSphere[3] = radius;

    Sha256Builder hash;
    hash.Add("OENGINE-CANONICAL-GEOMETRY-V3");
    AddU32(hash, std::uint32_t(asset.domains.size()));
    for (const MaterialDomain& domain : asset.domains) {
        AddU32(hash, domain.materialId);
        AddU32(hash, domain.meshletFlags);
        AddU32(hash, domain.attributeMask);
        AddU32(hash, std::uint32_t(domain.vertices.size()));
        AddU32(hash, std::uint32_t(domain.indices.size()));
        for (const CanonicalVertex& vertex : domain.vertices) {
            for (float value : vertex.position) AddF32(hash, value);
            for (float value : vertex.normal) AddF32(hash, value);
            if (domain.attributeMask & kAttributeTangent) {
                for (float value : vertex.tangent) AddF32(hash, value);
            }
            if (domain.attributeMask & kAttributeUv0) {
                for (float value : vertex.uv0) AddF32(hash, value);
            }
            if (domain.attributeMask & kAttributeUv1) {
                for (float value : vertex.uv1) AddF32(hash, value);
            }
            if (domain.attributeMask & kAttributeColor) {
                for (float value : vertex.color) AddF32(hash, value);
            }
        }
        for (std::uint32_t index : domain.indices) AddU32(hash, index);
    }
    asset.sourceHash = hash.Finish();
}

}  // namespace oengine::asset
