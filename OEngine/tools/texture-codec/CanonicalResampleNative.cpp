#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

extern "C" int image_resample(const uint8_t*, uint32_t, uint32_t, uint8_t*, uint32_t, uint32_t, uint32_t, uint32_t);

int main(int argc, char** argv) {
    if (argc != 9) return 2;
    const uint32_t sw = std::strtoul(argv[1], nullptr, 10), sh = std::strtoul(argv[2], nullptr, 10);
    const uint32_t dw = std::strtoul(argv[3], nullptr, 10), dh = std::strtoul(argv[4], nullptr, 10);
    if (!sw || !sh || !dw || !dh || sw > 16384 || sh > 16384 || dw > 16384 || dh > 16384) return 2;
    std::vector<uint8_t> input(size_t(sw) * sh * 4), output(size_t(dw) * dh * 4);
    FILE* file = std::fopen(argv[7], "rb");
    if (!file) return 3;
    const bool valid = std::fread(input.data(), 1, input.size(), file) == input.size() && std::fgetc(file) == EOF;
    std::fclose(file);
    if (!valid) return 4;
    if (!image_resample(input.data(), sw, sh, output.data(), dw, dh, std::atoi(argv[5]), std::atoi(argv[6]))) return 5;
    file = std::fopen(argv[8], "wb");
    if (!file) return 6;
    const bool written = std::fwrite(output.data(), 1, output.size(), file) == output.size();
    return std::fclose(file) == 0 && written ? 0 : 7;
}
