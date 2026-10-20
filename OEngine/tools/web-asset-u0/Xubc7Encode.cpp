#include "basisu_xbc7_encode.h"
#include "basisu_transcoder.h"
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <chrono>

extern "C" int u0_decode(const uint8_t*, uint32_t, uint32_t, uint32_t, uint8_t*, uint32_t);
extern "C" void u0_bc_init() { basist::basisu_transcoder_init(); }
static bool write(const char* name, const void* p, size_t n) {
    FILE* f = std::fopen(name, "wb");
    if (!f) return false;
    bool ok = std::fwrite(p, 1, n, f) == n;
    return std::fclose(f) == 0 && ok;
}
int main(int argc, char** argv) {
    if (argc != 8) return 2;
    uint32_t w = std::atoi(argv[1]), h = std::atoi(argv[2]);
    if (!w || !h || w > 512 || h > 512) return 2;
    std::vector<uint8_t> pixels(size_t(w) * h * 4);
    FILE* f = std::fopen(argv[5], "rb");
    if (!f) return 3;
    bool valid = std::fread(pixels.data(), 1, pixels.size(), f) == pixels.size() && std::fgetc(f) == EOF;
    std::fclose(f);
    if (!valid) return 4;
    basisu::basisu_encoder_init();
    basisu::image image(pixels.data(), w, h, 4);
    basisu::job_pool pool(1);
    basisu::xbc7::pack_options options;
    options.m_bc7_encoder = basisu::xbc7::bc7_encoder_type::cBC7E_Scalar;
    options.m_bc7e_scalar_level = 6;
    options.m_perceptual = std::atoi(argv[3]) != 0;
    options.m_dct_q = std::atoi(argv[4]);
    options.set_rdo_level(0);
    options.m_num_stripes = 1;
    options.m_self_validate = true;
    options.m_pJob_pool = &pool;
    basisu::uint8_vec stream;
    basisu::vector2D<basist::bc7u::log_bc7_block> reference;
    auto start = std::chrono::steady_clock::now();
    if (!basisu::xbc7::pack_image(image, options, stream, reference)) return 5;
    double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::vector<uint8_t> blocks(size_t((w + 3) / 4) * ((h + 3) / 4) * 16);
    if (!u0_decode(stream.data(), stream.size(), w, h, blocks.data(), blocks.size())) return 6;
    if (!write(argv[6], stream.data(), stream.size()) || !write(argv[7], blocks.data(), blocks.size())) return 7;
    std::printf("{\"encodeMs\":%.3f,\"streamBytes\":%zu,\"nativeBytes\":%zu}\n", ms, stream.size(), blocks.size());
    return 0;
}
