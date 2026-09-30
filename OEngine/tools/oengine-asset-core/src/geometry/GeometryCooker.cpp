#include "oengine_asset/GeometryCooker.h"
#include "oengine_asset/OegPackCodec.h"

#include "meshoptimizer.h"

#include <algorithm>
#include <cfloat>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <numeric>
#include <stdexcept>
#include <unordered_map>

namespace oengine::asset {
namespace {

struct Meshlet {
    std::vector<std::uint32_t> vertices;
    std::vector<std::uint8_t> triangles;
    float sphere[4]{};
    float bboxMin[3]{};
    float bboxMax[3]{};
    std::uint32_t groupId = kInvalidId;
    std::uint32_t refineGroupId = kInvalidId;
};

struct Group {
    std::vector<std::uint32_t> meshletIds;
    float sphere[4]{};
    float bboxMin[3]{};
    float bboxMax[3]{};
    float parentError = 0.0f;
    std::uint32_t id = kInvalidId;
    std::uint8_t lodLevel = 0xffu;
    bool simplificationFallback = false;
};

struct DomainProduct {
    std::vector<SerializedGroupV3> groups;
    std::vector<GeometryHierarchyNodeV3> hierarchy;
    std::uint32_t rootNode = 0u;
    std::uint32_t leafMeshlets = 0u;
    std::uint32_t totalMeshlets = 0u;
    VertexFormatRecordV3 vertexFormat{};
};

constexpr float kInfinity = std::numeric_limits<float>::infinity();
constexpr float kValidationEpsilon = 1e-4f;

std::uint32_t AlignUp(std::uint32_t value, std::uint32_t alignment) {
    return (value + alignment - 1u) & ~(alignment - 1u);
}

void MergeSphere(const float a[4], const float b[4], float out[4]) {
    const float dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const float distance = std::sqrt(dx * dx + dy * dy + dz * dz);
    if (a[3] >= distance + b[3]) { std::copy(a, a + 4, out); return; }
    if (b[3] >= distance + a[3]) { std::copy(b, b + 4, out); return; }
    const float radius = 0.5f * (a[3] + b[3] + distance);
    const float scale = distance > 1e-6f ? (radius - a[3]) / distance : 0.0f;
    out[0] = a[0] + dx * scale; out[1] = a[1] + dy * scale;
    out[2] = a[2] + dz * scale; out[3] = radius;
}

void MergeAabb(const float amin[3], const float amax[3], const float bmin[3], const float bmax[3], float outMin[3], float outMax[3]) {
    for (std::uint32_t i = 0; i < 3u; ++i) { outMin[i] = std::min(amin[i], bmin[i]); outMax[i] = std::max(amax[i], bmax[i]); }
}

bool SphereContains(const float outer[4], const float inner[4]) {
    const float dx = inner[0] - outer[0], dy = inner[1] - outer[1], dz = inner[2] - outer[2];
    return std::sqrt(dx * dx + dy * dy + dz * dz) + inner[3] <= outer[3] + kValidationEpsilon;
}

void ComputeBounds(const MaterialDomain& source, Meshlet& meshlet) {
    const float* positions = source.vertices.front().position;
    const meshopt_Bounds bounds = meshopt_computeMeshletBounds(
        meshlet.vertices.data(), meshlet.triangles.data(), meshlet.triangles.size() / 3u,
        positions, source.vertices.size(), sizeof(CanonicalVertex));
    meshlet.sphere[0] = bounds.center[0]; meshlet.sphere[1] = bounds.center[1];
    meshlet.sphere[2] = bounds.center[2]; meshlet.sphere[3] = bounds.radius;
    std::fill(meshlet.bboxMin, meshlet.bboxMin + 3, kInfinity);
    std::fill(meshlet.bboxMax, meshlet.bboxMax + 3, -kInfinity);
    for (std::uint32_t index : meshlet.vertices) {
        for (std::uint32_t axis = 0; axis < 3u; ++axis) {
            meshlet.bboxMin[axis] = std::min(meshlet.bboxMin[axis], source.vertices[index].position[axis]);
            meshlet.bboxMax[axis] = std::max(meshlet.bboxMax[axis], source.vertices[index].position[axis]);
        }
    }
    const float qx = (meshlet.bboxMax[0] - meshlet.bboxMin[0]) / (2.0f * 65535.0f);
    const float qy = (meshlet.bboxMax[1] - meshlet.bboxMin[1]) / (2.0f * 65535.0f);
    const float qz = (meshlet.bboxMax[2] - meshlet.bboxMin[2]) / (2.0f * 65535.0f);
    meshlet.sphere[3] += std::sqrt(qx * qx + qy * qy + qz * qz);
}

std::vector<Meshlet> BuildMeshlets(
    const MaterialDomain& source, const GeometryCookRecipeV3& recipe,
    const std::vector<std::uint32_t>& indices) {
    const std::size_t bound = meshopt_buildMeshletsBound(indices.size(), recipe.meshletMaxVertices, recipe.meshletMinTriangles);
    std::vector<meshopt_Meshlet> native(bound);
    std::vector<std::uint32_t> vertices(indices.size());
    std::vector<unsigned char> triangles(indices.size());
    const std::size_t count = meshopt_buildMeshletsFlex(
        native.data(), vertices.data(), triangles.data(), indices.data(), indices.size(),
        source.vertices.front().position, source.vertices.size(), sizeof(CanonicalVertex),
        recipe.meshletMaxVertices, recipe.meshletMinTriangles, recipe.meshletMaxTriangles,
        recipe.coneWeight, recipe.clusterSplitFactor);
    std::vector<Meshlet> output;
    output.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
        const meshopt_Meshlet& item = native[i];
        Meshlet meshlet;
        meshlet.vertices.assign(vertices.begin() + item.vertex_offset, vertices.begin() + item.vertex_offset + item.vertex_count);
        meshlet.triangles.assign(triangles.begin() + item.triangle_offset, triangles.begin() + item.triangle_offset + item.triangle_count * 3u);
        meshopt_optimizeMeshlet(meshlet.vertices.data(), meshlet.triangles.data(), item.triangle_count, item.vertex_count);
        ComputeBounds(source, meshlet);
        output.push_back(std::move(meshlet));
    }
    return output;
}

std::vector<std::uint32_t> GroupMeshlets(
    const MaterialDomain& source, const GeometryCookRecipeV3& recipe,
    const std::vector<Meshlet>& meshlets, const std::vector<std::uint32_t>& active,
    const std::vector<std::uint32_t>& positionRemap, std::uint8_t lodLevel,
    std::vector<Group>& groups) {
    if (active.empty()) return {};
    std::size_t totalIndexCount = 0u;
    for (std::uint32_t id : active) totalIndexCount += meshlets[id].triangles.size();
    std::vector<std::uint32_t> clusterIndices;
    clusterIndices.reserve(totalIndexCount);
    std::vector<unsigned int> clusterCounts(active.size());
    for (std::size_t i = 0; i < active.size(); ++i) {
        const Meshlet& meshlet = meshlets[active[i]];
        clusterCounts[i] = unsigned(meshlet.triangles.size());
        for (std::uint8_t local : meshlet.triangles) clusterIndices.push_back(positionRemap[meshlet.vertices[local]]);
    }
    std::vector<unsigned int> partitions(active.size());
    const std::size_t partitionCount = meshopt_partitionClusters(
        partitions.data(), clusterIndices.data(), clusterIndices.size(), clusterCounts.data(), active.size(),
        source.vertices.front().position, source.vertices.size(), sizeof(CanonicalVertex), recipe.groupTargetMeshlets);
    std::vector<Group> created(partitionCount);
    for (std::size_t i = 0; i < active.size(); ++i) created[partitions[i]].meshletIds.push_back(active[i]);
    std::vector<std::uint32_t> ids(partitionCount);
    for (std::size_t i = 0; i < created.size(); ++i) {
        Group& group = created[i];
        if (group.meshletIds.empty()) throw std::runtime_error("meshopt_partitionClusters produced an empty partition");
        const Meshlet& first = meshlets[group.meshletIds.front()];
        std::copy(first.sphere, first.sphere + 4, group.sphere);
        std::copy(first.bboxMin, first.bboxMin + 3, group.bboxMin);
        std::copy(first.bboxMax, first.bboxMax + 3, group.bboxMax);
        for (std::size_t m = 1; m < group.meshletIds.size(); ++m) {
            const Meshlet& child = meshlets[group.meshletIds[m]];
            MergeSphere(group.sphere, child.sphere, group.sphere);
            MergeAabb(group.bboxMin, group.bboxMax, child.bboxMin, child.bboxMax, group.bboxMin, group.bboxMax);
        }
        group.id = std::uint32_t(groups.size() + i); group.lodLevel = lodLevel;
        ids[i] = group.id;
    }
    groups.insert(groups.end(), std::make_move_iterator(created.begin()), std::make_move_iterator(created.end()));
    return ids;
}

void BuildSeamLocks(
    const MaterialDomain& source, const GeometryCookRecipeV3& recipe,
    const std::vector<Group>& groups, const std::vector<std::uint32_t>& groupIds,
    const std::vector<Meshlet>& meshlets, const std::vector<std::uint32_t>& positionRemap,
    std::vector<unsigned char>& locks) {
    // Representatives may belong to old LODs. Only live wedges contribute to
    // attributes, adjacency and ownership; a historical normal is never a seam.
    std::unordered_map<std::uint32_t, std::uint32_t> first, owner;
    std::unordered_map<std::uint64_t, unsigned> edges;
    std::vector<std::uint32_t> live;
    std::vector<unsigned char> seen(source.vertices.size());
    for (std::uint32_t groupId : groupIds) for (std::uint32_t meshletId : groups[groupId].meshletIds) {
        const Meshlet& m = meshlets[meshletId];
        for (std::uint32_t id : m.vertices) {
            if (!seen[id]) { seen[id] = 1; live.push_back(id); }
            const auto p = positionRemap[id];
            auto entry = owner.emplace(p, groupId);
            if (!entry.second && entry.first->second != groupId) locks[p] |= meshopt_SimplifyVertex_Protect;
            first.emplace(p, id);
            // Ordinary UV discontinuities remain independent attribute wedges.
            // Making every UV seam Protect turns atlas junctions into Locked
            // vertices in meshoptimizer and prevents useful parent cuts.
            // The joint metric evaluates each wedge, including both UV sets.

        }
        for (std::size_t i=0;i<m.triangles.size();i+=3) for (unsigned j=0;j<3;++j) {
            auto a=positionRemap[m.vertices[m.triangles[i+j]]];
            auto b=positionRemap[m.vertices[m.triangles[i+(j+1)%3]]];
            if(a!=b) ++edges[(std::uint64_t(std::min(a,b))<<32)|std::max(a,b)];
        }
    }
    // Open material-domain borders (including retired neighbouring groups) must
    // remain stationary when domains/windows are cooked independently.
    for (const auto& edge : edges) if (edge.second > 2u) {
        locks[std::uint32_t(edge.first >> 32)] |= meshopt_SimplifyVertex_Lock;
        locks[std::uint32_t(edge.first)] |= meshopt_SimplifyVertex_Lock;
    }
    for (auto id : live) locks[id] |= locks[positionRemap[id]];
}

VertexFormatRecordV3 MakeVertexFormat(std::uint16_t mask);

std::uint64_t MeshletPayloadCost(const std::vector<Meshlet>& items, std::uint32_t stride) {
    std::uint32_t bytes=64u+48u*std::uint32_t(items.size());
    for(const auto& m:items) bytes+=AlignUp(std::uint32_t(m.triangles.size()),4u);
    bytes=AlignUp(bytes,16u);
    for(const auto& m:items) bytes+=AlignUp(std::uint32_t(m.vertices.size())*stride,4u);
    return AlignUp(bytes,16u);
}

bool SimplifyGroup(
    MaterialDomain& source, const GeometryCookRecipeV3& recipe,
    const Group& group, const std::vector<Meshlet>& meshlets,
    const std::vector<unsigned char>& locks, std::vector<Meshlet>& output,
    float& outputError, bool& usedFallback) {
    std::vector<std::uint32_t> used;
    for(auto id:group.meshletIds) used.insert(used.end(),meshlets[id].vertices.begin(),meshlets[id].vertices.end());
    std::sort(used.begin(),used.end()); used.erase(std::unique(used.begin(),used.end()),used.end());
    if(used.empty()) return false;
    std::unordered_map<std::uint32_t,std::uint32_t> local;
    std::vector<CanonicalVertex> original;
    std::vector<unsigned char> localLocks;
    for(auto id:used) {local[id]=std::uint32_t(original.size());original.push_back(source.vertices[id]);localLocks.push_back(locks[id]);}
    std::vector<std::uint32_t> indices;
    std::uint64_t originalBytes=64u+48u*group.meshletIds.size();
    std::uint32_t childTriangles=0,childVertices=0;
    const auto stride=MakeVertexFormat(source.attributeMask).strideBytes;
    for(auto id:group.meshletIds) {
        const auto& m=meshlets[id];
        for(auto v:m.triangles) indices.push_back(local.at(m.vertices[v]));
        childTriangles+=AlignUp(std::uint32_t(m.triangles.size()),4u);
        childVertices+=AlignUp(std::uint32_t(m.vertices.size())*stride,4u);
    }
    originalBytes = AlignUp(AlignUp(std::uint32_t(originalBytes)+childTriangles,16u)+childVertices,16u);
    // Full-record weld, with flags ORed across identical records.
    std::vector<unsigned> remap(original.size());
    auto unique=meshopt_generateVertexRemap(remap.data(),indices.data(),indices.size(),original.data(),original.size(),sizeof(CanonicalVertex));
    std::vector<CanonicalVertex> welded(unique);
    std::vector<unsigned char> weldedLocks(unique);
    meshopt_remapVertexBuffer(welded.data(),original.data(),original.size(),sizeof(CanonicalVertex),remap.data());
    for(std::size_t i=0;i<original.size();++i) weldedLocks[remap[i]]|=localLocks[i];
    meshopt_remapIndexBuffer(indices.data(),indices.data(),indices.size(),remap.data());
    original=std::move(welded);localLocks=std::move(weldedLocks);

    // Like gltfpack::simplifyUvSplit, preserve mirrored charts even at vertices
    // with identical UV coordinates. Extend the orientation key to BOTH UV sets.
    std::vector<unsigned> orientations(original.size());
    std::vector<unsigned> triangleSign(indices.size()/3);
    for(std::size_t i=0;i<indices.size();i+=3) {
        unsigned key=0;
        for(unsigned uv=0;uv<2;++uv) if(source.attributeMask&(uv?kAttributeUv1:kAttributeUv0)) {
            const auto& a=original[indices[i]];const auto& b=original[indices[i+1]];const auto& c=original[indices[i+2]];
            const float* x=uv?a.uv1:a.uv0;const float* y=uv?b.uv1:b.uv0;const float* z=uv?c.uv1:c.uv0;
            float determinant=(y[0]-x[0])*(z[1]-x[1])-(y[1]-x[1])*(z[0]-x[0]);
            key|=(determinant>0?1u:determinant<0?2u:0u)<<(uv*2);
        }
        triangleSign[i/3]=key;
        for(unsigned c=0;c<3;++c) orientations[indices[i+c]]|=key;
    }
    std::map<std::uint64_t,unsigned> split;
    const auto beforeSplit=original.size();
    for(std::size_t i=0;i<indices.size();++i) {
        const auto old=indices[i];
        if(source.normalUvSet < 0 || ((orientations[old]&3u)!=3u && ((orientations[old]>>2)&3u)!=3u)) continue;
        const auto key=(std::uint64_t(old)<<4)|triangleSign[i/3];
        auto entry=split.emplace(key,std::uint32_t(original.size()));
        if(entry.second){original.push_back(original[old]);localLocks.push_back(localLocks[old]|meshopt_SimplifyVertex_Protect);}
        indices[i]=entry.first->second;
    }
    (void)beforeSplit;
    std::vector<float> positions(original.size()*3);
    const unsigned attributesCount=3u+((source.attributeMask&kAttributeUv0)?2u:0u)+((source.attributeMask&kAttributeUv1)?2u:0u)+((source.attributeMask&kAttributeColor)?4u:0u);
    std::vector<float> attributes(original.size()*attributesCount),weights(attributesCount,0.5f);
    unsigned w=3;
    if(source.attributeMask&kAttributeUv0){weights[w++]=source.uvWeights[0];weights[w++]=source.uvWeights[1];}
    if(source.attributeMask&kAttributeUv1){weights[w++]=source.uvWeights[2];weights[w++]=source.uvWeights[3];}
    if(source.attributeMask&kAttributeColor) for(unsigned c=0;c<4;++c)weights[w++]=0.05f;
    for(std::size_t i=0;i<original.size();++i){
        const auto& v=original[i];std::copy(v.position,v.position+3,positions.begin()+i*3);
        unsigned k=unsigned(i*attributesCount);
        for(float f:v.normal)attributes[k++]=f;
        if(source.attributeMask&kAttributeUv0)for(float f:v.uv0)attributes[k++]=f;
        if(source.attributeMask&kAttributeUv1)for(float f:v.uv1)attributes[k++]=f;
        if(source.attributeMask&kAttributeColor)for(float f:v.color)attributes[k++]=f;
    }
    const auto target=std::size_t(indices.size()*recipe.simplifyTargetRatio);
    const unsigned options=meshopt_SimplifySparse|meshopt_SimplifyErrorAbsolute|meshopt_SimplifyPreserveFolds|
        (recipe.simplifyPermissive?meshopt_SimplifyPermissive:0);
    struct Candidate { std::vector<CanonicalVertex> vertices;std::vector<Meshlet> meshlets;float error=0;std::size_t indices=0;bool updated=false; } best;
    auto prepare=[&](std::vector<unsigned>& reduced,const std::vector<float>& p,const std::vector<float>& a,float error,bool updated)->bool {
        if(reduced.empty() || reduced.size()>=indices.size() || float(reduced.size())/float(indices.size())>recipe.simplifyUpdateFailureRatio || !std::isfinite(error))return false;
        std::vector<CanonicalVertex> vertices=original;
        std::vector<unsigned char> referenced(vertices.size());for(auto id:reduced)referenced[id]=1;
        for(std::size_t i=0;i<vertices.size();++i) if(referenced[i] && updated && !(localLocks[i]&meshopt_SimplifyVertex_Lock)) {
            auto& v=vertices[i];std::copy(p.begin()+i*3,p.begin()+i*3+3,v.position);
            unsigned k=unsigned(i*attributesCount);
            for(float& f:v.normal)f=a[k++];
            if(source.attributeMask&kAttributeUv0)for(float& f:v.uv0)f=a[k++];
            if(source.attributeMask&kAttributeUv1)for(float& f:v.uv1)f=a[k++];
            if(source.attributeMask&kAttributeColor)for(float& f:v.color)f=std::clamp(a[k++],0.0f,1.0f);
            const float length=std::sqrt(v.normal[0]*v.normal[0]+v.normal[1]*v.normal[1]+v.normal[2]*v.normal[2]);
            if(!(length>1e-8f)||!std::isfinite(length))return false;
            for(float& f:v.normal)f/=length;
            for(float f:v.position)if(!std::isfinite(f))return false;
            for(float f:v.uv0)if(!std::isfinite(f))return false;
            for(float f:v.uv1)if(!std::isfinite(f))return false;
        }
        for(std::size_t i=0;i<reduced.size();i+=3) {
            const auto& a0=vertices[reduced[i]];const auto& b=vertices[reduced[i+1]];const auto& c=vertices[reduced[i+2]];
            float ab[3],ac[3],n[3];for(unsigned j=0;j<3;++j){ab[j]=b.position[j]-a0.position[j];ac[j]=c.position[j]-a0.position[j];}
            for(unsigned j=0;j<3;++j)n[j]=ab[(j+1)%3]*ac[(j+2)%3]-ab[(j+2)%3]*ac[(j+1)%3];
            float len=std::sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]);if(!(len>0)||!std::isfinite(len))return false;
            for (auto* v : {&vertices[reduced[i]], &vertices[reduced[i + 1]], &vertices[reduced[i + 2]]}) {
                const float alignment = (n[0] * v->normal[0] + n[1] * v->normal[1] + n[2] * v->normal[2]) / len;
                if (alignment < 1e-4f) {
                    v->normal[0] = n[0] / len; v->normal[1] = n[1] / len; v->normal[2] = n[2] / len;
                }
            }

        }
        std::vector<CanonicalVertex> corners;corners.reserve(reduced.size());
        std::vector<float> tangents;
        if((source.attributeMask&kAttributeTangent)&&(source.attributeMask&(source.normalUvSet==1?kAttributeUv1:kAttributeUv0))) {
            tangents.resize(reduced.size()*4);
            meshopt_generateTangents(tangents.data(),reduced.data(),reduced.size(),vertices[0].position,vertices.size(),sizeof(CanonicalVertex),vertices[0].normal,sizeof(CanonicalVertex),(source.normalUvSet==1?vertices[0].uv1:vertices[0].uv0),sizeof(CanonicalVertex),meshopt_TangentCompatible);
        }
        for(std::size_t i=0;i<reduced.size();++i) {
            auto v=vertices[reduced[i]];            const std::size_t tri = (i / 3u) * 3u;
            const auto& pa = vertices[reduced[tri]], &pb = vertices[reduced[tri + 1u]], &pc = vertices[reduced[tri + 2u]];
            const float ux = pb.position[0] - pa.position[0], uy = pb.position[1] - pa.position[1], uz = pb.position[2] - pa.position[2];
            const float vx = pc.position[0] - pa.position[0], vy = pc.position[1] - pa.position[1], vz = pc.position[2] - pa.position[2];
            const float fn[3] = {uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx};
            const float fl = std::sqrt(fn[0] * fn[0] + fn[1] * fn[1] + fn[2] * fn[2]);
            if (fl > 1e-8f && (fn[0] * v.normal[0] + fn[1] * v.normal[1] + fn[2] * v.normal[2]) < 0.0f) {
                v.normal[0] = fn[0] / fl; v.normal[1] = fn[1] / fl; v.normal[2] = fn[2] / fl;
            }
            if(!tangents.empty() && !(localLocks[reduced[i]]&meshopt_SimplifyVertex_Lock))std::copy(tangents.begin()+i*4,tangents.begin()+i*4+4,v.tangent);
            corners.push_back(v);
        }
        std::vector<unsigned> remap(corners.size()),compactIndices(corners.size());
        auto count=meshopt_generateVertexRemap(remap.data(),nullptr,corners.size(),corners.data(),corners.size(),sizeof(CanonicalVertex));
        MaterialDomain temp;temp.attributeMask=source.attributeMask;temp.vertices.resize(count);
        meshopt_remapVertexBuffer(temp.vertices.data(),corners.data(),corners.size(),sizeof(CanonicalVertex),remap.data());
        std::copy(remap.begin(),remap.end(),compactIndices.begin());
        auto built=BuildMeshlets(temp,recipe,compactIndices);
        auto bytes=MeshletPayloadCost(built,stride);
        if(built.empty()||built.size()>=group.meshletIds.size()||bytes>originalBytes)return false;
        if(!best.meshlets.empty() && (built.size()>best.meshlets.size() || (built.size()==best.meshlets.size() && bytes>MeshletPayloadCost(best.meshlets,stride)) || (built.size()==best.meshlets.size() && bytes==MeshletPayloadCost(best.meshlets,stride) && !updated)))return false;
        best.vertices=std::move(temp.vertices);best.meshlets=std::move(built);best.error=error;best.indices=reduced.size();best.updated=updated;
        return true;
    };
    float error=0;std::vector<unsigned> reduced(indices.size());
    reduced.resize(meshopt_simplifyWithAttributes(reduced.data(),indices.data(),indices.size(),positions.data(),original.size(),12,attributes.data(),attributesCount*4,weights.data(),attributesCount,localLocks.data(),target,FLT_MAX,options,&error));
    prepare(reduced,positions,attributes,error,false);
    if(recipe.simplifyWithUpdate) {
        auto p=positions,a=attributes;auto updated=indices;
        updated.resize(meshopt_simplifyWithUpdate(updated.data(),updated.size(),p.data(),original.size(),12,a.data(),attributesCount*4,weights.data(),attributesCount,localLocks.data(),target,FLT_MAX,options,&error));
        prepare(updated,p,a,error,true);
    }
    if(best.meshlets.empty())return false;
    const auto base=std::uint32_t(source.vertices.size());
    source.vertices.insert(source.vertices.end(),best.vertices.begin(),best.vertices.end());
    output=std::move(best.meshlets);
    for(auto& m:output){m.refineGroupId=group.id;for(auto& v:m.vertices)v+=base;}
    outputError=best.error*recipe.attributeErrorScale;usedFallback=best.updated;
    return true;
}

