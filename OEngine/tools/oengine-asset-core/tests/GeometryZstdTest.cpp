#include "oengine_asset/GeometryZstd.h"
#include <cassert>
#include <fstream>
#include <string>

using namespace oengine::asset;

void Save(const std::string& directory, const char* name, const std::vector<unsigned char>& bytes) {
    std::ofstream out(directory + "/" + name, std::ios::binary);
    out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    assert(out.good());
}

int main(int argc, char** argv) {
    assert(argc == 2);
    std::vector<unsigned char> input(262144u);
    for (std::size_t i = 0u; i < input.size(); ++i) input[i] = (i / 4u) % 251u;
    const auto selected = EncodeGeometryZstd(input);
    assert(selected.size() < input.size());
    Save(argv[1], "decoded.bin", input);
    Save(argv[1], "selected.zst", selected);
    std::size_t minimum = input.size();
    for (int level : {9, 15, 19}) {
        auto* context = ZSTD_createCCtx();
        assert(context);
        assert(!ZSTD_isError(ZSTD_CCtx_setParameter(context, ZSTD_c_compressionLevel, level)));
        assert(!ZSTD_isError(ZSTD_CCtx_setParameter(context, ZSTD_c_checksumFlag, 1)));
        assert(!ZSTD_isError(ZSTD_CCtx_setParameter(context, ZSTD_c_windowLog, 18)));
        std::vector<unsigned char> encoded(ZSTD_compressBound(input.size()));
        const auto size = ZSTD_compress2(context, encoded.data(), encoded.size(), input.data(), input.size());
        assert(!ZSTD_isError(size));
        encoded.resize(size);
        minimum = std::min(minimum, size);
        assert(IsGeometryZstdFrame(encoded.data(), size, input.size()));
        Save(argv[1], ("level" + std::to_string(level) + ".zst").c_str(), encoded);
        ZSTD_freeCCtx(context);
    }
    assert(selected.size() == minimum);
    auto trailing = selected;
    trailing.push_back(0u);
    assert(!IsGeometryZstdFrame(trailing.data(), trailing.size(), input.size()));
    auto concatenated = selected;
    concatenated.insert(concatenated.end(), selected.begin(), selected.end());
    assert(!IsGeometryZstdFrame(concatenated.data(), concatenated.size(), input.size()));
    Save(argv[1], "trailing.zst", trailing);
    Save(argv[1], "concatenated.zst", concatenated);
    auto damaged = selected;
    damaged.back() ^= 1u;
    Save(argv[1], "checksum.zst", damaged);
    auto* context = ZSTD_createCCtx();
    for (const bool unknownSize : {false, true}) {
        ZSTD_CCtx_reset(context, ZSTD_reset_session_and_parameters);
        ZSTD_CCtx_setParameter(context, ZSTD_c_checksumFlag, unknownSize ? 1 : 0);
        ZSTD_CCtx_setParameter(context, ZSTD_c_contentSizeFlag, unknownSize ? 0 : 1);
        std::vector<unsigned char> encoded(ZSTD_compressBound(input.size()));
        const auto size = ZSTD_compress2(context, encoded.data(), encoded.size(), input.data(), input.size());
        assert(!ZSTD_isError(size));
        encoded.resize(size);
        assert(!IsGeometryZstdFrame(encoded.data(), size, input.size()));
        Save(argv[1], unknownSize ? "unknown-size.zst" : "no-checksum.zst", encoded);
    }
    ZSTD_freeCCtx(context);
    std::uint32_t random = 0x62f19d5u;
    for (auto& byte : input) {
        random ^= random << 13u;
        random ^= random >> 17u;
        random ^= random << 5u;
        byte = static_cast<unsigned char>(random);
    }
    assert(EncodeGeometryZstd(input) == input); // Incompressible pages never expand.
}
