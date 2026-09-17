#include "oengine_asset/GeometryCooker.h"

#define CGLTF_IMPLEMENTATION
#include "cgltf.h"

#include "oengine_asset/CanonicalGeometry.h"

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
    if (!normal) GenerateCanonicalNormalsV3(domain);
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
    FinalizeCanonicalGeometryAssetV3(asset);
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