void ValidateLodBuild(const std::vector<Group>& groups, const std::vector<Meshlet>& meshlets) {
    if (groups.empty() || meshlets.empty()) throw std::runtime_error("LOD build produced no groups or meshlets");
    std::vector<std::uint32_t> refineReferences(groups.size(), 0u);
    for (const Meshlet& meshlet : meshlets) {
        if (meshlet.groupId >= groups.size()) throw std::runtime_error("meshlet groupId is invalid");
        if (meshlet.refineGroupId != kInvalidId) {
            if (meshlet.refineGroupId >= groups.size()) throw std::runtime_error("meshlet refineGroupId is invalid");
            ++refineReferences[meshlet.refineGroupId];
            const Group& coarse = groups[meshlet.groupId];
            const Group& fine = groups[meshlet.refineGroupId];
            if (coarse.lodLevel <= fine.lodLevel) throw std::runtime_error("refinement LOD is not strictly finer");
            if (!std::isfinite(fine.parentError) || coarse.parentError + kValidationEpsilon < fine.parentError) throw std::runtime_error("LOD parent error is not monotonic");
            if (!SphereContains(meshlet.sphere, fine.sphere)) throw std::runtime_error("coarse meshlet bound does not contain refine group");
        }
        if (meshlet.vertices.empty() || meshlet.vertices.size() > 128u || meshlet.triangles.empty() || meshlet.triangles.size() / 3u > 128u) throw std::runtime_error("meshlet exceeds V3 limits");
        for (std::uint8_t local : meshlet.triangles) if (local >= meshlet.vertices.size()) throw std::runtime_error("meshlet local triangle index exceeds vertexCount");
    }
    for (std::size_t i = 0; i < groups.size(); ++i) {
        if (groups[i].meshletIds.empty() || groups[i].meshletIds.size() > 128u) throw std::runtime_error("group meshlet count is invalid");
        if (std::isinf(groups[i].parentError) && refineReferences[i] != 0u) throw std::runtime_error("referenced refine group has infinite error");
        for (std::uint32_t meshletId : groups[i].meshletIds) if (meshletId >= meshlets.size() || meshlets[meshletId].groupId != i) throw std::runtime_error("group ownership is inconsistent");
    }
}

