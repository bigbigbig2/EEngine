#include <stddef.h>
#include <stdint.h>
#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"

enum { PAGE_BYTES = 20736, INPUT_BYTES = ZSTD_COMPRESSBOUND(PAGE_BYTES) };
static uint64_t context_storage[32768];
static unsigned char input[INPUT_BYTES];
static unsigned char output[PAGE_BYTES];
static ZSTD_DCtx* context;

uintptr_t tiled_input(void) { return (uintptr_t)input; }
uintptr_t tiled_output(void) { return (uintptr_t)output; }

int tiled_init(void) {
    if (ZSTD_estimateDCtxSize() > sizeof(context_storage)) return 0;
    context = ZSTD_initStaticDCtx(context_storage, sizeof(context_storage));
    return context != NULL;
}

int tiled_decode(unsigned encoded_size, unsigned native_size) {
    ZSTD_frameHeader header;
    size_t result;
    if (!context || (native_size != 20736 && native_size != 10368) ||
        encoded_size == 0 || encoded_size > ZSTD_COMPRESSBOUND(native_size)) return -1;
    result = ZSTD_getFrameHeader(&header, input, encoded_size);
    if (ZSTD_isError(result) || result != 0 || header.frameType != ZSTD_frame ||
        header.frameContentSize != native_size || header.windowSize > native_size ||
        header.dictID != 0 || header.checksumFlag != 1) return -2;
    result = ZSTD_findFrameCompressedSize(input, encoded_size);
    if (ZSTD_isError(result) || result != encoded_size) return -3;
    result = ZSTD_decompressDCtx(context, output, native_size, input, encoded_size);
    if (ZSTD_isError(result) || result != native_size) return -4;
    return (int)result;
}
