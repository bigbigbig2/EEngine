#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>
extern "C" int bc_encode(const uint8_t*, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint8_t*);
extern "C" int bc_decode(const uint8_t*, uint32_t, uint32_t, uint32_t, uint8_t*);
extern "C" int bc_resample(const uint8_t*, uint32_t, uint32_t, uint8_t*, uint32_t, uint32_t, uint32_t, uint32_t);
int main(int argc, char** argv) {
    if (argc != 8 && argc != 9 && argc != 10) return 2;
    const uint32_t w = std::strtoul(argv[2], nullptr, 10), h = std::strtoul(argv[3], nullptr, 10);
    if (argv[1][0] == 'r') {
        if (argc != 10) return 2;
        const uint32_t dw = std::strtoul(argv[4], nullptr, 10), dh = std::strtoul(argv[5], nullptr, 10);
        if (!w || !h || !dw || !dh || w > 16384 || h > 16384 || dw > 16384 || dh > 16384) return 2;
        std::vector<uint8_t> input(size_t(w)*h*4), output(size_t(dw)*dh*4);
        FILE* f = std::fopen(argv[8], "rb");
        if (!f) return 3;
        const bool valid = std::fread(input.data(), 1, input.size(), f) == input.size() && std::fgetc(f) == EOF;
        std::fclose(f);
        if (!valid) return 4;
        if (!bc_resample(input.data(),w,h,output.data(),dw,dh,std::atoi(argv[6]),std::atoi(argv[7]))) return 5;
        f = std::fopen(argv[9], "wb");
        if (!f) return 6;
        const bool written = std::fwrite(output.data(),1,output.size(),f) == output.size();
        return std::fclose(f) == 0 && written ? 0 : 7;
    }
    const uint32_t format = std::strtoul(argv[4], nullptr, 10);
    if (!w || !h || w > 16384 || h > 16384 || (format != 7 && format != 4)) return 2;
    const size_t blockBytes = ((w + 3) / 4) * ((h + 3) / 4) * (format == 7 ? 16 : 8);
    const bool decode = argv[1][0] == 'd';
    std::vector<uint8_t> input(decode ? blockBytes : size_t(w)*h*4), output(decode ? size_t(w)*h*4 : blockBytes);
    FILE* f = std::fopen(argv[6], "rb");
    if (!f) return 3;
    const bool valid = std::fread(input.data(), 1, input.size(), f) == input.size() && std::fgetc(f) == EOF;
    std::fclose(f);
    if (!valid) return 4;
    const bool ok = decode ? bc_decode(input.data(),w,h,format,output.data()) : bc_encode(input.data(),w,h,format,std::atoi(argv[5]),argc == 9 ? std::atoi(argv[8]) : 0,output.data());
    if (!ok) return 5;
    f = std::fopen(argv[7], "wb");
    if (!f) return 6;
    const bool written = std::fwrite(output.data(),1,output.size(),f) == output.size();
    return std::fclose(f) == 0 && written ? 0 : 7;
}
