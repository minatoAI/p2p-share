#include <algorithm>
#include "protocol.h"

namespace p2p {

std::vector<unsigned char> encode_chunk(uint32_t index, uint32_t total,
                                        const unsigned char* payload, size_t len) {
    std::vector<unsigned char> out(kChunkHeaderBytes + len);
    // 小端
    out[0] = static_cast<unsigned char>(index & 0xff);
    out[1] = static_cast<unsigned char>((index >> 8) & 0xff);
    out[2] = static_cast<unsigned char>((index >> 16) & 0xff);
    out[3] = static_cast<unsigned char>((index >> 24) & 0xff);
    out[4] = static_cast<unsigned char>(total & 0xff);
    out[5] = static_cast<unsigned char>((total >> 8) & 0xff);
    out[6] = static_cast<unsigned char>((total >> 16) & 0xff);
    out[7] = static_cast<unsigned char>((total >> 24) & 0xff);
    if (len) std::copy(payload, payload + len, out.begin() + kChunkHeaderBytes);
    return out;
}

bool decode_chunk(const std::vector<unsigned char>& frame, Chunk* out, std::string* reason) {
    if (frame.size() < kChunkHeaderBytes) {
        if (reason) *reason = "分片太短：" + std::to_string(frame.size()) + " 字节";
        return false;
    }
    out->index = static_cast<uint32_t>(frame[0]) | (static_cast<uint32_t>(frame[1]) << 8) |
                 (static_cast<uint32_t>(frame[2]) << 16) | (static_cast<uint32_t>(frame[3]) << 24);
    out->total = static_cast<uint32_t>(frame[4]) | (static_cast<uint32_t>(frame[5]) << 8) |
                 (static_cast<uint32_t>(frame[6]) << 16) | (static_cast<uint32_t>(frame[7]) << 24);
    out->payload_offset = kChunkHeaderBytes;
    return true;
}

}  // namespace p2p
