# CMake generated Testfile for 
# Source directory: /tmp/shrooms-board/module
# Build directory: /tmp/shrooms-board/module/build
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test(parity "/tmp/shrooms-board/module/build/test_parity" "/tmp/shrooms-board/module/tests/golden")
set_tests_properties(parity PROPERTIES  _BACKTRACE_TRIPLES "/tmp/shrooms-board/module/CMakeLists.txt;31;add_test;/tmp/shrooms-board/module/CMakeLists.txt;0;")
