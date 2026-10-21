cmake_minimum_required(VERSION 3.20)
project(p2p-jni-bench CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(LibDataChannel CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

add_executable(bench_peer peer.cpp)
target_link_libraries(bench_peer PRIVATE LibDataChannel::LibDataChannel nlohmann_json::nlohmann_json)
if(MSVC)
  target_compile_options(bench_peer PRIVATE /utf-8)
endif()
