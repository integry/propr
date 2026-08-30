#define UNICODE
#define _UNICODE

/*
 * Immutable Windows bootstrap authority.
 *
 * This deliberately small, separately versioned program is not rebuilt by
 * build-windows-authority-helper.mjs.  A clean checkout can therefore obtain
 * the OS directories and place the first packaged-broker CreateProcess behind
 * a native deny-write/delete lease without depending on the broker being
 * built.  The source and PE have independent SHA-256 pins in the build and
 * runtime loaders.
 */

#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <io.h>
#include <limits.h>
#include <sddl.h>
#include <softpub.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wincrypt.h>
#include <wintrust.h>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "wintrust.lib")

#define PROPR_FAILURE 23
#define PROPR_BUILD_MANIFEST_LIMIT (64 * 1024 * 1024)
#define PROPR_BUILD_INPUT_LIMIT 30000

typedef struct {
  ULONGLONG VolumeSerialNumber;
  FILE_ID_128 FileId;
} PROPR_FILE_ID_INFO;

static int hex_digest(const char *text) {
  if (text == NULL || strlen(text) != 64) return 0;
  for (size_t index = 0; index < 64; index += 1) {
    if (!((text[index] >= '0' && text[index] <= '9') ||
          (text[index] >= 'a' && text[index] <= 'f'))) return 0;
  }
  return 1;
}

static int ordinary_file(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION information;
  return handle != INVALID_HANDLE_VALUE && GetFileInformationByHandle(handle, &information) &&
    (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 &&
    information.nNumberOfLinks == 1;
}

static int get_file_id(HANDLE handle, PROPR_FILE_ID_INFO *identity) {
  return GetFileInformationByHandleEx(handle, FileIdInfo, identity, sizeof(*identity));
}

static int same_file_id(const PROPR_FILE_ID_INFO *left, const PROPR_FILE_ID_INFO *right) {
  return left->VolumeSerialNumber == right->VolumeSerialNumber &&
    memcmp(left->FileId.Identifier, right->FileId.Identifier, 16) == 0;
}

static int sha256_bytes(const BYTE *bytes, DWORD length, BYTE output[32]) {
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  BYTE *object = NULL;
  DWORD object_size = 0;
  DWORD received = 0;
  int result = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&object_size,
                        sizeof(object_size), &received, 0) < 0 || object_size == 0 || object_size > 65536) goto cleanup;
  object = (BYTE *)HeapAlloc(GetProcessHeap(), 0, object_size);
  if (object == NULL || BCryptCreateHash(algorithm, &hash, object, object_size, NULL, 0, 0) < 0 ||
      BCryptHashData(hash, (PUCHAR)bytes, length, 0) < 0 ||
      BCryptFinishHash(hash, output, 32, 0) < 0) goto cleanup;
  result = 1;
cleanup:
  if (hash != NULL) BCryptDestroyHash(hash);
  if (object != NULL) HeapFree(GetProcessHeap(), 0, object);
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  return result;
}

static int hmac_sha256(const BYTE key[32], const BYTE *bytes, DWORD length, BYTE output[32]) {
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  BYTE *object = NULL;
  DWORD object_size = 0;
  DWORD received = 0;
  int result = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL,
      BCRYPT_ALG_HANDLE_HMAC_FLAG) < 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&object_size,
        sizeof(object_size), &received, 0) < 0 || object_size == 0 || object_size > 65536) goto cleanup;
  object = (BYTE *)HeapAlloc(GetProcessHeap(), 0, object_size);
  if (object == NULL || BCryptCreateHash(algorithm, &hash, object, object_size,
      (PUCHAR)key, 32, 0) < 0 || BCryptHashData(hash, (PUCHAR)bytes, length, 0) < 0 ||
      BCryptFinishHash(hash, output, 32, 0) < 0) goto cleanup;
  result = 1;
