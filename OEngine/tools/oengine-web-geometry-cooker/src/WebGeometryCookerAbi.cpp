#include "oengine_web_geometry_cooker/WebGeometryCookerAbi.h"

#include "oengine_asset/CanonicalGeometry.h"
#include "oengine_asset/DecodedGeometryProduct.h"
#include "oengine_asset/GeometryCookRecipe.h"
#include "oengine_asset/OegPackCodec.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <future>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace oengine::asset;

constexpr std::uint32_t kAbiVersion = 1u;
/** Upper bound on per-cook worker threads; the pthread pool is sized the same. */
[[maybe_unused]] constexpr std::uint32_t kMaxCookThreads = 8u;
constexpr std::uint32_t kCanonicalHeaderBytes = 128u;
constexpr std::uint32_t kCanonicalDomainBytes = 32u;
constexpr std::uint32_t kCanonicalVertexBytes = 72u;
constexpr std::uint32_t kRecipeBytes = 96u;
constexpr std::array<std::uint8_t, 8> kCanonicalMagic = {'O','E','W','G','C','A','N',0};
constexpr std::array<std::uint8_t, 8> kRecipeMagic = {'O','E','W','G','R','C','P',0};
constexpr std::uint16_t kDomainGenerateNormals = 1u << 0u;

thread_local std::string gLastError;

struct CookResult {
    DecodedGeometryProductV1 product;
    CookEvidenceV3 evidence;
    Hash256 recipeHash{};
    Hash256 contentManifestHash{};
    std::vector<std::uint8_t> assetRecords;
    std::vector<std::uint8_t> rootNodeIds;
    std::vector<std::uint8_t> hierarchyNodes;
    std::vector<std::uint8_t> groupDirectory;
    std::vector<std::uint8_t> pageRecords;
    std::vector<std::uint8_t> bootstrapPageIds;
    std::vector<std::uint8_t> vertexFormats;
};

void AddU32(Sha256Builder& hash, std::uint32_t value) {
    const std::uint8_t bytes[4] = {
        std::uint8_t(value), std::uint8_t(value >> 8u),
        std::uint8_t(value >> 16u), std::uint8_t(value >> 24u)};
    hash.Add(bytes, sizeof(bytes));
}

void AddU64(Sha256Builder& hash, std::uint64_t value) {
    const std::uint8_t bytes[8] = {
        std::uint8_t(value), std::uint8_t(value >> 8u),
        std::uint8_t(value >> 16u), std::uint8_t(value >> 24u),
        std::uint8_t(value >> 32u), std::uint8_t(value >> 40u),
        std::uint8_t(value >> 48u), std::uint8_t(value >> 56u)};
    hash.Add(bytes, sizeof(bytes));
}

void AddManifestPart(
    Sha256Builder& manifest, std::uint32_t tag,
    const std::vector<std::uint8_t>& bytes) {
    const Hash256 digest = Sha256(bytes);
    AddU32(manifest, tag);
    AddU64(manifest, bytes.size());
    manifest.Add(digest.data(), digest.size());
}

std::uint16_t ReadU16(const std::uint8_t* bytes, std::size_t at) {
    return std::uint16_t(bytes[at]) | (std::uint16_t(bytes[at + 1u]) << 8u);
}

std::uint32_t ReadU32(const std::uint8_t* bytes, std::size_t at) {
    std::uint32_t value = 0u;
    for (std::uint32_t i = 0u; i < 4u; ++i) {
        value |= std::uint32_t(bytes[at + i]) << (i * 8u);
    }
    return value;
}

float ReadF32(const std::uint8_t* bytes, std::size_t at) {
    const std::uint32_t bits = ReadU32(bytes, at);
    float value = 0.0f;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
}

void WriteU32(std::uint8_t* bytes, std::size_t at, std::uint32_t value) {
    for (std::uint32_t i = 0u; i < 4u; ++i) {
        bytes[at + i] = std::uint8_t(value >> (i * 8u));
    }
}

std::size_t AlignUp(std::size_t value, std::size_t alignment) {
    if (value > std::numeric_limits<std::size_t>::max() - (alignment - 1u)) {
        throw std::runtime_error("canonical input size overflows address space");
    }
    return (value + alignment - 1u) & ~(alignment - 1u);
}

