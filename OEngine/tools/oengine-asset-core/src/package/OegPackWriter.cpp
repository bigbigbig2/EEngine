#include "oengine_asset/OegPackWriter.h"
#include "oengine_asset/OegPackCodec.h"

#include "lz4.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <future>
#include <iomanip>
#include <iostream>
#include <limits>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>
#include <cerrno>
#include <direct.h>
#include <windows.h>
#include <psapi.h>

namespace oengine::asset {
namespace {

struct PageBuild {
    std::vector<std::uint8_t> decoded = std::vector<std::uint8_t>(kGeometryPageBytesV3, 0u);
    std::vector<std::uint32_t> groups;
    std::uint32_t usedBytes = 0u;
    std::uint8_t lodLevel = 0u;
    bool bootstrap = false;
    std::vector<std::uint8_t> encoded;
    GeometryPageDirectoryV3 directory{};
};

std::string JoinPath(const std::string& directory, const std::string& name) {
    if (directory.empty()) return name;
    const char tail = directory.back();
    return directory + ((tail == '/' || tail == '\\') ? "" : "/") + name;
}

std::string FileName(const std::string& path) {
    const std::size_t split = path.find_last_of("/\\");
    return split == std::string::npos ? path : path.substr(split + 1u);
}

void CreateDirectories(const std::string& path) {
    std::string current;
    current.reserve(path.size());
    for (std::size_t i = 0; i < path.size(); ++i) {
        const char c = path[i];
        current.push_back(c);
        if ((c == '/' || c == '\\') && current.size() > 3u) {
            if (_mkdir(current.c_str()) != 0 && errno != EEXIST) throw std::runtime_error("cannot create directory: " + current);
        }
    }
    if (_mkdir(current.c_str()) != 0 && errno != EEXIST) throw std::runtime_error("cannot create directory: " + current);
}

std::uint64_t FileSize(const std::string& path) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) throw std::runtime_error("cannot open file: " + path);
    const std::streamoff size = input.tellg();
    if (size < 0) throw std::runtime_error("cannot size file: " + path);
    return std::uint64_t(size);
}

std::uint64_t PeakWorkingSetBytes() {
    PROCESS_MEMORY_COUNTERS counters{};
    counters.cb = sizeof(counters);
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters))) return 0u;
    return std::uint64_t(counters.PeakWorkingSetSize);
}

std::uint64_t AlignUp64(std::uint64_t value, std::uint64_t alignment) {
    return (value + alignment - 1u) & ~(alignment - 1u);
}

void RequireLittleEndian() {
    const std::uint32_t marker = 0x01020304u;
    if (*reinterpret_cast<const std::uint8_t*>(&marker) != 0x04u) throw std::runtime_error("OEGPACK V3 writer requires a little-endian host");
}

template <typename T>
void WriteRecord(std::vector<std::uint8_t>& bytes, std::uint64_t offset, const T& value) {
    if (offset + sizeof(T) > bytes.size()) throw std::runtime_error("record write exceeds pack allocation");
    EncodeRecordV3(bytes.data() + offset, value);
}

template <typename T>
void WriteRecords(std::vector<std::uint8_t>& bytes, std::uint64_t offset, const std::vector<T>& values) {
    if (!values.empty()) {
        const std::uint64_t size = values.size() * sizeof(T);
        if (offset + size > bytes.size()) throw std::runtime_error("record table exceeds pack allocation");
        for (std::size_t index = 0u; index < values.size(); ++index) EncodeRecordV3(bytes.data() + offset + index * sizeof(T), values[index]);
    }
}

template <typename T>
std::vector<T> ReadRecords(const std::vector<std::uint8_t>& bytes, std::uint64_t offset, std::uint32_t count) {
    const std::uint64_t size = std::uint64_t(count) * sizeof(T);
    if (offset > bytes.size() || size > bytes.size() - offset) throw std::runtime_error("record table is outside file bounds");
    std::vector<T> output(count);
    for (std::uint32_t index = 0u; index < count; ++index) DecodeRecordV3(bytes.data() + offset + std::uint64_t(index) * sizeof(T), &output[index]);
    return output;
}

std::vector<std::uint8_t> ReadFile(const std::string& path) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) throw std::runtime_error("cannot open file: " + path);
    const std::streamoff end = input.tellg();
    if (end < 0) throw std::runtime_error("cannot size file: " + path);
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(end), std::uint8_t(0));
    input.seekg(0);
    if (!bytes.empty()) input.read(reinterpret_cast<char*>(bytes.data()), std::streamsize(bytes.size()));
    if (!input) throw std::runtime_error("cannot read file: " + path);
    return bytes;
}

void WriteFile(const std::string& path, const std::vector<std::uint8_t>& bytes) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("cannot create file: " + path);
    if (!bytes.empty()) output.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
    if (!output) throw std::runtime_error("cannot write file: " + path);
}

void AddEvidence(CookEvidenceV3& target, const CookEvidenceV3& source) {
    target.sourceBytes += source.sourceBytes;
    target.uniqueGeometryBytes += source.uniqueGeometryBytes;
    target.leafMeshlets += source.leafMeshlets; target.parentMeshlets += source.parentMeshlets;
    target.groups += source.groups; target.hierarchyNodes += source.hierarchyNodes; target.hierarchyBytes += source.hierarchyBytes;
    target.pageCount += source.pageCount; target.compressedPageBytes += source.compressedPageBytes;
    target.decodedPageBytes += source.decodedPageBytes; target.wastedPaddingBytes += source.wastedPaddingBytes;
    target.bootstrapPageCount += source.bootstrapPageCount; target.bootstrapGeometryBytes += source.bootstrapGeometryBytes;
    target.serializedVertexBytes += source.serializedVertexBytes;
    target.uniqueReferencedVertexBytes += source.uniqueReferencedVertexBytes;
    target.simplificationFallbackGroups += source.simplificationFallbackGroups;
    target.cookWallMilliseconds += source.cookWallMilliseconds;
    target.peakWorkingBytes = std::max(target.peakWorkingBytes, source.peakWorkingBytes);
}

std::uint64_t AssetDecodedBytes(const CookedAssetV3& asset) {
    std::uint64_t bytes = 0u;
    for (const SerializedGroupV3& group : asset.groups) bytes += group.bytes.size();
    return bytes;
}

