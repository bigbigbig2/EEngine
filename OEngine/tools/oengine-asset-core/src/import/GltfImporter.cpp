#include "oengine_asset/GeometryCooker.h"

#define CGLTF_IMPLEMENTATION
#include "cgltf.h"

#include "oengine_asset/CanonicalGeometry.h"
#include "meshoptimizer.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
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

// cgltf parses EXT_meshopt_compression but leaves decoding to its caller.
// Read only referenced views; the virtual decoded buffer need not exist on disk.
std::vector<unsigned char> ReadBufferRange(
    const cgltf_data& data, const cgltf_buffer& buffer, const std::string& path,
    std::size_t offset, std::size_t size) {
    if (offset > buffer.size || size > buffer.size - offset) {
        throw std::runtime_error("glTF buffer range exceeds declared size");
    }
    if (buffer.data) {
        const auto* bytes = static_cast<const unsigned char*>(buffer.data);
        return {bytes + offset, bytes + offset + size};
    }
    if (!buffer.uri) {
        if (&buffer != data.buffers || !data.bin || offset > data.bin_size || size > data.bin_size - offset) {
            throw std::runtime_error("glTF buffer has no readable payload");
        }
        const auto* bytes = static_cast<const unsigned char*>(data.bin);
        return {bytes + offset, bytes + offset + size};
    }
    std::string uri(buffer.uri);
    if (uri.rfind("data:", 0u) == 0u || uri.find("://") != std::string::npos) {
        throw std::runtime_error("range importer requires a local external buffer");
    }
    cgltf_decode_uri(uri.data());
    uri.resize(std::strlen(uri.c_str()));
    const auto source = std::filesystem::path(path).parent_path() / std::filesystem::path(uri);
    std::ifstream input(source, std::ios::binary | std::ios::ate);
    if (!input) throw std::runtime_error("cannot open glTF buffer: " + source.string());
    const auto length = input.tellg();
    if (length < 0 || std::uint64_t(length) != buffer.size) {
        throw std::runtime_error("glTF external buffer size differs from descriptor");
    }
    if (offset > std::size_t(std::numeric_limits<std::streamoff>::max()) ||
        size > std::size_t(std::numeric_limits<std::streamsize>::max())) {
        throw std::runtime_error("glTF range exceeds host file limits");
    }
    std::vector<unsigned char> bytes(size);
    input.seekg(std::streamoff(offset));
    input.read(reinterpret_cast<char*>(bytes.data()), std::streamsize(size));
    if (!input) throw std::runtime_error("short read of glTF buffer range");
    return bytes;
}

void LoadView(cgltf_data& data, cgltf_buffer_view* view, const std::string& path) {
    if (!view || view->data) return;
    std::vector<unsigned char> decoded;
    if (view->has_meshopt_compression) {
        const auto& compression = view->meshopt_compression;
        if (!compression.buffer || compression.count == 0u || compression.stride == 0u ||
            compression.count > std::numeric_limits<std::size_t>::max() / compression.stride ||
            compression.count * compression.stride != view->size) {
            throw std::runtime_error("invalid meshopt decoded extent");
        }
        const auto encoded = ReadBufferRange(data, *compression.buffer, path, compression.offset, compression.size);
        decoded.resize(view->size);
        int result = -1;
        switch (compression.mode) {
        case cgltf_meshopt_compression_mode_attributes:
            if (compression.stride > 256u || compression.stride % 4u != 0u) {
                throw std::runtime_error("invalid meshopt attribute stride");
            }
            result = meshopt_decodeVertexBuffer(decoded.data(), compression.count, compression.stride, encoded.data(), encoded.size());
            break;
        case cgltf_meshopt_compression_mode_triangles:
        case cgltf_meshopt_compression_mode_indices:
            if ((compression.stride != 2u && compression.stride != 4u) ||
                (compression.mode == cgltf_meshopt_compression_mode_triangles && compression.count % 3u != 0u) ||
                compression.filter != cgltf_meshopt_compression_filter_none) {
                throw std::runtime_error("invalid meshopt index layout");
            }
            result = compression.mode == cgltf_meshopt_compression_mode_triangles
                ? meshopt_decodeIndexBuffer(decoded.data(), compression.count, compression.stride, encoded.data(), encoded.size())
                : meshopt_decodeIndexSequence(decoded.data(), compression.count, compression.stride, encoded.data(), encoded.size());
            break;
        default:
            throw std::runtime_error("unsupported meshopt compression mode");
        }
        if (result != 0) throw std::runtime_error("meshopt buffer decode failed: " + std::to_string(result));
        switch (compression.filter) {
        case cgltf_meshopt_compression_filter_none: break;
        case cgltf_meshopt_compression_filter_octahedral:
            if (compression.stride != 4u && compression.stride != 8u) throw std::runtime_error("invalid meshopt oct stride");
            meshopt_decodeFilterOct(decoded.data(), compression.count, compression.stride); break;
        case cgltf_meshopt_compression_filter_quaternion:
            if (compression.stride != 8u) throw std::runtime_error("invalid meshopt quaternion stride");
            meshopt_decodeFilterQuat(decoded.data(), compression.count, compression.stride); break;
        case cgltf_meshopt_compression_filter_exponential:
            meshopt_decodeFilterExp(decoded.data(), compression.count, compression.stride); break;
        default: throw std::runtime_error("unsupported meshopt filter");
        }
    } else {
        if (!view->buffer) throw std::runtime_error("glTF view has no buffer");
        decoded = ReadBufferRange(data, *view->buffer, path, view->offset, view->size);
    }
    // cgltf_free owns view.data through this same allocator.
    void* memory = data.memory.alloc_func(data.memory.user_data, decoded.size());
    if (!memory) throw std::bad_alloc();
    std::memcpy(memory, decoded.data(), decoded.size());
    view->data = memory;
}

