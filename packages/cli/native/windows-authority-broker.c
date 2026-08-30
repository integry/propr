#define UNICODE
#define _UNICODE

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include <wintrust.h>
#include <softpub.h>

#include <stdint.h>
#include <errno.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "wintrust.lib")

#define PROPR_MAX_ENTRIES 64
#define PROPR_MAX_OUTPUT (128 * 1024)
#define PROPR_MAX_REQUEST 4096
#define PROPR_LAUNCH_FAILURE 23

typedef struct {
  ULONGLONG VolumeSerialNumber;
  FILE_ID_128 FileId;
} PROPR_FILE_ID_INFO;

typedef struct {
  char bytes[PROPR_MAX_OUTPUT];
  size_t length;
} output_buffer;

static int append(output_buffer *output, const char *value, size_t length) {
  if (length > sizeof(output->bytes) - output->length) return 0;
  memcpy(output->bytes + output->length, value, length);
  output->length += length;
  return 1;
}

static int append_literal(output_buffer *output, const char *value) {
  return append(output, value, strlen(value));
}

static int append_u64(output_buffer *output, ULONGLONG value) {
  char decimal[32];
  int length = snprintf(decimal, sizeof(decimal), "%llu", (unsigned long long)value);
  return length > 0 && (size_t)length < sizeof(decimal) && append(output, decimal, (size_t)length);
}

static int append_u32(output_buffer *output, DWORD value) {
  char decimal[16];
  int length = snprintf(decimal, sizeof(decimal), "%lu", (unsigned long)value);
  return length > 0 && (size_t)length < sizeof(decimal) && append(output, decimal, (size_t)length);
}

/* Convert the little-endian unsigned 128-bit Windows file ID without narrowing. */
static int append_file_id(output_buffer *output, const BYTE file_id[16]) {
  BYTE work[16];
  memcpy(work, file_id, sizeof(work));
  char reversed[40];
  size_t digits = 0;
  int nonzero = 1;
  while (nonzero) {
    unsigned int remainder = 0;
    nonzero = 0;
    for (int index = 15; index >= 0; index -= 1) {
      unsigned int current = (remainder << 8) | work[index];
      work[index] = (BYTE)(current / 10);
      remainder = current % 10;
      if (work[index] != 0) nonzero = 1;
    }
    reversed[digits++] = (char)('0' + remainder);
  }
  for (size_t index = 0; index < digits; index += 1) {
    if (!append(output, &reversed[digits - index - 1], 1)) return 0;
  }
  return 1;
}

static int sid_text(PSID sid, char *destination, size_t capacity) {
  LPWSTR wide = NULL;
  if (!IsValidSid(sid) || !ConvertSidToStringSidW(sid, &wide)) return 0;
  int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, -1,
                                   destination, (int)capacity, NULL, NULL);
  LocalFree(wide);
  return length > 1 && (size_t)length <= capacity;
}

/* Legacy bootstrap-only path mode retained for deterministic pre-authentication
   attack probes. Production setup and inspection use batch-v1 handles only. */
static HANDLE open_path(const wchar_t *path, DWORD access) {
  return CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                     NULL, OPEN_EXISTING,
                     FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
}

static int get_file_id(HANDLE handle, PROPR_FILE_ID_INFO *identity) {
  return GetFileInformationByHandleEx(handle, FileIdInfo, identity, sizeof(*identity));
}

static int same_file_id(const PROPR_FILE_ID_INFO *left, const PROPR_FILE_ID_INFO *right) {
  return left->VolumeSerialNumber == right->VolumeSerialNumber &&
         memcmp(left->FileId.Identifier, right->FileId.Identifier, 16) == 0;
}

static const char *authority_kind_text(const wchar_t *kind) {
  if (wcscmp(kind, L"ancestor") == 0) return "ancestor";
  if (wcscmp(kind, L"home") == 0) return "home";
  if (wcscmp(kind, L"root") == 0) return "root";
  if (wcscmp(kind, L"data") == 0) return "data";
  if (wcscmp(kind, L"env") == 0) return "env";
  return NULL;
}

