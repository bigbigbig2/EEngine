// Local differential harness; donor source remains unchanged.
#include "offsetAllocator.hpp"
#include <cstdio>
#include <vector>

int main() {
    OffsetAllocator::Allocator allocator(65536, 4097);
    std::vector<OffsetAllocator::Allocation> live;
    unsigned seed = 0x7ac01983u;
    auto random = [&]() { seed = seed * 1664525u + 1013904223u; return seed; };
    for (unsigned step = 0; step < 12000; step++) {
        if (!live.empty() && random() % 3 == 0) {
            unsigned index = random() % live.size();
            allocator.free(live[index]);
            live.erase(live.begin() + index);
            std::printf("F %u\n", index);
        } else {
            unsigned size = random() % 1024 + 1;
            auto allocation = allocator.allocate(size);
            std::printf("A %u %u\n", size, allocation.offset);
            if (allocation.offset != 0xffffffffu) live.push_back(allocation);
        }
    }
}
