# shrooms-board core — C++ mirror of the JS reference engine.
# Mode A (default): standalone library + parity tests, no Logos SDK required.
# Mode B (-DBUILD_MODULE=ON): the logoscore plugin (needs the Logos SDK roots);
#        wired up in the next milestone — see logos-module-scaffold.
cmake_minimum_required(VERSION 3.16)
project(board_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(board_core STATIC
  src/hlc.cpp
  src/events.cpp
  src/engine.cpp
)
target_include_directories(board_core PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
target_compile_options(board_core PRIVATE -Wall -Wextra)

option(BUILD_TESTS "Build the parity tests" ON)
if(BUILD_TESTS)
  enable_testing()
  add_executable(test_parity tests/test_parity.cpp)
  target_link_libraries(test_parity PRIVATE board_core)
  # ctest runs from the module/ dir, so the fixtures path is relative to it
  add_test(NAME parity COMMAND test_parity ${CMAKE_CURRENT_SOURCE_DIR}/tests/golden)
endif()