void PatchAssetForPack(
    CookedAssetV3& asset, std::uint32_t groupBase, std::uint32_t nodeBase,
    const std::vector<std::uint8_t>& formatRemap) {
    for (SerializedGroupV3& group : asset.groups) {
        GroupHeaderV3 header{}; DecodeRecordV3(group.bytes.data(), &header);
        if (header.vertexFormatId >= formatRemap.size()) throw std::runtime_error("asset vertex format id is invalid");
        header.vertexFormatId = formatRemap[header.vertexFormatId]; EncodeRecordV3(group.bytes.data(), header);
        for (std::uint32_t i = 0; i < header.meshletCount; ++i) {
            std::uint8_t* address = group.bytes.data() + header.meshletHeaderOffset + i * sizeof(MeshletHeaderV3);
            MeshletHeaderV3 meshlet{}; DecodeRecordV3(address, &meshlet);
            if (meshlet.refineGroupId != kInvalidId) meshlet.refineGroupId += groupBase;
            EncodeRecordV3(address, meshlet);
        }
    }
    for (GeometryHierarchyNodeV3& node : asset.hierarchy) {
        if (IsGroupLeafV3(node.packedNodeData)) {
            const std::uint32_t group = (node.packedNodeData >> 1u) & 0x00ffffffu;
            const std::uint32_t count = ((node.packedNodeData >> 25u) & 0x7fu) + 1u;
            node.packedNodeData = PackGroupLeafV3(groupBase + group, count);
        } else {
            const std::uint32_t child = (node.packedNodeData >> 1u) & 0x07ffffffu;
            const std::uint32_t count = (node.packedNodeData >> 28u) & 0x0fu;
            node.packedNodeData = PackInternalNodeV3(nodeBase + child, count);
        }
    }
    for (std::uint32_t& root : asset.rootNodeIndices) root += nodeBase;
}

void CompressPage(PageBuild& page, const GeometryCookRecipeV3& recipe) {
    std::vector<char> lz4(static_cast<std::size_t>(LZ4_compressBound(int(kGeometryPageBytesV3))), char(0));
    const int compressed = LZ4_compress_default(
        reinterpret_cast<const char*>(page.decoded.data()), lz4.data(),
        int(kGeometryPageBytesV3), int(lz4.size()));
    if (compressed <= 0) throw std::runtime_error("LZ4 compression failed");
    if (std::uint32_t(compressed) >= kGeometryPageBytesV3 - recipe.rawCodecThresholdBytes) {
        page.encoded = page.decoded;
        page.directory.codec = kPageCodecRaw256K;
    } else {
        page.encoded.assign(reinterpret_cast<const std::uint8_t*>(lz4.data()), reinterpret_cast<const std::uint8_t*>(lz4.data()) + compressed);
        page.directory.codec = kPageCodecLz4Block;
    }
    page.directory.compressedBytes = std::uint32_t(page.encoded.size());
    page.directory.decodedBytes = kGeometryPageBytesV3;
    const Hash256 hash = Sha256(page.decoded);
    std::copy(hash.begin(), hash.begin() + 16u, page.directory.decodedContentHash128);
    page.directory.compressedChecksum = Crc32(page.encoded.data(), page.encoded.size());
    page.directory.flags = page.bootstrap ? kGroupBootstrap : 0u;
}

struct PackAssembly {
    std::vector<GeometryAssetRecordV3> assets;
    std::vector<std::uint32_t> roots;
    std::vector<GeometryHierarchyNodeV3> hierarchy;
    std::vector<GeometryGroupDirectoryV3> groups;
    std::vector<VertexFormatRecordV3> formats;
    std::vector<std::uint32_t> bootstrapPages;
    std::vector<PageBuild> pages;
    std::vector<SerializedGroupV3> serializedGroups;
};

