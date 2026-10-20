#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include <stdint.h>
#include <stddef.h>

static union { uint64_t alignment; unsigned char bytes[262144]; } workspace;

int geometry_zstd_decode(const void* input, unsigned bytes, void* output, unsigned decoded) {
    ZSTD_FrameHeader header;
    if (!input || !output || bytes == 0 || bytes > 262144 || decoded != 262144) return -1;
    size_t result = ZSTD_getFrameHeader(&header, input, bytes);
    if (ZSTD_isError(result) || result != 0 || header.frameType != ZSTD_frame ||
        header.frameContentSize != decoded || header.windowSize > 262144 ||
        header.dictID != 0 || header.checksumFlag != 1) return -2;
    result = ZSTD_findFrameCompressedSize(input, bytes);
    if (ZSTD_isError(result) || result != bytes) return -3;
    if (ZSTD_estimateDCtxSize() > sizeof(workspace.bytes)) return -4;
    ZSTD_DCtx* context = ZSTD_initStaticDCtx(workspace.bytes, sizeof(workspace.bytes));
    if (!context) return -5;
    result = ZSTD_decompressDCtx(context, output, decoded, input, bytes);
    return ZSTD_isError(result) || result != decoded ? -6 : 0;
}