cleanup:
  if (hash != NULL) BCryptDestroyHash(hash);
  if (object != NULL) HeapFree(GetProcessHeap(), 0, object);
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  return result;
}

static int sha256_handle(HANDLE file, char output[65]) {
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  BYTE *object = NULL;
  DWORD object_size = 0;
  DWORD received = 0;
  BYTE digest[32];
  LARGE_INTEGER original;
  LARGE_INTEGER zero;
  original.QuadPart = 0;
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
  SetFilePointerEx(file, original, NULL, FILE_BEGIN);
  if (hash != NULL) BCryptDestroyHash(hash);
  if (object != NULL) HeapFree(GetProcessHeap(), 0, object);
  if (algorithm != NULL) BCryptCloseAlgorithmProvider(algorithm, 0);
  return result;
}

static int current_user_sid(BYTE **token_buffer, PSID *sid) {
  HANDLE token = NULL;
  DWORD size = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  if (size == 0 || size > 65536) { CloseHandle(token); return 0; }
  *token_buffer = (BYTE *)LocalAlloc(LPTR, size);
  if (*token_buffer == NULL || !GetTokenInformation(token, TokenUser, *token_buffer, size, &size)) {
    if (*token_buffer != NULL) LocalFree(*token_buffer);
    *token_buffer = NULL;
    CloseHandle(token);
    return 0;
  }
  CloseHandle(token);
  *sid = ((TOKEN_USER *)*token_buffer)->User.Sid;
  return IsValidSid(*sid);
}

static int protect_and_validate(HANDLE handle, PSID current_user) {
  PSID system_sid = NULL;
  PSID administrators_sid = NULL;
  PACL acl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL actual_dacl = NULL;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  int result = 0;
  if (!ordinary_file(handle) ||
      !ConvertStringSidToSidW(L"S-1-5-18", &system_sid) ||
      !ConvertStringSidToSidW(L"S-1-5-32-544", &administrators_sid)) goto cleanup;
  PSID principals[3] = { current_user, system_sid, administrators_sid };
  DWORD acl_size = sizeof(ACL);
  for (int index = 0; index < 3; index += 1) {
    acl_size += sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(principals[index]);
  }
  acl = (PACL)LocalAlloc(LPTR, acl_size);
  if (acl == NULL || !InitializeAcl(acl, acl_size, ACL_REVISION)) goto cleanup;
  for (int index = 0; index < 3; index += 1) {
    if (!AddAccessAllowedAceEx(acl, ACL_REVISION, 0, FILE_ALL_ACCESS, principals[index])) goto cleanup;
  }
  if (SetSecurityInfo(handle, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      current_user, NULL, acl, NULL) != ERROR_SUCCESS) goto cleanup;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, NULL, &actual_dacl, NULL, &descriptor) != ERROR_SUCCESS || owner == NULL || actual_dacl == NULL ||
      !EqualSid(owner, current_user) || !GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      (control & SE_DACL_PROTECTED) == 0 || actual_dacl->AceCount != 3) goto cleanup;
  result = 1;
cleanup:
  if (descriptor != NULL) LocalFree(descriptor);
  if (acl != NULL) LocalFree(acl);
  if (administrators_sid != NULL) LocalFree(administrators_sid);
  if (system_sid != NULL) LocalFree(system_sid);
  return result;
}