PackAssembly AssemblePack(std::vector<CookedAssetV3> cooked) {
    PackAssembly pack;
    std::vector<std::vector<std::uint32_t>> assetBootstrapPages(cooked.size());
    for (std::size_t assetIndex = 0; assetIndex < cooked.size(); ++assetIndex) {
        CookedAssetV3& asset = cooked[assetIndex];
        const std::uint32_t groupBase = std::uint32_t(pack.groups.size());
        const std::uint32_t nodeBase = std::uint32_t(pack.hierarchy.size());
        std::vector<std::uint8_t> formatRemap;
        for (const VertexFormatRecordV3& format : asset.vertexFormats) {
            auto found = std::find_if(pack.formats.begin(), pack.formats.end(), [&](const VertexFormatRecordV3& candidate) {
                return std::memcmp(&candidate, &format, sizeof(format)) == 0;
            });
            if (found == pack.formats.end()) {
                if (pack.formats.size() >= 255u) throw std::runtime_error("pack has more than 255 distinct vertex formats");
                formatRemap.push_back(std::uint8_t(pack.formats.size()));
                pack.formats.push_back(format);
            } else {
                formatRemap.push_back(std::uint8_t(found - pack.formats.begin()));
            }
        }
        PatchAssetForPack(asset, groupBase, nodeBase, formatRemap);

        GeometryAssetRecordV3 record{};
        std::copy(asset.assetId.begin(), asset.assetId.end(), record.assetId);
        std::copy(asset.boundsSphere, asset.boundsSphere + 4, record.boundsSphere);
        std::copy(asset.boundsMin, asset.boundsMin + 3, record.boundsMin);
        std::copy(asset.boundsMax, asset.boundsMax + 3, record.boundsMax);
        record.rootNodeBegin = std::uint32_t(pack.roots.size()); record.rootNodeCount = std::uint32_t(asset.rootNodeIndices.size());
        record.hierarchyBegin = nodeBase; record.hierarchyCount = std::uint32_t(asset.hierarchy.size());
        record.groupBegin = groupBase; record.groupCount = std::uint32_t(asset.groups.size());
        record.sourceTriangleCount = asset.sourceTriangleCount; record.leafMeshletCount = asset.leafMeshletCount;
        record.totalMeshletCount = asset.totalMeshletCount;
        pack.roots.insert(pack.roots.end(), asset.rootNodeIndices.begin(), asset.rootNodeIndices.end());
        pack.hierarchy.insert(pack.hierarchy.end(), asset.hierarchy.begin(), asset.hierarchy.end());
        pack.groups.resize(pack.groups.size() + asset.groups.size());
        pack.serializedGroups.insert(
            pack.serializedGroups.end(),
            std::make_move_iterator(asset.groups.begin()),
            std::make_move_iterator(asset.groups.end()));
        pack.assets.push_back(record);
    }

    std::vector<std::uint32_t> packingOrder(pack.serializedGroups.size());
    std::iota(packingOrder.begin(), packingOrder.end(), 0u);
    std::stable_sort(packingOrder.begin(), packingOrder.end(), [&](std::uint32_t a, std::uint32_t b) {
        const SerializedGroupV3& left = pack.serializedGroups[a];
        const SerializedGroupV3& right = pack.serializedGroups[b];
        const bool leftBootstrap = (left.flags & kGroupBootstrap) != 0u;
        const bool rightBootstrap = (right.flags & kGroupBootstrap) != 0u;
        if (leftBootstrap != rightBootstrap) return leftBootstrap > rightBootstrap;
        if (left.lodLevel != right.lodLevel) return left.lodLevel > right.lodLevel;
        return a < b;
    });
    constexpr std::size_t kBestFitCandidateWindow = 16u;
    for (std::uint32_t groupId : packingOrder) {
        const SerializedGroupV3& group = pack.serializedGroups[groupId];
        const bool bootstrap = (group.flags & kGroupBootstrap) != 0u;
        std::size_t bestPage = pack.pages.size();
        std::uint32_t bestRemaining = std::numeric_limits<std::uint32_t>::max();
        std::size_t matchingCandidates = 0u;
        for (std::size_t reverse = pack.pages.size(); reverse-- > 0u && matchingCandidates < kBestFitCandidateWindow;) {
            PageBuild& candidate = pack.pages[reverse];
            if (candidate.bootstrap != bootstrap || candidate.lodLevel != group.lodLevel) continue;
            ++matchingCandidates;
            const std::uint32_t aligned = std::uint32_t(AlignUp64(candidate.usedBytes, 16u));
            if (group.bytes.size() > kGeometryPageBytesV3 - aligned) continue;
            const std::uint32_t remaining = kGeometryPageBytesV3 - aligned - std::uint32_t(group.bytes.size());
            if (remaining <= bestRemaining) { bestRemaining = remaining; bestPage = reverse; }
        }
        if (bestPage == pack.pages.size()) {
            pack.pages.emplace_back(); bestPage = pack.pages.size() - 1u;
            pack.pages[bestPage].bootstrap = bootstrap; pack.pages[bestPage].lodLevel = group.lodLevel;
        }
        PageBuild& page = pack.pages[bestPage];
        const std::uint32_t offset = std::uint32_t(AlignUp64(page.usedBytes, 16u));
        if (offset + group.bytes.size() > kGeometryPageBytesV3) throw std::runtime_error("group does not fit in an empty page");
        std::copy(group.bytes.begin(), group.bytes.end(), page.decoded.begin() + offset);
        GeometryGroupDirectoryV3& directory = pack.groups[groupId];
        directory.offsetInDecodedPage = offset; directory.payloadBytes = std::uint32_t(group.bytes.size()); directory.flags = group.flags;
        page.groups.push_back(groupId); page.usedBytes = offset + directory.payloadBytes;
    }
    for (PageBuild& page : pack.pages) {
        page.directory.firstGroup = *std::min_element(page.groups.begin(), page.groups.end());
        page.directory.groupCount = std::uint32_t(page.groups.size());
    }

    std::stable_sort(pack.pages.begin(), pack.pages.end(), [](const PageBuild& a, const PageBuild& b) {
        if (a.bootstrap != b.bootstrap) return a.bootstrap > b.bootstrap;
        if (a.lodLevel != b.lodLevel) return a.lodLevel > b.lodLevel;
        return a.groups.front() < b.groups.front();
    });
    for (std::uint32_t pageId = 0u; pageId < pack.pages.size(); ++pageId) {
        PageBuild& page = pack.pages[pageId];
        for (std::uint32_t group : page.groups) pack.groups[group].pageId = pageId;
        if (page.bootstrap) {
            pack.bootstrapPages.push_back(pageId);
            for (std::size_t assetIndex = 0; assetIndex < pack.assets.size(); ++assetIndex) {
                const GeometryAssetRecordV3& asset = pack.assets[assetIndex];
                const std::uint32_t assetLast = asset.groupBegin + asset.groupCount - 1u;
                if (std::any_of(page.groups.begin(), page.groups.end(), [&](std::uint32_t group) {
                    return group >= asset.groupBegin && group <= assetLast;
                })) assetBootstrapPages[assetIndex].push_back(pageId);
            }
        }
    }
    pack.bootstrapPages.clear();
    for (std::size_t assetIndex = 0; assetIndex < pack.assets.size(); ++assetIndex) {
        GeometryAssetRecordV3& asset = pack.assets[assetIndex];
        asset.bootstrapPageBegin = std::uint32_t(pack.bootstrapPages.size());
        asset.bootstrapPageCount = std::uint32_t(assetBootstrapPages[assetIndex].size());
        pack.bootstrapPages.insert(pack.bootstrapPages.end(), assetBootstrapPages[assetIndex].begin(), assetBootstrapPages[assetIndex].end());
        if (asset.bootstrapPageCount == 0u) throw std::runtime_error("asset has no bootstrap pages");
    }
    return pack;
}

