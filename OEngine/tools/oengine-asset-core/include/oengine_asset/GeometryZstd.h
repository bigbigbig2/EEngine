#pragma once

#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include <cstddef>
#include <vector>
#include <stdexcept>

namespace oengine::asset {

// The upstream decoder supports concatenation and dictionaries; the product does not.
inline bool IsGeometryZstdFrame(const void* input, std::size_t bytes, std::size_t decoded) {
    if (bytes == 0u || bytes > 262144u || decoded != 262144u) return false;
    ZSTD_FrameHeader header{};
    const auto status = ZSTD_getFrameHeader(&header, input, bytes);
    if (ZSTD_isError(status) || status != 0u || header.frameType != ZSTD_frame ||
        header.frameContentSize != decoded || header.windowSize > 262144u ||
        header.dictID != 0u || header.checksumFlag != 1u) return false;
    const auto extent = ZSTD_findFrameCompressedSize(input, bytes);
    return !ZSTD_isError(extent) && extent == bytes;
}

inline std::vector<unsigned char> EncodeGeometryZstd(const std::vector<unsigned char>& decoded) {
    if (decoded.size() != 262144u) throw std::runtime_error("geometry page must be 256 KiB");
    auto selected = decoded; // Raw is the candidate that always fits the transport cap.
    ZSTD_CCtx* context = ZSTD_createCCtx();
    if (!context) throw std::runtime_error("Zstd encoder allocation failed");
    try {
        std::vector<unsigned char> candidate(ZSTD_compressBound(decoded.size()));
        for (int level : {9, 15, 19}) {
            for (auto result : {ZSTD_CCtx_reset(context, ZSTD_reset_session_and_parameters),
                ZSTD_CCtx_setParameter(context, ZSTD_c_compressionLevel, level),
                ZSTD_CCtx_setParameter(context, ZSTD_c_windowLog, 18),
                ZSTD_CCtx_setParameter(context, ZSTD_c_checksumFlag, 1),
                ZSTD_CCtx_setParameter(context, ZSTD_c_contentSizeFlag, 1),
                ZSTD_CCtx_setParameter(context, ZSTD_c_dictIDFlag, 0)}) {
                if (ZSTD_isError(result)) throw std::runtime_error(ZSTD_getErrorName(result));
            }
            const auto size = ZSTD_compress2(context, candidate.data(), candidate.size(),
                decoded.data(), decoded.size());
            if (ZSTD_isError(size)) throw std::runtime_error(ZSTD_getErrorName(size));
            if (size < selected.size()) {
                if (!IsGeometryZstdFrame(candidate.data(), size, decoded.size()))
                    throw std::runtime_error("Zstd encoder violated single-frame contract");
                selected.assign(candidate.begin(), candidate.begin() + size);
            }
        }
    } catch (...) {
        ZSTD_freeCCtx(context);
        throw;
    }
    ZSTD_freeCCtx(context);
    return selected;
}

} // namespace oengine::asset