std::vector<GeometryHierarchyNodeV3> BuildHierarchy(
    const std::vector<GeometryHierarchyNodeV3>& initial,
    std::vector<std::uint32_t>& reorder) {
    if (initial.empty()) return {};
    if (initial.size() == 1u) {
        reorder[0] = 0u;
        GeometryHierarchyNodeV3 parent = initial[0];
        parent.packedNodeData = PackInternalNodeV3(1u, 1u);
        return {parent, initial[0]};
    }
    std::vector<std::vector<GeometryHierarchyNodeV3>> levels(1u, initial);
    while (levels.back().size() > 1u) {
        const std::vector<GeometryHierarchyNodeV3>& current = levels.back();
        std::vector<float> centers(current.size() * 3u);
        for (std::size_t i = 0; i < current.size(); ++i) std::copy(current[i].boundsSphere, current[i].boundsSphere + 3, centers.begin() + i * 3u);
        std::vector<unsigned int> order(current.size());
        meshopt_spatialClusterPoints(order.data(), centers.data(), current.size(), sizeof(float) * 3u, 8u);
        if (levels.size() == 1u) for (std::size_t i = 0; i < order.size(); ++i) reorder[i] = order[i];
        std::vector<GeometryHierarchyNodeV3> sorted(current.size());
        for (std::size_t i = 0; i < order.size(); ++i) sorted[i] = current[order[i]];
        levels.back() = std::move(sorted);
        std::vector<GeometryHierarchyNodeV3> parents;
        for (std::uint32_t start = 0u; start < levels.back().size(); start += 8u) {
            const std::uint32_t count = std::min<std::uint32_t>(8u, std::uint32_t(levels.back().size()) - start);
            GeometryHierarchyNodeV3 parent = levels.back()[start];
            parent.packedNodeData = PackInternalNodeV3(start, count);
            for (std::uint32_t i = 1u; i < count; ++i) {
                const GeometryHierarchyNodeV3& child = levels.back()[start + i];
                MergeSphere(parent.boundsSphere, child.boundsSphere, parent.boundsSphere);
                MergeAabb(parent.bboxMin, parent.bboxMax, child.bboxMin, child.bboxMax, parent.bboxMin, parent.bboxMax);
                parent.maxParentError = std::max(parent.maxParentError, child.maxParentError);
            }
            parents.push_back(parent);
        }
        levels.push_back(std::move(parents));
    }
    std::vector<std::size_t> offsets(levels.size());
    std::size_t total = 0u;
    for (std::size_t i = levels.size(); i-- > 0u;) { offsets[i] = total; total += levels[i].size(); }
    std::vector<GeometryHierarchyNodeV3> result(total);
    for (std::size_t level = levels.size(); level-- > 0u;) {
        for (std::size_t i = 0; i < levels[level].size(); ++i) {
            GeometryHierarchyNodeV3 node = levels[level][i];
            if (level > 0u && !IsGroupLeafV3(node.packedNodeData)) {
                const std::uint32_t childStart = (node.packedNodeData >> 1u) & 0x07ffffffu;
                const std::uint32_t childCount = (node.packedNodeData >> 28u) & 0x0fu;
                node.packedNodeData = PackInternalNodeV3(std::uint32_t(offsets[level - 1u]) + childStart, childCount);
            }
            result[offsets[level] + i] = node;
        }
    }
    return result;
}

