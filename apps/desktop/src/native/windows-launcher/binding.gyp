{
  "targets": [
    {
      "target_name": "propr_windows_launcher",
      "sources": ["propr_windows_launcher.cc"],
      "defines": ["NAPI_VERSION=9", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "libraries": ["-ladvapi32", "-lbcrypt", "-lcrypt32", "-lwintrust"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17", "/guard:cf", "/sdl"]
        },
        "VCLinkerTool": {
          "AdditionalOptions": ["/guard:cf", "/dynamicbase", "/nxcompat"]
        }
      }
    }
  ]
}
