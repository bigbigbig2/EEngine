#include "oengine_asset/DecodedGeometryProduct.h"

#include "oengine_asset/Hash.h"
#include "oengine_asset/OegPackCodec.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iterator>
#include <limits>
#include <numeric>
#include <stdexcept>

namespace oengine::asset {

std::array<std::uint8_t, 16> ComputeGeometryPageIdentityV1(
    const std::vector<std::uint32_t>& groupIds,
    const std::vector<std::uint32_t>& payloadBytes,
    const std::vector<Hash256>& payloadDigests) {
    if (groupIds.size() != payloadBytes.size() ||
        groupIds.size() != payloadDigests.size()) {
        throw std::runtime_error("page identity inputs must have equal length");
    }
    if (groupIds.empty()) {
        throw std::runtime_error("page identity requires at least one group");
    }
    Sha256Builder builder;
    builder.Add(std::string("OENGINE-GEOMETRY-PAGE-IDENTITY-V1"));
    const auto addU32 = [&builder](std::uint32_t value) {
        const std::uint8_t bytes[4] = {
            std::uint8_t(value), std::uint8_t(value >> 8u),
            std::uint8_t(value >> 16u), std::uint8_t(value >> 24u)};
        builder.Add(bytes, sizeof(bytes));
    };
    addU32(std::uint32_t(groupIds.size()));
    for (std::size_t index = 0u; index < groupIds.size(); ++index) {
        if (index > 0u && groupIds[index] <= groupIds[index - 1u]) {
            throw std::runtime_error("page identity groups must be strictly ascending");
        }
        addU32(groupIds[index]);
        addU32(payloadBytes[index]);
        builder.Add(payloadDigests[index].data(), payloadDigests[index].size());
    }
    const Hash256 identity = builder.Finish();
    std::array<std::uint8_t, 16> output{};
    std::copy(identity.begin(), identity.begin() + output.size(), output.begin());
    return output;
}

namespace {

struct PendingPage {
    std::vector<std::uint8_t> decoded = std::vector<std::uint8_t>(kGeometryPageBytesV4, 0u);
    std::vector<std::uint32_t> groups;
    /** Per-Group payload digest, parallel to `groups`, used for page identity. */
    std::vector<Hash256> groupDigests;
    std::uint32_t usedBytes = 0u;
    std::uint8_t lodLevel = 0u;
    bool bootstrap = false;
};

/** Query section V3 is a descriptor index over the same decoded page bytes.
 * Coarse simplification has no coverage proof, so the minimum guaranteed cut
 * contains every refinement leaf. No simplified hull is labelled exact. */
std::vector<std::uint8_t> BuildQuerySection(
    const DecodedGeometryProductPlanV1& product,
    const std::vector<SerializedGroupV4>& groups,
    const Hash256& recipeHash) {
    constexpr std::uint32_t headerBytes = 160u;
    constexpr std::uint32_t assetStride = 32u;
    constexpr std::uint32_t clusterStride = 80u;
    std::vector<std::uint32_t> groupBegins(groups.size() + 1u, 0u);
    for (std::size_t group = 0u; group < groups.size(); ++group) {
        GroupHeaderV4 header{};
        DecodeRecordV4(groups[group].bytes.data(), &header);
        if (header.meshletCount == 0u || header.meshletCount > 128u ||
            std::uint64_t(header.meshletHeaderOffset) +
                std::uint64_t(header.meshletCount) * sizeof(MeshletHeaderV4) > groups[group].bytes.size()) {
            throw std::runtime_error("query source has an invalid meshlet range");
        }
        const auto next = std::uint64_t(groupBegins[group]) + header.meshletCount;
        if (next >= kInvalidId) throw std::runtime_error("query cluster identity exhausted");
        groupBegins[group + 1u] = std::uint32_t(next);
    }
    std::vector<std::uint32_t> children, roots, minimum, pages, primitives, vertices;
    std::vector<std::array<std::uint32_t, 8>> assets;
    std::vector<std::array<std::uint32_t, 20>> clusters;
    clusters.reserve(groupBegins.back());
    const auto floatBits = [](float value) {
        if (!std::isfinite(value)) throw std::runtime_error("query source bounds/error are non-finite");
        std::uint32_t bits;
        std::memcpy(&bits, &value, sizeof(bits));
        return bits;
    };
    for (std::uint32_t assetId = 0u; assetId < product.assets.size(); ++assetId) {
        const auto& asset = product.assets[assetId];
        const auto rootBegin = std::uint32_t(roots.size());
        const auto cutBegin = std::uint32_t(minimum.size());
        const auto pageBegin = std::uint32_t(pages.size());
        std::vector<std::uint32_t> assetPages;
        for (std::uint32_t groupId = asset.groupBegin;
             groupId < asset.groupBegin + asset.groupCount; ++groupId) {
            const auto& source = groups[groupId];
            const auto& directory = product.groups[groupId];
            GroupHeaderV4 header{};
            DecodeRecordV4(source.bytes.data(), &header);
            std::uint32_t sourcePrimitive = 0u, sourceVertex = 0u;
            for (std::uint32_t meshletId = 0u; meshletId < header.meshletCount; ++meshletId) {
                MeshletHeaderV4 meshlet{};
                DecodeRecordV4(source.bytes.data() + header.meshletHeaderOffset +
                    meshletId * sizeof(meshlet), &meshlet);
                const auto clusterId = groupBegins[groupId] + meshletId;
                if (clusterId != clusters.size()) throw std::runtime_error("query asset group ranges overlap");
                const auto childBegin = std::uint32_t(children.size());
                const bool leaf = meshlet.refineGroupId == kInvalidId;
                if (!leaf) {
                    if (meshlet.refineGroupId < asset.groupBegin ||
                        meshlet.refineGroupId >= asset.groupBegin + asset.groupCount) {
                        throw std::runtime_error("query refinement escapes its asset");
                    }
                    for (auto child = groupBegins[meshlet.refineGroupId];
                         child < groupBegins[meshlet.refineGroupId + 1u]; ++child) {
                        children.push_back(child);
                    }
                }
                if (source.flags & kGroupBootstrap) roots.push_back(clusterId);
                if (leaf) {
                    minimum.push_back(clusterId);
                    assetPages.push_back(directory.pageId);
                }
                // All unproven coarse surfaces are coverage-critical. Error
                // class 0 is exact leaf; class 1 is approximate raster geometry.
                const auto flags = (leaf ? 1u : 2u) | 4u;
                clusters.push_back({
                    directory.pageId, groupId, meshletId, meshlet.triangleCount,
                    meshlet.materialId, header.vertexFormatId, flags, assetId,
                    floatBits(meshlet.bboxMin[0]), floatBits(meshlet.bboxMin[1]), floatBits(meshlet.bboxMin[2]),
                    floatBits(meshlet.bboxMax[0]), floatBits(meshlet.bboxMax[1]), floatBits(meshlet.bboxMax[2]),
                    floatBits(leaf ? 0.0f : header.parentError), childBegin,
                    std::uint32_t(children.size()) - childBegin, header.lodLevel,
                    std::uint32_t(primitives.size()), std::uint32_t(vertices.size())});
                if (std::uint64_t(sourcePrimitive) + meshlet.triangleCount > source.stablePrimitiveIds.size() ||
                    std::uint64_t(sourceVertex) + meshlet.vertexCount > source.sourceVertexIds.size()) {
                    throw std::runtime_error("query source correspondence is incomplete");
                }
                for (std::uint32_t triangle = 0u; triangle < meshlet.triangleCount; ++triangle) {
                    primitives.push_back(source.stablePrimitiveIds[sourcePrimitive++]);
                }
                for (std::uint32_t vertex = 0u; vertex < meshlet.vertexCount; ++vertex) {
                    vertices.push_back(source.sourceVertexIds[sourceVertex++]);
                }
            }
            if (sourcePrimitive != source.stablePrimitiveIds.size() || sourceVertex != source.sourceVertexIds.size()) {
                throw std::runtime_error("query source correspondence contains unowned records");
            }
        }
        std::sort(assetPages.begin(), assetPages.end());
        assetPages.erase(std::unique(assetPages.begin(), assetPages.end()), assetPages.end());
        pages.insert(pages.end(), assetPages.begin(), assetPages.end());
        assets.push_back({rootBegin, std::uint32_t(roots.size()) - rootBegin,
            cutBegin, std::uint32_t(minimum.size()) - cutBegin,
            pageBegin, std::uint32_t(pages.size()) - pageBegin, 0u, 0u});
    }
    const std::uint64_t total = headerBytes + assets.size() * assetStride +
        clusters.size() * clusterStride + 4u * (children.size() + roots.size() + minimum.size() + pages.size() +
            primitives.size() + vertices.size());
    if (total >= kInvalidId) throw std::runtime_error("query section exceeds u32 byte addressing");
    std::vector<std::uint8_t> bytes(std::size_t(total), 0u);
    const auto put = [&](std::size_t at, std::uint32_t value) { EncodeRecordV4(bytes.data() + at, value); };
    put(0u, 0x3251474fu); // OGQ2
    put(4u, 3u); put(8u, headerBytes); put(12u, std::uint32_t(total));
    std::copy(recipeHash.begin(), recipeHash.end(), bytes.begin() + 16u);
    const std::size_t counts[] = {assets.size(), clusters.size(), children.size(), roots.size(), minimum.size(), pages.size()};
    for (std::size_t i = 0u; i < 6u; ++i) put(48u + i * 4u, std::uint32_t(counts[i]));
    std::uint32_t cursor = headerBytes;
    put(72u, cursor);
    for (const auto& asset : assets) for (auto word : asset) { put(cursor, word); cursor += 4u; }
    put(76u, cursor);
    for (const auto& cluster : clusters) for (auto word : cluster) { put(cursor, word); cursor += 4u; }
    const std::vector<std::uint32_t>* tables[] = {&children, &roots, &minimum, &pages};
    for (std::size_t i = 0u; i < 4u; ++i) {
        put(80u + i * 4u, cursor);
        for (auto word : *tables[i]) { put(cursor, word); cursor += 4u; }
    }
    put(96u, std::uint32_t(primitives.size()));
    put(100u, std::uint32_t(vertices.size()));
    put(104u, cursor);
    for (auto word : primitives) { put(cursor, word); cursor += 4u; }
    put(108u, cursor);
    for (auto word : vertices) { put(cursor, word); cursor += 4u; }
    const auto contentHash = Sha256(bytes.data() + headerBytes, bytes.size() - headerBytes);
    std::copy(contentHash.begin(), contentHash.end(), bytes.begin() + 128u);
    return bytes;
}

std::uint64_t AlignUp64(std::uint64_t value, std::uint64_t alignment) {
    return (value + alignment - 1u) & ~(alignment - 1u);
}

void PatchAssetForProduct(
    CookedAssetV4& asset, std::uint32_t groupBase, std::uint32_t nodeBase,
    const std::vector<std::uint8_t>& formatRemap) {
    for (SerializedGroupV4& group : asset.groups) {
        GroupHeaderV4 header{};
        DecodeRecordV4(group.bytes.data(), &header);
        if (header.vertexFormatId >= formatRemap.size()) {
            throw std::runtime_error("asset vertex format id is invalid");
        }
        header.vertexFormatId = formatRemap[header.vertexFormatId];
        EncodeRecordV4(group.bytes.data(), header);
        for (std::uint32_t i = 0u; i < header.meshletCount; ++i) {
            std::uint8_t* address = group.bytes.data() +
                header.meshletHeaderOffset + i * sizeof(MeshletHeaderV4);
            MeshletHeaderV4 meshlet{};
            DecodeRecordV4(address, &meshlet);
            if (meshlet.refineGroupId != kInvalidId) meshlet.refineGroupId += groupBase;
            EncodeRecordV4(address, meshlet);
        }
    }
    for (GeometryHierarchyNodeV4& node : asset.hierarchy) {
        if (IsGroupLeafV4(node.packedNodeData)) {
            const std::uint32_t group = (node.packedNodeData >> 1u) & 0x00ffffffu;
            const std::uint32_t count = ((node.packedNodeData >> 25u) & 0x7fu) + 1u;
            node.packedNodeData = PackGroupLeafV4(groupBase + group, count);
        } else {
            const std::uint32_t child = (node.packedNodeData >> 1u) & 0x07ffffffu;
            const std::uint32_t count = (node.packedNodeData >> 28u) & 0x0fu;
            node.packedNodeData = PackInternalNodeV4(nodeBase + child, count);
        }
    }
    for (std::uint32_t& root : asset.rootNodeIndices) root += nodeBase;
}

/**
 * Shared packing core for both the monolithic and the two-phase paths.
 *
 * Page layout, Group assignment, page identity and the activation cut are
 * decided here and nowhere else, so a plan produced by the descriptor stage and
 * a product produced by the monolithic path cannot drift. `materializePages`
 * only controls whether 256 KiB payload buffers are actually filled.
 */
DecodedGeometryProductPlanV1 PackDecodedGeometryProductV1(
    std::vector<CookedAssetV4> cooked,
    std::vector<SerializedGroupV4>* retainedGroups,
    bool materializePages) {
    if (cooked.empty()) throw std::runtime_error("decoded Geometry Product has no assets");

    DecodedGeometryProductPlanV1 product;
    const auto recipeHash = cooked.front().recipeHash;
    for (const auto& asset : cooked) {
        if (asset.recipeHash != recipeHash) throw std::runtime_error("query Product mixes cook recipes");
    }
    std::vector<SerializedGroupV4> serializedGroups;
    std::vector<std::vector<std::uint32_t>> assetBootstrapPages(cooked.size());
    for (std::size_t assetIndex = 0u; assetIndex < cooked.size(); ++assetIndex) {
        CookedAssetV4& asset = cooked[assetIndex];
        if (asset.groups.empty() || asset.hierarchy.empty() || asset.rootNodeIndices.empty()) {
            throw std::runtime_error("decoded Geometry Product asset is incomplete");
        }
        const std::uint32_t groupBase = std::uint32_t(product.groups.size());
        const std::uint32_t nodeBase = std::uint32_t(product.hierarchy.size());
        std::vector<std::uint8_t> formatRemap;
        for (const VertexFormatRecordV4& format : asset.vertexFormats) {
            const auto found = std::find_if(
                product.formats.begin(), product.formats.end(),
                [&](const VertexFormatRecordV4& candidate) {
                    return std::memcmp(&candidate, &format, sizeof(format)) == 0;
                });
            if (found == product.formats.end()) {
                if (product.formats.size() >= 255u) {
                    throw std::runtime_error("product has more than 255 distinct vertex formats");
                }
                formatRemap.push_back(std::uint8_t(product.formats.size()));
                product.formats.push_back(format);
            } else {
                formatRemap.push_back(std::uint8_t(found - product.formats.begin()));
            }
        }
        PatchAssetForProduct(asset, groupBase, nodeBase, formatRemap);

        GeometryAssetRecordV4 record{};
        std::copy(asset.assetId.begin(), asset.assetId.end(), record.assetId);
        std::copy(asset.boundsSphere, asset.boundsSphere + 4, record.boundsSphere);
        std::copy(asset.boundsMin, asset.boundsMin + 3, record.boundsMin);
        std::copy(asset.boundsMax, asset.boundsMax + 3, record.boundsMax);
        record.rootNodeBegin = std::uint32_t(product.roots.size());
        record.rootNodeCount = std::uint32_t(asset.rootNodeIndices.size());
        record.hierarchyBegin = nodeBase;
        record.hierarchyCount = std::uint32_t(asset.hierarchy.size());
        record.groupBegin = groupBase;
        record.groupCount = std::uint32_t(asset.groups.size());
        record.sourceTriangleCount = asset.sourceTriangleCount;
        record.leafMeshletCount = asset.leafMeshletCount;
        record.totalMeshletCount = asset.totalMeshletCount;
        product.roots.insert(
            product.roots.end(), asset.rootNodeIndices.begin(), asset.rootNodeIndices.end());
        product.hierarchy.insert(
            product.hierarchy.end(), asset.hierarchy.begin(), asset.hierarchy.end());
        product.groups.resize(product.groups.size() + asset.groups.size());
        serializedGroups.insert(
            serializedGroups.end(),
            std::make_move_iterator(asset.groups.begin()),
            std::make_move_iterator(asset.groups.end()));
        product.assets.push_back(record);
    }

    // Geometry Product V1 page records describe one contiguous GroupID range.
    // Preserve Nyx group identity and tier locality while bounding best-fit search.
    std::vector<PendingPage> pendingPages;
    constexpr std::size_t kBestFitCandidateWindow = 16u;
    for (std::uint32_t groupId = 0u; groupId < serializedGroups.size(); ++groupId) {
        const SerializedGroupV4& group = serializedGroups[groupId];
        const bool bootstrap = (group.flags & kGroupBootstrap) != 0u;
        std::size_t bestPage = pendingPages.size();
        std::uint32_t bestRemaining = std::numeric_limits<std::uint32_t>::max();
        std::size_t matchingCandidates = 0u;
        for (std::size_t reverse = pendingPages.size();
             reverse-- > 0u && matchingCandidates < kBestFitCandidateWindow;) {
            PendingPage& candidate = pendingPages[reverse];
            if (candidate.groups.empty() || candidate.groups.back() + 1u != groupId) continue;
            if (candidate.bootstrap != bootstrap || candidate.lodLevel != group.lodLevel) continue;
            ++matchingCandidates;
            const std::uint32_t aligned = std::uint32_t(AlignUp64(candidate.usedBytes, 16u));
            if (group.bytes.size() > kGeometryPageBytesV4 - aligned) continue;
            const std::uint32_t remaining =
                kGeometryPageBytesV4 - aligned - std::uint32_t(group.bytes.size());
            if (remaining <= bestRemaining) {
                bestRemaining = remaining;
                bestPage = reverse;
            }
        }
        if (bestPage == pendingPages.size()) {
            pendingPages.emplace_back();
            bestPage = pendingPages.size() - 1u;
            pendingPages[bestPage].bootstrap = bootstrap;
            pendingPages[bestPage].lodLevel = group.lodLevel;
        }
        PendingPage& page = pendingPages[bestPage];
        const std::uint32_t offset = std::uint32_t(AlignUp64(page.usedBytes, 16u));
        if (offset + group.bytes.size() > kGeometryPageBytesV4) {
            throw std::runtime_error("group does not fit in an empty decoded page");
        }
        if (materializePages) {
            std::copy(group.bytes.begin(), group.bytes.end(), page.decoded.begin() + offset);
        }
        GeometryGroupDirectoryV4& directory = product.groups[groupId];
        directory.offsetInDecodedPage = offset;
        directory.payloadBytes = std::uint32_t(group.bytes.size());
        directory.flags = group.flags;
        page.groups.push_back(groupId);
        page.groupDigests.push_back(Sha256(group.bytes));
        page.usedBytes = offset + directory.payloadBytes;
    }

    std::stable_sort(
        pendingPages.begin(), pendingPages.end(),
        [](const PendingPage& a, const PendingPage& b) {
            if (a.bootstrap != b.bootstrap) return a.bootstrap > b.bootstrap;
            if (a.lodLevel != b.lodLevel) return a.lodLevel > b.lodLevel;
            return a.groups.front() < b.groups.front();
        });
    product.pages.reserve(pendingPages.size());
    for (std::uint32_t pageId = 0u; pageId < pendingPages.size(); ++pageId) {
        PendingPage& pending = pendingPages[pageId];
        for (std::uint32_t group : pending.groups) product.groups[group].pageId = pageId;
        DecodedGeometryPagePlanV1 page;
        // Page identity is rolled up from the page's Group payloads, not from the
        // packed page buffer. This keeps identity stable under padding and lets a
        // producer freeze it before any payload buffer exists.
        std::vector<std::uint32_t> identityPayloadBytes;
        identityPayloadBytes.reserve(pending.groups.size());
        for (std::uint32_t group : pending.groups) {
            identityPayloadBytes.push_back(product.groups[group].payloadBytes);
        }
        page.decodedHash128 = ComputeGeometryPageIdentityV1(
            pending.groups, identityPayloadBytes, pending.groupDigests);
        page.firstGroup = pending.groups.front();
        page.groupCount = std::uint32_t(pending.groups.size());
        page.usedBytes = pending.usedBytes;
        page.lodLevel = pending.lodLevel;
        page.bootstrap = pending.bootstrap;
        product.pages.push_back(page);
        if (pending.bootstrap) {
            for (std::size_t assetIndex = 0u; assetIndex < product.assets.size(); ++assetIndex) {
                const GeometryAssetRecordV4& asset = product.assets[assetIndex];
                const std::uint32_t assetLast = asset.groupBegin + asset.groupCount - 1u;
                if (std::any_of(
                        pending.groups.begin(), pending.groups.end(),
                        [&](std::uint32_t group) {
                            return group >= asset.groupBegin && group <= assetLast;
                        })) {
                    assetBootstrapPages[assetIndex].push_back(pageId);
                }
            }
        }
    }

    for (std::size_t assetIndex = 0u; assetIndex < product.assets.size(); ++assetIndex) {
        GeometryAssetRecordV4& asset = product.assets[assetIndex];
        asset.bootstrapPageBegin = std::uint32_t(product.bootstrapPages.size());
        asset.bootstrapPageCount = std::uint32_t(assetBootstrapPages[assetIndex].size());
        product.bootstrapPages.insert(
            product.bootstrapPages.end(),
            assetBootstrapPages[assetIndex].begin(), assetBootstrapPages[assetIndex].end());
        if (asset.bootstrapPageCount == 0u) {
            throw std::runtime_error("asset has no complete bootstrap page cut");
        }
    }
    product.querySection = BuildQuerySection(product, serializedGroups, recipeHash);
    if (retainedGroups) *retainedGroups = std::move(serializedGroups);
    return product;
}

}  // namespace

DecodedGeometryProductPlanV1 PlanDecodedGeometryProductV1(
    std::vector<CookedAssetV4> cooked,
    std::vector<SerializedGroupV4>& retainedGroups) {
    DecodedGeometryProductPlanV1 plan = PackDecodedGeometryProductV1(
        std::move(cooked), &retainedGroups, /*materializePages=*/false);
    if (retainedGroups.size() != plan.groups.size()) {
        throw std::runtime_error("planned Geometry Product lost Group payloads");
    }
    return plan;
}

DecodedGeometryPageV1 MaterializeDecodedGeometryPageV1(
    const DecodedGeometryProductPlanV1& plan,
    const std::vector<SerializedGroupV4>& retainedGroups,
    std::uint32_t pageId) {
    if (pageId >= plan.pages.size()) {
        throw std::runtime_error("decoded page index is out of range");
    }
    const DecodedGeometryPagePlanV1& planned = plan.pages[pageId];
    if (planned.groupCount == 0u) {
        throw std::runtime_error("planned decoded page has no groups");
    }
    const std::uint32_t lastGroup = planned.firstGroup + planned.groupCount - 1u;
    if (lastGroup >= retainedGroups.size()) {
        throw std::runtime_error("planned decoded page references an unknown group");
    }
    DecodedGeometryPageV1 page;
    page.bytes.assign(kGeometryPageBytesV4, 0u);
    std::vector<std::uint32_t> identityGroupIds;
    std::vector<std::uint32_t> identityPayloadBytes;
    std::vector<Hash256> identityPayloadDigests;
    identityGroupIds.reserve(planned.groupCount);
    identityPayloadBytes.reserve(planned.groupCount);
    identityPayloadDigests.reserve(planned.groupCount);
    for (std::uint32_t groupId = planned.firstGroup; groupId <= lastGroup; ++groupId) {
        const GeometryGroupDirectoryV4& directory = plan.groups[groupId];
        if (directory.pageId != pageId) {
            throw std::runtime_error("planned decoded page owns a non-contiguous group range");
        }
        const SerializedGroupV4& group = retainedGroups[groupId];
        if (group.bytes.size() != directory.payloadBytes) {
            throw std::runtime_error("retained Group payload bytes do not match the plan");
        }
        const std::uint32_t offset = directory.offsetInDecodedPage;
        if (std::uint64_t(offset) + directory.payloadBytes > page.bytes.size()) {
            throw std::runtime_error("planned Group payload escapes its decoded page");
        }
        std::copy(group.bytes.begin(), group.bytes.end(), page.bytes.begin() + offset);
        identityGroupIds.push_back(groupId);
        identityPayloadBytes.push_back(directory.payloadBytes);
        identityPayloadDigests.push_back(Sha256(group.bytes));
    }
    const std::array<std::uint8_t, 16> identity = ComputeGeometryPageIdentityV1(
        identityGroupIds, identityPayloadBytes, identityPayloadDigests);
    if (identity != planned.decodedHash128) {
        throw std::runtime_error("materialized page identity does not match the plan");
    }
    page.decodedHash128 = identity;
    page.firstGroup = planned.firstGroup;
    page.groupCount = planned.groupCount;
    page.usedBytes = planned.usedBytes;
    page.lodLevel = planned.lodLevel;
    page.bootstrap = planned.bootstrap;
    return page;
}

DecodedGeometryProductV1 AssembleDecodedGeometryProductV1(
    std::vector<CookedAssetV4> cooked) {
    std::vector<SerializedGroupV4> retained;
    DecodedGeometryProductPlanV1 plan = PackDecodedGeometryProductV1(
        std::move(cooked), &retained, /*materializePages=*/true);
    // Materialise every page before `plan` is consumed by the moves below:
    // MaterializeDecodedGeometryPageV1 reads plan.pages and plan.groups, and the
    // monolithic path must not observe a half-moved plan.
    std::vector<DecodedGeometryPageV1> pages;
    pages.reserve(plan.pages.size());
    for (std::uint32_t pageId = 0u; pageId < plan.pages.size(); ++pageId) {
        pages.push_back(
            MaterializeDecodedGeometryPageV1(plan, retained, pageId));
    }
    DecodedGeometryProductV1 product;
    product.querySection = std::move(plan.querySection);
    product.assets = std::move(plan.assets);
    product.roots = std::move(plan.roots);
    product.hierarchy = std::move(plan.hierarchy);
    product.groups = std::move(plan.groups);
    product.formats = std::move(plan.formats);
    product.bootstrapPages = std::move(plan.bootstrapPages);
    product.pages = std::move(pages);
    return product;
}

}  // namespace oengine::asset
