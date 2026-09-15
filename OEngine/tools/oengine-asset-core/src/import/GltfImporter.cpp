#include "oengine_asset/GeometryCooker.h"

#define CGLTF_IMPLEMENTATION
#include "cgltf.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <stdexcept>
#include <unordered_map>

namespace oengine::asset {
namespace {

struct CgltfDeleter {
    void operator()(cgltf_data* data) const { if (data) cgltf_free(data); }
};

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

const cgltf_accessor* FindAttribute(
    const cgltf_primitive& primitive, cgltf_attribute_type type, int index = 0) {
    for (cgltf_size i = 0; i < primitive.attributes_count; ++i) {
        const cgltf_attribute& attribute = primitive.attributes[i];
        if (attribute.type == type && attribute.index == index) return attribute.data;
    }
    return nullptr;
}

void ReadFloat(const cgltf_accessor* accessor, cgltf_size index, float* values, cgltf_size count) {
    if (!cgltf_accessor_read_float(accessor, index, values, count)) {
        throw std::runtime_error("cgltf failed to decode a vertex accessor");
    }
    for (cgltf_size component = 0; component < count; ++component) {
        if (!std::isfinite(values[component])) throw std::runtime_error("glTF contains non-finite vertex data");
    }
}

std::uint32_t MaterialFlags(const cgltf_material* material) {
    std::uint32_t flags = kMeshletCastsShadow;
    if (!material || material->alpha_mode == cgltf_alpha_mode_opaque) flags |= kMeshletOpaque;
    else if (material->alpha_mode == cgltf_alpha_mode_mask) flags |= kMeshletMask;
    else flags |= kMeshletBlend;
    if (material && material->double_sided) flags |= kMeshletTwoSided;
    return flags;
}

void GenerateNormals(MaterialDomain& domain) {
    for (CanonicalVertex& vertex : domain.vertices) {
        vertex.normal[0] = vertex.normal[1] = vertex.normal[2] = 0.0f;
    }
    for (std::size_t i = 0; i < domain.indices.size(); i += 3u) {
        CanonicalVertex& a = domain.vertices[domain.indices[i]];
        CanonicalVertex& b = domain.vertices[domain.indices[i + 1u]];
        CanonicalVertex& c = domain.vertices[domain.indices[i + 2u]];
        const float ab[3] = {b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]};
        const float ac[3] = {c.position[0] - a.position[0], c.position[1] - a.position[1], c.position[2] - a.position[2]};
        const float n[3] = {
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0]};
        for (std::uint32_t axis = 0; axis < 3u; ++axis) {
            a.normal[axis] += n[axis]; b.normal[axis] += n[axis]; c.normal[axis] += n[axis];
        }
    }
    for (CanonicalVertex& vertex : domain.vertices) {
        const float length = std::sqrt(vertex.normal[0] * vertex.normal[0] +
                                       vertex.normal[1] * vertex.normal[1] +
                                       vertex.normal[2] * vertex.normal[2]);
        if (length > 1e-20f) {
            vertex.normal[0] /= length; vertex.normal[1] /= length; vertex.normal[2] /= length;
        } else {
            vertex.normal[2] = 1.0f;
        }
    }
}