std::vector<GeometryHierarchyNodeV3> BuildNyxHierarchy(
    const std::vector<Group>& groups, const std::vector<std::uint32_t>& oldToSerialized,
    std::uint32_t& rootIndex) {
    std::uint8_t maximumLod = 0u;
    for (const Group& group : groups) maximumLod = std::max(maximumLod, group.lodLevel);
    std::vector<std::vector<GeometryHierarchyNodeV3>> lodTrees(maximumLod + 1u);
    std::vector<GeometryHierarchyNodeV3> lodRoots;
    for (int lod = maximumLod; lod >= 0; --lod) {
        std::vector<GeometryHierarchyNodeV3> leaves;
        for (const Group& group : groups) if (group.lodLevel == lod) {
            GeometryHierarchyNodeV3 leaf{};
            std::copy(group.sphere, group.sphere + 4, leaf.boundsSphere);
            std::copy(group.bboxMin, group.bboxMin + 3, leaf.bboxMin);
            std::copy(group.bboxMax, group.bboxMax + 3, leaf.bboxMax);
            leaf.maxParentError = group.parentError;
            leaf.packedNodeData = PackGroupLeafV3(oldToSerialized[group.id], std::uint32_t(group.meshletIds.size()));
            leaves.push_back(leaf);
        }
        std::vector<std::uint32_t> reorder(leaves.size());
        lodTrees[lod] = BuildHierarchy(leaves, reorder);
        if (lodTrees[lod].empty()) throw std::runtime_error("LOD hierarchy is empty");
        lodRoots.push_back(lodTrees[lod][0]);
    }
    std::vector<std::uint32_t> rootReorder(lodRoots.size());
    std::vector<GeometryHierarchyNodeV3> top = BuildHierarchy(lodRoots, rootReorder);
    if (top.empty()) throw std::runtime_error("top hierarchy is empty");
    const std::uint32_t topSize = std::uint32_t(top.size());
    std::vector<std::uint32_t> lodOffsets(maximumLod + 1u);
    std::uint32_t cursor = topSize;
    for (int lod = maximumLod; lod >= 0; --lod) { lodOffsets[lod] = cursor; cursor += std::uint32_t(lodTrees[lod].size() - 1u); }
    std::vector<GeometryHierarchyNodeV3> result(cursor);
    for (std::uint32_t i = 0; i < topSize; ++i) {
        GeometryHierarchyNodeV3 node = top[i];
        if (i >= topSize - lodRoots.size()) {
            const int lod = int(maximumLod) - int(rootReorder[i - (topSize - std::uint32_t(lodRoots.size()))]);
            const GeometryHierarchyNodeV3& root = lodTrees[lod][0];
            const std::uint32_t count = (root.packedNodeData >> 28u) & 0x0fu;
            node.packedNodeData = PackInternalNodeV3(lodOffsets[lod], count);
        }
        result[i] = node;
    }
    for (int lod = maximumLod; lod >= 0; --lod) {
        const auto& tree = lodTrees[lod];
        for (std::size_t i = 1u; i < tree.size(); ++i) {
            GeometryHierarchyNodeV3 node = tree[i];
            if (!IsGroupLeafV3(node.packedNodeData)) {
                const std::uint32_t localStart = (node.packedNodeData >> 1u) & 0x07ffffffu;
                const std::uint32_t count = (node.packedNodeData >> 28u) & 0x0fu;
                node.packedNodeData = PackInternalNodeV3(lodOffsets[lod] + localStart - 1u, count);
            }
            result[lodOffsets[lod] + std::uint32_t(i - 1u)] = node;
        }
    }
    rootIndex = 0u;
    return result;
}

