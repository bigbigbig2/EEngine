#include "oengine_asset/OegPackWriter.h"
#include "oengine_asset/DecodedGeometryProduct.h"
#include "oengine_asset/OegPackCodec.h"

#include "oengine_asset/GeometryZstd.h"

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

struct EncodedPage {
    std::vector<std::uint8_t> encoded;
    GeometryPageDirectoryV4 directory{};
};

/** Descriptor validation also runs with page decoding disabled. Metadata
 * hashes prove integrity, not that a cut covers the declared Product. */
std::vector<std::uint32_t> ValidateQuerySection(
    const std::uint8_t* bytes, std::size_t size, const OegPackHeaderV4& header,
    const std::vector<GeometryAssetRecordV4>& assets,
    const std::vector<GeometryHierarchyNodeV4>& hierarchy,
    const std::vector<GeometryGroupDirectoryV4>& groups) {
    const auto word = [&](std::size_t at) {
        std::uint32_t value;
        DecodeRecordV4(bytes + at, &value);
        return value;
    };
    const auto require = [](bool valid, const char* reason) {
        if (!valid) {
            throw std::runtime_error(std::string("query section: ") + reason);
        }
    };
    require(size >= 160u && word(0u) == 0x3251474fu && word(4u) == 3u &&
        word(8u) == 160u && word(12u) == size, "invalid version/extent; recook source");
    require(std::equal(bytes + 16u, bytes + 48u, header.recipeHash), "recipe mismatch");
    require(std::all_of(bytes + 112u, bytes + 128u,
        [](std::uint8_t value) { return value == 0u; }), "reserved header bytes");
    const auto digest = Sha256(bytes + 160u, size - 160u);
    require(std::equal(digest.begin(), digest.end(), bytes + 128u), "content hash mismatch");
    std::array<std::uint32_t, 8> counts{}, offsets{};
    constexpr std::uint32_t strides[] = {32u, 80u, 4u, 4u, 4u, 4u, 4u, 4u};
    std::uint64_t cursor = 160u;
    for (std::size_t table = 0u; table < counts.size(); ++table) {
        counts[table] = word(table < 6u ? 48u + table * 4u : 96u + (table - 6u) * 4u);
        offsets[table] = word(table < 6u ? 72u + table * 4u : 104u + (table - 6u) * 4u);
        require(offsets[table] == cursor, "noncanonical table offset");
        cursor += std::uint64_t(counts[table]) * strides[table];
        require(cursor <= size, "table escapes section");
    }
    require(cursor == size && counts[0] == assets.size(), "unowned bytes/assets");
    std::vector<std::uint32_t> groupCounts(groups.size(), 0u);
    for (const auto& node : hierarchy) {
        if (IsGroupLeafV4(node.packedNodeData)) {
            const auto group = (node.packedNodeData >> 1u) & 0x00ffffffu;
            require(group < groups.size(), "hierarchy group is invalid");
            groupCounts[group] = (node.packedNodeData >> 25u) + 1u;
        }
    }
    std::uint64_t meshlets = 0u;
    for (auto count : groupCounts) {
        meshlets += count;
    }
    require(meshlets == counts[1], "cluster domain differs from Product meshlets");
    std::vector<std::uint32_t> lookup(groups.size() * 128u, kInvalidId);
    std::vector<std::uint8_t> hasParent(counts[1], 0u);
    std::vector<std::vector<std::uint32_t>> leaves(assets.size()), roots(assets.size());
    const auto clusterWord = [&](std::uint32_t cluster, std::uint32_t field) {
        return word(offsets[1] + std::size_t(cluster) * 80u + field);
    };
    for (std::uint32_t cluster = 0u; cluster < counts[1]; ++cluster) {
        const auto group = clusterWord(cluster, 4u);
        const auto local = clusterWord(cluster, 8u);
        const auto owner = clusterWord(cluster, 28u);
        require(owner < assets.size(), "cluster owner is invalid");
        const auto& asset = assets[owner];
        require(group >= asset.groupBegin && std::uint64_t(group) <
            std::uint64_t(asset.groupBegin) + asset.groupCount && group < groups.size(),
            "cluster escapes its asset");
        require(local < groupCounts[group] && clusterWord(cluster, 0u) == groups[group].pageId &&
            clusterWord(cluster, 12u) > 0u && clusterWord(cluster, 12u) <= 128u &&
            clusterWord(cluster, 20u) < header.vertexFormatCount, "cluster reference is invalid");
        auto& entry = lookup[std::size_t(group) * 128u + local];
        require(entry == kInvalidId, "duplicate meshlet reference");
        entry = cluster;
        const auto flags = clusterWord(cluster, 24u);
        const auto lod = clusterWord(cluster, 68u);
        require((flags == 5u || flags == 6u) && lod <= 254u,
            "cluster flags/revision are invalid");
        const auto primitiveBegin = clusterWord(cluster, 72u);
        const auto vertexBegin = clusterWord(cluster, 76u);
        const auto vertexEnd = cluster + 1u < counts[1] ? clusterWord(cluster + 1u, 76u) : counts[7];
        require(primitiveBegin == (cluster == 0u ? 0u :
            clusterWord(cluster - 1u, 72u) + clusterWord(cluster - 1u, 12u)) &&
            std::uint64_t(primitiveBegin) + clusterWord(cluster, 12u) <= counts[6] &&
            (cluster != 0u || vertexBegin == 0u) && vertexEnd > vertexBegin &&
            vertexEnd - vertexBegin <= 128u && vertexEnd <= counts[7], "invalid source remap range");
        for (std::uint32_t primitive = 0u; primitive < clusterWord(cluster, 12u); ++primitive) {
            require(word(offsets[6] + std::size_t(primitiveBegin + primitive) * 4u) != kInvalidId,
                "invalid source primitive identity");
        }
        if (flags == 5u) {
            for (std::uint32_t vertex = vertexBegin; vertex < vertexEnd; ++vertex) {
                require(word(offsets[7] + std::size_t(vertex) * 4u) != kInvalidId,
                    "exact leaf has no source vertex correspondence");
            }
        }
        float error;
        const auto errorBits = clusterWord(cluster, 56u);
        std::memcpy(&error, &errorBits, sizeof(error));
        const auto childBegin = clusterWord(cluster, 60u);
        const auto childCount = clusterWord(cluster, 64u);
        require(std::isfinite(error) && error >= 0.0f &&
            std::uint64_t(childBegin) + childCount <= counts[2], "invalid refinement range/error");
        require(flags == 5u ? childCount == 0u && error == 0.0f && lod == 0u :
            childCount > 0u && lod > 0u, "leaf/refinement classification is invalid");
        for (std::uint32_t axis = 0u; axis < 3u; ++axis) {
            const auto lowBits = clusterWord(cluster, 32u + axis * 4u);
            const auto highBits = clusterWord(cluster, 44u + axis * 4u);
            float low, high;
            std::memcpy(&low, &lowBits, sizeof(low));
            std::memcpy(&high, &highBits, sizeof(high));
            require(std::isfinite(low) && std::isfinite(high) && low <= high,
                "invalid cluster bounds");
        }
        if (flags == 5u) {
            leaves[owner].push_back(cluster);
        }
        std::set<std::uint32_t> children;
        std::uint32_t fineGroup = kInvalidId;
        for (std::uint32_t index = 0u; index < childCount; ++index) {
            const auto child = word(offsets[2] + std::size_t(childBegin + index) * 4u);
            require(child < counts[1], "child reference is invalid");
            require(clusterWord(child, 28u) == owner && clusterWord(child, 68u) < lod &&
                children.insert(child).second, "cycle/duplicate/foreign child");
            const auto childGroup = clusterWord(child, 4u);
            require(childGroup < groups.size(), "child group is invalid");
            if (fineGroup == kInvalidId) {
                fineGroup = childGroup;
            }
            require(childGroup == fineGroup, "mixed refinement groups");
            hasParent[child] = 1u;
        }
        require(childCount == 0u || childCount == groupCounts[fineGroup],
            "refinement omits child meshlets");
    }
    require(counts[1] > 0u && std::uint64_t(clusterWord(counts[1] - 1u, 72u)) +
        clusterWord(counts[1] - 1u, 12u) == counts[6], "unowned source primitive remaps");
    for (std::uint32_t cluster = 0u; cluster < counts[1]; ++cluster) {
        if (!hasParent[cluster]) {
            roots[clusterWord(cluster, 28u)].push_back(cluster);
        }
    }
    std::array<std::uint32_t, 3> tableCursors{};
    for (std::uint32_t asset = 0u; asset < assets.size(); ++asset) {
        std::set<std::uint32_t> pageSet;
        std::set<std::uint32_t> sourcePrimitives;
        for (auto cluster : leaves[asset]) {
            pageSet.insert(clusterWord(cluster, 0u));
            for (std::uint32_t primitive = 0u; primitive < clusterWord(cluster, 12u); ++primitive) {
                const auto identity = word(offsets[6] +
                    std::size_t(clusterWord(cluster, 72u) + primitive) * 4u);
                require(identity < assets[asset].sourceTriangleCount && sourcePrimitives.insert(identity).second,
                    "exact cut duplicates or escapes source primitive identities");
            }
        }
        require(sourcePrimitives.size() == assets[asset].sourceTriangleCount,
            "exact cut omits source primitive identities");
        const std::vector<std::uint32_t> pages(pageSet.begin(), pageSet.end());
        const std::vector<std::uint32_t>* expected[] = {&roots[asset], &leaves[asset], &pages};
        for (std::size_t table = 0u; table < tableCursors.size(); ++table) {
            const auto at = offsets[0] + std::size_t(asset) * 32u + table * 8u;
            const auto begin = word(at);
            const auto count = word(at + 4u);
            require(begin == tableCursors[table] && count > 0u &&
                std::uint64_t(begin) + count <= counts[3u + table] &&
                count == expected[table]->size(), "incomplete roots/cut/pages");
            for (std::uint32_t index = 0u; index < count; ++index) {
                require(word(offsets[3u + table] + std::size_t(begin + index) * 4u) ==
                    (*expected[table])[index], "roots/cut/pages disagree with cluster forest");
            }
            tableCursors[table] = begin + count;
        }
        require(word(offsets[0] + std::size_t(asset) * 32u + 24u) == 0u &&
            word(offsets[0] + std::size_t(asset) * 32u + 28u) == 0u,
            "static Product has nonzero topology/deformation revision");
    }
    for (std::size_t table = 0u; table < tableCursors.size(); ++table) {
        require(tableCursors[table] == counts[3u + table], "unowned cut records");
    }
    return lookup;
}

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
    EncodeRecordV4(bytes.data() + offset, value);
}