static int trusted_build_input_acl(HANDLE handle) {
  BYTE *token_buffer = NULL;
  PSID current_user = NULL;
  PSID system_sid = NULL;
  PSID administrators_sid = NULL;
  PSID trusted_installer_sid = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  int result = 0;
  if (!current_user_sid(&token_buffer, &current_user) ||
      !ConvertStringSidToSidW(L"S-1-5-18", &system_sid) ||
      !ConvertStringSidToSidW(L"S-1-5-32-544", &administrators_sid) ||
      !ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
        &trusted_installer_sid) ||
      GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &dacl, NULL, &descriptor) != ERROR_SUCCESS || owner == NULL || dacl == NULL) goto acl_cleanup;
  if (!EqualSid(owner, current_user) && !EqualSid(owner, system_sid) &&
      !EqualSid(owner, administrators_sid) && !EqualSid(owner, trusted_installer_sid)) goto acl_cleanup;
  if (dacl->AceCount > 256) goto acl_cleanup;
  const DWORD mutating = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
    DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD | GENERIC_WRITE | GENERIC_ALL;
  for (DWORD index = 0; index < dacl->AceCount; index += 1) {
    void *raw = NULL;
    if (!GetAce(dacl, index, &raw)) goto acl_cleanup;
    ACE_HEADER *header = (ACE_HEADER *)raw;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    /* Unknown, object-specific and callback allow ACEs are not silently
       reinterpreted: only the exact ordinary allow shape is authorized. */
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) goto acl_cleanup;
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)raw;
    PSID sid = (PSID)&ace->SidStart;
    if ((ace->Mask & mutating) != 0 && !EqualSid(sid, current_user) && !EqualSid(sid, system_sid) &&
        !EqualSid(sid, administrators_sid) && !EqualSid(sid, trusted_installer_sid)) goto acl_cleanup;
  }
  result = 1;
acl_cleanup:
  if (descriptor != NULL) LocalFree(descriptor);
  if (trusted_installer_sid != NULL) LocalFree(trusted_installer_sid);
  if (administrators_sid != NULL) LocalFree(administrators_sid);
  if (system_sid != NULL) LocalFree(system_sid);
  if (token_buffer != NULL) LocalFree(token_buffer);
  return result;
}

static void digest_hex(const BYTE digest[32], char output[65]) {
  static const char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < 32; index += 1) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 15];
  }
  output[64] = '\0';
}

/* Build tools use an explicit embedded-signature policy. Catalog-only and
   unsigned images are rejected rather than silently changing trust modes. */
static int read_embedded_authenticode_pins(const wchar_t *path, char leaf[65], char spki[65]) {
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
  int result = 0;
  if (WinVerifyTrust(INVALID_HANDLE_VALUE, &policy, &data) == ERROR_SUCCESS) {
    CRYPT_PROVIDER_DATA *provider = WTHelperProvDataFromStateData(data.hWVTStateData);
    CRYPT_PROVIDER_SGNR *signer = provider == NULL ? NULL : WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0);
    PCCERT_CONTEXT certificate = signer == NULL || signer->csCertChain == 0 ? NULL : signer->pasCertChain[0].pCert;
    BYTE leaf_digest[32];
    BYTE spki_digest[32];
    BYTE *encoded_spki = NULL;
    DWORD encoded_size = 0;
    if (certificate != NULL && sha256_bytes(certificate->pbCertEncoded, certificate->cbCertEncoded, leaf_digest) &&
        CryptEncodeObjectEx(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO,
          &certificate->pCertInfo->SubjectPublicKeyInfo, CRYPT_ENCODE_ALLOC_FLAG, NULL,
          &encoded_spki, &encoded_size) && encoded_spki != NULL && encoded_size > 0 &&
        sha256_bytes(encoded_spki, encoded_size, spki_digest)) {
      digest_hex(leaf_digest, leaf);
      digest_hex(spki_digest, spki);
      result = 1;
    }
    if (encoded_spki != NULL) LocalFree(encoded_spki);
  }
  data.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(INVALID_HANDLE_VALUE, &policy, &data);
  return result;
}

static int verify_authenticode_pins(const wchar_t *path, const char *leaf, const char *spki) {
  char actual_leaf[65];
  char actual_spki[65];
  return leaf != NULL && spki != NULL && read_embedded_authenticode_pins(path, actual_leaf, actual_spki) &&
    strcmp(actual_leaf, leaf) == 0 && strcmp(actual_spki, spki) == 0;
}