std::int16_t ToSnorm16(float value) {
    value = std::max(-1.0f, std::min(1.0f, value));
    return std::int16_t(std::lround(value * 32767.0f));
}

std::array<std::int16_t, 2> EncodeOct(float x, float y, float z) {
    const float length = std::abs(x) + std::abs(y) + std::abs(z);
    if (length <= 1e-20f) return {0, 0};
    x /= length; y /= length; z /= length;
    if (z < 0.0f) {
        const float oldX = x;
        x = (1.0f - std::abs(y)) * (oldX >= 0.0f ? 1.0f : -1.0f);
        y = (1.0f - std::abs(oldX)) * (y >= 0.0f ? 1.0f : -1.0f);
    }
    return {ToSnorm16(x), ToSnorm16(y)};
}

std::uint16_t FloatToHalf(float value) {
    value = std::max(-65504.0f, std::min(65504.0f, value));
    std::uint32_t bits; std::memcpy(&bits, &value, sizeof(bits));
    const std::uint32_t sign = (bits >> 16u) & 0x8000u;
    std::int32_t exponent = std::int32_t((bits >> 23u) & 0xffu) - 127 + 15;
    std::uint32_t mantissa = bits & 0x7fffffu;
    if (exponent <= 0) {
        if (exponent < -10) return std::uint16_t(sign);
        mantissa = (mantissa | 0x800000u) >> (1u - exponent);
        return std::uint16_t(sign | ((mantissa + 0x1000u) >> 13u));
    }
    if (exponent >= 31) return std::uint16_t(sign | 0x7c00u);
    return std::uint16_t(sign | (std::uint32_t(exponent) << 10u) | ((mantissa + 0x1000u) >> 13u));
}