template <typename T>
void WriteRecords(std::vector<std::uint8_t>& bytes, std::uint64_t offset, const std::vector<T>& values) {
    if (!values.empty()) {
        const std::uint64_t size = values.size() * sizeof(T);
        if (offset + size > bytes.size()) throw std::runtime_error("record table exceeds pack allocation");
        for (std::size_t index = 0u; index < values.size(); ++index) EncodeRecordV4(bytes.data() + offset + index * sizeof(T), values[index]);
    }
}

template <typename T>
std::vector<T> ReadRecords(const std::vector<std::uint8_t>& bytes, std::uint64_t offset, std::uint32_t count) {
    const std::uint64_t size = std::uint64_t(count) * sizeof(T);
    if (offset > bytes.size() || size > bytes.size() - offset) throw std::runtime_error("record table is outside file bounds");
    std::vector<T> output(count);
    for (std::uint32_t index = 0u; index < count; ++index) DecodeRecordV4(bytes.data() + offset + std::uint64_t(index) * sizeof(T), &output[index]);
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



std::uint64_t AssetDecodedBytes(const CookedAssetV4& asset) {
    std::uint64_t bytes = 0u;
    for (const SerializedGroupV4& group : asset.groups) bytes += group.bytes.size();
    return bytes;
}

void CompressPage(
    const DecodedGeometryPageV1& decoded, EncodedPage& page,
    const GeometryCookRecipeV4&) {
    page.encoded = EncodeGeometryZstd(decoded.bytes);
    page.directory.codec = page.encoded.size() < decoded.bytes.size() ? kPageCodecZstdFrame : kPageCodecRaw256K;
    page.directory.compressedBytes = std::uint32_t(page.encoded.size());
    page.directory.decodedBytes = kGeometryPageBytesV4;
    page.directory.firstGroup = decoded.firstGroup;
    page.directory.groupCount = decoded.groupCount;
    std::copy(
        decoded.decodedHash128.begin(), decoded.decodedHash128.end(),
        page.directory.decodedContentHash128);
    page.directory.compressedChecksum = Crc32(page.encoded.data(), page.encoded.size());
    page.directory.flags = decoded.bootstrap ? kGroupBootstrap : 0u;
}

WrittenPackV4 WritePack(
    const std::string& outputDirectory, std::vector<CookedAssetV4> assets,
    const std::vector<std::uint32_t>& sourceIndices, const GeometryCookRecipeV4& recipe,
    std::uint32_t workerCount, CookEvidenceV4& evidence, std::vector<double>& pageFills) {
    DecodedGeometryProductV1 product = AssembleDecodedGeometryProductV1(std::move(assets));
    std::vector<EncodedPage> encodedPages(product.pages.size());
    const std::size_t concurrency = std::max<std::size_t>(1u, workerCount);
    for (std::size_t begin = 0u; begin < product.pages.size(); begin += concurrency) {
        std::vector<std::future<void>> compression;
        const std::size_t end = std::min(product.pages.size(), begin + concurrency);
        compression.reserve(end - begin);
        for (std::size_t pageIndex = begin; pageIndex < end; ++pageIndex) {
            compression.push_back(std::async(std::launch::async, [&, pageIndex]() {
                CompressPage(product.pages[pageIndex], encodedPages[pageIndex], recipe);
            }));
        }
        for (auto& task : compression) task.get();
    }

    OegPackHeaderV4 header{};
    std::copy(kOegPackMagicV4.begin(), kOegPackMagicV4.end(), header.magic);
    header.formatMajor = kOegPackFormatMajorV4; header.formatMinor = kOegPackFormatMinorV4;
    header.endianMarker = kOegPackEndianMarker; header.headerBytes = kOegPackHeaderBytesV4;
    header.pageShift = kGeometryPageShiftV4; header.pageBytes = kGeometryPageBytesV4;
    header.defaultCodec = kPageCodecZstdFrame;
    header.assetCount = std::uint32_t(product.assets.size()); header.rootNodeIndexCount = std::uint32_t(product.roots.size());
    header.hierarchyNodeCount = std::uint32_t(product.hierarchy.size()); header.groupCount = std::uint32_t(product.groups.size());
    header.pageCount = std::uint32_t(product.pages.size()); header.vertexFormatCount = std::uint32_t(product.formats.size());
    header.bootstrapPageCount = std::uint32_t(product.bootstrapPages.size());
    std::uint64_t cursor = sizeof(header);
    header.assetDirectoryOffset = cursor; cursor = AlignUp64(cursor + product.assets.size() * sizeof(GeometryAssetRecordV4), 16u);
    header.rootNodeIndexOffset = cursor; cursor = AlignUp64(cursor + product.roots.size() * sizeof(std::uint32_t), 16u);
    header.hierarchyOffset = cursor; cursor = AlignUp64(cursor + product.hierarchy.size() * sizeof(GeometryHierarchyNodeV4), 16u);
    header.groupDirectoryOffset = cursor; cursor = AlignUp64(cursor + product.groups.size() * sizeof(GeometryGroupDirectoryV4), 16u);
    header.pageDirectoryOffset = cursor; cursor = AlignUp64(cursor + encodedPages.size() * sizeof(GeometryPageDirectoryV4), 16u);
    header.bootstrapPageOffset = cursor; cursor = AlignUp64(cursor + product.bootstrapPages.size() * sizeof(std::uint32_t), 16u);
    header.vertexFormatOffset = cursor; cursor = AlignUp64(cursor + product.formats.size() * sizeof(VertexFormatRecordV4), 16u);
    header.querySectionOffset = cursor; header.querySectionBytes = product.querySection.size();
    cursor = AlignUp64(cursor + header.querySectionBytes, 256u);
    header.pageBlobOffset = cursor;
    for (EncodedPage& page : encodedPages) {
        page.directory.compressedFileOffset = cursor;
        cursor += page.encoded.size();
    }
    header.fileBytes = cursor;
    const Hash256 recipeHash = Sha256(CanonicalRecipeJson(recipe));
    std::copy(recipeHash.begin(), recipeHash.end(), header.recipeHash);
    std::vector<GeometryPageDirectoryV4> pageDirectories;
    for (const EncodedPage& page : encodedPages) pageDirectories.push_back(page.directory);
    std::vector<std::uint8_t> bytes(std::size_t(header.fileBytes), 0u);
    WriteRecord(bytes, 0u, header);
    WriteRecords(bytes, header.assetDirectoryOffset, product.assets);
    WriteRecords(bytes, header.rootNodeIndexOffset, product.roots);
    WriteRecords(bytes, header.hierarchyOffset, product.hierarchy);
    WriteRecords(bytes, header.groupDirectoryOffset, product.groups);
    WriteRecords(bytes, header.pageDirectoryOffset, pageDirectories);
    WriteRecords(bytes, header.bootstrapPageOffset, product.bootstrapPages);
    WriteRecords(bytes, header.vertexFormatOffset, product.formats);
    std::copy(product.querySection.begin(), product.querySection.end(), bytes.begin() + header.querySectionOffset);
    for (const EncodedPage& page : encodedPages) std::copy(page.encoded.begin(), page.encoded.end(), bytes.begin() + page.directory.compressedFileOffset);
    const Hash256 packHash = Sha256(bytes.data(), std::size_t(header.pageBlobOffset));
    std::copy(packHash.begin(), packHash.end(), header.packContentHash);
    WriteRecord(bytes, 0u, header);
    const std::string id = Hex(packHash);
    const std::string path = JoinPath(outputDirectory, "geometry-" + id.substr(0u, 20u) + ".oegpack");
    WriteFile(path, bytes);
    ValidateOegPackV4File(path, true);

    evidence.pageCount += product.pages.size(); evidence.decodedPageBytes += product.pages.size() * std::uint64_t(kGeometryPageBytesV4);
    for (std::size_t pageIndex = 0u; pageIndex < product.pages.size(); ++pageIndex) {
        const DecodedGeometryPageV1& page = product.pages[pageIndex];
        evidence.compressedPageBytes += encodedPages[pageIndex].encoded.size(); evidence.wastedPaddingBytes += kGeometryPageBytesV4 - page.usedBytes;
        if (page.bootstrap) { ++evidence.bootstrapPageCount; evidence.bootstrapGeometryBytes += page.usedBytes; }
        pageFills.push_back(double(page.usedBytes) / double(kGeometryPageBytesV4));
    }
    WrittenPackV4 written; written.path = path; written.packId = packHash; written.sourceAssetIndices = sourceIndices;
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
    const std::string& path, const ImportedSceneV4& imported,
    const std::vector<CookedAssetV4>& cooked, const std::vector<WrittenPackV4>& packs) {
    struct Location { std::uint32_t pack = 0u; std::uint32_t record = 0u; };
    std::vector<Location> locations(cooked.size());
    for (std::uint32_t packIndex = 0; packIndex < packs.size(); ++packIndex) for (std::uint32_t record = 0; record < packs[packIndex].sourceAssetIndices.size(); ++record) locations[packs[packIndex].sourceAssetIndices[record]] = {packIndex, record};
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("cannot create scene manifest");
    output << std::setprecision(9) << "{\n  \"schema\": \"oengine-scene-v4\",\n  \"instanceSemantics\": \"cast-receive-explicit-v1\",\n  \"packs\": [\n";
    for (std::size_t i = 0; i < packs.size(); ++i) {
        output << "    {\"packId\":\"" << Hex(packs[i].packId) << "\",\"uri\":\"" << JsonEscape(FileName(packs[i].path)) << "\"}" << (i + 1u == packs.size() ? "\n" : ",\n");
    }
    output << "  ],\n  \"assets\": [\n";
    for (std::size_t i = 0; i < cooked.size(); ++i) {
        output << "    {\"assetId\":\"" << Hex(cooked[i].assetId) << "\",\"pack\":" << locations[i].pack << ",\"assetRecordIndex\":" << locations[i].record << "}" << (i + 1u == cooked.size() ? "\n" : ",\n");
    }
    output << "  ],\n  \"instances\": [\n";
    for (std::size_t i = 0; i < imported.instances.size(); ++i) {
        const SceneInstanceV4& instance = imported.instances[i];
        output << "    {\"asset\":" << instance.assetIndex << ",\"materialBindingTable\":0,\"flags\":" << instance.flags << ",\"transform\":[";
        for (std::size_t m = 0; m < 16u; ++m) output << (m ? "," : "") << instance.worldTransform[m];
        output << "]}" << (i + 1u == imported.instances.size() ? "\n" : ",\n");
    }
    output << "  ]\n}\n";
    if (!output) throw std::runtime_error("cannot write scene manifest");
}

}  // namespace