static int inspect_entry(output_buffer *output, HANDLE handle, const char *current_sid,
                         int index, const wchar_t *kind) {
  int result = 0;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  PROPR_FILE_ID_INFO before;
  PROPR_FILE_ID_INFO after;
  BY_HANDLE_FILE_INFORMATION legacy;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;

  if (!get_file_id(handle, &before) || !GetFileInformationByHandle(handle, &legacy)) goto cleanup;
  int expected_directory = wcscmp(kind, L"env") != 0;
  int actual_directory = (legacy.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  const char *kind_text = authority_kind_text(kind);
  if (kind_text == NULL || expected_directory != actual_directory) goto cleanup;
  DWORD status = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, NULL, &dacl, NULL, &descriptor);
  if (status != ERROR_SUCCESS || owner == NULL || dacl == NULL ||
      !GetSecurityDescriptorControl(descriptor, &control, &revision)) goto cleanup;

  char owner_sid[192];
  if (!sid_text(owner, owner_sid, sizeof(owner_sid))) goto cleanup;
  if (!append_literal(output, "{\"index\":") ||
      !append_u32(output, (DWORD)index) ||
      !append_literal(output, ",\"kind\":\"") ||
      !append(output, actual_directory ? "directory" : "file", actual_directory ? 9 : 4) ||
      !append_literal(output, "\",\"authorityKind\":\"") ||
      !append_literal(output, kind_text) ||
      !append_literal(output, "\",\"currentUserSid\":\"") ||
      !append_literal(output, current_sid) ||
      !append_literal(output, "\",\"ownerSid\":\"") ||
      !append_literal(output, owner_sid) ||
      !append_literal(output, "\",\"daclProtected\":") ||
      !append_literal(output, (control & SE_DACL_PROTECTED) ? "true" : "false") ||
      !append_literal(output, ",\"reparsePoint\":") ||
      !append_literal(output, (legacy.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? "true" : "false") ||
      !append_literal(output, ",\"volumeSerialNumber\":\"") ||
      !append_u64(output, before.VolumeSerialNumber) ||
      !append_literal(output, "\",\"fileId\":\"") ||
      !append_file_id(output, before.FileId.Identifier) ||
      !append_literal(output, "\",\"rules\":[")) goto cleanup;

  if (dacl->AceCount > 256) goto cleanup;
  for (DWORD index = 0; index < dacl->AceCount; index += 1) {
    void *raw_ace = NULL;
    if (!GetAce(dacl, index, &raw_ace)) goto cleanup;
    ACE_HEADER *header = (ACE_HEADER *)raw_ace;
    DWORD mask;
    PSID sid;
    const char *access_type;
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)raw_ace;
      mask = ace->Mask;
      sid = (PSID)&ace->SidStart;
      access_type = "allow";
    } else if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
      ACCESS_DENIED_ACE *ace = (ACCESS_DENIED_ACE *)raw_ace;
      mask = ace->Mask;
      sid = (PSID)&ace->SidStart;
      access_type = "deny";
    } else {
      goto cleanup;
    }
    char rule_sid[192];
    if (!sid_text(sid, rule_sid, sizeof(rule_sid))) goto cleanup;
    if ((index != 0 && !append_literal(output, ",")) ||
        !append_literal(output, "{\"identitySid\":\"") ||
        !append_literal(output, rule_sid) ||
        !append_literal(output, "\",\"inherited\":") ||
        !append_literal(output, (header->AceFlags & INHERITED_ACE) ? "true" : "false") ||
        !append_literal(output, ",\"accessType\":\"") ||
        !append_literal(output, access_type) ||
        !append_literal(output, "\",\"appliesToSelf\":") ||
        !append_literal(output, (header->AceFlags & INHERIT_ONLY_ACE) ? "false" : "true") ||
        !append_literal(output, ",\"rights\":\"") ||
        !append_u32(output, mask) ||
        !append_literal(output, "\"}")) goto cleanup;
  }
  if (!get_file_id(handle, &after) || !same_file_id(&before, &after) ||
      !append_literal(output, "],\"verifiedVolumeSerialNumber\":\"") ||
      !append_u64(output, after.VolumeSerialNumber) ||
      !append_literal(output, "\",\"verifiedFileId\":\"") ||
      !append_file_id(output, after.FileId.Identifier) ||
      !append_literal(output, "\"}")) goto cleanup;
  result = 1;