WrittenPackV3 WritePack(
    const std::string& outputDirectory, std::vector<CookedAssetV3> assets,
    const std::vector<std::uint32_t>& sourceIndices, const GeometryCookRecipeV3& recipe,
    std::uint32_t workerCount, CookEvidenceV3& evidence, std::vector<double>& pageFills) {
    PackAssembly pack = AssemblePack(std::move(assets));
    const std::size_t concurrency = std::max<std::size_t>(1u, workerCount);
    for (std::size_t begin = 0u; begin < pack.pages.size(); begin += concurrency) {
        std::vector<std::future<void>> compression;
        const std::size_t end = std::min(pack.pages.size(), begin + concurrency);
        compression.reserve(end - begin);
        for (std::size_t pageIndex = begin; pageIndex < end; ++pageIndex) {
            compression.push_back(std::async(std::launch::async, [&, pageIndex]() {
                CompressPage(pack.pages[pageIndex], recipe);
            }));
        }
        for (auto& task : compression) task.get();
    }

    OegPackHeaderV3 header{};
    std::copy(kOegPackMagicV3.begin(), kOegPackMagicV3.end(), header.magic);
    header.formatMajor = kOegPackFormatMajorV3; header.formatMinor = kOegPackFormatMinorV3;
    header.endianMarker = kOegPackEndianMarker; header.headerBytes = kOegPackHeaderBytesV3;
    header.pageShift = kGeometryPageShiftV3; header.pageBytes = kGeometryPageBytesV3;
    header.defaultCodec = kPageCodecLz4Block;
    header.assetCount = std::uint32_t(pack.assets.size()); header.rootNodeIndexCount = std::uint32_t(pack.roots.size());
    header.hierarchyNodeCount = std::uint32_t(pack.hierarchy.size()); header.groupCount = std::uint32_t(pack.groups.size());
    header.pageCount = std::uint32_t(pack.pages.size()); header.vertexFormatCount = std::uint32_t(pack.formats.size());
    header.bootstrapPageCount = std::uint32_t(pack.bootstrapPages.size());
    std::uint64_t cursor = sizeof(header);
    header.assetDirectoryOffset = cursor; cursor = AlignUp64(cursor + pack.assets.size() * sizeof(GeometryAssetRecordV3), 16u);
    header.rootNodeIndexOffset = cursor; cursor = AlignUp64(cursor + pack.roots.size() * sizeof(std::uint32_t), 16u);
    header.hierarchyOffset = cursor; cursor = AlignUp64(cursor + pack.hierarchy.size() * sizeof(GeometryHierarchyNodeV3), 16u);
    header.groupDirectoryOffset = cursor; cursor = AlignUp64(cursor + pack.groups.size() * sizeof(GeometryGroupDirectoryV3), 16u);
    header.pageDirectoryOffset = cursor; cursor = AlignUp64(cursor + pack.pages.size() * sizeof(GeometryPageDirectoryV3), 16u);
    header.bootstrapPageOffset = cursor; cursor = AlignUp64(cursor + pack.bootstrapPages.size() * sizeof(std::uint32_t), 16u);
    header.vertexFormatOffset = cursor; cursor = AlignUp64(cursor + pack.formats.size() * sizeof(VertexFormatRecordV3), 256u);
    header.pageBlobOffset = cursor;
    for (PageBuild& page : pack.pages) {
        page.directory.compressedFileOffset = cursor;
        cursor += page.encoded.size();
    }
    header.fileBytes = cursor;
    const Hash256 recipeHash = Sha256(CanonicalRecipeJson(recipe));
    std::copy(recipeHash.begin(), recipeHash.end(), header.recipeHash);
    std::vector<GeometryPageDirectoryV3> pageDirectories;
    for (const PageBuild& page : pack.pages) pageDirectories.push_back(page.directory);
    std::vector<std::uint8_t> bytes(std::size_t(header.fileBytes), 0u);
    WriteRecord(bytes, 0u, header);
    WriteRecords(bytes, header.assetDirectoryOffset, pack.assets);
    WriteRecords(bytes, header.rootNodeIndexOffset, pack.roots);
    WriteRecords(bytes, header.hierarchyOffset, pack.hierarchy);
    WriteRecords(bytes, header.groupDirectoryOffset, pack.groups);
    WriteRecords(bytes, header.pageDirectoryOffset, pageDirectories);
    WriteRecords(bytes, header.bootstrapPageOffset, pack.bootstrapPages);
    WriteRecords(bytes, header.vertexFormatOffset, pack.formats);
    for (const PageBuild& page : pack.pages) std::copy(page.encoded.begin(), page.encoded.end(), bytes.begin() + page.directory.compressedFileOffset);
    const Hash256 packHash = Sha256(bytes.data(), std::size_t(header.pageBlobOffset));
    std::copy(packHash.begin(), packHash.end(), header.packContentHash);
    WriteRecord(bytes, 0u, header);
    const std::string id = Hex(packHash);
    const std::string path = JoinPath(outputDirectory, "geometry-" + id.substr(0u, 20u) + ".oegpack");
    WriteFile(path, bytes);
    ValidateOegPackV3File(path, true);

    evidence.pageCount += pack.pages.size(); evidence.decodedPageBytes += pack.pages.size() * std::uint64_t(kGeometryPageBytesV3);
    for (const PageBuild& page : pack.pages) {
        evidence.compressedPageBytes += page.encoded.size(); evidence.wastedPaddingBytes += kGeometryPageBytesV3 - page.usedBytes;
        if (page.bootstrap) { ++evidence.bootstrapPageCount; evidence.bootstrapGeometryBytes += page.usedBytes; }
        pageFills.push_back(double(page.usedBytes) / double(kGeometryPageBytesV3));
    }
    WrittenPackV3 written; written.path = path; written.packId = packHash; written.sourceAssetIndices = sourceIndices;
    return written;
}

std::string JsonEscape(const std::string& text) {
    std::ostringstream output;
    for (unsigned char c : text) {
        if (c == '\\' || c == '"') output << '\\' << char(c);
        else if (c >= 0x20u) output << char(c);
    }
    return output.str();
}

void WriteSceneManifest(
    const std::string& path, const ImportedSceneV3& imported,
    const std::vector<CookedAssetV3>& cooked, const std::vector<WrittenPackV3>& packs) {
    struct Location { std::uint32_t pack = 0u; std::uint32_t record = 0u; };
    std::vector<Location> locations(cooked.size());
    for (std::uint32_t packIndex = 0; packIndex < packs.size(); ++packIndex) for (std::uint32_t record = 0; record < packs[packIndex].sourceAssetIndices.size(); ++record) locations[packs[packIndex].sourceAssetIndices[record]] = {packIndex, record};
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("cannot create scene manifest");
    output << std::setprecision(9) << "{\n  \"schema\": \"oengine-scene-v3\",\n  \"packs\": [\n";
    for (std::size_t i = 0; i < packs.size(); ++i) {
        output << "    {\"packId\":\"" << Hex(packs[i].packId) << "\",\"uri\":\"" << JsonEscape(FileName(packs[i].path)) << "\"}" << (i + 1u == packs.size() ? "\n" : ",\n");
    }
    output << "  ],\n  \"assets\": [\n";
    for (std::size_t i = 0; i < cooked.size(); ++i) {
        output << "    {\"assetId\":\"" << Hex(cooked[i].assetId) << "\",\"pack\":" << locations[i].pack << ",\"assetRecordIndex\":" << locations[i].record << "}" << (i + 1u == cooked.size() ? "\n" : ",\n");
    }
    output << "  ],\n  \"instances\": [\n";
    for (std::size_t i = 0; i < imported.instances.size(); ++i) {
        const SceneInstanceV3& instance = imported.instances[i];
        output << "    {\"asset\":" << instance.assetIndex << ",\"materialBindingTable\":0,\"flags\":" << instance.flags << ",\"transform\":[";
        for (std::size_t m = 0; m < 16u; ++m) output << (m ? "," : "") << instance.worldTransform[m];
        output << "]}" << (i + 1u == imported.instances.size() ? "\n" : ",\n");
    }
    output << "  ]\n}\n";
    if (!output) throw std::runtime_error("cannot write scene manifest");
}

}  // namespace