/** Bounded per-cook concurrency. Threads only exist in the pthread build. */
std::uint32_t CookConcurrency(std::size_t domainCount) {
#if defined(__EMSCRIPTEN_PTHREADS__)
    const std::uint32_t hardware = std::max(1u, std::thread::hardware_concurrency());
    return std::max(1u, std::min<std::uint32_t>(std::min(hardware, kMaxCookThreads), std::max<std::size_t>(1u, domainCount)));
#else
    (void)domainCount;
    return 1u;
#endif
}

std::size_t CheckedTableBytes(
    std::uint32_t count, std::uint32_t stride, const char* name) {
    const std::uint64_t bytes = std::uint64_t(count) * stride;
    if (bytes > std::numeric_limits<std::size_t>::max()) {
        throw std::runtime_error(std::string(name) + " table exceeds address space");
    }
    return std::size_t(bytes);
}

void RequireZero(
    const std::uint8_t* bytes, std::size_t begin, std::size_t end,
    const char* name) {
    if (std::find_if(bytes + begin, bytes + end, [](std::uint8_t value) {
            return value != 0u;
        }) != bytes + end) {
        throw std::runtime_error(std::string(name) + " reserved/padding bytes must be zero");
    }
}

GeometryCookRecipeV3 DecodeRecipe(
    const std::uint8_t* bytes, std::size_t byteLength) {
    if (!bytes || byteLength != kRecipeBytes ||
        !std::equal(kRecipeMagic.begin(), kRecipeMagic.end(), bytes)) {
        throw std::runtime_error("invalid Web geometry recipe header");
    }
    if (ReadU32(bytes, 8u) != kAbiVersion || ReadU32(bytes, 12u) != kRecipeBytes) {
        throw std::runtime_error("unsupported Web geometry recipe ABI");
    }
    GeometryCookRecipeV3 recipe;
    recipe.meshletMaxVertices = ReadU32(bytes, 16u);
    recipe.meshletMinTriangles = ReadU32(bytes, 20u);
    recipe.meshletMaxTriangles = ReadU32(bytes, 24u);
    recipe.groupTargetMeshlets = ReadU32(bytes, 28u);
    recipe.coneWeight = ReadF32(bytes, 32u);
    recipe.clusterSplitFactor = ReadF32(bytes, 36u);
    recipe.simplifyTargetRatio = ReadF32(bytes, 40u);
    recipe.simplifyFailureRatio = ReadF32(bytes, 44u);
    recipe.simplifySloppyFailureRatio = ReadF32(bytes, 48u);
    const std::uint32_t flags = ReadU32(bytes, 52u);
    if ((flags & ~3u) != 0u) throw std::runtime_error("Web geometry recipe flags are invalid");
    recipe.simplifyPermissive = (flags & 1u) != 0u;
    recipe.sloppyFallback = (flags & 2u) != 0u;
    recipe.sloppyErrorFactor = ReadF32(bytes, 56u);
    recipe.minimumLodReduction = ReadF32(bytes, 60u);
    recipe.lodErrorMergeFactor = ReadF32(bytes, 64u);
    recipe.hierarchyFanout = ReadU32(bytes, 68u);
    recipe.pageShift = ReadU32(bytes, 72u);
    recipe.rawCodecThresholdBytes = ReadU32(bytes, 76u);
    recipe.bootstrapGeometryBudgetBytes =
        std::uint64_t(ReadU32(bytes, 80u)) |
        (std::uint64_t(ReadU32(bytes, 84u)) << 32u);
    recipe.deterministicSeed = ReadU32(bytes, 88u);
    if (ReadU32(bytes, 92u) != 0u) {
        throw std::runtime_error("Web geometry recipe reserved bytes must be zero");
    }
    ValidateRecipe(recipe);
    return recipe;
}