void WriteU16(std::vector<std::uint8_t>& bytes, std::uint32_t offset, std::uint16_t value) {
    bytes[offset] = std::uint8_t(value); bytes[offset + 1u] = std::uint8_t(value >> 8u);
}

VertexFormatRecordV3 MakeVertexFormat(std::uint16_t mask) {
    VertexFormatRecordV3 format{};
    std::memset(&format, 0xff, sizeof(format));
    format.attributeMask = mask;
    std::uint8_t cursor = 0u;
    format.positionOffset = cursor; cursor += 12u;
    format.normalOffset = cursor; cursor += 4u;
    if (mask & kAttributeTangent) { format.tangentOffset = cursor; cursor += 6u; }
    if (mask & kAttributeUv0) { format.uv0Offset = cursor; cursor += 4u; }
    if (mask & kAttributeUv1) { format.uv1Offset = cursor; cursor += 4u; }
    if (mask & kAttributeColor) { format.colorOffset = cursor; cursor += 4u; }
    format.strideBytes = std::uint16_t(AlignUp(cursor, 4u));
    std::memset(format.reserved, 0, sizeof(format.reserved));
    format.positionEncoding = 1u; // Float32x3; old meshlet-local U16 products must be recooked.
    return format;
}

void PackVertex(
    std::vector<std::uint8_t>& bytes, std::uint32_t offset, const CanonicalVertex& vertex,
    const VertexFormatRecordV3& format) {
    for (std::uint32_t axis = 0; axis < 3u; ++axis) {
        std::uint32_t bits;
        std::memcpy(&bits, &vertex.position[axis], sizeof(bits));
        WriteU16(bytes, offset + format.positionOffset + axis * 4u, std::uint16_t(bits));
        WriteU16(bytes, offset + format.positionOffset + axis * 4u + 2u, std::uint16_t(bits >> 16u));
    }
    const auto normal = EncodeOct(vertex.normal[0], vertex.normal[1], vertex.normal[2]);
    WriteU16(bytes, offset + format.normalOffset, std::uint16_t(normal[0]));
    WriteU16(bytes, offset + format.normalOffset + 2u, std::uint16_t(normal[1]));
    if (format.tangentOffset != 0xffu) {
        const auto tangent = EncodeOct(vertex.tangent[0], vertex.tangent[1], vertex.tangent[2]);
        WriteU16(bytes, offset + format.tangentOffset, std::uint16_t(tangent[0]));
        WriteU16(bytes, offset + format.tangentOffset + 2u, std::uint16_t(tangent[1]));
        WriteU16(bytes, offset + format.tangentOffset + 4u, std::uint16_t(ToSnorm16(vertex.tangent[3])));
    }
    if (format.uv0Offset != 0xffu) { WriteU16(bytes, offset + format.uv0Offset, FloatToHalf(vertex.uv0[0])); WriteU16(bytes, offset + format.uv0Offset + 2u, FloatToHalf(vertex.uv0[1])); }
    if (format.uv1Offset != 0xffu) { WriteU16(bytes, offset + format.uv1Offset, FloatToHalf(vertex.uv1[0])); WriteU16(bytes, offset + format.uv1Offset + 2u, FloatToHalf(vertex.uv1[1])); }
    if (format.colorOffset != 0xffu) for (std::uint32_t i = 0; i < 4u; ++i) bytes[offset + format.colorOffset + i] = std::uint8_t(std::lround(std::max(0.0f, std::min(1.0f, vertex.color[i])) * 255.0f));
}

