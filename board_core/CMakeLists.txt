# shrooms-board core — C++ engine + Logos universal module.
#
# Standalone (no builder): library + tests, no Logos SDK needed.
# Under logos-module-builder: LOGOS_MODULE_BUILDER_ROOT is set, so the module
# helper is included and logos_module() builds the plugin + generated glue.
cmake_minimum_required(VERSION 3.16)
project(BoardCorePlugin LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(BOARD_HAVE_LOGOS FALSE)
if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})
  include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)
  set(BOARD_HAVE_LOGOS TRUE)
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/LogosModule.cmake")
  include(cmake/LogosModule.cmake)
  set(BOARD_HAVE_LOGOS TRUE)
endif()

# --- engine + app logic (testable without the SDK) -------------------------
add_library(board_engine STATIC
  src/hlc.cpp
  src/events.cpp
  src/engine.cpp
  src/board_state.cpp
)
target_include_directories(board_engine PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
target_compile_options(board_engine PRIVATE -Wall -Wextra)

option(BUILD_TESTS "Build the tests" ON)
if(BUILD_TESTS)
  enable_testing()
  add_executable(test_parity tests/test_parity.cpp)
  target_link_libraries(test_parity PRIVATE board_engine)
  add_test(NAME parity COMMAND test_parity ${CMAKE_CURRENT_SOURCE_DIR}/tests/golden)
  add_executable(test_state tests/test_state.cpp)
  target_link_libraries(test_state PRIVATE board_engine)
  add_test(NAME state COMMAND test_state)
endif()

# --- the universal module (only when the builder provides the helper) ------
if(BOARD_HAVE_LOGOS)
  file(READ "${CMAKE_CURRENT_SOURCE_DIR}/metadata.json" METADATA_JSON)
  string(JSON MODULE_NAME GET ${METADATA_JSON} name)
  logos_module(
    NAME ${MODULE_NAME}
    SOURCES
      src/board_core_impl.h
      src/board_core_impl.cpp
      src/board_state.cpp
      src/hlc.cpp
      src/events.cpp
      src/engine.cpp
    INCLUDE_DIRS
      src
      third_party
  )
else()
  message(STATUS "No LogosModule.cmake - standalone build (engine + tests only)")
endif()