CanonicalGeometryAsset DecodeCanonicalInput(
    const std::uint8_t* bytes, std::size_t byteLength) {
    if (!bytes || byteLength < kCanonicalHeaderBytes ||
        !std::equal(kCanonicalMagic.begin(), kCanonicalMagic.end(), bytes)) {
        throw std::runtime_error("invalid canonical geometry header");
    }
    const std::uint32_t version = ReadU32(bytes, 8u);
    const std::uint32_t headerBytes = ReadU32(bytes, 12u);
    const std::uint32_t declaredBytes = ReadU32(bytes, 16u);
    const std::uint32_t domainCount = ReadU32(bytes, 20u);
    const std::uint32_t vertexCount = ReadU32(bytes, 24u);
    const std::uint32_t indexCount = ReadU32(bytes, 28u);
    const std::uint32_t domainOffset = ReadU32(bytes, 32u);
    const std::uint32_t vertexOffset = ReadU32(bytes, 36u);
    const std::uint32_t indexOffset = ReadU32(bytes, 40u);
    if (version != kAbiVersion || headerBytes != kCanonicalHeaderBytes ||
        declaredBytes != byteLength || domainCount == 0u || vertexCount < 3u ||
        indexCount == 0u || indexCount % 3u != 0u ||
        ReadU32(bytes, 44u) != kCanonicalVertexBytes ||
        ReadU32(bytes, 48u) != kCanonicalDomainBytes ||
        ReadU32(bytes, 52u) != 0u) {
        throw std::runtime_error("canonical geometry header fields are invalid");
    }
    RequireZero(bytes, 56u, kCanonicalHeaderBytes, "canonical header");
    const std::size_t domainsBytes =
        CheckedTableBytes(domainCount, kCanonicalDomainBytes, "domain");
    const std::size_t verticesBytes =
        CheckedTableBytes(vertexCount, kCanonicalVertexBytes, "vertex");
    const std::size_t indicesBytes = CheckedTableBytes(indexCount, 4u, "index");
    const std::size_t expectedDomainOffset = kCanonicalHeaderBytes;
    const std::size_t expectedVertexOffset = AlignUp(expectedDomainOffset + domainsBytes, 16u);
    const std::size_t expectedIndexOffset = AlignUp(expectedVertexOffset + verticesBytes, 16u);
    const std::size_t expectedTotalBytes = AlignUp(expectedIndexOffset + indicesBytes, 16u);
    if (domainOffset != expectedDomainOffset || vertexOffset != expectedVertexOffset ||
        indexOffset != expectedIndexOffset || byteLength != expectedTotalBytes) {
        throw std::runtime_error("canonical geometry sections are not in canonical order");
    }
    RequireZero(bytes, expectedDomainOffset + domainsBytes, expectedVertexOffset, "domain");
    RequireZero(bytes, expectedVertexOffset + verticesBytes, expectedIndexOffset, "vertex");
    RequireZero(bytes, expectedIndexOffset + indicesBytes, expectedTotalBytes, "index");

    CanonicalGeometryAsset asset;
    asset.sourceName = "web-canonical-v1";
    asset.domains.reserve(domainCount);
    std::uint32_t expectedVertexBegin = 0u;
    std::uint32_t expectedIndexBegin = 0u;
    for (std::uint32_t domainIndex = 0u; domainIndex < domainCount; ++domainIndex) {
        const std::size_t at = domainOffset + std::size_t(domainIndex) * kCanonicalDomainBytes;
        MaterialDomain domain;
        domain.materialId = ReadU32(bytes, at);
        domain.meshletFlags = ReadU32(bytes, at + 4u);
        domain.attributeMask = ReadU16(bytes, at + 8u);
        const std::uint16_t flags = ReadU16(bytes, at + 10u);
        const std::uint32_t vertexBegin = ReadU32(bytes, at + 12u);
        const std::uint32_t domainVertexCount = ReadU32(bytes, at + 16u);
        const std::uint32_t indexBegin = ReadU32(bytes, at + 20u);
        const std::uint32_t domainIndexCount = ReadU32(bytes, at + 24u);
        if ((flags & ~kDomainGenerateNormals) != 0u || ReadU32(bytes, at + 28u) != 0u ||
            vertexBegin != expectedVertexBegin || indexBegin != expectedIndexBegin ||
            domainVertexCount < 3u || domainIndexCount == 0u || domainIndexCount % 3u != 0u ||
            std::uint64_t(vertexBegin) + domainVertexCount > vertexCount ||
            std::uint64_t(indexBegin) + domainIndexCount > indexCount) {
            throw std::runtime_error("canonical geometry domain range is invalid");
        }
        const bool generateNormals = (flags & kDomainGenerateNormals) != 0u;
        if (generateNormals == ((domain.attributeMask & kAttributeNormal) != 0u) ||
            (domain.attributeMask & kAttributePosition) == 0u) {
            throw std::runtime_error("canonical geometry normal declaration is invalid");
        }
        domain.vertices.resize(domainVertexCount);
        for (std::uint32_t vertex = 0u; vertex < domainVertexCount; ++vertex) {
            const std::size_t source = vertexOffset +
                std::size_t(vertexBegin + vertex) * kCanonicalVertexBytes;
            CanonicalVertex& target = domain.vertices[vertex];
            std::size_t cursor = source;
            for (float& value : target.position) { value = ReadF32(bytes, cursor); cursor += 4u; }
            for (float& value : target.normal) { value = ReadF32(bytes, cursor); cursor += 4u; }
            for (float& value : target.tangent) { value = ReadF32(bytes, cursor); cursor += 4u; }
            for (float& value : target.uv0) { value = ReadF32(bytes, cursor); cursor += 4u; }
            for (float& value : target.uv1) { value = ReadF32(bytes, cursor); cursor += 4u; }
            for (float& value : target.color) { value = ReadF32(bytes, cursor); cursor += 4u; }
        }
        domain.indices.resize(domainIndexCount);
        for (std::uint32_t index = 0u; index < domainIndexCount; ++index) {
            domain.indices[index] = ReadU32(
                bytes, indexOffset + std::size_t(indexBegin + index) * 4u);
        }
        if (generateNormals) GenerateCanonicalNormalsV3(domain);
        asset.domains.push_back(std::move(domain));
        expectedVertexBegin += domainVertexCount;
        expectedIndexBegin += domainIndexCount;
    }
    if (expectedVertexBegin != vertexCount || expectedIndexBegin != indexCount) {
        throw std::runtime_error("canonical geometry contains unowned vertices or indices");
    }
    FinalizeCanonicalGeometryAssetV3(asset);
    return asset;
}