void LoadAccessor(cgltf_data& data, const cgltf_accessor* accessor, const std::string& path) {
    if (!accessor) return;
    LoadView(data, accessor->buffer_view, path);
    if (accessor->is_sparse) {
        LoadView(data, accessor->sparse.indices_buffer_view, path);
        LoadView(data, accessor->sparse.values_buffer_view, path);
    }
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
    if (const auto* m = primitive.material) {
        const auto uvSet = [](const cgltf_texture_view& slot) {
            return slot.has_transform && slot.transform.has_texcoord ? slot.transform.texcoord : slot.texcoord;
        };
        const cgltf_texture_view* slots[] = {&m->pbr_metallic_roughness.base_color_texture,
            &m->pbr_metallic_roughness.metallic_roughness_texture, &m->normal_texture,
            &m->occlusion_texture, &m->emissive_texture};
        for (const auto* slot : slots) if (slot->texture) {
            const auto uv = uvSet(*slot);
            if (uv < 0 || uv > 1) throw std::runtime_error("Geometry cooking supports UV0/UV1 only");
            for (unsigned axis=0;axis<2;++axis) {
                const float scale = slot->has_transform ? slot->transform.scale[axis] : 1.0f;
                if (!std::isfinite(scale)) throw std::runtime_error("invalid texture scale");
                domain.uvWeights[uv*2+axis] = std::max(domain.uvWeights[uv*2+axis], 0.1f*std::abs(scale));
            }
        }
        if (m->normal_texture.texture) domain.normalUvSet = uvSet(m->normal_texture);
    }
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
    const cgltf_result validation = cgltf_validate(data.get());
    if (validation != cgltf_result_success) throw std::runtime_error("cgltf_validate failed: " + std::to_string(validation));
    // Keep the existing embedded-data URI import capability. Large range jobs
    // contain external files and never enter cgltf's whole-buffer loader.
    bool hasDataUri = false;
    for (cgltf_size index = 0u; index < data->buffers_count; ++index) {
        const char* uri = data->buffers[index].uri;
        hasDataUri |= uri && std::strncmp(uri, "data:", 5u) == 0;
    }
    if (hasDataUri) {
        const auto buffers = cgltf_load_buffers(&options, data.get(), path.c_str());
        if (buffers != cgltf_result_success) throw std::runtime_error("cgltf_load_buffers failed: " + std::to_string(buffers));
    }

    for (cgltf_size mesh = 0u; mesh < data->meshes_count; ++mesh) {
        for (cgltf_size primitive = 0u; primitive < data->meshes[mesh].primitives_count; ++primitive) {
            const auto& value = data->meshes[mesh].primitives[primitive];
            LoadAccessor(*data, value.indices, path);
            for (cgltf_size attribute = 0u; attribute < value.attributes_count; ++attribute) {
                LoadAccessor(*data, value.attributes[attribute].data, path);
            }
        }
    }

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