SerializedGroupV3 SerializeGroup(
    const MaterialDomain& source, const Group& group, const std::vector<Meshlet>& meshlets,
    const std::vector<std::uint32_t>& oldToSerialized, std::uint8_t vertexFormatId,
    const VertexFormatRecordV3& format, CookEvidenceV3& evidence) {
    const std::uint32_t meshletCount = std::uint32_t(group.meshletIds.size());
    const std::uint32_t headersEnd = 64u + meshletCount * 48u;
    const std::uint32_t triangleStart = AlignUp(headersEnd, 16u);
    std::uint32_t triangleCursor = triangleStart;
    for (std::uint32_t id : group.meshletIds) triangleCursor += AlignUp(std::uint32_t(meshlets[id].triangles.size()), 4u);
    const std::uint32_t vertexStart = AlignUp(triangleCursor, 16u);
    std::uint32_t vertexCursor = vertexStart;
    for (std::uint32_t id : group.meshletIds) vertexCursor += AlignUp(std::uint32_t(meshlets[id].vertices.size()) * format.strideBytes, 4u);
    const std::uint32_t payloadBytes = AlignUp(vertexCursor, 16u);
    if (payloadBytes > kGeometryPageBytesV3) throw std::runtime_error("group payload exceeds one 256 KiB page");
    SerializedGroupV3 output;
    output.bytes.resize(payloadBytes, 0u);
    output.lodLevel = group.lodLevel;
    output.flags = 0u;
    if (group.simplificationFallback) output.flags |= kGroupSimplificationFallback;
    if (source.meshletFlags & kMeshletOpaque) output.flags |= kGroupOpaque;
    if (source.meshletFlags & kMeshletMask) output.flags |= kGroupMask;
    if (source.meshletFlags & kMeshletBlend) output.flags |= kGroupBlend;
    if (source.meshletFlags & kMeshletTwoSided) output.flags |= kGroupTwoSided;
    GroupHeaderV3 header{};
    std::copy(group.sphere, group.sphere + 4, header.boundsSphere);
    std::copy(group.bboxMin, group.bboxMin + 3, header.bboxMin);
    std::copy(group.bboxMax, group.bboxMax + 3, header.bboxMax);
    header.parentError = group.parentError; header.meshletCount = std::uint16_t(meshletCount);
    header.lodLevel = group.lodLevel; header.vertexFormatId = vertexFormatId;
    header.meshletHeaderOffset = 64u; header.triangleDataOffset = triangleStart;
    header.vertexDataOffset = vertexStart; header.payloadBytes = payloadBytes;
    EncodeRecordV3(output.bytes.data(), header);
    triangleCursor = triangleStart; vertexCursor = vertexStart;
    for (std::uint32_t i = 0; i < meshletCount; ++i) {
        const Meshlet& meshlet = meshlets[group.meshletIds[i]];
        MeshletHeaderV3 meshletHeader{};
        meshletHeader.vertexCount = std::uint16_t(meshlet.vertices.size());
        meshletHeader.triangleCount = std::uint16_t(meshlet.triangles.size() / 3u);
        meshletHeader.vertexByteOffset = vertexCursor;
        meshletHeader.triangleByteOffset = triangleCursor;
        meshletHeader.refineGroupId = meshlet.refineGroupId == kInvalidId ? kInvalidId : oldToSerialized[meshlet.refineGroupId];
        meshletHeader.materialId = source.materialId; meshletHeader.flags = source.meshletFlags;
        std::copy(meshlet.bboxMin, meshlet.bboxMin + 3, meshletHeader.bboxMin);
        std::copy(meshlet.bboxMax, meshlet.bboxMax + 3, meshletHeader.bboxMax);
        EncodeRecordV3(output.bytes.data() + 64u + i * 48u, meshletHeader);
        std::copy(meshlet.triangles.begin(), meshlet.triangles.end(), output.bytes.begin() + triangleCursor);
        triangleCursor += AlignUp(std::uint32_t(meshlet.triangles.size()), 4u);
        for (std::uint32_t vertex : meshlet.vertices) {
            PackVertex(output.bytes, vertexCursor, source.vertices[vertex], format);
            vertexCursor += format.strideBytes;
            evidence.serializedVertexBytes += format.strideBytes;
        }
        vertexCursor = AlignUp(vertexCursor, 4u);
    }
    return output;
}

DomainProduct CookDomain(MaterialDomain source, const GeometryCookRecipeV3& recipe, CookEvidenceV3& evidence) {
    std::vector<Meshlet> meshlets = BuildMeshlets(source, recipe, source.indices);
    const std::uint32_t leafCount = std::uint32_t(meshlets.size());
    std::vector<std::uint32_t> active(meshlets.size()); std::iota(active.begin(), active.end(), 0u);
    std::vector<std::uint32_t> positionRemap(source.vertices.size());
    meshopt_generatePositionRemap(positionRemap.data(), source.vertices.front().position, source.vertices.size(), sizeof(CanonicalVertex));
    std::vector<Group> groups;
    std::uint32_t previousTriangles = std::uint32_t(source.indices.size() / 3u);
    std::uint8_t lodLevel = 1u;
    while (!active.empty()) {
        const std::vector<std::uint32_t> groupIds = GroupMeshlets(source, recipe, meshlets, active, positionRemap, std::uint8_t(lodLevel - 1u), groups);
        for (std::uint32_t groupId : groupIds) for (std::uint32_t meshletId : groups[groupId].meshletIds) meshlets[meshletId].groupId = groupId;
        std::vector<unsigned char> locks(source.vertices.size(), 0u);
        BuildSeamLocks(source, recipe, groups, groupIds, meshlets, positionRemap, locks);
        const auto levelVertexBegin = source.vertices.size();
        std::vector<Meshlet> generated;
        std::vector<std::uint32_t> next;
        for (std::uint32_t groupId : groupIds) {
            Group& group = groups[groupId];
            if (group.meshletIds.size() <= 1u) { group.parentError = FLT_MAX; continue; }
            std::vector<Meshlet> simplified;
            float error = 0.0f; bool fallback = false;
            if (!SimplifyGroup(source, recipe, group, meshlets, locks, simplified, error, fallback)) { group.parentError = FLT_MAX; continue; }
            group.simplificationFallback = fallback;
            if (fallback) ++evidence.simplificationFallbackGroups;
            float propagated = error;
            for (std::uint32_t id : group.meshletIds) if (meshlets[id].refineGroupId != kInvalidId) propagated = std::max(propagated, groups[meshlets[id].refineGroupId].parentError * recipe.lodErrorMergeFactor);
            group.parentError = propagated;
            const std::uint32_t base = std::uint32_t(meshlets.size() + generated.size());
            for (Meshlet& item : simplified) {
                // WithUpdate can move parent vertices. The coarse bound must
                // cover both the new coarse surface and every refinement
                // descendant that can be selected below this group.
                MergeSphere(item.sphere, group.sphere, item.sphere);
                MergeAabb(item.bboxMin, item.bboxMax, group.bboxMin, group.bboxMax, item.bboxMin, item.bboxMax);
                next.push_back(base + std::uint32_t(&item - simplified.data()));
                generated.push_back(std::move(item));
            }
        }
        if (generated.empty()) { source.vertices.resize(levelVertexBegin); break; }
        std::uint32_t triangleCount = 0u;
        for (const Meshlet& meshlet : generated) triangleCount += std::uint32_t(meshlet.triangles.size() / 3u);
        const float reduction = 1.0f - float(triangleCount) / float(previousTriangles);
        if (reduction < recipe.minimumLodReduction) {
            // Generated replacements are discarded: these groups remain DAG roots.
            // A finite parent error would cull them at distance with no replacement.
            for (std::uint32_t groupId : groupIds) groups[groupId].parentError = FLT_MAX;
            source.vertices.resize(levelVertexBegin);
            break;
        }
        previousTriangles = triangleCount;
        meshlets.insert(meshlets.end(), std::make_move_iterator(generated.begin()), std::make_move_iterator(generated.end()));
        // Coarse wedge records are appended during simplification. The next
        // grouping/locking pass must include their shared geometric positions.
        positionRemap.resize(source.vertices.size());
        meshopt_generatePositionRemap(positionRemap.data(), source.vertices.front().position, source.vertices.size(), sizeof(CanonicalVertex));
        active = std::move(next); ++lodLevel;
        if (lodLevel == 255u) throw std::runtime_error("LOD level exceeds u8 ABI");
    }
    ValidateLodBuild(groups, meshlets);
    std::vector<std::uint32_t> order(groups.size()); std::iota(order.begin(), order.end(), 0u);
    std::stable_sort(order.begin(), order.end(), [&](std::uint32_t a, std::uint32_t b) {
        if (groups[a].lodLevel != groups[b].lodLevel) return groups[a].lodLevel > groups[b].lodLevel;
        return a < b;
    });
    std::vector<std::uint32_t> oldToSerialized(groups.size());
    for (std::uint32_t i = 0; i < order.size(); ++i) oldToSerialized[order[i]] = i;
    DomainProduct product;
    product.vertexFormat = MakeVertexFormat(source.attributeMask);
    std::vector<std::uint8_t> hasCoarseParent(groups.size(), 0u);
    for (const Meshlet& meshlet : meshlets) if (meshlet.refineGroupId != kInvalidId) hasCoarseParent[meshlet.refineGroupId] = 1u;
    product.groups.reserve(groups.size());
    for (std::uint32_t oldId : order) {
        SerializedGroupV3 serialized = SerializeGroup(source, groups[oldId], meshlets, oldToSerialized, 0u, product.vertexFormat, evidence);
        serialized.localStableId = oldToSerialized[oldId];
        // Every refine-DAG root is required. Branches can stop simplifying at
        // different LODs, so "maximum LOD only" would create bootstrap holes.
        if (!hasCoarseParent[oldId]) serialized.flags |= kGroupBootstrap;
        product.groups.push_back(std::move(serialized));
    }
    product.hierarchy = BuildNyxHierarchy(groups, oldToSerialized, product.rootNode);
    product.leafMeshlets = leafCount; product.totalMeshlets = std::uint32_t(meshlets.size());
    return product;
}