MaterialDomain DecodePrimitive(const cgltf_data& data, const cgltf_primitive& primitive) {
    if (primitive.type != cgltf_primitive_type_triangles) throw std::runtime_error("OEG V3 accepts triangle primitives only");
    const cgltf_accessor* position = FindAttribute(primitive, cgltf_attribute_type_position);
    if (!position || position->count < 3u) throw std::runtime_error("glTF primitive is missing POSITION");
    const cgltf_accessor* normal = FindAttribute(primitive, cgltf_attribute_type_normal);
    const cgltf_accessor* tangent = FindAttribute(primitive, cgltf_attribute_type_tangent);
    const cgltf_accessor* uv0 = FindAttribute(primitive, cgltf_attribute_type_texcoord, 0);
    const cgltf_accessor* uv1 = FindAttribute(primitive, cgltf_attribute_type_texcoord, 1);
    const cgltf_accessor* color = FindAttribute(primitive, cgltf_attribute_type_color, 0);

    MaterialDomain domain;
    domain.materialId = primitive.material ? std::uint32_t(primitive.material - data.materials) : kInvalidId;
    domain.meshletFlags = MaterialFlags(primitive.material);
    domain.attributeMask = kAttributePosition | kAttributeNormal;
    if (tangent) domain.attributeMask |= kAttributeTangent;
    if (uv0) domain.attributeMask |= kAttributeUv0;
    if (uv1) domain.attributeMask |= kAttributeUv1;
    if (color) domain.attributeMask |= kAttributeColor;
    domain.vertices.resize(position->count);
    for (cgltf_size i = 0; i < position->count; ++i) {
        CanonicalVertex& vertex = domain.vertices[i];
        ReadFloat(position, i, vertex.position, 3u);
        if (normal) ReadFloat(normal, i, vertex.normal, 3u);
        if (tangent) ReadFloat(tangent, i, vertex.tangent, 4u);
        if (uv0) ReadFloat(uv0, i, vertex.uv0, 2u);
        if (uv1) ReadFloat(uv1, i, vertex.uv1, 2u);
        if (color) ReadFloat(color, i, vertex.color, 4u);
    }
    const std::size_t indexCount = primitive.indices ? primitive.indices->count : position->count;
    if (indexCount == 0u || indexCount % 3u != 0u) throw std::runtime_error("glTF primitive indices are not a triangle list");
    domain.indices.resize(indexCount);
    for (std::size_t i = 0; i < indexCount; ++i) {
        const std::size_t index = primitive.indices ? cgltf_accessor_read_index(primitive.indices, i) : i;
        if (index >= domain.vertices.size()) throw std::runtime_error("glTF index exceeds primitive vertex count");
        domain.indices[i] = std::uint32_t(index);
    }
    if (!normal) GenerateNormals(domain);
    return domain;
}

std::uint64_t DomainKey(const MaterialDomain& domain) {
    return (std::uint64_t(domain.materialId) << 32u) |
           (std::uint64_t(domain.meshletFlags & 0xffffu) << 16u) |
           domain.attributeMask;
}

void AppendDomain(MaterialDomain& target, MaterialDomain source) {
    const std::uint32_t vertexBase = std::uint32_t(target.vertices.size());
    target.vertices.insert(target.vertices.end(), source.vertices.begin(), source.vertices.end());
    target.indices.reserve(target.indices.size() + source.indices.size());
    for (std::uint32_t index : source.indices) target.indices.push_back(vertexBase + index);
}

void ComputeBounds(CanonicalGeometryAsset& asset) {
    float minimum[3] = {
        std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::infinity()};
    float maximum[3] = {-minimum[0], -minimum[1], -minimum[2]};
    for (const MaterialDomain& domain : asset.domains) {
        for (const CanonicalVertex& vertex : domain.vertices) {
            for (std::uint32_t axis = 0; axis < 3u; ++axis) {
                minimum[axis] = std::min(minimum[axis], vertex.position[axis]);
                maximum[axis] = std::max(maximum[axis], vertex.position[axis]);
            }
        }
    }
    float radius = 0.0f;
    float center[3]{};
    for (std::uint32_t axis = 0; axis < 3u; ++axis) center[axis] = 0.5f * (minimum[axis] + maximum[axis]);
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
    asset.boundsSphere[0] = center[0]; asset.boundsSphere[1] = center[1];
    asset.boundsSphere[2] = center[2]; asset.boundsSphere[3] = radius;
}

Hash256 HashCanonicalAsset(const CanonicalGeometryAsset& asset) {
    Sha256Builder hash;
    hash.Add("OENGINE-CANONICAL-GEOMETRY-V3");
    AddU32(hash, std::uint32_t(asset.domains.size()));
    for (const MaterialDomain& domain : asset.domains) {
        AddU32(hash, domain.materialId); AddU32(hash, domain.meshletFlags); AddU32(hash, domain.attributeMask);
        AddU32(hash, std::uint32_t(domain.vertices.size())); AddU32(hash, std::uint32_t(domain.indices.size()));
        for (const CanonicalVertex& vertex : domain.vertices) {
            for (float value : vertex.position) AddF32(hash, value);
            for (float value : vertex.normal) AddF32(hash, value);
            if (domain.attributeMask & kAttributeTangent) for (float value : vertex.tangent) AddF32(hash, value);
            if (domain.attributeMask & kAttributeUv0) for (float value : vertex.uv0) AddF32(hash, value);
            if (domain.attributeMask & kAttributeUv1) for (float value : vertex.uv1) AddF32(hash, value);
            if (domain.attributeMask & kAttributeColor) for (float value : vertex.color) AddF32(hash, value);
        }
        for (std::uint32_t index : domain.indices) AddU32(hash, index);
    }
    return hash.Finish();
}