template <typename T>
std::vector<std::uint8_t> EncodeRecords(const std::vector<T>& records) {
    std::vector<std::uint8_t> output(records.size() * sizeof(T));
    for (std::size_t index = 0u; index < records.size(); ++index) {
        EncodeRecordV3(output.data() + index * sizeof(T), records[index]);
    }
    return output;
}

std::unique_ptr<CookResult> Cook(
    const std::uint8_t* canonicalInput, std::size_t canonicalInputBytes,
    const std::uint8_t* recipeInput, std::size_t recipeInputBytes,
    std::uint64_t maxDecodedProductBytes) {
    if (maxDecodedProductBytes < kGeometryPageBytesV3) {
        throw std::runtime_error("decoded Product budget cannot hold one page");
    }
    GeometryCookRecipeV3 recipe = DecodeRecipe(recipeInput, recipeInputBytes);
    CanonicalGeometryAsset asset = DecodeCanonicalInput(canonicalInput, canonicalInputBytes);
    auto result = std::make_unique<CookResult>();
    // The Web profile maps one canonical material domain to one Product asset so
    // that each GLB mesh primitive stays independently addressable by instance
    // geometry index. The Offline cooker keeps its own mesh-level asset
    // granularity; Web and Offline are not required to share asset boundaries.
    const std::size_t domainCount = asset.domains.size();
    std::vector<CanonicalGeometryAsset> singles(domainCount);
    for (std::size_t domainIndex = 0u; domainIndex < domainCount; ++domainIndex) {
        singles[domainIndex].sourceName = asset.sourceName + "#" + std::to_string(domainIndex);
        singles[domainIndex].domains.push_back(asset.domains[domainIndex]);
        FinalizeCanonicalGeometryAssetV3(singles[domainIndex]);
    }
    std::vector<CookedAssetV3> cooked(domainCount);
    std::vector<CookEvidenceV3> domainEvidence(domainCount);
    const std::uint32_t concurrency = CookConcurrency(domainCount);
    if (concurrency <= 1u) {
        for (std::size_t index = 0u; index < domainCount; ++index) {
            cooked[index] = CookGeometryAssetV3(singles[index], recipe, domainEvidence[index]);
        }
    } else {
        for (std::size_t begin = 0u; begin < domainCount; begin += concurrency) {
            const std::size_t end = std::min(domainCount, begin + std::size_t(concurrency));
            std::vector<std::future<void>> tasks;
            tasks.reserve(end - begin);
            for (std::size_t index = begin; index < end; ++index) {
                tasks.push_back(std::async(std::launch::async, [&, index]() {
                    cooked[index] = CookGeometryAssetV3(singles[index], recipe, domainEvidence[index]);
                }));
            }
            for (auto& task : tasks) task.get();
        }
    }
    for (const CookEvidenceV3& item : domainEvidence) AddEvidence(result->evidence, item);
    result->product = AssembleDecodedGeometryProductV1(std::move(cooked));    const std::uint64_t decodedBytes =
        std::uint64_t(result->product.pages.size()) * kGeometryPageBytesV3;
    std::uint64_t bootstrapPayloadBytes = 0u;
    for (const GeometryGroupDirectoryV3& group : result->product.groups) {
        if ((group.flags & kGroupBootstrap) != 0u) {
            bootstrapPayloadBytes += group.payloadBytes;
        }
    }
    if (decodedBytes > maxDecodedProductBytes ||
        bootstrapPayloadBytes > recipe.bootstrapGeometryBudgetBytes) {
        throw std::runtime_error("decoded Geometry Product exceeds admitted budget");
    }
    result->recipeHash = Sha256(CanonicalRecipeJson(recipe));
    result->assetRecords = EncodeRecords(result->product.assets);
    result->rootNodeIds = EncodeRecords(result->product.roots);
    result->hierarchyNodes = EncodeRecords(result->product.hierarchy);
    result->groupDirectory = EncodeRecords(result->product.groups);
    result->bootstrapPageIds = EncodeRecords(result->product.bootstrapPages);
    result->vertexFormats = EncodeRecords(result->product.formats);
    result->pageRecords.resize(result->product.pages.size() * 32u, 0u);
    for (std::size_t pageIndex = 0u; pageIndex < result->product.pages.size(); ++pageIndex) {
        const DecodedGeometryPageV1& page = result->product.pages[pageIndex];
        std::uint8_t* record = result->pageRecords.data() + pageIndex * 32u;
        std::copy(page.decodedHash128.begin(), page.decodedHash128.end(), record);
        WriteU32(record, 16u, page.firstGroup);
        WriteU32(record, 20u, page.groupCount);
    }
    Sha256Builder contentManifest;
    contentManifest.Add("OENGINE-WEB-GEOMETRY-CONTENT-MANIFEST-V1");
    AddManifestPart(contentManifest, 1u, result->assetRecords);
    AddManifestPart(contentManifest, 2u, result->rootNodeIds);
    AddManifestPart(contentManifest, 3u, result->hierarchyNodes);
    AddManifestPart(contentManifest, 4u, result->groupDirectory);
    AddManifestPart(contentManifest, 5u, result->pageRecords);
    AddManifestPart(contentManifest, 6u, result->bootstrapPageIds);
    AddManifestPart(contentManifest, 7u, result->vertexFormats);
    AddU32(contentManifest, 8u);
    AddU64(contentManifest, result->product.pages.size());
    for (std::size_t pageIndex = 0u; pageIndex < result->product.pages.size(); ++pageIndex) {
        const Hash256 pageHash = Sha256(result->product.pages[pageIndex].bytes);
        AddU32(contentManifest, std::uint32_t(pageIndex));
        contentManifest.Add(pageHash.data(), pageHash.size());
    }
    result->contentManifestHash = contentManifest.Finish();
    return result;
}