WriteSceneResultV3 CookAndWriteSceneV3(
    const std::string& inputPath, const std::string& outputDirectory,
    const GeometryCookRecipeV3& recipe, std::uint64_t targetShardBytes,
    std::uint32_t workerCount) {
    RequireLittleEndian(); ValidateRecipe(recipe);
    const auto started = std::chrono::steady_clock::now();
    CreateDirectories(outputDirectory);
    ImportedSceneV3 imported = ImportGltfCanonical(inputPath);
    const std::uint64_t sourceBytes = FileSize(inputPath);
    std::vector<CookedAssetV3> cooked(imported.assets.size());
    std::vector<CookEvidenceV3> assetEvidence(imported.assets.size());
    const std::uint32_t concurrency = std::max(1u, workerCount);
    for (std::size_t begin = 0; begin < imported.assets.size(); begin += concurrency) {
        std::vector<std::future<void>> tasks;
        for (std::size_t index = begin; index < std::min(imported.assets.size(), begin + concurrency); ++index) {
            tasks.push_back(std::async(std::launch::async, [&, index]() { cooked[index] = CookGeometryAssetV3(imported.assets[index], recipe, assetEvidence[index]); }));
        }
        for (auto& task : tasks) task.get();
    }
    WriteSceneResultV3 result;
    result.evidence.sourceBytes = sourceBytes;
    for (const CookEvidenceV3& item : assetEvidence) AddEvidence(result.evidence, item);
    for (const CanonicalGeometryAsset& asset : imported.assets) for (const MaterialDomain& domain : asset.domains) result.evidence.uniqueGeometryBytes += domain.vertices.size() * sizeof(CanonicalVertex) + domain.indices.size() * sizeof(std::uint32_t);
    std::uint64_t bootstrapPayloadBytes = 0u;
    for (const CookedAssetV3& asset : cooked) for (const SerializedGroupV3& group : asset.groups) if (group.flags & kGroupBootstrap) bootstrapPayloadBytes += group.bytes.size();
    if (bootstrapPayloadBytes > recipe.bootstrapGeometryBudgetBytes) throw std::runtime_error("scene bootstrap geometry budget exceeded");

    std::vector<std::vector<std::uint32_t>> shards;
    std::uint64_t shardBytes = 0u;
    for (std::uint32_t index = 0u; index < cooked.size(); ++index) {
        const std::uint64_t bytes = AssetDecodedBytes(cooked[index]);
        if (!shards.empty() && !shards.back().empty() && shardBytes + bytes > targetShardBytes) { shards.emplace_back(); shardBytes = 0u; }
        if (shards.empty()) shards.emplace_back();
        shards.back().push_back(index); shardBytes += bytes;
    }
    std::vector<double> pageFills;
    for (const std::vector<std::uint32_t>& shard : shards) {
        std::vector<CookedAssetV3> assets;
        for (std::uint32_t index : shard) assets.push_back(cooked[index]);
        result.packs.push_back(WritePack(outputDirectory, std::move(assets), shard, recipe, concurrency, result.evidence, pageFills));
    }
    result.scenePath = JoinPath(outputDirectory, "scene.oescene");
    WriteSceneManifest(result.scenePath, imported, cooked, result.packs);
    result.evidence.vertexDuplicationRatio = result.evidence.uniqueReferencedVertexBytes == 0u ? 0.0 :
        double(result.evidence.serializedVertexBytes) / double(result.evidence.uniqueReferencedVertexBytes);
    std::sort(pageFills.begin(), pageFills.end());
    if (!pageFills.empty()) {
        result.evidence.meanPageFill = std::accumulate(pageFills.begin(), pageFills.end(), 0.0) / pageFills.size();
        result.evidence.p50PageFill = pageFills[std::size_t((pageFills.size() - 1u) * 0.50)];
        result.evidence.p95PageFill = pageFills[std::size_t((pageFills.size() - 1u) * 0.95)];
    }
    result.evidence.peakWorkingBytes = std::max(result.evidence.peakWorkingBytes, PeakWorkingSetBytes());
    result.evidence.cookWallMilliseconds =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    return result;
}

