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
  # The persistence test drives the module WRAPPER, so it needs the Logos SDK header.
  # Point LOGOS_CPP_SDK_ROOT at the SDK checkout (a module build gets it from the
  # builder). Without it the test is skipped, and says so loudly rather than passing.
  find_path(BOARD_LOGOS_SDK_INCLUDE logos_module_context.h
    HINTS $ENV{LOGOS_CPP_SDK_ROOT}/cpp)
  if(BOARD_LOGOS_SDK_INCLUDE)
    add_executable(test_persistence tests/test_persistence.cpp src/board_core_impl.cpp)
    target_include_directories(test_persistence PRIVATE ${BOARD_LOGOS_SDK_INCLUDE})
    target_link_libraries(test_persistence PRIVATE board_engine)
    add_test(NAME persistence COMMAND test_persistence)
  else()
    message(STATUS "board_core: SKIPPING the persistence test - logos_module_context.h not found; set LOGOS_CPP_SDK_ROOT")
  endif()
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