const std::vector<std::uint8_t>* Section(
    const CookResult& result, std::uint32_t section, std::uint32_t index) {
    if (index != 0u && section != OENGINE_WEB_COOK_SECTION_PAGE_BYTES) return nullptr;
    switch (section) {
        case OENGINE_WEB_COOK_SECTION_ASSET_RECORDS: return &result.assetRecords;
        case OENGINE_WEB_COOK_SECTION_ROOT_NODE_IDS: return &result.rootNodeIds;
        case OENGINE_WEB_COOK_SECTION_HIERARCHY_NODES: return &result.hierarchyNodes;
        case OENGINE_WEB_COOK_SECTION_GROUP_DIRECTORY: return &result.groupDirectory;
        case OENGINE_WEB_COOK_SECTION_PAGE_RECORDS: return &result.pageRecords;
        case OENGINE_WEB_COOK_SECTION_BOOTSTRAP_PAGE_IDS: return &result.bootstrapPageIds;
        case OENGINE_WEB_COOK_SECTION_VERTEX_FORMATS: return &result.vertexFormats;
        default: return nullptr;
    }
}

CookResult* Result(std::uintptr_t handle) {
    if (handle == 0u) throw std::runtime_error("Web geometry cook handle is null");
    return reinterpret_cast<CookResult*>(handle);
}

void SetError(const std::exception& error) {
    gLastError = error.what();
}

}  // namespace

std::uint32_t oengine_web_geometry_cook_abi_version() {
    return kAbiVersion;
}

