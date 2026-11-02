cmake_minimum_required(VERSION 3.24)
project(antsim VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(ANTSIM_THREADS "Build with thread support (pthreads in wasm)" ON)
option(ANTSIM_BUILD_TESTS "Build native unit tests" ON)

# ---------------------------------------------------------------- header-only deps
function(antsim_fetch_header url dest)
  if(NOT EXISTS ${dest})
    file(DOWNLOAD ${url} ${dest} STATUS dl_status TLS_VERIFY ON)
    list(GET dl_status 0 dl_code)
    if(NOT dl_code EQUAL 0)
      file(REMOVE ${dest})
      message(FATAL_ERROR "Failed to download ${url}: ${dl_status}")
    endif()
  endif()
endfunction()
set(ANTSIM_DEPS ${CMAKE_BINARY_DIR}/_deps)
antsim_fetch_header(https://github.com/nlohmann/json/releases/download/v3.12.0/json.hpp
                    ${ANTSIM_DEPS}/nlohmann/nlohmann/json.hpp)

# ---------------------------------------------------------------- core library
add_library(antsim_core STATIC
  src/grid/rect_grid.cpp
  src/fdtd/threadpool.cpp
  src/fdtd/yee.cpp
  src/fdtd/excitation.cpp
  src/geometry/voxelize.cpp
  src/fdtd/cpml.cpp
  src/fdtd/metal.cpp
  src/nf2ff/nf2ff.cpp
  src/api/problem.cpp
  src/api/solver.cpp
  src/api/benchmark.cpp
)
target_include_directories(antsim_core PUBLIC include)
target_include_directories(antsim_core SYSTEM PRIVATE ${ANTSIM_DEPS}/nlohmann)
target_compile_definitions(antsim_core PUBLIC ANTSIM_THREADS=$<BOOL:${ANTSIM_THREADS}>)
target_compile_options(antsim_core PRIVATE -Wall -Wextra -Wpedantic)

if(EMSCRIPTEN)
  # Wasm has no FMA contraction by default; SIMD128 for auto-vectorization.
  target_compile_options(antsim_core PUBLIC -msimd128 -fwasm-exceptions)
  if(ANTSIM_THREADS)
    target_compile_options(antsim_core PUBLIC -pthread)
  endif()
else()
  # Disable FMA contraction so native results are comparable with wasm.
  target_compile_options(antsim_core PUBLIC -ffp-contract=off)
  if(ANTSIM_THREADS)
    find_package(Threads REQUIRED)
    target_link_libraries(antsim_core PUBLIC Threads::Threads)
  endif()
endif()

# ---------------------------------------------------------------- wasm module
if(EMSCRIPTEN)
  if(ANTSIM_THREADS)
    set(ANTSIM_WASM_NAME antsim-mt)
  else()
    set(ANTSIM_WASM_NAME antsim-st)
  endif()
  add_executable(antsim_wasm bindings/wasm_api.cpp)
  target_link_libraries(antsim_wasm PRIVATE antsim_core)
  target_include_directories(antsim_wasm SYSTEM PRIVATE ${ANTSIM_DEPS}/nlohmann)
  set_target_properties(antsim_wasm PROPERTIES OUTPUT_NAME ${ANTSIM_WASM_NAME} SUFFIX ".js")
  target_link_options(antsim_wasm PRIVATE
    -lembind
    -fwasm-exceptions
    -msimd128
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createAntsim
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=32MB
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=1MB
  )
  if(ANTSIM_THREADS)
    # Pool size must not exceed antsim::kMaxThreads (see threadpool.hpp).
    target_link_options(antsim_wasm PRIVATE
      -pthread
      "-sPTHREAD_POOL_SIZE=Math.min(navigator.hardwareConcurrency||4,8)"
      -sPTHREAD_POOL_SIZE_STRICT=2
    )
  endif()
endif()

# ---------------------------------------------------------------- native tools and tests
if(NOT EMSCRIPTEN)
  add_executable(antsim_cli apps/antsim_cli.cpp)
  target_link_libraries(antsim_cli PRIVATE antsim_core)

  if(ANTSIM_BUILD_TESTS)
    antsim_fetch_header(https://raw.githubusercontent.com/doctest/doctest/v2.5.3/doctest/doctest.h
                        ${ANTSIM_DEPS}/doctest/doctest.h)
    add_executable(antsim_tests
      tests/test_main.cpp
      tests/test_grid.cpp
      tests/test_threadpool.cpp
      tests/test_yee.cpp
      tests/test_solver.cpp
      tests/test_voxelize.cpp
      tests/test_metal.cpp
    )
    target_include_directories(antsim_tests PRIVATE ${CMAKE_BINARY_DIR}/_deps/doctest)
    target_include_directories(antsim_tests SYSTEM PRIVATE ${ANTSIM_DEPS}/nlohmann)
    target_link_libraries(antsim_tests PRIVATE antsim_core)
    enable_testing()
    add_test(NAME antsim_tests COMMAND antsim_tests)
  endif()
endif()