cleanup:
  if (descriptor != NULL) LocalFree(descriptor);
  return result;
}

static int add_full_control_ace(PACL acl, PSID sid, DWORD inheritance) {
  return AddAccessAllowedAceEx(acl, ACL_REVISION, inheritance, FILE_ALL_ACCESS, sid);
}

static int protect_entry(HANDLE handle, int directory, PSID current_sid) {
  int result = 0;
  BY_HANDLE_FILE_INFORMATION information;
  PSID system_sid = NULL;
  PSID administrators_sid = NULL;
  PACL acl = NULL;
  if (!GetFileInformationByHandle(handle, &information) ||
      (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) goto cleanup;
  if (!ConvertStringSidToSidW(L"S-1-5-18", &system_sid) ||
      !ConvertStringSidToSidW(L"S-1-5-32-544", &administrators_sid)) goto cleanup;
  DWORD acl_size = sizeof(ACL);
  PSID principals[3] = { current_sid, system_sid, administrators_sid };
  for (int index = 0; index < 3; index += 1) {
    acl_size += sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(principals[index]);
  }
  acl = (PACL)LocalAlloc(LPTR, acl_size);
  if (acl == NULL || !InitializeAcl(acl, acl_size, ACL_REVISION)) goto cleanup;
  DWORD inheritance = directory ? (CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE) : 0;
  for (int index = 0; index < 3; index += 1) {
    if (!add_full_control_ace(acl, principals[index], inheritance)) goto cleanup;
  }
  DWORD status = SetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    current_sid, NULL, acl, NULL);
  if (status != ERROR_SUCCESS) goto cleanup;
  result = 1;

cleanup:
  if (acl != NULL) LocalFree(acl);
  if (administrators_sid != NULL) LocalFree(administrators_sid);
  if (system_sid != NULL) LocalFree(system_sid);
  return result;
}

static int current_user_sid(BYTE **token_buffer, PSID *sid, char *text, size_t capacity) {
  HANDLE token = NULL;
  DWORD size = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  if (size == 0 || size > 65536) { CloseHandle(token); return 0; }
  *token_buffer = (BYTE *)LocalAlloc(LPTR, size);
  if (*token_buffer == NULL ||
      !GetTokenInformation(token, TokenUser, *token_buffer, size, &size)) {
    if (*token_buffer != NULL) LocalFree(*token_buffer);
    *token_buffer = NULL;
    CloseHandle(token);
    return 0;
  }
  CloseHandle(token);
  *sid = ((TOKEN_USER *)*token_buffer)->User.Sid;
  return sid_text(*sid, text, capacity);
}

static int write_output(const output_buffer *output) {
  size_t written = fwrite(output->bytes, 1, output->length, stdout);
  return written == output->length && fflush(stdout) == 0;
}

static int parse_uintptr(const wchar_t *text, ULONG_PTR *value) {
  if (text == NULL || text[0] == L'\0' || text[0] == L'-') return 0;
  wchar_t *end = NULL;
  errno = 0;
  unsigned long long parsed = _wcstoui64(text, &end, 10);
  if (errno != 0 || end == text || *end != L'\0' || parsed > (unsigned long long)(ULONG_PTR)-1) return 0;
  *value = (ULONG_PTR)parsed;
  return 1;
}

static int request_line(char *request, size_t length, size_t *offset, char **line) {
  if (*offset >= length) return 0;
  size_t start = *offset;
  while (*offset < length && request[*offset] != '\n') {
    unsigned char value = (unsigned char)request[*offset];
    if (value == 0 || value == '\r' || value > 0x7f) return 0;
    *offset += 1;
  }
  if (*offset >= length || request[*offset] != '\n') return 0;
  request[*offset] = '\0';
  *offset += 1;
  *line = request + start;
  return 1;
}