std::uintptr_t oengine_web_geometry_cook(
    const std::uint8_t* canonicalInput, std::size_t canonicalInputBytes,
    const std::uint8_t* recipeInput, std::size_t recipeInputBytes,
    std::uint64_t maxDecodedProductBytes) {
    try {
        gLastError.clear();
        return reinterpret_cast<std::uintptr_t>(Cook(
            canonicalInput, canonicalInputBytes, recipeInput, recipeInputBytes,
            maxDecodedProductBytes).release());
    } catch (const std::exception& error) {
        SetError(error);
        return 0u;
    }
}

void oengine_web_geometry_cook_destroy(std::uintptr_t handle) {
    delete reinterpret_cast<CookResult*>(handle);
}

std::size_t oengine_web_geometry_cook_section_size(
    std::uintptr_t handle, std::uint32_t section, std::uint32_t index) {
    try {
        gLastError.clear();
        const CookResult& result = *Result(handle);
        if (section == OENGINE_WEB_COOK_SECTION_RECIPE_HASH) {
            if (index != 0u) throw std::runtime_error("recipe hash index must be zero");
            return result.recipeHash.size();
        }
        if (section == OENGINE_WEB_COOK_SECTION_CONTENT_MANIFEST_HASH) {
            if (index != 0u) throw std::runtime_error("content manifest hash index must be zero");
            return result.contentManifestHash.size();
        }
        if (section == OENGINE_WEB_COOK_SECTION_PAGE_BYTES) {
            if (index >= result.product.pages.size()) {
                throw std::runtime_error("decoded page index is out of range");
            }
            return result.product.pages[index].bytes.size();
        }
        const std::vector<std::uint8_t>* bytes = Section(result, section, index);
        if (!bytes) throw std::runtime_error("unknown Web geometry cook section");
        return bytes->size();
    } catch (const std::exception& error) {
        SetError(error);
        return 0u;
    }
}

std::uint32_t oengine_web_geometry_cook_copy_section(
    std::uintptr_t handle, std::uint32_t section, std::uint32_t index,
    std::uint8_t* output, std::size_t outputBytes) {
    try {
        gLastError.clear();
        const CookResult& result = *Result(handle);
        const std::uint8_t* begin = nullptr;
        std::size_t required = 0u;
        if (section == OENGINE_WEB_COOK_SECTION_RECIPE_HASH) {
            if (index != 0u) throw std::runtime_error("recipe hash index must be zero");
            begin = result.recipeHash.data();
            required = result.recipeHash.size();
        } else if (section == OENGINE_WEB_COOK_SECTION_CONTENT_MANIFEST_HASH) {
            if (index != 0u) throw std::runtime_error("content manifest hash index must be zero");
            begin = result.contentManifestHash.data();
            required = result.contentManifestHash.size();
        } else if (section == OENGINE_WEB_COOK_SECTION_PAGE_BYTES) {
            if (index >= result.product.pages.size()) {
                throw std::runtime_error("decoded page index is out of range");
            }
            begin = result.product.pages[index].bytes.data();
            required = result.product.pages[index].bytes.size();
        } else {
            const std::vector<std::uint8_t>* bytes = Section(result, section, index);
            if (!bytes) throw std::runtime_error("unknown Web geometry cook section");
            begin = bytes->data();
            required = bytes->size();
        }
        if (!output || outputBytes != required) {
            throw std::runtime_error("Web geometry cook section destination size is not exact");
        }
        std::copy(begin, begin + required, output);
        return 1u;
    } catch (const std::exception& error) {
        SetError(error);
        return 0u;
    }
}

std::uint32_t oengine_web_geometry_cook_page_count(std::uintptr_t handle) {
    try {
        gLastError.clear();
        const std::size_t count = Result(handle)->product.pages.size();
        if (count > std::numeric_limits<std::uint32_t>::max()) {
            throw std::runtime_error("decoded page count exceeds u32");
        }
        return std::uint32_t(count);
    } catch (const std::exception& error) {
        SetError(error);
        return 0u;
    }
}

std::size_t oengine_web_geometry_cook_last_error_size() {
    return gLastError.size();
}

std::uint32_t oengine_web_geometry_cook_copy_last_error(
    char* output, std::size_t outputBytes) {
    if (!output || outputBytes != gLastError.size()) return 0u;
    std::copy(gLastError.begin(), gLastError.end(), output);
    return 1u;
}
