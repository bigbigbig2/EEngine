#include "meshoptimizer.h"
#include "lz4.h"
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include <cstdint>
#include <cstring>
extern "C" int u0_exponent(const float* bounds, int min_exp, int bits) {
    return meshopt_computePositionExponent(bounds, bounds + 3, min_exp, bits);
}
extern "C" int u0_compress(int codec, const uint8_t* src, uint32_t size, uint8_t* dst, uint32_t cap, uint32_t stride) {
    if (codec == 0) return LZ4_compress_default(reinterpret_cast<const char*>(src), reinterpret_cast<char*>(dst), size, cap);
    if (codec == 1) {
        const size_t n = ZSTD_compress(dst, cap, src, size, 9);
        return ZSTD_isError(n) ? 0 : int(n);
    }
    if (codec == 3) {
        if (size % 4) return 0;
        return int(meshopt_encodeIndexSequence(dst, cap, reinterpret_cast<const unsigned int*>(src), size / 4));
    }
    if (!stride || stride % 4 || stride > 256 || size % stride) return 0;
    return int(meshopt_encodeVertexBuffer(dst, cap, src, size / stride, stride));
}
extern "C" int u0_decompress(int codec, const uint8_t* src, uint32_t size, uint8_t* dst, uint32_t cap, uint32_t stride) {
    if (!src || !dst || !size || !cap || size > 512 * 1024 || cap > 256 * 1024 || codec < 0 || codec > 3) return 0;
    if (codec == 0) return LZ4_decompress_safe(reinterpret_cast<const char*>(src), reinterpret_cast<char*>(dst), size, cap) == int(cap);
    if (codec == 1) {
        alignas(8) static uint8_t workspace[128 * 1024];
        if (ZSTD_estimateDCtxSize() > sizeof(workspace) || ZSTD_getDictID_fromFrame(src, size) != 0 ||
            ZSTD_getFrameContentSize(src, size) != cap || ZSTD_findFrameCompressedSize(src, size) != size) return 0;
        ZSTD_DCtx* ctx = ZSTD_initStaticDCtx(workspace, sizeof(workspace));
        return ctx && ZSTD_decompressDCtx(ctx, dst, cap, src, size) == cap;
    }
    if (codec == 3) return cap % 4 == 0 && meshopt_decodeIndexSequence(dst, cap / 4, 4, src, size) == 0;
    if (!stride || stride % 4 || stride > 256 || cap % stride) return 0;
    return meshopt_decodeVertexBuffer(dst, cap / stride, stride, src, size) == 0;
}
