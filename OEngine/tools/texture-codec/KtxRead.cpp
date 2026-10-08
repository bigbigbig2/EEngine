// EEngine read-only embind adaptation of KTX-Software 4.4.2. No container parser.
#include <emscripten/bind.h>
#include <ktx.h>
#include <memory>
#include <stdexcept>
#include <vector>
using namespace emscripten;

class Texture {
    std::vector<uint8_t> source;
    ktxTexture2* ptr = nullptr;
    int error = KTX_SUCCESS;
public:
    Texture(val bytes, bool metadataOnly) : source(bytes["byteLength"].as<size_t>()) {
        if (source.empty() || source.size() > 134217728) throw std::runtime_error("KTX input budget");
        val(typed_memory_view(source.size(), source.data())).call<void>("set", bytes);
        // source survives metadata-only parse: libktx retains its memory stream.
        error = ktxTexture2_CreateFromMemory(source.data(), source.size(),
            metadataOnly ? KTX_TEXTURE_CREATE_NO_FLAGS : KTX_TEXTURE_CREATE_LOAD_IMAGE_DATA_BIT, &ptr);
    }
    ~Texture() { if (ptr) ktxTexture_Destroy(ktxTexture(ptr)); }
    double get(uint32_t field) const {
        if (!ptr) return 0;
        switch (field) {
            case 0: return ptr->baseWidth;
            case 1: return ptr->baseHeight;
            case 2: return ptr->baseDepth;
            case 3: return ptr->numDimensions;
            case 4: return ptr->numLevels;
            case 5: return ptr->numLayers;
            case 6: return ptr->numFaces;
            case 7: return ptr->isArray;
            case 8: return ktxTexture2_GetColorModel_e(ptr);
            case 9: return ktxTexture2_GetOETF_e(ptr);
            case 10: return ptr->supercompressionScheme;
            case 11: return ptr->vkFormat;
            case 12: return ktxTexture2_NeedsTranscoding(ptr);
            case 13: return ktxTexture_GetDataSizeUncompressed(ktxTexture(ptr));
            default: return 0;
        }
    }
    int status() const { return error; }
    std::string message() const { return ktxErrorString(static_cast<KTX_error_code>(error)); }
    int load() { if (!ptr) return error; return error = ktxTexture_LoadImageData(ktxTexture(ptr), nullptr, 0); }
    int transcode(uint32_t target) {
        if (!ptr) return error;
        return error = ktxTexture2_TranscodeBasis(ptr, static_cast<ktx_transcode_fmt_e>(target), 0);
    }
    val image(uint32_t level) {
        if (!ptr || !ptr->pData || level >= ptr->numLevels) throw std::runtime_error("KTX image unavailable");
        ktx_size_t offset;
        error = ktxTexture_GetImageOffset(ktxTexture(ptr), level, 0, 0, &offset);
        if (error) throw std::runtime_error(message());
        auto size = ktxTexture_GetImageSize(ktxTexture(ptr), level);
        if (offset > ptr->dataSize || size > ptr->dataSize - offset) throw std::runtime_error("KTX image range");
        return val(typed_memory_view(size, ptr->pData + offset));
    }
};
EMSCRIPTEN_BINDINGS(eengine_ktx_read) {
    class_<Texture>("Texture").constructor<val, bool>()
        .function("get", &Texture::get).function("status", &Texture::status)
        .function("message", &Texture::message).function("load", &Texture::load)
        .function("transcode", &Texture::transcode).function("image", &Texture::image);
}