void PatchGroupIds(SerializedGroupV3& group, std::uint32_t groupBase, std::uint8_t vertexFormatId) {
    GroupHeaderV3 header{}; DecodeRecordV3(group.bytes.data(), &header);
    header.vertexFormatId = vertexFormatId; EncodeRecordV3(group.bytes.data(), header);
    for (std::uint32_t i = 0; i < header.meshletCount; ++i) {
        std::uint8_t* address = group.bytes.data() + header.meshletHeaderOffset + i * sizeof(MeshletHeaderV3);
        MeshletHeaderV3 meshlet{}; DecodeRecordV3(address, &meshlet);
        if (meshlet.refineGroupId != kInvalidId) meshlet.refineGroupId += groupBase;
        EncodeRecordV3(address, meshlet);
    }
}

}  // namespace

CookedAssetV3 CookGeometryAssetV3(
    const CanonicalGeometryAsset& source, const GeometryCookRecipeV3& recipe,
    CookEvidenceV3& evidence) {
    ValidateRecipe(recipe);
    const auto started = std::chrono::steady_clock::now();
    CookedAssetV3 output;
    Sha256Builder identity;
    identity.Add("OEG3", 4u); identity.Add(source.sourceHash.data(), source.sourceHash.size());
    const Hash256 recipeHash = Sha256(CanonicalRecipeJson(recipe));
    identity.Add(recipeHash.data(), recipeHash.size()); output.assetId = identity.Finish();
    std::copy(source.boundsSphere, source.boundsSphere + 4, output.boundsSphere);
    std::copy(source.boundsMin, source.boundsMin + 3, output.boundsMin);
    std::copy(source.boundsMax, source.boundsMax + 3, output.boundsMax);
    for (const MaterialDomain& domain : source.domains) {
        output.sourceTriangleCount += std::uint32_t(domain.indices.size() / 3u);
        evidence.uniqueReferencedVertexBytes += domain.vertices.size() * sizeof(CanonicalVertex);
        DomainProduct product = CookDomain(domain, recipe, evidence);
        // Asset culling must enclose relocated parent geometry as well as leaves.
        for (const auto& serialized : product.groups) {
            GroupHeaderV3 header{}; DecodeRecordV3(serialized.bytes.data(), &header);
            MergeSphere(output.boundsSphere, header.boundsSphere, output.boundsSphere);
            MergeAabb(output.boundsMin, output.boundsMax, header.bboxMin, header.bboxMax, output.boundsMin, output.boundsMax);
        }
        const std::uint32_t groupBase = std::uint32_t(output.groups.size());
        const std::uint32_t nodeBase = std::uint32_t(output.hierarchy.size());
        const std::uint8_t formatId = std::uint8_t(output.vertexFormats.size());
        if (formatId == 0xffu) throw std::runtime_error("asset requires too many vertex formats");
        output.vertexFormats.push_back(product.vertexFormat);
        for (SerializedGroupV3& group : product.groups) {
            PatchGroupIds(group, groupBase, formatId);
            output.groups.push_back(std::move(group));
        }
        for (GeometryHierarchyNodeV3 node : product.hierarchy) {
            if (IsGroupLeafV3(node.packedNodeData)) {
                const std::uint32_t group = (node.packedNodeData >> 1u) & 0x00ffffffu;
                const std::uint32_t count = ((node.packedNodeData >> 25u) & 0x7fu) + 1u;
                node.packedNodeData = PackGroupLeafV3(groupBase + group, count);
            } else {
                const std::uint32_t child = (node.packedNodeData >> 1u) & 0x07ffffffu;
                const std::uint32_t count = (node.packedNodeData >> 28u) & 0x0fu;
                node.packedNodeData = PackInternalNodeV3(nodeBase + child, count);
            }
            output.hierarchy.push_back(node);
        }
        output.rootNodeIndices.push_back(nodeBase + product.rootNode);
        output.leafMeshletCount += product.leafMeshlets;
        output.totalMeshletCount += product.totalMeshlets;
    }
    evidence.leafMeshlets += output.leafMeshletCount;
    evidence.parentMeshlets += output.totalMeshletCount - output.leafMeshletCount;
    evidence.groups += output.groups.size();
    evidence.hierarchyNodes += output.hierarchy.size();
    evidence.hierarchyBytes += output.hierarchy.size() * sizeof(GeometryHierarchyNodeV3);
    evidence.vertexDuplicationRatio = evidence.uniqueReferencedVertexBytes == 0u ? 0.0 :
        double(evidence.serializedVertexBytes) / double(evidence.uniqueReferencedVertexBytes);
    evidence.cookWallMilliseconds += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    return output;
}

}  // namespace oengine::asset