CanonicalGeometryAsset DecodeMesh(const cgltf_data& data, const cgltf_mesh& mesh, std::size_t meshIndex) {
    CanonicalGeometryAsset asset;
    asset.sourceName = mesh.name ? mesh.name : ("mesh-" + std::to_string(meshIndex));
    std::map<std::uint64_t, std::size_t> compatibleDomains;
    for (cgltf_size primitiveIndex = 0; primitiveIndex < mesh.primitives_count; ++primitiveIndex) {
        const cgltf_primitive& primitive = mesh.primitives[primitiveIndex];
        if (primitive.type != cgltf_primitive_type_triangles) continue;
        MaterialDomain decoded = DecodePrimitive(data, primitive);
        const std::uint64_t key = DomainKey(decoded);
        const auto found = compatibleDomains.find(key);
        if (found == compatibleDomains.end()) {
            compatibleDomains.emplace(key, asset.domains.size());
            asset.domains.push_back(std::move(decoded));
        } else {
            AppendDomain(asset.domains[found->second], std::move(decoded));
        }
    }
    if (asset.domains.empty()) throw std::runtime_error("glTF mesh has no supported triangle primitives");
    ComputeBounds(asset);
    asset.sourceHash = HashCanonicalAsset(asset);
    return asset;
}

}  // namespace

ImportedSceneV3 ImportGltfCanonical(const std::string& path) {
    cgltf_options options{};
    cgltf_data* raw = nullptr;
    const cgltf_result parse = cgltf_parse_file(&options, path.c_str(), &raw);
    if (parse != cgltf_result_success) throw std::runtime_error("cgltf_parse_file failed: " + std::to_string(parse));
    std::unique_ptr<cgltf_data, CgltfDeleter> data(raw);
    const cgltf_result buffers = cgltf_load_buffers(&options, data.get(), path.c_str());
    if (buffers != cgltf_result_success) throw std::runtime_error("cgltf_load_buffers failed: " + std::to_string(buffers));
    const cgltf_result validation = cgltf_validate(data.get());
    if (validation != cgltf_result_success) throw std::runtime_error("cgltf_validate failed: " + std::to_string(validation));

    ImportedSceneV3 output;
    std::vector<std::uint32_t> meshToAsset(data->meshes_count, kInvalidId);
    std::unordered_map<std::string, std::uint32_t> deduplicated;
    for (cgltf_size meshIndex = 0; meshIndex < data->meshes_count; ++meshIndex) {
        CanonicalGeometryAsset asset = DecodeMesh(*data, data->meshes[meshIndex], meshIndex);
        const std::string key = Hex(asset.sourceHash);
        const auto found = deduplicated.find(key);
        if (found != deduplicated.end()) {
            meshToAsset[meshIndex] = found->second;
        } else {
            const std::uint32_t assetIndex = std::uint32_t(output.assets.size());
            deduplicated.emplace(key, assetIndex);
            meshToAsset[meshIndex] = assetIndex;
            output.assets.push_back(std::move(asset));
        }
    }

    for (cgltf_size nodeIndex = 0; nodeIndex < data->nodes_count; ++nodeIndex) {
        const cgltf_node& node = data->nodes[nodeIndex];
        if (!node.mesh) continue;
        if (node.skin) {
            throw std::runtime_error(
                "OEGPACK V3 static geometry import does not accept skinned mesh nodes");
        }
        const std::size_t meshIndex = std::size_t(node.mesh - data->meshes);
        if (meshIndex >= meshToAsset.size() || meshToAsset[meshIndex] == kInvalidId) continue;
        SceneInstanceV3 instance;
        instance.assetIndex = meshToAsset[meshIndex];
        cgltf_node_transform_world(&node, instance.worldTransform.data());
        output.instances.push_back(instance);
    }
    if (output.assets.empty() || output.instances.empty()) throw std::runtime_error("glTF scene contains no instanced triangle geometry");
    return output;
}

}  // namespace oengine::asset