static int print_signer_pins(const wchar_t *path) {
  char leaf[65];
  char spki[65];
  if (!read_embedded_authenticode_pins(path, leaf, spki)) return PROPR_FAILURE;
  return printf("E %s %s\n", leaf, spki) > 0 && fflush(stdout) == 0 ? 0 : PROPR_FAILURE;
}

static int quote_argument(wchar_t *output, size_t capacity, size_t *offset, const wchar_t *argument) {
  if (*offset + 2 >= capacity) return 0;
  output[(*offset)++] = L'"';
  size_t slashes = 0;
  for (const wchar_t *cursor = argument;; cursor += 1) {
    if (*cursor == L'\\') { slashes += 1; continue; }
    size_t repeats = slashes;
    if (*cursor == L'"' || *cursor == L'\0') repeats *= 2;
    if (*cursor == L'"') repeats += 1;
    if (*offset + repeats + 2 >= capacity) return 0;
    while (repeats-- > 0) output[(*offset)++] = L'\\';
    slashes = 0;
    if (*cursor == L'\0') break;
    output[(*offset)++] = *cursor;
  }
  output[(*offset)++] = L'"';
  output[*offset] = L'\0';
  return 1;
}

static int print_system_paths(void) {
  wchar_t windows_path[32768];
  wchar_t system_windows_path[32768];
  wchar_t system_path[32768];
  UINT first_length = GetWindowsDirectoryW(windows_path, 32768);
  UINT second_length = GetSystemWindowsDirectoryW(system_windows_path, 32768);
  UINT third_length = GetSystemDirectoryW(system_path, 32768);
  if (first_length == 0 || second_length == 0 || third_length == 0 ||
      first_length >= 32768 || second_length >= 32768 || third_length >= 32768) return PROPR_FAILURE;
  char first[32768];
  char second[32768];
  char third[32768];
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, windows_path, -1, first, sizeof(first), NULL, NULL) <= 1 ||
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, system_windows_path, -1, second, sizeof(second), NULL, NULL) <= 1 ||
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, system_path, -1, third, sizeof(third), NULL, NULL) <= 1) return PROPR_FAILURE;
  return printf("%s\n%s\n%s\n", first, second, third) > 0 && fflush(stdout) == 0 ? 0 : PROPR_FAILURE;
}

static int canonical_u64(const wchar_t *text, ULONGLONG *value) {
  if (text == NULL || text[0] == L'\0' || (text[0] == L'0' && text[1] != L'\0')) return 0;
  ULONGLONG parsed = 0;
  for (SIZE_T index = 0; text[index] != L'\0'; index += 1) {
    if (text[index] < L'0' || text[index] > L'9') return 0;
    ULONGLONG digit = (ULONGLONG)(text[index] - L'0');
    if (parsed > (ULLONG_MAX - digit) / 10) return 0;
    parsed = parsed * 10 + digit;
  }
  *value = parsed;
  return 1;
}

static int read_exact_fd(int fd, BYTE *bytes, int length) {
  int offset = 0;
  while (offset < length) {
    int count = _read(fd, bytes + offset, (unsigned int)(length - offset));
    if (count <= 0) return 0;
    offset += count;
  }
  return 1;
}

/* Retain exact deny-write/delete leases over a hash-bound build input set.
   Each worker receives a fresh MAC key only through inherited fd 4 and emits
   its own cumulative batch/file/byte frame after every lease is established.
   The parent starts the actual compiler/linker only after authenticating it. */
