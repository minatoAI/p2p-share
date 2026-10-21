cmake_minimum_required(VERSION 3.20)
project(p2p-jni-bench-android CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(LibDataChannel CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

add_library(jni_bench SHARED ../jni_bridge.cpp)
target_link_libraries(jni_bench PRIVATE
  LibDataChannel::LibDataChannel
  nlohmann_json::nlohmann_json
  log)
target_compile_options(jni_bench PRIVATE -finput-charset=UTF-8)
