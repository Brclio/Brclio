{
  "targets": [{
    "target_name": "brclio_hello",
    "sources": ["hello.cpp"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS", "NOMINMAX", "WIN32_LEAN_AND_MEAN", "_WIN32_WINNT=0x0A00", "NTDDI_VERSION=NTDDI_WIN10_CO"],
    "libraries": ["windowsapp.lib", "user32.lib"],
    "msvs_settings": {"VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17", "/utf-8", "/Zc:__cplusplus"]}}
  }]
}