static int lease_build_inputs(int argc, wchar_t **argv) {
  if (argc != 11) return PROPR_FAILURE;
  ULONGLONG batch = 0, batches = 0, prior_files = 0, total_files = 0;
  ULONGLONG prior_bytes = 0, total_bytes = 0;
  if (!canonical_u64(argv[4], &batch) || !canonical_u64(argv[5], &batches) ||
      !canonical_u64(argv[6], &prior_files) || !canonical_u64(argv[7], &total_files) ||
      !canonical_u64(argv[8], &prior_bytes) || !canonical_u64(argv[9], &total_bytes) ||
      batch < 1 || batch > batches || batches > 128 || prior_files > total_files ||
      total_files > PROPR_BUILD_INPUT_LIMIT || prior_bytes > total_bytes ||
      total_bytes > 1024ULL * 1024ULL * 1024ULL) return PROPR_FAILURE;
  char progress_nonce[65];
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[10], -1, progress_nonce,
      sizeof(progress_nonce), NULL, NULL) != 65 || !hex_digest(progress_nonce)) return PROPR_FAILURE;
  intptr_t inherited_self_value = _get_osfhandle(3);
  wchar_t self_path[32768];
  DWORD self_length = GetModuleFileNameW(NULL, self_path, 32768);
  HANDLE inherited_self = inherited_self_value == -1 ? INVALID_HANDLE_VALUE : (HANDLE)inherited_self_value;
  HANDLE self_lease = self_length == 0 || self_length >= 32768 ? INVALID_HANDLE_VALUE :
    CreateFileW(self_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  PROPR_FILE_ID_INFO inherited_self_id;
  PROPR_FILE_ID_INFO self_id;
  char inherited_self_hash[65];
  char self_hash[65];
  if (!ordinary_file(inherited_self) || !ordinary_file(self_lease) ||
      !get_file_id(inherited_self, &inherited_self_id) || !get_file_id(self_lease, &self_id) ||
      !same_file_id(&inherited_self_id, &self_id) || !sha256_handle(inherited_self, inherited_self_hash) ||
      !sha256_handle(self_lease, self_hash) || strcmp(inherited_self_hash, self_hash) != 0) {
    if (self_lease != INVALID_HANDLE_VALUE) CloseHandle(self_lease);
    return PROPR_FAILURE;
  }
  char expected_manifest[65];
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[3], -1, expected_manifest,
      sizeof(expected_manifest), NULL, NULL) != 65 || !hex_digest(expected_manifest)) return PROPR_FAILURE;
  HANDLE manifest = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  LARGE_INTEGER size;
  char actual_manifest[65];
  if (!ordinary_file(manifest) || !GetFileSizeEx(manifest, &size) || size.QuadPart < 24 ||
      size.QuadPart > PROPR_BUILD_MANIFEST_LIMIT || !sha256_handle(manifest, actual_manifest) ||
      strcmp(actual_manifest, expected_manifest) != 0) {
    if (manifest != INVALID_HANDLE_VALUE) CloseHandle(manifest);
    CloseHandle(self_lease);
    return PROPR_FAILURE;
  }
  BYTE *bytes = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size.QuadPart + 1);
  HANDLE *leases = (HANDLE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
    sizeof(HANDLE) * PROPR_BUILD_INPUT_LIMIT);
  if (bytes == NULL || leases == NULL) goto lease_cleanup;
  SetFilePointer(manifest, 0, NULL, FILE_BEGIN);
  DWORD received = 0;
  if (!ReadFile(manifest, bytes, (DWORD)size.QuadPart, &received, NULL) || received != (DWORD)size.QuadPart) goto lease_cleanup;
  bytes[size.QuadPart] = 0;
  static const char header[] = "PROPR_BUILD_LEASE_V1\n";
  if ((SIZE_T)size.QuadPart <= sizeof(header) - 1 || memcmp(bytes, header, sizeof(header) - 1) != 0) goto lease_cleanup;
  SIZE_T offset = sizeof(header) - 1;
  int count = 0;
  ULONGLONG leased_bytes = 0;
  while (offset < (SIZE_T)size.QuadPart) {
    if (count >= PROPR_BUILD_INPUT_LIMIT || offset + 68 > (SIZE_T)size.QuadPart ||
        (bytes[offset] != 'T' && bytes[offset] != 'F') || bytes[offset + 1] != ' ') goto lease_cleanup;
    int tool = bytes[offset] == 'T';
    char expected[65];
    memcpy(expected, bytes + offset + 2, 64);
    expected[64] = '\0';
    if (!hex_digest(expected) || bytes[offset + 66] != ' ') goto lease_cleanup;
    char expected_leaf[65];
    char expected_spki[65];
    SIZE_T path_start = offset + 67;
    if (tool) {
      if (offset + 200 > (SIZE_T)size.QuadPart || bytes[offset + 67] != 'E' ||
          bytes[offset + 68] != ' ' || bytes[offset + 133] != ' ' || bytes[offset + 198] != ' ') goto lease_cleanup;
      memcpy(expected_leaf, bytes + offset + 69, 64);
      expected_leaf[64] = '\0';
      memcpy(expected_spki, bytes + offset + 134, 64);
      expected_spki[64] = '\0';
      if (!hex_digest(expected_leaf) || !hex_digest(expected_spki)) goto lease_cleanup;
      path_start = offset + 199;
    }
    SIZE_T end = path_start;
    while (end < (SIZE_T)size.QuadPart && bytes[end] != '\n') {
      if (bytes[end] == 0 || bytes[end] == '\r') goto lease_cleanup;
      end += 1;
    }
    if (end == (SIZE_T)size.QuadPart || end == path_start || end - path_start >= 32767) goto lease_cleanup;
    int wide_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (char *)bytes + path_start,
      (int)(end - path_start), NULL, 0);
    if (wide_length <= 0 || wide_length >= 32767) goto lease_cleanup;
    wchar_t *path = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, sizeof(wchar_t) * ((SIZE_T)wide_length + 1));
    if (path == NULL || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (char *)bytes + path_start,
        (int)(end - path_start), path, wide_length) != wide_length) {
      if (path != NULL) HeapFree(GetProcessHeap(), 0, path);
      goto lease_cleanup;
    }
    path[wide_length] = L'\0';
    HANDLE lease = CreateFileW(path, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, NULL,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    LARGE_INTEGER lease_size;
    char actual[65];
    if (!ordinary_file(lease) || !trusted_build_input_acl(lease) ||
        !GetFileSizeEx(lease, &lease_size) || lease_size.QuadPart < 0 ||
        (ULONGLONG)lease_size.QuadPart > total_bytes - prior_bytes - leased_bytes ||
        !sha256_handle(lease, actual) || strcmp(actual, expected) != 0 ||
        (tool && !verify_authenticode_pins(path, expected_leaf, expected_spki))) {
      HeapFree(GetProcessHeap(), 0, path);
      if (lease != INVALID_HANDLE_VALUE) CloseHandle(lease);
      goto lease_cleanup;
    }
    HeapFree(GetProcessHeap(), 0, path);
    leases[count++] = lease;
    leased_bytes += (ULONGLONG)lease_size.QuadPart;
    offset = end + 1;
  }
  ULONGLONG completed_files = prior_files + (ULONGLONG)count;
  ULONGLONG completed_bytes = prior_bytes + leased_bytes;
  BYTE progress_key[32];
  BYTE extra = 0;
  if (count == 0 || completed_files > total_files || completed_bytes > total_bytes ||
      !read_exact_fd(4, progress_key, sizeof(progress_key)) || _read(4, &extra, 1) != 0) goto lease_cleanup;
  char progress_body[384];
  int progress_length = _snprintf(progress_body, sizeof(progress_body),
    "PROPR_BUILD_LEASE_PROGRESS_V2 %llu/%llu %llu/%llu %llu/%llu %s",
    batch, batches, completed_files, total_files, completed_bytes, total_bytes, progress_nonce);
  BYTE progress_digest[32];
  char progress_mac[65];
  if (progress_length <= 0 || progress_length >= (int)sizeof(progress_body) ||
      !hmac_sha256(progress_key, (BYTE *)progress_body, (DWORD)progress_length, progress_digest)) goto lease_cleanup;
  SecureZeroMemory(progress_key, sizeof(progress_key));
  digest_hex(progress_digest, progress_mac);
  if (fprintf(stdout, "%s %s\n", progress_body, progress_mac) < 0 || fflush(stdout) != 0 ||
      fclose(stdout) != 0) goto lease_cleanup;
  int release = fgetc(stdin);
  if (release != 'X' || fgetc(stdin) != EOF) goto lease_cleanup;
  for (int index = 0; index < count; index += 1) CloseHandle(leases[index]);
  HeapFree(GetProcessHeap(), 0, leases);
  HeapFree(GetProcessHeap(), 0, bytes);
  CloseHandle(manifest);
  CloseHandle(self_lease);
  return 0;
