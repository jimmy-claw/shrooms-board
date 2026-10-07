# shrooms-board core — C++ engine + Logos universal module.
#
# Mode A (default): standalone library + tests. No Logos SDK needed.
# Mode B (-DBUILD_MODULE=ON): the universal core module, built with
#        logos-module-builder (LogosModule.cmake on CMAKE_MODULE_PATH).
cmake_minimum_required(VERSION 3.16)
project(board_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# --- Mode A: engine + state, testable without the SDK ----------------------
add_library(board_core STATIC
  src/hlc.cpp
  src/events.cpp
  src/engine.cpp
  src/board_state.cpp
)
target_include_directories(board_core PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
target_compile_options(board_core PRIVATE -Wall -Wextra)

option(BUILD_TESTS "Build the tests" ON)
if(BUILD_TESTS)
  enable_testing()
  add_executable(test_parity tests/test_parity.cpp)
  target_link_libraries(test_parity PRIVATE board_core)
  add_test(NAME parity COMMAND test_parity ${CMAKE_CURRENT_SOURCE_DIR}/tests/golden)
  add_executable(test_state tests/test_state.cpp)
  target_link_libraries(test_state PRIVATE board_core)
  add_test(NAME state COMMAND test_state)
endif()

# --- Mode B: the Logos universal module (needs the SDK via the builder) ----
option(BUILD_MODULE "Build the Logos universal module" OFF)
if(BUILD_MODULE)
  include(LogosModule.cmake)
  logos_module(NAME board_core
    SOURCES
      src/board_core_impl.cpp
      src/board_state.cpp
      src/hlc.cpp
      src/events.cpp
      src/engine.cpp
    INCLUDE_DIRS
      src
      third_party
  )
endif()
