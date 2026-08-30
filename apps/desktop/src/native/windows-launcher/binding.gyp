{
  "targets": [
    {
      "target_name": "propr_windows_malicious_bootstrap",
      "sources": ["propr_windows_launcher.cc"],
      "defines": ["NAPI_VERSION=9", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0602", "PROPR_WINDOWS_BOOTSTRAP_ONLY=1", "PROPR_WINDOWS_MALICIOUS_BOOTSTRAP=1"],
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
    },
    {
      "target_name": "propr_windows_bootstrap",
      "sources": ["propr_windows_launcher.cc"],
      "defines": ["NAPI_VERSION=9", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0602", "PROPR_WINDOWS_BOOTSTRAP_ONLY=1"],
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
    },
    {
      "target_name": "propr_windows_launcher",
      "sources": ["propr_windows_launcher.cc"],
      "defines": ["NAPI_VERSION=9", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0602"],
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