lease_cleanup:
  if (leases != NULL) {
    for (int index = 0; index < PROPR_BUILD_INPUT_LIMIT; index += 1) {
      if (leases[index] != NULL && leases[index] != INVALID_HANDLE_VALUE) CloseHandle(leases[index]);
    }
    HeapFree(GetProcessHeap(), 0, leases);
  }
  if (bytes != NULL) HeapFree(GetProcessHeap(), 0, bytes);
  if (manifest != INVALID_HANDLE_VALUE) CloseHandle(manifest);
  if (self_lease != INVALID_HANDLE_VALUE) CloseHandle(self_lease);
  return PROPR_FAILURE;
}

static int launch_packaged_broker(int argc, wchar_t **argv) {
  int status = PROPR_FAILURE;
  if (argc < 9 || (wcscmp(argv[4], L"validation") != 0 && wcscmp(argv[4], L"production") != 0)) return PROPR_FAILURE;
  char expected[65];
  char leaf[65];
  char spki[65];
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[3], -1, expected, sizeof(expected), NULL, NULL) != 65 ||
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[5], -1, leaf, sizeof(leaf), NULL, NULL) != 65 ||
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[6], -1, spki, sizeof(spki), NULL, NULL) != 65 ||
      !hex_digest(expected)) return PROPR_FAILURE;
  int production = wcscmp(argv[4], L"production") == 0;
  if (production && (!hex_digest(leaf) || !hex_digest(spki))) return PROPR_FAILURE;

  intptr_t artifact_value = _get_osfhandle(6);
  intptr_t barrier_value = _get_osfhandle(7);
  intptr_t bootstrap_value = _get_osfhandle(8);
  if (artifact_value == -1 || barrier_value == -1 || bootstrap_value == -1) return PROPR_FAILURE;
  HANDLE inherited_artifact = (HANDLE)artifact_value;
  HANDLE barrier = (HANDLE)barrier_value;
  HANDLE inherited_bootstrap = (HANDLE)bootstrap_value;
  wchar_t self_path[32768];
  DWORD self_length = GetModuleFileNameW(NULL, self_path, 32768);
  HANDLE self_lease = self_length == 0 || self_length >= 32768 ? INVALID_HANDLE_VALUE :
    CreateFileW(self_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  HANDLE artifact_lease = CreateFileW(argv[2], GENERIC_READ | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
    FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BYTE *token_buffer = NULL;
  PSID user_sid = NULL;
  PROPR_FILE_ID_INFO self_id;
  PROPR_FILE_ID_INFO inherited_bootstrap_id;
  PROPR_FILE_ID_INFO artifact_id;
  PROPR_FILE_ID_INFO inherited_artifact_id;
  char artifact_hash[65];
  char inherited_hash[65];
  int authenticated = ordinary_file(self_lease) && ordinary_file(inherited_bootstrap) &&
    get_file_id(self_lease, &self_id) && get_file_id(inherited_bootstrap, &inherited_bootstrap_id) &&
    same_file_id(&self_id, &inherited_bootstrap_id) && ordinary_file(artifact_lease) && ordinary_file(inherited_artifact) &&
    get_file_id(artifact_lease, &artifact_id) && get_file_id(inherited_artifact, &inherited_artifact_id) &&
    same_file_id(&artifact_id, &inherited_artifact_id) && sha256_handle(artifact_lease, artifact_hash) &&
    sha256_handle(inherited_artifact, inherited_hash) && strcmp(artifact_hash, expected) == 0 &&
    strcmp(inherited_hash, expected) == 0 && current_user_sid(&token_buffer, &user_sid) &&
    protect_and_validate(artifact_lease, user_sid) &&
    (!production || verify_authenticode_pins(argv[2], leaf, spki));
  if (!authenticated) goto cleanup;

  BYTE ready = 'R';
  BYTE go = 0;
  DWORD transferred = 0;
  if (!WriteFile(barrier, &ready, 1, &transferred, NULL) || transferred != 1 ||
      !ReadFile(barrier, &go, 1, &transferred, NULL) || transferred != 1 || go != 'G') goto cleanup;
  SetHandleInformation(barrier, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(inherited_bootstrap, HANDLE_FLAG_INHERIT, 0);

  wchar_t command[32768];
  size_t offset = 0;
  for (int index = 7; index < argc; index += 1) {
    if (index != 7) command[offset++] = L' ';
    if (!quote_argument(command, sizeof(command) / sizeof(command[0]), &offset, argv[index])) goto cleanup;
  }
  STARTUPINFOW startup;
  PROCESS_INFORMATION child;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&child, sizeof(child));
  startup.cb = sizeof(startup);
  GetStartupInfoW(&startup);
  HANDLE job = NULL;
  if (!CreateProcessW(argv[2], command, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
      NULL, NULL, &startup, &child)) goto child_cleanup;
  job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job == NULL || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
      !AssignProcessToJobObject(job, child.hProcess)) goto child_cleanup;
  wchar_t loaded_path[32768];
  DWORD loaded_length = 32768;
  if (!QueryFullProcessImageNameW(child.hProcess, 0, loaded_path, &loaded_length)) goto child_cleanup;
  HANDLE loaded = CreateFileW(loaded_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  PROPR_FILE_ID_INFO loaded_id;
  char loaded_hash[65];
  int loaded_ok = ordinary_file(loaded) && get_file_id(loaded, &loaded_id) && same_file_id(&artifact_id, &loaded_id) &&
    sha256_handle(loaded, loaded_hash) && strcmp(loaded_hash, expected) == 0;
  if (loaded != INVALID_HANDLE_VALUE) CloseHandle(loaded);
  if (!loaded_ok || ResumeThread(child.hThread) == (DWORD)-1 ||
      WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) goto child_cleanup;
  DWORD exit_code = PROPR_FAILURE;
  if (GetExitCodeProcess(child.hProcess, &exit_code)) status = (int)exit_code;
child_cleanup:
  if (status == PROPR_FAILURE && child.hProcess != NULL) TerminateProcess(child.hProcess, PROPR_FAILURE);
  if (child.hThread != NULL) CloseHandle(child.hThread);
  if (child.hProcess != NULL) CloseHandle(child.hProcess);
  if (job != NULL) CloseHandle(job);
cleanup:
  if (artifact_lease != INVALID_HANDLE_VALUE) CloseHandle(artifact_lease);
  if (self_lease != INVALID_HANDLE_VALUE) CloseHandle(self_lease);
  if (token_buffer != NULL) LocalFree(token_buffer);
  return authenticated ? status : PROPR_FAILURE;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && wcscmp(argv[1], L"system-paths-v1") == 0) return print_system_paths();
  if (argc == 3 && wcscmp(argv[1], L"signer-pins-v1") == 0) return print_signer_pins(argv[2]);
  if (argc == 11 && wcscmp(argv[1], L"lease-build-inputs-v1") == 0) return lease_build_inputs(argc, argv);
  if (argc >= 9 && wcscmp(argv[1], L"launch-packaged-broker-v1") == 0) return launch_packaged_broker(argc, argv);
  return PROPR_FAILURE;
}
