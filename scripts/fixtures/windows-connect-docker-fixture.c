#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

/* Build-time-only hosted smoke fixture. It is deliberately not packaged. */
int wmain(void) {
  wchar_t executable[32768];
  DWORD length = GetModuleFileNameW(NULL, executable, sizeof(executable) / sizeof(executable[0]));
  if (length == 0 || length >= sizeof(executable) / sizeof(executable[0])) return 2;
  wchar_t *separator = wcsrchr(executable, L'\\');
  if (separator == NULL) return 2;
  wcscpy_s(separator + 1, (sizeof(executable) / sizeof(executable[0])) - (separator + 1 - executable), L"fixture-mode.txt");
  FILE *mode = NULL;
  if (_wfopen_s(&mode, executable, L"rb") != 0 || mode == NULL) return 2;
  char value[16] = {0};
  size_t received = fread(value, 1, sizeof(value) - 1, mode);
  fclose(mode);
  if (received >= 7 && memcmp(value, "missing", 7) == 0) return 0;
  static const char row[] = "packedfixture-tunnel\trunning\tUp 1 second\t\r\n";
  return fwrite(row, 1, sizeof(row) - 1, stdout) == sizeof(row) - 1 && fflush(stdout) == 0 ? 0 : 2;
}
