#pragma once
// 线格式：二进制分片。
//
// 分片头是两个小端 uint32：分片序号、分片总数。发送端按方向串行，
// 所以不需要带传输 ID。控制帧和信令都是 JSON，在各自的模块里拼。
#include <cstdint>
#include <string>
#include <vector>

namespace p2p {

inline constexpr size_t kChunkHeaderBytes = 8;

/** 分片头加载荷 */
std::vector<unsigned char> encode_chunk(uint32_t index, uint32_t total,
                                        const unsigned char* payload, size_t len);

struct Chunk {
    uint32_t index = 0;
    uint32_t total = 0;
    size_t payload_offset = 0;
};

/** 拆出序号和总数。载荷从 payload_offset 开始，不复制。 */
bool decode_chunk(const std::vector<unsigned char>& frame, Chunk* out, std::string* reason);

}  // namespace p2p
