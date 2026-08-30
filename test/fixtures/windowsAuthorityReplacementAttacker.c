#define UNICODE
#define _UNICODE
#include <windows.h>
#include <wchar.h>

/* Native same-user replacement fixture. Any execution is an immediate proof
   that the packaged-broker pre-CreateProcess lease failed. */
int wmain(void) {
  wchar_t path[32768];
  DWORD length = GetModuleFileNameW(NULL, path, sizeof(path) / sizeof(path[0]));
  if (length == 0 || length >= sizeof(path) / sizeof(path[0])) return 91;
  wchar_t *separator = wcsrchr(path, L'\\');
  if (separator == NULL) return 91;
  wcscpy_s(separator + 1, (sizeof(path) / sizeof(path[0])) - (separator + 1 - path),
    L"packaged-broker-attacker-executed");
  HANDLE marker = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
    FILE_ATTRIBUTE_NORMAL, NULL);
  if (marker == INVALID_HANDLE_VALUE) return 91;
  static const char bytes[] = "attacker executed\n";
  DWORD written = 0;
  BOOL ok = WriteFile(marker, bytes, sizeof(bytes) - 1, &written, NULL);
  CloseHandle(marker);
  return ok && written == sizeof(bytes) - 1 ? 90 : 91;
}