void ValidateOegPackV3File(const std::string& path, bool verifyPages) {
    RequireLittleEndian();
    std::vector<std::uint8_t> bytes = ReadFile(path);
    if (bytes.size() < sizeof(OegPackHeaderV3)) throw std::runtime_error("pack is shorter than V3 header");
    OegPackHeaderV3 header{}; DecodeRecordV3(bytes.data(), &header);
    if (!std::equal(kOegPackMagicV3.begin(), kOegPackMagicV3.end(), header.magic)) throw std::runtime_error("invalid OEGPACK magic");
    if (header.formatMajor != 3u || header.formatMinor != 0u) throw std::runtime_error("unsupported OEGPACK version");
    if (header.endianMarker != kOegPackEndianMarker || header.headerBytes != 256u) throw std::runtime_error("invalid endian/header contract");
    if (header.pageShift != 18u || header.pageBytes != kGeometryPageBytesV3) throw std::runtime_error("invalid V3 page size contract");
    if (header.flags != 0u || header.defaultCodec != kPageCodecLz4Block || header.reserved0 != 0u || std::any_of(std::begin(header.reserved), std::end(header.reserved), [](std::uint8_t value) { return value != 0u; })) throw std::runtime_error("header flags/default codec/reserved bytes are invalid");
    if (header.fileBytes != bytes.size() || header.pageBlobOffset > bytes.size()) throw std::runtime_error("pack file size is inconsistent");
    if (header.pageBlobOffset % 256u != 0u) throw std::runtime_error("page blob is not 256-byte aligned");
    std::uint64_t previousTableEnd = sizeof(OegPackHeaderV3);
    const auto validateTable = [&](std::uint64_t start, std::uint32_t count, std::uint64_t stride, std::uint64_t alignment, const char* name) {
        const std::uint64_t size = std::uint64_t(count) * stride;
        if (start % alignment != 0u || start < previousTableEnd || start > header.pageBlobOffset || size > header.pageBlobOffset - start) {
            throw std::runtime_error(std::string(name) + " table range/alignment is invalid");
        }
        previousTableEnd = start + size;
    };
    validateTable(header.assetDirectoryOffset, header.assetCount, sizeof(GeometryAssetRecordV3), 16u, "asset");
    validateTable(header.rootNodeIndexOffset, header.rootNodeIndexCount, sizeof(std::uint32_t), 16u, "root node");
    validateTable(header.hierarchyOffset, header.hierarchyNodeCount, sizeof(GeometryHierarchyNodeV3), 16u, "hierarchy");
    validateTable(header.groupDirectoryOffset, header.groupCount, sizeof(GeometryGroupDirectoryV3), 16u, "group");
    validateTable(header.pageDirectoryOffset, header.pageCount, sizeof(GeometryPageDirectoryV3), 16u, "page");
    validateTable(header.bootstrapPageOffset, header.bootstrapPageCount, sizeof(std::uint32_t), 16u, "bootstrap");
    validateTable(header.vertexFormatOffset, header.vertexFormatCount, sizeof(VertexFormatRecordV3), 16u, "vertex format");
    std::vector<std::uint8_t> metadata(bytes.begin(), bytes.begin() + header.pageBlobOffset);
    const Hash256 expectedPackHash = [&]() { Hash256 h{}; std::copy(header.packContentHash, header.packContentHash + 32u, h.begin()); return h; }();
    std::fill(metadata.begin() + 176u, metadata.begin() + 208u, 0u);
    if (Sha256(metadata) != expectedPackHash) throw std::runtime_error("pack content hash mismatch");

    const auto assets = ReadRecords<GeometryAssetRecordV3>(bytes, header.assetDirectoryOffset, header.assetCount);
    const auto roots = ReadRecords<std::uint32_t>(bytes, header.rootNodeIndexOffset, header.rootNodeIndexCount);
    const auto hierarchy = ReadRecords<GeometryHierarchyNodeV3>(bytes, header.hierarchyOffset, header.hierarchyNodeCount);
    const auto groups = ReadRecords<GeometryGroupDirectoryV3>(bytes, header.groupDirectoryOffset, header.groupCount);
    const auto pages = ReadRecords<GeometryPageDirectoryV3>(bytes, header.pageDirectoryOffset, header.pageCount);
    const auto formats = ReadRecords<VertexFormatRecordV3>(bytes, header.vertexFormatOffset, header.vertexFormatCount);
    const auto bootstrap = ReadRecords<std::uint32_t>(bytes, header.bootstrapPageOffset, header.bootstrapPageCount);
    if (assets.empty() || roots.empty() || hierarchy.empty() || groups.empty() || pages.empty() || formats.empty() || bootstrap.empty()) throw std::runtime_error("required resident metadata table is empty");
    for (const GeometryAssetRecordV3& asset : assets) {
        if (asset.rootNodeBegin + asset.rootNodeCount > roots.size() || asset.hierarchyBegin + asset.hierarchyCount > hierarchy.size() || asset.groupBegin + asset.groupCount > groups.size() || asset.bootstrapPageBegin + asset.bootstrapPageCount > bootstrap.size()) throw std::runtime_error("asset metadata range is invalid");
        if (asset.rootNodeCount == 0u || asset.bootstrapPageCount == 0u) throw std::runtime_error("asset has no root/bootstrap cut");
        if (asset.flags != 0u || asset.reserved[0] != 0u || asset.reserved[1] != 0u) throw std::runtime_error("asset flags/reserved fields are invalid");
    }
    constexpr std::uint16_t kKnownAttributes = kAttributePosition | kAttributeNormal | kAttributeTangent | kAttributeUv0 | kAttributeUv1 | kAttributeColor;
    for (const VertexFormatRecordV3& format : formats) {
        if ((format.attributeMask & (kAttributePosition | kAttributeNormal)) != (kAttributePosition | kAttributeNormal) || (format.attributeMask & ~kKnownAttributes) != 0u || format.strideBytes == 0u || format.positionOffset + 6u > format.strideBytes || format.normalOffset + 4u > format.strideBytes || std::any_of(std::begin(format.reserved), std::end(format.reserved), [](std::uint8_t value) { return value != 0u; })) throw std::runtime_error("vertex format record is invalid");
        const auto optionalRange = [&](std::uint8_t offset, std::uint32_t width) { return offset == 0xffu || std::uint32_t(offset) + width <= format.strideBytes; };
        if (!optionalRange(format.tangentOffset, 6u) || !optionalRange(format.uv0Offset, 4u) || !optionalRange(format.uv1Offset, 4u) || !optionalRange(format.colorOffset, 4u)) throw std::runtime_error("vertex format optional attribute range is invalid");
    }
    for (std::uint32_t root : roots) if (root >= hierarchy.size()) throw std::runtime_error("root node index is invalid");
    for (const GeometryHierarchyNodeV3& node : hierarchy) {
        for (float value : node.boundsSphere) if (!std::isfinite(value)) throw std::runtime_error("hierarchy sphere is non-finite");
        for (float value : node.bboxMin) if (!std::isfinite(value)) throw std::runtime_error("hierarchy bboxMin is non-finite");
        for (float value : node.bboxMax) if (!std::isfinite(value)) throw std::runtime_error("hierarchy bboxMax is non-finite");
        if (!std::isfinite(node.maxParentError)) throw std::runtime_error("hierarchy error is non-finite");
        if (IsGroupLeafV3(node.packedNodeData)) {
            const std::uint32_t start = (node.packedNodeData >> 1u) & 0x00ffffffu;
            if (start >= groups.size()) throw std::runtime_error("hierarchy leaf group is invalid");
        } else {
            const std::uint32_t start = (node.packedNodeData >> 1u) & 0x07ffffffu;
            const std::uint32_t count = (node.packedNodeData >> 28u) & 0x0fu;
            if (count == 0u || count > 8u || start + count > hierarchy.size()) throw std::runtime_error("hierarchy child range is invalid");
        }
    }
    for (const GeometryAssetRecordV3& asset : assets) {
        const std::uint32_t nodeEnd = asset.hierarchyBegin + asset.hierarchyCount;
        const std::uint32_t groupEnd = asset.groupBegin + asset.groupCount;
        std::vector<std::uint8_t> reachedNodes(asset.hierarchyCount, 0u);
        std::vector<std::uint8_t> reachedGroups(asset.groupCount, 0u);
        std::vector<std::uint32_t> stack;
        for (std::uint32_t i = 0u; i < asset.rootNodeCount; ++i) {
            const std::uint32_t root = roots[asset.rootNodeBegin + i];
            if (root < asset.hierarchyBegin || root >= nodeEnd) throw std::runtime_error("asset root escapes its hierarchy range");
            stack.push_back(root);
        }
        while (!stack.empty()) {
            const std::uint32_t nodeId = stack.back(); stack.pop_back();
            std::uint8_t& reached = reachedNodes[nodeId - asset.hierarchyBegin];
            if (reached) continue;
            reached = 1u;
            const GeometryHierarchyNodeV3& node = hierarchy[nodeId];
            if (IsGroupLeafV3(node.packedNodeData)) {
                const std::uint32_t group = (node.packedNodeData >> 1u) & 0x00ffffffu;
                if (group < asset.groupBegin || group >= groupEnd) throw std::runtime_error("asset hierarchy leaf escapes its group range");
                reachedGroups[group - asset.groupBegin] = 1u;
            } else {
                const std::uint32_t start = (node.packedNodeData >> 1u) & 0x07ffffffu;
                const std::uint32_t count = (node.packedNodeData >> 28u) & 0x0fu;
                if (start < asset.hierarchyBegin || start + count > nodeEnd) throw std::runtime_error("asset hierarchy child escapes its hierarchy range");
                for (std::uint32_t child = start; child < start + count; ++child) stack.push_back(child);
            }
        }
        if (std::find(reachedNodes.begin(), reachedNodes.end(), 0u) != reachedNodes.end()) throw std::runtime_error("asset contains a hierarchy node unreachable from its roots");
        if (std::find(reachedGroups.begin(), reachedGroups.end(), 0u) != reachedGroups.end()) throw std::runtime_error("asset contains a group unreachable from its roots");
    }
    std::uint64_t previousEnd = header.pageBlobOffset;
    std::set<std::uint32_t> bootstrapSet(bootstrap.begin(), bootstrap.end());
    for (std::uint32_t id : bootstrap) if (id >= pages.size()) throw std::runtime_error("bootstrap page id is invalid");
    std::vector<GroupHeaderV3> decodedGroups(groups.size());
    std::vector<std::uint8_t> decodedGroupPresent(groups.size(), 0u);
    struct RefineEdge { std::uint32_t coarseGroup; std::uint32_t fineGroup; };
    std::vector<RefineEdge> refineEdges;
    for (std::uint32_t pageId = 0u; pageId < pages.size(); ++pageId) {
        const GeometryPageDirectoryV3& page = pages[pageId];
        if ((page.flags & ~kGroupBootstrap) != 0u || page.reserved0 != 0u || page.reserved1 != 0u) throw std::runtime_error("page flags/reserved fields are invalid");
        if (page.decodedBytes != kGeometryPageBytesV3 || page.compressedBytes == 0u) throw std::runtime_error("page size is invalid");
        if (page.compressedFileOffset < previousEnd || page.compressedFileOffset + page.compressedBytes > bytes.size()) throw std::runtime_error("compressed page ranges overlap or exceed file");
        previousEnd = page.compressedFileOffset + page.compressedBytes;
        if (page.firstGroup >= groups.size() || page.groupCount == 0u) throw std::runtime_error("page group summary is invalid");
        if (!verifyPages) continue;
        const std::uint8_t* encoded = bytes.data() + page.compressedFileOffset;
        if (Crc32(encoded, page.compressedBytes) != page.compressedChecksum) throw std::runtime_error("compressed page checksum mismatch");
        std::vector<std::uint8_t> decoded(kGeometryPageBytesV3);
        if (page.codec == kPageCodecRaw256K) {
            if (page.compressedBytes != kGeometryPageBytesV3) throw std::runtime_error("raw page is not exactly 256 KiB");
            std::memcpy(decoded.data(), encoded, decoded.size());
        } else if (page.codec == kPageCodecLz4Block) {
            const int result = LZ4_decompress_safe(reinterpret_cast<const char*>(encoded), reinterpret_cast<char*>(decoded.data()), int(page.compressedBytes), int(decoded.size()));
            if (result != int(decoded.size())) throw std::runtime_error("LZ4 page does not decode to exactly 256 KiB");
        } else throw std::runtime_error("unsupported page codec");
        const Hash256 decodedHash = Sha256(decoded);
        if (!std::equal(decodedHash.begin(), decodedHash.begin() + 16u, page.decodedContentHash128)) throw std::runtime_error("decoded page hash mismatch");
        std::uint32_t groupsOnPage = 0u;
        std::uint32_t minimumGroup = kInvalidId;
        bool pageContainsBootstrap = false;
        for (std::uint32_t groupId = 0u; groupId < groups.size(); ++groupId) {
            const GeometryGroupDirectoryV3& directory = groups[groupId];
            if (directory.pageId != pageId) continue;
            ++groupsOnPage;
            constexpr std::uint32_t kKnownGroupFlags = kGroupBootstrap | kGroupOpaque | kGroupMask | kGroupBlend | kGroupTwoSided | kGroupSimplificationFallback;
            if ((directory.flags & ~kKnownGroupFlags) != 0u) throw std::runtime_error("group flags are invalid");
            minimumGroup = std::min(minimumGroup, groupId);
            pageContainsBootstrap = pageContainsBootstrap || (directory.flags & kGroupBootstrap) != 0u;
            if (directory.pageId != pageId || directory.offsetInDecodedPage % 16u != 0u || directory.offsetInDecodedPage + directory.payloadBytes > decoded.size()) throw std::runtime_error("group page mapping is invalid");
            if (directory.payloadBytes < sizeof(GroupHeaderV3)) throw std::runtime_error("group payload is too small");
            GroupHeaderV3 group{}; DecodeRecordV3(decoded.data() + directory.offsetInDecodedPage, &group);
            if (group.payloadBytes != directory.payloadBytes || group.meshletCount == 0u || group.meshletCount > 128u || group.vertexFormatId >= formats.size()) throw std::runtime_error("group header is invalid");
            for (float value : group.boundsSphere) if (!std::isfinite(value)) throw std::runtime_error("group sphere is non-finite");
            for (float value : group.bboxMin) if (!std::isfinite(value)) throw std::runtime_error("group bboxMin is non-finite");
            for (float value : group.bboxMax) if (!std::isfinite(value)) throw std::runtime_error("group bboxMax is non-finite");
            if (!std::isfinite(group.parentError)) throw std::runtime_error("group parent error is non-finite");
            if (group.meshletHeaderOffset != 64u || group.meshletHeaderOffset + group.meshletCount * sizeof(MeshletHeaderV3) > group.triangleDataOffset || group.triangleDataOffset > group.vertexDataOffset || group.vertexDataOffset > group.payloadBytes) throw std::runtime_error("group section offsets are invalid");
            decodedGroups[groupId] = group; decodedGroupPresent[groupId] = 1u;
            for (std::uint32_t meshletIndex = 0u; meshletIndex < group.meshletCount; ++meshletIndex) {
                MeshletHeaderV3 meshlet{};
                DecodeRecordV3(decoded.data() + directory.offsetInDecodedPage + group.meshletHeaderOffset + meshletIndex * sizeof(meshlet), &meshlet);
                if (meshlet.vertexCount == 0u || meshlet.vertexCount > 128u || meshlet.triangleCount == 0u || meshlet.triangleCount > 128u) throw std::runtime_error("meshlet count exceeds V3 limits");
                constexpr std::uint32_t kKnownMeshletFlags = kMeshletOpaque | kMeshletMask | kMeshletBlend | kMeshletTwoSided | kMeshletCastsShadow;
                if ((meshlet.flags & ~kKnownMeshletFlags) != 0u) throw std::runtime_error("meshlet flags are invalid");
                if (meshlet.refineGroupId != kInvalidId) {
                    if (meshlet.refineGroupId >= groups.size()) throw std::runtime_error("meshlet refineGroupId is invalid");
                    refineEdges.push_back({groupId, meshlet.refineGroupId});
                }
                const std::uint64_t triangleEnd = std::uint64_t(meshlet.triangleByteOffset) + meshlet.triangleCount * 3u;
                const std::uint64_t vertexEnd = std::uint64_t(meshlet.vertexByteOffset) + std::uint64_t(meshlet.vertexCount) * formats[group.vertexFormatId].strideBytes;
                if (meshlet.triangleByteOffset < group.triangleDataOffset || triangleEnd > group.vertexDataOffset || meshlet.vertexByteOffset < group.vertexDataOffset || vertexEnd > group.payloadBytes) throw std::runtime_error("meshlet data offset is invalid");
                const std::uint8_t* triangles = decoded.data() + directory.offsetInDecodedPage + meshlet.triangleByteOffset;
                for (std::uint32_t i = 0; i < meshlet.triangleCount * 3u; ++i) if (triangles[i] >= meshlet.vertexCount) throw std::runtime_error("meshlet local triangle index is invalid");
            }
        }
        if (groupsOnPage != page.groupCount || minimumGroup != page.firstGroup) throw std::runtime_error("page group summary is inconsistent");
        if (((page.flags & kGroupBootstrap) != 0u) != pageContainsBootstrap) throw std::runtime_error("page bootstrap summary is inconsistent");
    }
    if (previousEnd != bytes.size()) throw std::runtime_error("pack has trailing or unindexed page bytes");
    if (verifyPages) {
        if (std::find(decodedGroupPresent.begin(), decodedGroupPresent.end(), 0u) != decodedGroupPresent.end()) throw std::runtime_error("a group payload was not decoded from any page");
        for (const RefineEdge& edge : refineEdges) {
            const GroupHeaderV3& coarse = decodedGroups[edge.coarseGroup];
            const GroupHeaderV3& fine = decodedGroups[edge.fineGroup];
            if (coarse.lodLevel <= fine.lodLevel) throw std::runtime_error("refinement LOD is not strictly finer");
            if (coarse.parentError + 1.0e-5f < fine.parentError) throw std::runtime_error("refinement parent error is not monotonic");
        }
    }
    for (const GeometryAssetRecordV3& asset : assets) {
        std::set<std::uint32_t> assetBootstrap;
        for (std::uint32_t i = 0u; i < asset.bootstrapPageCount; ++i) {
            const std::uint32_t pageId = bootstrap[asset.bootstrapPageBegin + i];
            if (!bootstrapSet.count(pageId) || !assetBootstrap.insert(pageId).second) throw std::runtime_error("asset bootstrap range is invalid");
        }
        std::set<std::uint32_t> requiredBootstrap;
        for (std::uint32_t group = asset.groupBegin; group < asset.groupBegin + asset.groupCount; ++group) {
            if (groups[group].flags & kGroupBootstrap) requiredBootstrap.insert(groups[group].pageId);
        }
        if (requiredBootstrap.empty() || requiredBootstrap != assetBootstrap) throw std::runtime_error("asset bootstrap cut is incomplete or contains unrelated pages");
        if (verifyPages) {
            std::vector<std::vector<std::uint32_t>> refineChildren(asset.groupCount);
            std::vector<std::uint32_t> incomingRefineEdges(asset.groupCount, 0u);
            for (const RefineEdge& edge : refineEdges) {
                if (edge.coarseGroup < asset.groupBegin || edge.coarseGroup >= asset.groupBegin + asset.groupCount) continue;
                if (edge.fineGroup < asset.groupBegin || edge.fineGroup >= asset.groupBegin + asset.groupCount) throw std::runtime_error("refinement edge escapes its asset group range");
                refineChildren[edge.coarseGroup - asset.groupBegin].push_back(edge.fineGroup - asset.groupBegin);
                ++incomingRefineEdges[edge.fineGroup - asset.groupBegin];
            }
            std::vector<std::uint8_t> reached(asset.groupCount, 0u);
            std::vector<std::uint32_t> stack;
            for (std::uint32_t group = asset.groupBegin; group < asset.groupBegin + asset.groupCount; ++group) {
                const bool bootstrapGroup = (groups[group].flags & kGroupBootstrap) != 0u;
                const bool dagRoot = incomingRefineEdges[group - asset.groupBegin] == 0u;
                if (bootstrapGroup != dagRoot) throw std::runtime_error("bootstrap group set does not equal refine-DAG roots");
                if (bootstrapGroup) stack.push_back(group - asset.groupBegin);
            }
            while (!stack.empty()) {
                const std::uint32_t group = stack.back(); stack.pop_back();
                if (reached[group]) continue;
                reached[group] = 1u;
                for (std::uint32_t child : refineChildren[group]) stack.push_back(child);
            }
            if (std::find(reached.begin(), reached.end(), 0u) != reached.end()) throw std::runtime_error("bootstrap refine-DAG cut leaves an unreachable group hole");
        }
    }
}

}  // namespace oengine::asset