static int request_id_valid(const char *value) {
  if (strlen(value) != 32) return 0;
  for (size_t index = 0; index < 32; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static int parse_count(const char *value, int *count) {
  if (value[0] < '1' || value[0] > '9') return 0;
  unsigned int parsed = 0;
  for (size_t index = 0; value[index] != '\0'; index += 1) {
    if (value[index] < '0' || value[index] > '9') return 0;
    parsed = parsed * 10u + (unsigned int)(value[index] - '0');
    if (parsed > PROPR_MAX_ENTRIES) return 0;
  }
  *count = (int)parsed;
  return 1;
}

static int read_batch_request(char request[PROPR_MAX_REQUEST + 1], char **request_id,
                              int *protect, int *count, char *kinds[PROPR_MAX_ENTRIES]) {
  size_t length = fread(request, 1, PROPR_MAX_REQUEST + 1, stdin);
  if (ferror(stdin) || length == 0 || length > PROPR_MAX_REQUEST) return 0;
  size_t offset = 0;
  char *line = NULL;
  if (!request_line(request, length, &offset, &line) || strcmp(line, "PROPR_AUTHORITY_V1") != 0 ||
      !request_line(request, length, &offset, request_id) || !request_id_valid(*request_id) ||
      !request_line(request, length, &offset, &line)) return 0;
  if (strcmp(line, "inspect") == 0) *protect = 0;
  else if (strcmp(line, "protect") == 0) *protect = 1;
  else return 0;
  if (!request_line(request, length, &offset, &line) || !parse_count(line, count)) return 0;
  for (int index = 0; index < *count; index += 1) {
    if (!request_line(request, length, &offset, &kinds[index])) return 0;
    if (*protect) {
      if (strcmp(kinds[index], "directory") != 0 && strcmp(kinds[index], "file") != 0) return 0;
    } else if (strcmp(kinds[index], "ancestor") != 0 && strcmp(kinds[index], "home") != 0 &&
               strcmp(kinds[index], "root") != 0 && strcmp(kinds[index], "data") != 0 &&
               strcmp(kinds[index], "env") != 0) return 0;
  }
  return offset == length;
}

static const wchar_t *wide_kind(const char *kind) {
  if (strcmp(kind, "ancestor") == 0) return L"ancestor";
  if (strcmp(kind, "home") == 0) return L"home";
  if (strcmp(kind, "root") == 0 || strcmp(kind, "directory") == 0) return L"root";
  if (strcmp(kind, "data") == 0) return L"data";
  if (strcmp(kind, "env") == 0 || strcmp(kind, "file") == 0) return L"env";
  return NULL;
}

static HANDLE reopen_for_protection(HANDLE source, int directory) {
  PROPR_FILE_ID_INFO before;
  PROPR_FILE_ID_INFO after;
  BY_HANDLE_FILE_INFORMATION information;
  if (!get_file_id(source, &before) || !GetFileInformationByHandle(source, &information) ||
      ((information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory ||
      (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return INVALID_HANDLE_VALUE;
  HANDLE reopened = ReOpenFile(source, READ_CONTROL | WRITE_DAC | WRITE_OWNER,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
  if (reopened == INVALID_HANDLE_VALUE || !get_file_id(reopened, &after) || !same_file_id(&before, &after)) {
    if (reopened != INVALID_HANDLE_VALUE) CloseHandle(reopened);
    return INVALID_HANDLE_VALUE;
  }
  return reopened;
}

static int hex_digest(const char *text) {
  if (text == NULL || strlen(text) != 64) return 0;
  for (size_t index = 0; index < 64; index += 1) {
    if (!((text[index] >= '0' && text[index] <= '9') ||
          (text[index] >= 'a' && text[index] <= 'f'))) return 0;
  }
  return 1;
}

static int sha256_handle(HANDLE file, char output[65]) {
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  BYTE *object = NULL;
  DWORD object_size = 0;
  DWORD received = 0;
  BYTE digest[32];
  LARGE_INTEGER original;
  original.QuadPart = 0;
  LARGE_INTEGER zero;
  zero.QuadPart = 0;
  int result = 0;
  if (!SetFilePointerEx(file, zero, &original, FILE_CURRENT) ||
      BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&object_size,
                        sizeof(object_size), &received, 0) < 0 || object_size == 0 || object_size > 65536) goto cleanup;
  object = (BYTE *)HeapAlloc(GetProcessHeap(), 0, object_size);
  if (object == NULL || BCryptCreateHash(algorithm, &hash, object, object_size, NULL, 0, 0) < 0 ||
      !SetFilePointerEx(file, zero, NULL, FILE_BEGIN)) goto cleanup;
  BYTE buffer[16384];
  for (;;) {
    DWORD count = 0;
    if (!ReadFile(file, buffer, sizeof(buffer), &count, NULL)) goto cleanup;
    if (count == 0) break;
    if (BCryptHashData(hash, buffer, count, 0) < 0) goto cleanup;
  }
  if (BCryptFinishHash(hash, digest, sizeof(digest), 0) < 0) goto cleanup;
  static const char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 15];
  }
  output[64] = '\0';
  result = 1;

cleanup:
  if (file != INVALID_HANDLE_VALUE) SetFilePointerEx(file, original, NULL, FILE_BEGIN);
  if (hash != NULL) BCryptDestroyHash(hash);
  if (object != NULL) HeapFree(GetProcessHeap(), 0, object);
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  return result;
}

static int ordinary_file(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION information;
  return handle != INVALID_HANDLE_VALUE && GetFileInformationByHandle(handle, &information) &&
         (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
}

static int verify_authenticode(const wchar_t *path) {
  WINTRUST_FILE_INFO file;
  WINTRUST_DATA data;
  ZeroMemory(&file, sizeof(file));
  ZeroMemory(&data, sizeof(data));
  file.cbStruct = sizeof(file);
  file.pcwszFilePath = path;
  data.cbStruct = sizeof(data);
  data.dwUIChoice = WTD_UI_NONE;
  data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
  data.dwUnionChoice = WTD_CHOICE_FILE;
  data.pFile = &file;
  data.dwStateAction = WTD_STATEACTION_VERIFY;
  data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  LONG status = WinVerifyTrust(INVALID_HANDLE_VALUE, &policy, &data);
  data.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(INVALID_HANDLE_VALUE, &policy, &data);
  return status == ERROR_SUCCESS;
}

static int secure_launch_supervisor(int argc, wchar_t **argv) {
  if (argc != 7 || argv[2] == NULL || argv[2][0] == L'\0' || wcschr(argv[2], L'"') != NULL) return PROPR_LAUNCH_FAILURE;
  int production = wcscmp(argv[3], L"production") == 0;
  int validation = wcscmp(argv[3], L"validation") == 0;
  int validation_job_failure = wcscmp(argv[3], L"validation-job-failure") == 0;
  char expected[65];
  char leaf[65];
  char spki[65];
  if ((!production && !validation && !validation_job_failure) ||
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[4], -1, expected, sizeof(expected), NULL, NULL) != 65 ||
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[5], -1, leaf, sizeof(leaf), NULL, NULL) != 65 ||
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[6], -1, spki, sizeof(spki), NULL, NULL) != 65 ||
      !hex_digest(expected) || (production && (!hex_digest(leaf) || !hex_digest(spki)))) return PROPR_LAUNCH_FAILURE;
  wchar_t launcher_path[32768];
  DWORD launcher_length = GetModuleFileNameW(NULL, launcher_path,
    sizeof(launcher_path) / sizeof(launcher_path[0]));
  if (launcher_length == 0 || launcher_length >= sizeof(launcher_path) / sizeof(launcher_path[0]) ||
      (production && !verify_authenticode(launcher_path))) return PROPR_LAUNCH_FAILURE;

  intptr_t inherited_value = _get_osfhandle(4);
  if (inherited_value == -1) return PROPR_LAUNCH_FAILURE;
  HANDLE inherited = (HANDLE)inherited_value;
  HANDLE lease = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                             FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  PROPR_FILE_ID_INFO inherited_id;
  PROPR_FILE_ID_INFO lease_id;
  char inherited_hash[65];
  char lease_hash[65];
  if (!ordinary_file(inherited) || !ordinary_file(lease) || !get_file_id(inherited, &inherited_id) ||
      !get_file_id(lease, &lease_id) || !same_file_id(&inherited_id, &lease_id) ||
      !sha256_handle(inherited, inherited_hash) || !sha256_handle(lease, lease_hash) ||
      strcmp(inherited_hash, expected) != 0 || strcmp(lease_hash, expected) != 0 ||
      (production && !verify_authenticode(argv[2]))) {
    if (lease != INVALID_HANDLE_VALUE) CloseHandle(lease);
    return PROPR_LAUNCH_FAILURE;
  }

  STARTUPINFOW startup;
  PROCESS_INFORMATION child;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&child, sizeof(child));
  startup.cb = sizeof(startup);
  GetStartupInfoW(&startup);
  wchar_t command[32768];
  int length = (validation || validation_job_failure)
    ? swprintf(command, sizeof(command) / sizeof(command[0]), validation_job_failure
        ? L"\"%ls\" --lease-validation-job-failure-v2" : L"\"%ls\" --lease-validation-v2", argv[2])
    : swprintf(command, sizeof(command) / sizeof(command[0]), L"\"%ls\" --lease-v2 %ls %ls", argv[2], argv[5], argv[6]);
  HANDLE job = NULL;
  int status = PROPR_LAUNCH_FAILURE;
  if (length <= 0 || length >= (int)(sizeof(command) / sizeof(command[0])) ||
      !CreateProcessW(argv[2], command, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
                      NULL, NULL, &startup, &child)) goto launch_cleanup;
  job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == NULL || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !AssignProcessToJobObject(job, child.hProcess)) goto launch_cleanup;

  wchar_t loaded_path[32768];
  DWORD loaded_length = sizeof(loaded_path) / sizeof(loaded_path[0]);
  if (!QueryFullProcessImageNameW(child.hProcess, 0, loaded_path, &loaded_length)) goto launch_cleanup;
  HANDLE loaded = CreateFileW(loaded_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  PROPR_FILE_ID_INFO loaded_id;
  char loaded_hash[65];
  int loaded_ok = ordinary_file(loaded) && get_file_id(loaded, &loaded_id) && same_file_id(&lease_id, &loaded_id) &&
                  sha256_handle(loaded, loaded_hash) && strcmp(loaded_hash, expected) == 0;
  if (loaded != INVALID_HANDLE_VALUE) CloseHandle(loaded);
  if (!loaded_ok || ResumeThread(child.hThread) == (DWORD)-1) goto launch_cleanup;
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) goto launch_cleanup;
  DWORD exit_code = PROPR_LAUNCH_FAILURE;
  if (GetExitCodeProcess(child.hProcess, &exit_code)) status = (int)exit_code;

launch_cleanup:
  if (status == PROPR_LAUNCH_FAILURE && child.hProcess != NULL) TerminateProcess(child.hProcess, PROPR_LAUNCH_FAILURE);
  if (child.hThread != NULL) CloseHandle(child.hThread);
  if (child.hProcess != NULL) CloseHandle(child.hProcess);
  if (job != NULL) CloseHandle(job);
  CloseHandle(lease);
  return status;
}