WriteSceneResultV4 CookAndWriteSceneV4(
    const std::string& inputPath, const std::string& outputDirectory,
    const GeometryCookRecipeV4& recipe, std::uint64_t targetShardBytes,
    std::uint32_t workerCount) {
    RequireLittleEndian(); ValidateRecipe(recipe);
    const auto started = std::chrono::steady_clock::now();
    CreateDirectories(outputDirectory);
    std::cerr << "phase=import\n";
    ImportedSceneV4 imported = ImportGltfCanonical(inputPath);
    std::cerr << "phase=hierarchy assets=" << imported.assets.size() << "\n";
    const std::uint64_t sourceBytes = FileSize(inputPath);
    std::vector<CookedAssetV4> cooked(imported.assets.size());
    std::vector<CookEvidenceV4> assetEvidence(imported.assets.size());
    const std::uint32_t concurrency = std::max(1u, workerCount);
    for (std::size_t begin = 0; begin < imported.assets.size(); begin += concurrency) {
        std::vector<std::future<void>> tasks;
        for (std::size_t index = begin; index < std::min(imported.assets.size(), begin + concurrency); ++index) {
            tasks.push_back(std::async(std::launch::async, [&, index]() { cooked[index] = CookGeometryAssetV4(imported.assets[index], recipe, assetEvidence[index]); }));
        }
        for (auto& task : tasks) task.get();
    }
    WriteSceneResultV4 result;
    result.evidence.sourceBytes = sourceBytes;
    for (const CookEvidenceV4& item : assetEvidence) AddEvidence(result.evidence, item);
    for (const CanonicalGeometryAsset& asset : imported.assets) for (const MaterialDomain& domain : asset.domains) result.evidence.uniqueGeometryBytes += domain.vertices.size() * sizeof(CanonicalVertex) + domain.indices.size() * sizeof(std::uint32_t);
    std::uint64_t bootstrapPayloadBytes = 0u;
    for (const CookedAssetV4& asset : cooked) for (const SerializedGroupV4& group : asset.groups) if (group.flags & kGroupBootstrap) bootstrapPayloadBytes += group.bytes.size();
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
        std::cerr << "phase=pack assets=" << shard.size() << "\n";
        std::vector<CookedAssetV4> assets;
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

void ValidateOegPackV4File(const std::string& path, bool verifyPages) {
    RequireLittleEndian();
    std::vector<std::uint8_t> bytes = ReadFile(path);
    if (bytes.size() < sizeof(OegPackHeaderV4)) throw std::runtime_error("pack is shorter than V3 header");
    OegPackHeaderV4 header{}; DecodeRecordV4(bytes.data(), &header);
    if (!std::equal(kOegPackMagicV4.begin(), kOegPackMagicV4.end(), header.magic)) throw std::runtime_error("invalid OEGPACK magic");
    if (header.formatMajor != 4u || header.formatMinor != 0u) throw std::runtime_error("OEGPACK query geometry requires V4.0; recook source");
    if (header.endianMarker != kOegPackEndianMarker || header.headerBytes != 256u) throw std::runtime_error("invalid endian/header contract");
    if (header.pageShift != 18u || header.pageBytes != kGeometryPageBytesV4) throw std::runtime_error("invalid V3 page size contract");
    if (header.flags != 0u || header.defaultCodec != kPageCodecZstdFrame || header.reserved0 != 0u || std::any_of(std::begin(header.reserved), std::end(header.reserved), [](std::uint8_t value) { return value != 0u; })) throw std::runtime_error("header flags/default codec/reserved bytes are invalid");
    if (header.fileBytes != bytes.size() || header.pageBlobOffset > bytes.size()) throw std::runtime_error("pack file size is inconsistent");
    if (header.pageBlobOffset % 256u != 0u) throw std::runtime_error("page blob is not 256-byte aligned");
    std::uint64_t previousTableEnd = sizeof(OegPackHeaderV4);
    const auto validateTable = [&](std::uint64_t start, std::uint32_t count, std::uint64_t stride, std::uint64_t alignment, const char* name) {
        const std::uint64_t size = std::uint64_t(count) * stride;
        if (start % alignment != 0u || start < previousTableEnd || start > header.pageBlobOffset || size > header.pageBlobOffset - start) {
            throw std::runtime_error(std::string(name) + " table range/alignment is invalid");
        }
        previousTableEnd = start + size;
    };
    validateTable(header.assetDirectoryOffset, header.assetCount, sizeof(GeometryAssetRecordV4), 16u, "asset");
    validateTable(header.rootNodeIndexOffset, header.rootNodeIndexCount, sizeof(std::uint32_t), 16u, "root node");
    validateTable(header.hierarchyOffset, header.hierarchyNodeCount, sizeof(GeometryHierarchyNodeV4), 16u, "hierarchy");
    validateTable(header.groupDirectoryOffset, header.groupCount, sizeof(GeometryGroupDirectoryV4), 16u, "group");
    validateTable(header.pageDirectoryOffset, header.pageCount, sizeof(GeometryPageDirectoryV4), 16u, "page");
    validateTable(header.bootstrapPageOffset, header.bootstrapPageCount, sizeof(std::uint32_t), 16u, "bootstrap");
    validateTable(header.vertexFormatOffset, header.vertexFormatCount, sizeof(VertexFormatRecordV4), 16u, "vertex format");
    if (header.querySectionBytes < 128u || header.querySectionBytes >= kInvalidId)
        throw std::runtime_error("query section size is invalid");
    validateTable(header.querySectionOffset, std::uint32_t(header.querySectionBytes), 1u, 16u, "query section");
    std::vector<std::uint8_t> metadata(bytes.begin(), bytes.begin() + header.pageBlobOffset);
    const Hash256 expectedPackHash = [&]() { Hash256 h{}; std::copy(header.packContentHash, header.packContentHash + 32u, h.begin()); return h; }();
    std::fill(metadata.begin() + 176u, metadata.begin() + 208u, 0u);
    if (Sha256(metadata) != expectedPackHash) throw std::runtime_error("pack content hash mismatch");

    const auto assets = ReadRecords<GeometryAssetRecordV4>(bytes, header.assetDirectoryOffset, header.assetCount);
    const auto roots = ReadRecords<std::uint32_t>(bytes, header.rootNodeIndexOffset, header.rootNodeIndexCount);
    const auto hierarchy = ReadRecords<GeometryHierarchyNodeV4>(bytes, header.hierarchyOffset, header.hierarchyNodeCount);
    const auto groups = ReadRecords<GeometryGroupDirectoryV4>(bytes, header.groupDirectoryOffset, header.groupCount);
    const auto pages = ReadRecords<GeometryPageDirectoryV4>(bytes, header.pageDirectoryOffset, header.pageCount);
    const auto formats = ReadRecords<VertexFormatRecordV4>(bytes, header.vertexFormatOffset, header.vertexFormatCount);
    const auto bootstrap = ReadRecords<std::uint32_t>(bytes, header.bootstrapPageOffset, header.bootstrapPageCount);
    if (assets.empty() || roots.empty() || hierarchy.empty() || groups.empty() || pages.empty() || formats.empty() || bootstrap.empty()) throw std::runtime_error("required resident metadata table is empty");
    for (const GeometryAssetRecordV4& asset : assets) {
        if (asset.rootNodeBegin + asset.rootNodeCount > roots.size() || asset.hierarchyBegin + asset.hierarchyCount > hierarchy.size() || asset.groupBegin + asset.groupCount > groups.size() || asset.bootstrapPageBegin + asset.bootstrapPageCount > bootstrap.size()) throw std::runtime_error("asset metadata range is invalid");
        if (asset.rootNodeCount == 0u || asset.bootstrapPageCount == 0u) throw std::runtime_error("asset has no root/bootstrap cut");
        if (asset.flags != 0u || asset.reserved[0] != 0u || asset.reserved[1] != 0u) throw std::runtime_error("asset flags/reserved fields are invalid");
    }
    for (const VertexFormatRecordV4& format : formats) {
        if (!IsGeometryVertexFormatV4(format)) throw std::runtime_error("noncanonical SoA vertex format");
    }
    for (std::uint32_t root : roots) if (root >= hierarchy.size()) throw std::runtime_error("root node index is invalid");
    for (const GeometryHierarchyNodeV4& node : hierarchy) {
        for (float value : node.boundsSphere) if (!std::isfinite(value)) throw std::runtime_error("hierarchy sphere is non-finite");
        for (float value : node.bboxMin) if (!std::isfinite(value)) throw std::runtime_error("hierarchy bboxMin is non-finite");
        for (float value : node.bboxMax) if (!std::isfinite(value)) throw std::runtime_error("hierarchy bboxMax is non-finite");
        if (!std::isfinite(node.maxParentError)) throw std::runtime_error("hierarchy error is non-finite");
        if (IsGroupLeafV4(node.packedNodeData)) {
            const std::uint32_t start = (node.packedNodeData >> 1u) & 0x00ffffffu;
            if (start >= groups.size()) throw std::runtime_error("hierarchy leaf group is invalid");
        } else {
            const std::uint32_t start = (node.packedNodeData >> 1u) & 0x07ffffffu;
            const std::uint32_t count = (node.packedNodeData >> 28u) & 0x0fu;
            if (count == 0u || count > 8u || start + count > hierarchy.size()) throw std::runtime_error("hierarchy child range is invalid");
        }
    }
    for (const GeometryAssetRecordV4& asset : assets) {
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
            const GeometryHierarchyNodeV4& node = hierarchy[nodeId];
            if (IsGroupLeafV4(node.packedNodeData)) {
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
    const auto queryLookup = ValidateQuerySection(bytes.data() + header.querySectionOffset,
        std::size_t(header.querySectionBytes), header, assets, hierarchy, groups);
    const auto queryWord = [&](std::size_t at) {
        std::uint32_t value;
        DecodeRecordV4(bytes.data() + header.querySectionOffset + at, &value);
        return value;
    };
    std::uint64_t previousEnd = header.pageBlobOffset;
    std::set<std::uint32_t> bootstrapSet(bootstrap.begin(), bootstrap.end());
    for (std::uint32_t id : bootstrap) if (id >= pages.size()) throw std::runtime_error("bootstrap page id is invalid");
    std::vector<GroupHeaderV4> decodedGroups(groups.size());
    std::vector<std::uint8_t> decodedGroupPresent(groups.size(), 0u);
    struct RefineEdge { std::uint32_t coarseGroup; std::uint32_t fineGroup; };
    std::vector<RefineEdge> refineEdges;
    std::vector<std::pair<std::size_t, std::uint32_t>> queryRefinements;
    for (std::uint32_t pageId = 0u; pageId < pages.size(); ++pageId) {
        const GeometryPageDirectoryV4& page = pages[pageId];
        if ((page.flags & ~kGroupBootstrap) != 0u || page.reserved0 != 0u || page.reserved1 != 0u) throw std::runtime_error("page flags/reserved fields are invalid");
        if (page.decodedBytes != kGeometryPageBytesV4 || (page.compressedBytes == 0u || page.compressedBytes > kGeometryPageBytesV4)) throw std::runtime_error("page size is invalid");
        if (page.compressedFileOffset < previousEnd || page.compressedFileOffset + page.compressedBytes > bytes.size()) throw std::runtime_error("compressed page ranges overlap or exceed file");
        previousEnd = page.compressedFileOffset + page.compressedBytes;
        if (page.firstGroup >= groups.size() || page.groupCount == 0u) throw std::runtime_error("page group summary is invalid");
        if (!verifyPages) continue;
        const std::uint8_t* encoded = bytes.data() + page.compressedFileOffset;
        if (Crc32(encoded, page.compressedBytes) != page.compressedChecksum) throw std::runtime_error("compressed page checksum mismatch");
        std::vector<std::uint8_t> decoded(kGeometryPageBytesV4);
        if (page.codec == kPageCodecRaw256K) {
            if (page.compressedBytes != kGeometryPageBytesV4) throw std::runtime_error("raw page is not exactly 256 KiB");
            std::memcpy(decoded.data(), encoded, decoded.size());
        } else if (page.codec == kPageCodecZstdFrame) {
            if (!IsGeometryZstdFrame(encoded, page.compressedBytes, decoded.size()))
                throw std::runtime_error("Invalid bounded geometry Zstd frame");
            const auto result = ZSTD_decompress(decoded.data(), decoded.size(), encoded, page.compressedBytes);
            if (ZSTD_isError(result) || result != decoded.size()) throw std::runtime_error("Geometry Zstd decode failed");
        } else throw std::runtime_error("unsupported page codec");
        // Page identity is rolled up from the page's Group payloads and checked
        // once those payloads are located below; there is deliberately no
        // whole-page digest assertion here.
        std::uint32_t groupsOnPage = 0u;
        std::uint32_t minimumGroup = kInvalidId;
        bool pageContainsBootstrap = false;
        std::vector<std::uint32_t> identityGroupIds;
        std::vector<std::uint32_t> identityPayloadBytes;
        std::vector<Hash256> identityPayloadDigests;
        for (std::uint32_t groupId = 0u; groupId < groups.size(); ++groupId) {
            const GeometryGroupDirectoryV4& directory = groups[groupId];
            if (directory.pageId != pageId) continue;
            ++groupsOnPage;
            constexpr std::uint32_t kKnownGroupFlags = kGroupBootstrap | kGroupOpaque | kGroupMask | kGroupBlend | kGroupTwoSided | kGroupSimplificationFallback;
            if ((directory.flags & ~kKnownGroupFlags) != 0u) throw std::runtime_error("group flags are invalid");
            minimumGroup = std::min(minimumGroup, groupId);
            pageContainsBootstrap = pageContainsBootstrap || (directory.flags & kGroupBootstrap) != 0u;
            if (directory.pageId != pageId || directory.offsetInDecodedPage % 16u != 0u || directory.offsetInDecodedPage + directory.payloadBytes > decoded.size()) throw std::runtime_error("group page mapping is invalid");
            if (directory.payloadBytes < sizeof(GroupHeaderV4)) throw std::runtime_error("group payload is too small");
            identityGroupIds.push_back(groupId);
            identityPayloadBytes.push_back(directory.payloadBytes);
            identityPayloadDigests.push_back(Sha256(
                decoded.data() + directory.offsetInDecodedPage, directory.payloadBytes));
            GroupHeaderV4 group{}; DecodeRecordV4(decoded.data() + directory.offsetInDecodedPage, &group);
            if (group.payloadBytes != directory.payloadBytes || group.meshletCount == 0u || group.meshletCount > 128u || group.vertexFormatId >= formats.size()) throw std::runtime_error("group header is invalid");
            for (float value : group.boundsSphere) if (!std::isfinite(value)) throw std::runtime_error("group sphere is non-finite");
            for (float value : group.bboxMin) if (!std::isfinite(value)) throw std::runtime_error("group bboxMin is non-finite");
            for (float value : group.bboxMax) if (!std::isfinite(value)) throw std::runtime_error("group bboxMax is non-finite");
            if (!std::isfinite(group.parentError)) throw std::runtime_error("group parent error is non-finite");
            if (group.meshletHeaderOffset != 64u || group.meshletHeaderOffset + group.meshletCount * sizeof(MeshletHeaderV4) > group.triangleDataOffset || group.triangleDataOffset > group.vertexDataOffset || group.vertexDataOffset > group.payloadBytes) throw std::runtime_error("group section offsets are invalid");
            decodedGroups[groupId] = group; decodedGroupPresent[groupId] = 1u;
            for (std::uint32_t meshletIndex = 0u; meshletIndex < group.meshletCount; ++meshletIndex) {
                MeshletHeaderV4 meshlet{};
                DecodeRecordV4(decoded.data() + directory.offsetInDecodedPage + group.meshletHeaderOffset + meshletIndex * sizeof(meshlet), &meshlet);
                if (meshlet.vertexCount == 0u || meshlet.vertexCount > 128u || meshlet.triangleCount == 0u || meshlet.triangleCount > 128u) throw std::runtime_error("meshlet count exceeds V3 limits");
                constexpr std::uint32_t kKnownMeshletFlags = kMeshletOpaque | kMeshletMask | kMeshletBlend | kMeshletTwoSided | kMeshletCastsShadow;
                if ((meshlet.flags & ~kKnownMeshletFlags) != 0u) throw std::runtime_error("meshlet flags are invalid");
                const auto queryCluster = queryLookup[std::size_t(groupId) * 128u + meshletIndex];
                if (queryCluster == kInvalidId) throw std::runtime_error("query section omits a meshlet payload");
                const auto queryAt = queryWord(76u) + std::size_t(queryCluster) * 80u;
                if (queryWord(queryAt + 12u) != meshlet.triangleCount ||
                    queryWord(queryAt + 16u) != meshlet.materialId ||
                    queryWord(queryAt + 20u) != group.vertexFormatId ||
                    queryWord(queryAt + 68u) != group.lodLevel) {
                    throw std::runtime_error("query section disagrees with shared meshlet payload");
                }
                const auto vertexBegin = queryWord(queryAt + 76u);
                const auto remapVertexEnd = queryCluster + 1u < queryWord(52u) ?
                    queryWord(queryAt + 80u + 76u) : queryWord(100u);
                if (remapVertexEnd - vertexBegin != meshlet.vertexCount) {
                    throw std::runtime_error("query source vertex remap disagrees with shared meshlet payload");
                }
                queryRefinements.emplace_back(queryAt, meshlet.refineGroupId);
                if (meshlet.refineGroupId != kInvalidId) {
                    if (meshlet.refineGroupId >= groups.size()) throw std::runtime_error("meshlet refineGroupId is invalid");
                    refineEdges.push_back({groupId, meshlet.refineGroupId});
                }
                const std::uint64_t triangleEnd = std::uint64_t(meshlet.triangleByteOffset) + meshlet.triangleCount * 3u;
                const std::uint64_t vertexEnd = std::uint64_t(meshlet.vertexByteOffset) + GeometryVertexPayloadBytes(meshlet.vertexCount, formats[group.vertexFormatId]);
                if (meshlet.triangleByteOffset < group.triangleDataOffset || triangleEnd > group.vertexDataOffset || meshlet.vertexByteOffset < group.vertexDataOffset || vertexEnd > group.payloadBytes) throw std::runtime_error("meshlet data offset is invalid");
                const std::uint8_t* triangles = decoded.data() + directory.offsetInDecodedPage + meshlet.triangleByteOffset;
                for (std::uint32_t i = 0; i < meshlet.triangleCount * 3u; ++i) if (triangles[i] >= meshlet.vertexCount) throw std::runtime_error("meshlet local triangle index is invalid");
                for (std::uint32_t vertex = 0u; vertex < meshlet.vertexCount; ++vertex) {
                    const auto at = directory.offsetInDecodedPage + meshlet.vertexByteOffset +
                        std::size_t(vertex) * 4u;
                    for (std::uint32_t axis = 0u; axis < 3u; ++axis) {
                        float position, queryLow, queryHigh;
                        const auto lowBits = queryWord(queryAt + 32u + axis * 4u);
                        const auto highBits = queryWord(queryAt + 44u + axis * 4u);
                        std::memcpy(&position, decoded.data() + at + axis * meshlet.vertexCount * 4u, sizeof(position));
                        std::memcpy(&queryLow, &lowBits, sizeof(queryLow));
                        std::memcpy(&queryHigh, &highBits, sizeof(queryHigh));
                        if (!std::isfinite(position) || position < meshlet.bboxMin[axis] ||
                            position > meshlet.bboxMax[axis] || position < group.bboxMin[axis] ||
                            position > group.bboxMax[axis] || position < queryLow || position > queryHigh) {
                            throw std::runtime_error("query/shared bounds do not contain decoded vertex");
                        }
                    }
                }
            }
        }
        if (groupsOnPage != page.groupCount || minimumGroup != page.firstGroup) throw std::runtime_error("page group summary is inconsistent");
        if (((page.flags & kGroupBootstrap) != 0u) != pageContainsBootstrap) throw std::runtime_error("page bootstrap summary is inconsistent");
        // Page identity is recomputed from the page's Group payloads and must
        // match the value recorded in the pack directory.
        const std::array<std::uint8_t, 16> pageIdentity = ComputeGeometryPageIdentityV1(
            identityGroupIds, identityPayloadBytes, identityPayloadDigests);
        if (!std::equal(pageIdentity.begin(), pageIdentity.end(), page.decodedContentHash128)) {
            throw std::runtime_error("decoded page identity mismatch");
        }
    }
    if (previousEnd != bytes.size()) throw std::runtime_error("pack has trailing or unindexed page bytes");
    if (verifyPages) {
        if (std::find(decodedGroupPresent.begin(), decodedGroupPresent.end(), 0u) != decodedGroupPresent.end()) throw std::runtime_error("a group payload was not decoded from any page");
        for (const RefineEdge& edge : refineEdges) {
            const GroupHeaderV4& coarse = decodedGroups[edge.coarseGroup];
            const GroupHeaderV4& fine = decodedGroups[edge.fineGroup];
            if (coarse.lodLevel <= fine.lodLevel) throw std::runtime_error("refinement LOD is not strictly finer");
            if (coarse.parentError + 1.0e-5f < fine.parentError) throw std::runtime_error("refinement parent error is not monotonic");
        }
        for (const auto& refinement : queryRefinements) {
            const auto queryAt = refinement.first;
            const auto childCount = queryWord(queryAt + 64u);
            if (refinement.second == kInvalidId) {
                if (childCount != 0u) throw std::runtime_error("query section invents refinement");
            } else {
                if (childCount == 0u) throw std::runtime_error("query section omits refinement");
                const auto firstChild = queryWord(queryWord(80u) +
                    std::size_t(queryWord(queryAt + 60u)) * 4u);
                const auto fineGroup = queryWord(queryWord(76u) + std::size_t(firstChild) * 80u + 4u);
                if (fineGroup != refinement.second) {
                    throw std::runtime_error("query section disagrees with shared refinement");
                }
            }
        }
    }
    for (const GeometryAssetRecordV4& asset : assets) {
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
