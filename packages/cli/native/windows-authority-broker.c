#define UNICODE
#define _UNICODE

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <stdint.h>
#include <io.h>
#include <stdio.h>
#include <string.h>

#define PROPR_MAX_ENTRIES 64
#define PROPR_MAX_OUTPUT (128 * 1024)

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

int wmain(int argc, wchar_t **argv) {
  if (argc < 3) return 10;
  int inspect = wcscmp(argv[1], L"inspect") == 0;
  int protect = wcscmp(argv[1], L"protect") == 0;
  if (!inspect && !protect) return 11;
  if ((inspect && argc - 2 > PROPR_MAX_ENTRIES) ||
      (protect && (((argc - 2) % 2) != 0 || (argc - 2) / 2 > PROPR_MAX_ENTRIES))) return 10;
  BYTE *token_buffer = NULL;
  PSID user_sid = NULL;
  char user_sid_text[192];
  if (!current_user_sid(&token_buffer, &user_sid, user_sid_text, sizeof(user_sid_text))) return 12;

  output_buffer output = {{0}, 0};
  int count = inspect ? argc - 2 : (argc - 2) / 2;
  HANDLE handles[PROPR_MAX_ENTRIES];
  for (int index = 0; index < count; index += 1) handles[index] = INVALID_HANDLE_VALUE;

  /* Inspection never receives or resolves an authority pathname. Node passes
     each already-open pinned object as child fd 3+index; the CRT descriptor
     table exposes the exact inherited HANDLE through _get_osfhandle. */
  for (int index = 0; index < count; index += 1) {
    if (inspect) {
      const wchar_t *kind = argv[2 + index];
      if (wcscmp(kind, L"ancestor") != 0 && wcscmp(kind, L"home") != 0 &&
          wcscmp(kind, L"root") != 0 && wcscmp(kind, L"data") != 0 &&
          wcscmp(kind, L"env") != 0) goto failure;
      intptr_t inherited = _get_osfhandle(3 + index);
      if (inherited == -1) goto failure;
      handles[index] = (HANDLE)inherited;
    } else {
      const wchar_t *kind = argv[2 + index * 2];
      const wchar_t *path = argv[3 + index * 2];
      if (path[0] == L'\0') goto failure;
      if (wcscmp(kind, L"directory") != 0 && wcscmp(kind, L"file") != 0) goto failure;
      handles[index] = open_path(path, READ_CONTROL | WRITE_DAC | WRITE_OWNER);
    }
    if (handles[index] == INVALID_HANDLE_VALUE) goto failure;
  }

  if (inspect) {
    if (!append_literal(&output, "{\"version\":1,\"entries\":[")) goto failure;
    for (int index = 0; index < count; index += 1) {
      if ((index != 0 && !append_literal(&output, ",")) ||
          !inspect_entry(&output, handles[index], user_sid_text, index, argv[2 + index])) goto failure;
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
  if (protect) {
    for (int index = 0; index < count; index += 1) CloseHandle(handles[index]);
  }
  LocalFree(token_buffer);
  return write_output(&output) ? 0 : 14;

failure:
  for (int index = 0; index < count; index += 1) {
    if (protect && handles[index] != INVALID_HANDLE_VALUE) CloseHandle(handles[index]);
  }
  LocalFree(token_buffer);
  return 13;
}