static int print_system_paths(void) {
  wchar_t windows_path[32768];
  wchar_t system_windows_path[32768];
  UINT windows_length = GetWindowsDirectoryW(windows_path, sizeof(windows_path) / sizeof(windows_path[0]));
  UINT system_length = GetSystemWindowsDirectoryW(system_windows_path,
    sizeof(system_windows_path) / sizeof(system_windows_path[0]));
  if (windows_length == 0 || system_length == 0 ||
      windows_length >= sizeof(windows_path) / sizeof(windows_path[0]) ||
      system_length >= sizeof(system_windows_path) / sizeof(system_windows_path[0])) return PROPR_LAUNCH_FAILURE;
  char windows_utf8[32768];
  char system_utf8[32768];
  int first = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, windows_path, -1,
                                  windows_utf8, sizeof(windows_utf8), NULL, NULL);
  int second = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, system_windows_path, -1,
                                   system_utf8, sizeof(system_utf8), NULL, NULL);
  if (first <= 1 || second <= 1) return PROPR_LAUNCH_FAILURE;
  return fputs(windows_utf8, stdout) >= 0 && fputc('\n', stdout) != EOF &&
         fputs(system_utf8, stdout) >= 0 && fputc('\n', stdout) != EOF && fflush(stdout) == 0
    ? 0 : PROPR_LAUNCH_FAILURE;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && wcscmp(argv[1], L"system-paths-v1") == 0) return print_system_paths();
  if (argc >= 2 && wcscmp(argv[1], L"launch-supervisor-v2") == 0) return secure_launch_supervisor(argc, argv);
  if (argc == 2 && (wcscmp(argv[1], L"ping") == 0 || wcscmp(argv[1], L"ping-hold") == 0)) {
    if (wcscmp(argv[1], L"ping-hold") == 0) Sleep(1000);
    static const char response[] = "{\"version\":1,\"ready\":true}\n";
    return fwrite(response, 1, sizeof(response) - 1, stdout) == sizeof(response) - 1 && fflush(stdout) == 0 ? 0 : 14;
  }
  if (argc == 2 && wcscmp(argv[1], L"batch-v1") == 0) {
    char request[PROPR_MAX_REQUEST + 1];
    char *request_id = NULL;
    char *kinds[PROPR_MAX_ENTRIES];
    int protect = 0;
    int count = 0;
    if (!read_batch_request(request, &request_id, &protect, &count, kinds)) return 10;
    BYTE *token_buffer = NULL;
    PSID user_sid = NULL;
    char user_sid_text[192];
    if (!current_user_sid(&token_buffer, &user_sid, user_sid_text, sizeof(user_sid_text))) return 12;
    HANDLE handles[PROPR_MAX_ENTRIES];
    for (int index = 0; index < count; index += 1) handles[index] = INVALID_HANDLE_VALUE;
    output_buffer output = {{0}, 0};
    for (int index = 0; index < count; index += 1) {
      intptr_t inherited = _get_osfhandle(3 + index);
      if (inherited == -1) goto batch_failure;
      HANDLE source = (HANDLE)inherited;
      handles[index] = protect
        ? reopen_for_protection(source, strcmp(kinds[index], "directory") == 0)
        : source;
      if (handles[index] == INVALID_HANDLE_VALUE) goto batch_failure;
    }
    if (protect) {
      for (int index = 0; index < count; index += 1) {
        if (!protect_entry(handles[index], strcmp(kinds[index], "directory") == 0, user_sid)) goto batch_failure;
      }
    }
    if (!append_literal(&output, "{\"version\":1,\"requestId\":\"") ||
        !append_literal(&output, request_id) || !append_literal(&output, "\",")) goto batch_failure;
    if (protect && (!append_literal(&output, "\"protected\":") ||
                    !append_u32(&output, (DWORD)count) || !append_literal(&output, ","))) goto batch_failure;
    if (!append_literal(&output, "\"entries\":[")) goto batch_failure;
    for (int index = 0; index < count; index += 1) {
      const wchar_t *kind = wide_kind(kinds[index]);
      if (kind == NULL || (index != 0 && !append_literal(&output, ",")) ||
          !inspect_entry(&output, handles[index], user_sid_text, index, kind)) goto batch_failure;
    }
    if (!append_literal(&output, "]}\n")) goto batch_failure;
    for (int index = 0; index < count; index += 1) {
      if (protect && handles[index] != INVALID_HANDLE_VALUE) CloseHandle(handles[index]);
    }
    LocalFree(token_buffer);
    return write_output(&output) ? 0 : 14;

batch_failure:
    for (int index = 0; index < count; index += 1) {
      if (protect && handles[index] != INVALID_HANDLE_VALUE) CloseHandle(handles[index]);
    }
    LocalFree(token_buffer);
    return 13;
  }
  if (argc < 3) return 10;
  int inspect = wcscmp(argv[1], L"inspect") == 0;
  int inspect_parent = wcscmp(argv[1], L"inspect-parent") == 0;
  int protect = wcscmp(argv[1], L"protect") == 0;
  if (!inspect && !inspect_parent && !protect) return 11;
  if ((inspect && argc - 2 > PROPR_MAX_ENTRIES) ||
      (inspect_parent && (argc < 5 || ((argc - 3) % 2) != 0 || (argc - 3) / 2 > PROPR_MAX_ENTRIES)) ||
      (protect && (((argc - 2) % 2) != 0 || (argc - 2) / 2 > PROPR_MAX_ENTRIES))) return 10;
  BYTE *token_buffer = NULL;
  PSID user_sid = NULL;
  char user_sid_text[192];
  if (!current_user_sid(&token_buffer, &user_sid, user_sid_text, sizeof(user_sid_text))) return 12;

  output_buffer output = {{0}, 0};
  int count = inspect ? argc - 2 : inspect_parent ? (argc - 3) / 2 : (argc - 2) / 2;
  HANDLE handles[PROPR_MAX_ENTRIES];
  for (int index = 0; index < count; index += 1) handles[index] = INVALID_HANDLE_VALUE;
  HANDLE parent_process = NULL;
  if (inspect_parent) {
    ULONG_PTR parent_pid = 0;
    if (!parse_uintptr(argv[2], &parent_pid) || parent_pid == 0 || parent_pid > MAXDWORD) goto failure;
    parent_process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, (DWORD)parent_pid);
    if (parent_process == NULL) goto failure;
  }

  /* Inspection never receives or resolves an authority pathname. Node passes
     each already-open pinned object as child fd 3+index; the CRT descriptor
     table exposes the exact inherited HANDLE through _get_osfhandle. */
  for (int index = 0; index < count; index += 1) {
    if (inspect || inspect_parent) {
      const wchar_t *kind = inspect ? argv[2 + index] : argv[3 + index * 2];
      if (wcscmp(kind, L"ancestor") != 0 && wcscmp(kind, L"home") != 0 &&
          wcscmp(kind, L"root") != 0 && wcscmp(kind, L"data") != 0 &&
          wcscmp(kind, L"env") != 0) goto failure;
      if (inspect) {
        intptr_t inherited = _get_osfhandle(3 + index);
        if (inherited == -1) goto failure;
        handles[index] = (HANDLE)inherited;
      } else {
        ULONG_PTR source_value = 0;
        if (!parse_uintptr(argv[4 + index * 2], &source_value) || source_value == 0 ||
            !DuplicateHandle(parent_process, (HANDLE)source_value, GetCurrentProcess(),
                             &handles[index], 0, FALSE, DUPLICATE_SAME_ACCESS)) goto failure;
      }
    } else {
      const wchar_t *kind = argv[2 + index * 2];
      const wchar_t *path = argv[3 + index * 2];
      if (path[0] == L'\0') goto failure;
      if (wcscmp(kind, L"directory") != 0 && wcscmp(kind, L"file") != 0) goto failure;
      handles[index] = open_path(path, READ_CONTROL | WRITE_DAC | WRITE_OWNER);
    }
    if (handles[index] == INVALID_HANDLE_VALUE) goto failure;
  }

  if (inspect || inspect_parent) {
    if (!append_literal(&output, "{\"version\":1,\"entries\":[")) goto failure;
    for (int index = 0; index < count; index += 1) {
      if ((index != 0 && !append_literal(&output, ",")) ||
          !inspect_entry(&output, handles[index], user_sid_text, index,
                         inspect ? argv[2 + index] : argv[3 + index * 2])) goto failure;
    }
    if (!append_literal(&output, "]}\n")) goto failure;
  } else {
    for (int index = 0; index < count; index += 1) {
      const wchar_t *kind = argv[2 + index * 2];
      int directory = wcscmp(kind, L"directory") == 0;
      if (!protect_entry(handles[index], directory, user_sid)) goto failure;
    }
    if (!append_literal(&output, "{\"version\":1,\"protected\":") ||
        !append_u32(&output, (DWORD)count) || !append_literal(&output, "}\n")) goto failure;
  }
  if (protect || inspect_parent) {
    for (int index = 0; index < count; index += 1) CloseHandle(handles[index]);
  }
  if (parent_process != NULL) CloseHandle(parent_process);
  LocalFree(token_buffer);
  return write_output(&output) ? 0 : 14;

failure:
  for (int index = 0; index < count; index += 1) {
    if ((protect || inspect_parent) && handles[index] != INVALID_HANDLE_VALUE) CloseHandle(handles[index]);
  }
  if (parent_process != NULL) CloseHandle(parent_process);
  LocalFree(token_buffer);
  return 13;
}
