#include <node_api.h>
#include <windows.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <mscat.h>
#include <bcrypt.h>
#include <softpub.h>
#include <sddl.h>
#include <aclapi.h>
#include <io.h>
#include <fcntl.h>

#include <array>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <cwctype>
#include <memory>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "wintrust.lib")

namespace {
constexpr size_t kSystemDirectoryChars = 520;
constexpr DWORD kMaxImageBytes = 4 * 1024 * 1024;
constexpr DWORD kMaxBuildInputBytes = 32 * 1024 * 1024;
constexpr DWORD kMaxSourceBytes = 256 * 1024;
constexpr DWORD kFileIdInfo = 18;
constexpr DWORD kFileAttributeTagInfo = 9;

struct FileIdInfo {
  ULONGLONG volume;
  BYTE id[16];
};

struct AttributeTagInfo {
  DWORD attributes;
  DWORD reparse_tag;
};

struct LaunchLease {
  HANDLE image = nullptr;
  HANDLE process = nullptr;
  HANDLE job = nullptr;
  int stdin_fd = -1;
  int stdout_fd = -1;
  int stderr_fd = -1;
  bool closed = false;
};

struct FileLeases { std::vector<HANDLE> handles; bool closed = false; };

struct CatalogContextLease {
  HCATADMIN admin = nullptr;
  HCATINFO catalog = nullptr;
  ~CatalogContextLease() {
    if (catalog) CryptCATAdminReleaseCatalogContext(admin, catalog, 0);
    if (admin) CryptCATAdminReleaseContext(admin, 0);
  }
  CatalogContextLease() = default;
  CatalogContextLease(const CatalogContextLease&) = delete;
  CatalogContextLease& operator=(const CatalogContextLease&) = delete;
};

enum class CatalogBindingFault {
  None,
  NullAdmin,
  MismatchedAdmin,
  ReleasedEarly,
  WrongHashAlgorithm,
  ForeignCatalogContext,
};

CatalogBindingFault CatalogBindingFaultFromString(const std::string& fault) {
  if (fault == "catalog-binding-null-admin") return CatalogBindingFault::NullAdmin;
  if (fault == "catalog-binding-mismatched-admin") return CatalogBindingFault::MismatchedAdmin;
  if (fault == "catalog-binding-released-early") return CatalogBindingFault::ReleasedEarly;
  if (fault == "catalog-binding-wrong-hash-algorithm") return CatalogBindingFault::WrongHashAlgorithm;
  if (fault == "catalog-binding-foreign-catalog-context") return CatalogBindingFault::ForeignCatalogContext;
  return CatalogBindingFault::None;
}

bool ExactCatalogBinding(HCATADMIN acquired_admin, HCATINFO enumerated_catalog,
    HCATADMIN supplied_admin, HCATINFO supplied_catalog, const wchar_t* hash_algorithm,
    bool admin_retained, bool catalog_retained) {
  return acquired_admin != nullptr && enumerated_catalog != nullptr
    && supplied_admin == acquired_admin && supplied_catalog == enumerated_catalog
    && hash_algorithm != nullptr && lstrcmpW(hash_algorithm, BCRYPT_SHA256_ALGORITHM) == 0
    && admin_retained && catalog_retained;
}

void CloseFileLeases(FileLeases* leases) {
  if (!leases || leases->closed) return;
  leases->closed = true;
  for (HANDLE handle : leases->handles) if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  leases->handles.clear();
}

void FinalizeFileLeases(napi_env, void* data, void*) {
  auto* leases = static_cast<FileLeases*>(data);
  CloseFileLeases(leases);
  delete leases;
}

void CloseLease(LaunchLease* lease) {
  if (!lease || lease->closed) return;
  lease->closed = true;
  if (lease->stdin_fd >= 0) { _close(lease->stdin_fd); lease->stdin_fd = -1; }
  if (lease->stdout_fd >= 0) { _close(lease->stdout_fd); lease->stdout_fd = -1; }
  if (lease->stderr_fd >= 0) { _close(lease->stderr_fd); lease->stderr_fd = -1; }
  if (lease->job) { CloseHandle(lease->job); lease->job = nullptr; }
  if (lease->process) { CloseHandle(lease->process); lease->process = nullptr; }
  if (lease->image) { CloseHandle(lease->image); lease->image = nullptr; }
}

void FinalizeLease(napi_env, void* data, void*) {
  auto* lease = static_cast<LaunchLease*>(data);
  CloseLease(lease);
  delete lease;
}

bool Throw(napi_env env, const char* code) {
  napi_throw_error(env, code, "Windows native authority boundary rejected the operation");
  return false;
}

bool ThrowWithDiagnostics(napi_env env, const char* code, const std::vector<std::string>& bounded) {
  napi_value code_value, message, error, diagnostics, value;
  if (bounded.empty() || bounded.size() > 3
      || napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok
      || napi_create_string_utf8(env, "Windows native authority boundary rejected the operation",
        NAPI_AUTO_LENGTH, &message) != napi_ok
      || napi_create_error(env, code_value, message, &error) != napi_ok
      || napi_create_array_with_length(env, bounded.size(), &diagnostics) != napi_ok) return Throw(env, code);
  for (size_t index = 0; index < bounded.size(); ++index) {
    if (bounded[index].empty() || bounded[index].size() > 192
        || napi_create_string_utf8(env, bounded[index].c_str(), bounded[index].size(), &value) != napi_ok
        || napi_set_element(env, diagnostics, index, value) != napi_ok) return Throw(env, code);
  }
  if (napi_set_named_property(env, error, "diagnostics", diagnostics) != napi_ok
      || napi_throw(env, error) != napi_ok) return Throw(env, code);
  return false;
}

bool StringValue(napi_env env, napi_value object, const char* name, std::wstring* result) {
  napi_value value;
  size_t length = 0;
  if (napi_get_named_property(env, object, name, &value) != napi_ok
      || napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok
      || length == 0 || length > 32767) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  result->assign(reinterpret_cast<const wchar_t*>(buffer.data()), length);
  return true;
}

bool Utf8Value(napi_env env, napi_value object, const char* name, std::string* result, bool optional = false) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok) return optional;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type == napi_null || type == napi_undefined) return optional;
  size_t length = 0;
  if (type != napi_string || napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 1024) return false;
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  result->assign(buffer.data(), length);
  return true;
}

bool Uint32Value(napi_env env, napi_value object, const char* name, uint32_t* result) {
  napi_value value;
  return napi_get_named_property(env, object, name, &value) == napi_ok
    && napi_get_value_uint32(env, value, result) == napi_ok;
}

bool BoolValue(napi_env env, napi_value object, const char* name, bool* result) {
  napi_value value;
  return napi_get_named_property(env, object, name, &value) == napi_ok
    && napi_get_value_bool(env, value, result) == napi_ok;
}

std::string Hex(const BYTE* bytes, size_t length) {
  static constexpr char digits[] = "0123456789abcdef";
  std::string result(length * 2, '0');
  for (size_t i = 0; i < length; ++i) {
    result[i * 2] = digits[bytes[i] >> 4];
    result[i * 2 + 1] = digits[bytes[i] & 15];
  }
  return result;
}

bool Sha256Handle(HANDLE file, DWORD expected_size, std::string* result, DWORD maximum_size = kMaxImageBytes) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart != expected_size
      || size.QuadPart > maximum_size || SetFilePointer(file, 0, nullptr, FILE_BEGIN) == INVALID_SET_FILE_POINTER) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0, written = 0;
  std::vector<BYTE> object;
  std::array<BYTE, 32> digest{};
  bool ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0
    && BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<BYTE*>(&object_size), sizeof(object_size), &written, 0) == 0;
  if (ok) { object.resize(object_size); ok = BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) == 0; }
  std::array<BYTE, 64 * 1024> buffer{};
  DWORD total = 0;
  while (ok && total < expected_size) {
    DWORD read = 0;
    const DWORD requested = std::min<DWORD>(static_cast<DWORD>(buffer.size()), expected_size - total);
    ok = ReadFile(file, buffer.data(), requested, &read, nullptr) && read > 0
      && BCryptHashData(hash, buffer.data(), read, 0) == 0;
    total += read;
  }
  ok = ok && total == expected_size && BCryptFinishHash(hash, digest.data(), digest.size(), 0) == 0;
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (ok) *result = Hex(digest.data(), digest.size());
  return ok;
}

bool FileIdentity(HANDLE file, FileIdInfo* result) {
  return GetFileInformationByHandleEx(file, static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileIdInfo), result, sizeof(*result)) != FALSE;
}

bool SameIdentity(const FileIdInfo& left, const FileIdInfo& right) {
  return left.volume == right.volume && memcmp(left.id, right.id, sizeof(left.id)) == 0;
}

bool SameSid(PSID left, const wchar_t* right_text) {
  PSID right = nullptr;
  const bool same = ConvertStringSidToSidW(right_text, &right) && EqualSid(left, right);
  if (right) LocalFree(right);
  return same;
}

bool CurrentUserSid(PSID owner) {
  HANDLE token = nullptr;
  DWORD bytes = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  std::vector<BYTE> value(bytes);
  const bool same = bytes > 0 && GetTokenInformation(token, TokenUser, value.data(), bytes, &bytes)
    && EqualSid(owner, reinterpret_cast<TOKEN_USER*>(value.data())->User.Sid);
  CloseHandle(token);
  return same;
}

bool CurrentUserSidText(std::wstring* text) {
  HANDLE token = nullptr;
  DWORD bytes = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  std::vector<BYTE> value(bytes);
  LPWSTR sid_text = nullptr;
  const bool ok = bytes > 0 && GetTokenInformation(token, TokenUser, value.data(), bytes, &bytes)
    && ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(value.data())->User.Sid, &sid_text);
  if (ok) *text = sid_text;
  if (sid_text) LocalFree(sid_text);
  CloseHandle(token);
  return ok;
}

bool TrustedAuthoritySid(PSID sid, bool allow_current_user) {
  return (allow_current_user && CurrentUserSid(sid)) || SameSid(sid, L"S-1-5-18") || SameSid(sid, L"S-1-5-32-544")
    || SameSid(sid, L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
}

bool QualifiedAceSidAndMask(const ACE_HEADER* header, ACCESS_MASK* mask, PSID* sid, bool* allowed) {
  if (!header || header->AceSize < sizeof(ACE_HEADER) + sizeof(ACCESS_MASK) + sizeof(DWORD)) return false;
  const BYTE* bytes = reinterpret_cast<const BYTE*>(header);
  switch (header->AceType) {
    case ACCESS_ALLOWED_ACE_TYPE:
    case ACCESS_ALLOWED_CALLBACK_ACE_TYPE:
      *allowed = true;
      *mask = *reinterpret_cast<const ACCESS_MASK*>(bytes + sizeof(ACE_HEADER));
      *sid = const_cast<BYTE*>(bytes + sizeof(ACE_HEADER) + sizeof(ACCESS_MASK));
      break;
    case ACCESS_DENIED_ACE_TYPE:
    case ACCESS_DENIED_CALLBACK_ACE_TYPE:
      *allowed = false;
      *mask = *reinterpret_cast<const ACCESS_MASK*>(bytes + sizeof(ACE_HEADER));
      *sid = const_cast<BYTE*>(bytes + sizeof(ACE_HEADER) + sizeof(ACCESS_MASK));
      break;
    case ACCESS_ALLOWED_OBJECT_ACE_TYPE:
    case ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE:
    case ACCESS_DENIED_OBJECT_ACE_TYPE:
    case ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE: {
      *allowed = header->AceType == ACCESS_ALLOWED_OBJECT_ACE_TYPE
        || header->AceType == ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE;
      if (header->AceSize < sizeof(ACE_HEADER) + sizeof(ACCESS_MASK) + sizeof(DWORD)) return false;
      *mask = *reinterpret_cast<const ACCESS_MASK*>(bytes + sizeof(ACE_HEADER));
      const DWORD flags = *reinterpret_cast<const DWORD*>(bytes + sizeof(ACE_HEADER) + sizeof(ACCESS_MASK));
      size_t offset = sizeof(ACE_HEADER) + sizeof(ACCESS_MASK) + sizeof(DWORD);
      if ((flags & ACE_OBJECT_TYPE_PRESENT) != 0) offset += sizeof(GUID);
      if ((flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) != 0) offset += sizeof(GUID);
      if (offset >= header->AceSize) return false;
      *sid = const_cast<BYTE*>(bytes + offset);
      break;
    }
    default:
      return false;
  }
  const BYTE* sid_bytes = static_cast<const BYTE*>(*sid);
  if (sid_bytes < bytes || sid_bytes >= bytes + header->AceSize || !IsValidSid(*sid)) return false;
  const DWORD sid_bytes_length = GetLengthSid(*sid);
  return sid_bytes_length > 0 && sid_bytes + sid_bytes_length <= bytes + header->AceSize;
}

bool DangerousUntrustedAcl(PACL dacl, bool allow_current_user) {
  int prior_order = -1;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(dacl, index, &raw)) return true;
    auto* header = static_cast<ACE_HEADER*>(raw);
    if ((header->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
    ACCESS_MASK mask = 0;
    PSID sid = nullptr;
    bool allow_ace = false;
    if (!QualifiedAceSidAndMask(header, &mask, &sid, &allow_ace)) return true;
    const int order = (header->AceFlags & INHERITED_ACE) != 0
      ? (allow_ace ? 3 : 2) : (allow_ace ? 1 : 0);
    if (order < prior_order) return true;
    prior_order = order;
    GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
    MapGenericMask(&mask, &mapping);
    // Callback and conditional allow ACEs are conservatively treated as
    // effective. Evaluating their claims against only the current token would
    // miss a future attacker token for which the condition becomes true.
    // A named attacker SID is just as dangerous as a well-known broad group.
    // Only the user and the fixed Windows authority principals may mutate an
    // authenticated input while it is leased.
    constexpr DWORD mapped_dangerous = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES
      | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER;
    if (allow_ace && (mask & mapped_dangerous) != 0 && !TrustedAuthoritySid(sid, allow_current_user)) return true;
  }
  return false;
}

bool SecureObjectAcl(HANDLE object, bool allow_current_user = true) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PSID owner = nullptr;
  PACL dacl = nullptr;
  const DWORD status = GetSecurityInfo(object, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, nullptr, &dacl, nullptr, &descriptor);
  const bool secure = status == ERROR_SUCCESS && owner != nullptr && dacl != nullptr
    && ((allow_current_user && CurrentUserSid(owner)) || SameSid(owner, L"S-1-5-18") || SameSid(owner, L"S-1-5-32-544")
      || SameSid(owner, L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"))
    && !DangerousUntrustedAcl(dacl, allow_current_user);
  if (descriptor) LocalFree(descriptor);
  return secure;
}

#if defined(PROPR_WINDOWS_BUILD_BOOTSTRAP)
enum class SecureRegularFileFailure {
  None,
  FileMeta,
  Owner,
  Dacl,
  DaclProtected,
};

bool AcceptedFileOwner(PSID owner, bool allow_current_user) {
  return owner != nullptr
    && ((allow_current_user && CurrentUserSid(owner)) || SameSid(owner, L"S-1-5-18")
      || SameSid(owner, L"S-1-5-32-544")
      || SameSid(owner, L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"));
}

SecureRegularFileFailure DiagnoseSecureRegularFile(HANDLE file, DWORD expected_size, FileIdInfo* identity,
    bool require_protected = true, bool allow_current_user = true) {
  AttributeTagInfo tag{};
  BY_HANDLE_FILE_INFORMATION basic{};
  if (!GetFileInformationByHandle(file, &basic)
      || !GetFileInformationByHandleEx(file, static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileAttributeTagInfo), &tag, sizeof(tag))
      || !FileIdentity(file, identity) || (tag.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
      || (tag.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || tag.reparse_tag != 0
      || basic.nNumberOfLinks != 1 || basic.nFileSizeHigh != 0 || basic.nFileSizeLow != expected_size) {
    return SecureRegularFileFailure::FileMeta;
  }
  PSECURITY_DESCRIPTOR owner_descriptor = nullptr;
  PSID owner = nullptr;
  const DWORD owner_status = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
    &owner, nullptr, nullptr, nullptr, &owner_descriptor);
  const bool accepted_owner = owner_status == ERROR_SUCCESS && AcceptedFileOwner(owner, allow_current_user);
  if (owner_descriptor) LocalFree(owner_descriptor);
  if (!accepted_owner) return SecureRegularFileFailure::Owner;

  PSECURITY_DESCRIPTOR dacl_descriptor = nullptr;
  PACL dacl = nullptr;
  const DWORD dacl_status = GetSecurityInfo(file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, &dacl, nullptr, &dacl_descriptor);
  if (dacl_status != ERROR_SUCCESS || dacl == nullptr || DangerousUntrustedAcl(dacl, allow_current_user)) {
    if (dacl_descriptor) LocalFree(dacl_descriptor);
    return SecureRegularFileFailure::Dacl;
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  const bool protected_dacl = GetSecurityDescriptorControl(dacl_descriptor, &control, &revision)
    && (!require_protected || (control & SE_DACL_PROTECTED) != 0);
  if (dacl_descriptor) LocalFree(dacl_descriptor);
  return protected_dacl ? SecureRegularFileFailure::None : SecureRegularFileFailure::DaclProtected;
}
#endif

bool SecureRegularFile(HANDLE file, DWORD expected_size, FileIdInfo* identity, bool require_protected = true,
    bool allow_current_user = true) {
  AttributeTagInfo tag{};
  BY_HANDLE_FILE_INFORMATION basic{};
  if (!GetFileInformationByHandle(file, &basic)
      || !GetFileInformationByHandleEx(file, static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileAttributeTagInfo), &tag, sizeof(tag))
      || !FileIdentity(file, identity) || (tag.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
      || (tag.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || tag.reparse_tag != 0
      || basic.nNumberOfLinks != 1 || basic.nFileSizeHigh != 0 || basic.nFileSizeLow != expected_size) return false;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PSID owner = nullptr;
  PACL dacl = nullptr;
  const DWORD status = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, nullptr, &dacl, nullptr, &descriptor);
  bool secure = status == ERROR_SUCCESS && owner != nullptr && dacl != nullptr && SecureObjectAcl(file, allow_current_user);
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  secure = secure && GetSecurityDescriptorControl(descriptor, &control, &revision)
    && (!require_protected || (control & SE_DACL_PROTECTED) != 0);
  if (descriptor) LocalFree(descriptor);
  return secure;
}

bool SecureServicedSystemFile(HANDLE file, DWORD expected_size, FileIdInfo* identity) {
  AttributeTagInfo tag{};
  BY_HANDLE_FILE_INFORMATION basic{};
  return expected_size > 0 && expected_size <= kMaxBuildInputBytes
    && GetFileInformationByHandle(file, &basic)
    && GetFileInformationByHandleEx(file, static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileAttributeTagInfo), &tag, sizeof(tag))
    && FileIdentity(file, identity) && (tag.attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
    && (tag.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 && tag.reparse_tag == 0
    && basic.nNumberOfLinks >= 1 && basic.nFileSizeHigh == 0 && basic.nFileSizeLow == expected_size
    && SecureObjectAcl(file, false);
}

bool VerifyTrust(const std::wstring& path, HANDLE held) {
  WINTRUST_FILE_INFO file{};
  file.cbStruct = sizeof(file);
  file.pcwszFilePath = path.c_str();
  file.hFile = held;
  WINTRUST_DATA data{};
  data.cbStruct = sizeof(data);
  data.dwUIChoice = WTD_UI_NONE;
  data.fdwRevocationChecks = WTD_REVOKE_NONE;
  data.dwUnionChoice = WTD_CHOICE_FILE;
  data.pFile = &file;
  data.dwStateAction = WTD_STATEACTION_VERIFY;
  data.dwProvFlags = WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG status = WinVerifyTrust(nullptr, &policy, &data);
  data.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &policy, &data);
  return status == ERROR_SUCCESS;
}

bool Sha256Bytes(const BYTE* bytes, DWORD length, std::string* result) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0, written = 0;
  std::vector<BYTE> object;
  std::array<BYTE, 32> digest{};
  bool ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0
    && BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<BYTE*>(&object_size), sizeof(object_size), &written, 0) == 0;
  if (ok) { object.resize(object_size); ok = BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) == 0; }
  ok = ok && BCryptHashData(hash, const_cast<BYTE*>(bytes), length, 0) == 0
    && BCryptFinishHash(hash, digest.data(), digest.size(), 0) == 0;
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (ok) *result = Hex(digest.data(), digest.size());
  return ok;
}

enum class SignerContent {
  EmbeddedPe,
  StandaloneCatalog,
};

enum class CatalogFailure {
  None,
  Enumeration,
  MemberTag,
  CatalogHash,
  PolicyName,
  PolicyHash,
  PolicyTuple,
  WinTrustPolicy,
  Revocation,
  CatalogLease,
  SignerParse,
  ExactPublisher,
  RootPin,
  CertificatePin,
  SpkiPin,
};

const char* CatalogFailureCode(CatalogFailure failure) {
  switch (failure) {
    case CatalogFailure::Enumeration: return "CATALOG_ENUMERATION";
    case CatalogFailure::MemberTag: return "MEMBER_TAG";
    case CatalogFailure::CatalogHash: return "CATALOG_HASH";
    case CatalogFailure::PolicyName: return "POLICY_NAME";
    case CatalogFailure::PolicyHash: return "POLICY_HASH";
    case CatalogFailure::PolicyTuple: return "POLICY_TUPLE";
    case CatalogFailure::WinTrustPolicy: return "WINTRUST_POLICY";
    case CatalogFailure::Revocation: return "REVOCATION";
    case CatalogFailure::CatalogLease: return "CATALOG_LEASE";
    case CatalogFailure::SignerParse: return "SIGNER_PARSE";
    case CatalogFailure::ExactPublisher: return "EXACT_PUBLISHER";
    case CatalogFailure::RootPin: return "ROOT_PIN";
    case CatalogFailure::CertificatePin: return "CERTIFICATE_PIN";
    case CatalogFailure::SpkiPin: return "SPKI_PIN";
    default: return "SIGNER_CATALOG";
  }
}

bool RevocationFailure(LONG status) {
  return status == CERT_E_REVOKED || status == CRYPT_E_REVOKED
    || status == CRYPT_E_REVOCATION_OFFLINE || status == CERT_E_REVOCATION_FAILURE;
}

bool ReadHeldBytes(HANDLE held, DWORD maximum, std::vector<BYTE>* bytes) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(held, &size) || size.QuadPart <= 0 || size.QuadPart > maximum
      || SetFilePointer(held, 0, nullptr, FILE_BEGIN) == INVALID_SET_FILE_POINTER) return false;
  bytes->resize(static_cast<size_t>(size.QuadPart));
  DWORD total = 0;
  while (total < bytes->size()) {
    DWORD read = 0;
    const DWORD requested = std::min<DWORD>(64 * 1024, static_cast<DWORD>(bytes->size()) - total);
    if (!ReadFile(held, bytes->data() + total, requested, &read, nullptr) || read == 0) return false;
    total += read;
  }
  return total == bytes->size();
}

bool SignerEvidence(HANDLE held, SignerContent expected_content, std::wstring* publisher,
    std::string* certificate_hash, std::string* spki_hash, std::string* root_spki_hash = nullptr,
    DWORD* chain_errors = nullptr, std::string* subject_der = nullptr,
    std::string* subject_der_sha256 = nullptr) {
  HCERTSTORE store = nullptr;
  HCRYPTMSG message = nullptr;
  DWORD encoding = 0, content = 0, format = 0;
  const DWORD content_flag = expected_content == SignerContent::EmbeddedPe
    ? CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED : CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED;
  const DWORD required_content = expected_content == SignerContent::EmbeddedPe
    ? CERT_QUERY_CONTENT_PKCS7_SIGNED_EMBED : CERT_QUERY_CONTENT_PKCS7_SIGNED;
  std::vector<BYTE> exact_bytes;
  CRYPT_DATA_BLOB blob{};
  const bool read = ReadHeldBytes(held, kMaxBuildInputBytes, &exact_bytes);
  if (read) {
    blob.cbData = static_cast<DWORD>(exact_bytes.size());
    blob.pbData = exact_bytes.data();
  }
  if (!read || !CryptQueryObject(CERT_QUERY_OBJECT_BLOB, &blob, content_flag,
      CERT_QUERY_FORMAT_FLAG_BINARY, 0, &encoding, &content, &format, &store, &message, nullptr)
      || content != required_content || format != CERT_QUERY_FORMAT_BINARY) return false;
  DWORD bytes = 0;
  bool ok = CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, nullptr, &bytes) != FALSE;
  std::vector<BYTE> signer(bytes);
  ok = ok && CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, signer.data(), &bytes);
  PCCERT_CONTEXT certificate = nullptr;
  if (ok) {
    auto* info = reinterpret_cast<CMSG_SIGNER_INFO*>(signer.data());
    CERT_INFO wanted{};
    wanted.Issuer = info->Issuer;
    wanted.SerialNumber = info->SerialNumber;
    certificate = CertFindCertificateInStore(store, encoding, 0, CERT_FIND_SUBJECT_CERT, &wanted, nullptr);
    ok = certificate != nullptr;
  }
  if (ok) {
    if (publisher) {
      std::array<wchar_t, 513> name{};
      const DWORD name_length = CertNameToStrW(certificate->dwCertEncodingType, &certificate->pCertInfo->Subject,
        CERT_X500_NAME_STR, name.data(), static_cast<DWORD>(name.size()));
      *publisher = name_length > 1 && name_length <= name.size() ? std::wstring(name.data(), name_length - 1) : L"";
      ok = !publisher->empty();
    }
    const CERT_NAME_BLOB& subject = certificate->pCertInfo->Subject;
    ok = ok && subject.pbData != nullptr && subject.cbData > 0 && subject.cbData <= 1024;
    if (ok && subject_der) *subject_der = Hex(subject.pbData, subject.cbData);
    if (ok && subject_der_sha256) ok = Sha256Bytes(subject.pbData, subject.cbData, subject_der_sha256);
    BYTE* encoded = nullptr;
    DWORD encoded_bytes = 0;
    ok = ok && Sha256Bytes(certificate->pbCertEncoded, certificate->cbCertEncoded, certificate_hash)
      && CryptEncodeObjectEx(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO, &certificate->pCertInfo->SubjectPublicKeyInfo,
        CRYPT_ENCODE_ALLOC_FLAG, nullptr, &encoded, &encoded_bytes)
      && Sha256Bytes(encoded, encoded_bytes, spki_hash);
    if (encoded) LocalFree(encoded);
    if (ok) {
      CERT_CHAIN_PARA parameters{};
      parameters.cbSize = sizeof(parameters);
      PCCERT_CHAIN_CONTEXT chain = nullptr;
      // Catalogs in the canonical CatRoot store are the locally authoritative
      // Windows servicing statement. Never turn a hosted build into an online
      // revocation request: cached revocation is still enforced and an
      // explicitly revoked or otherwise untrusted chain remains fatal.
      ok = CertGetCertificateChain(nullptr, certificate, nullptr, store, &parameters,
        CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY,
        nullptr, &chain)
        && chain && chain->cChain >= 1 && chain->rgpChain[0]->cElement >= 2;
      if (ok) {
        const DWORD errors = chain->TrustStatus.dwErrorStatus;
        if (chain_errors) *chain_errors = errors;
        // A locally installed OS catalog remains usable without network or a
        // warmed revocation cache. Known revocation and every other chain
        // trust error are fatal; only an unavailable offline response is
        // tolerated for this canonical servicing catalog.
        const DWORD offline_only = CERT_TRUST_REVOCATION_STATUS_UNKNOWN | CERT_TRUST_IS_OFFLINE_REVOCATION;
        ok = (errors & ~offline_only) == CERT_TRUST_NO_ERROR;
      }
      if (ok && root_spki_hash) {
        PCCERT_CONTEXT root = chain->rgpChain[0]->rgpElement[chain->rgpChain[0]->cElement - 1]->pCertContext;
        BYTE* root_encoded = nullptr;
        DWORD root_bytes = 0;
        ok = CryptEncodeObjectEx(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO, &root->pCertInfo->SubjectPublicKeyInfo,
          CRYPT_ENCODE_ALLOC_FLAG, nullptr, &root_encoded, &root_bytes)
          && Sha256Bytes(root_encoded, root_bytes, root_spki_hash);
        if (root_encoded) LocalFree(root_encoded);
      }
      if (chain) CertFreeCertificateChain(chain);
    }
  }
  if (certificate) CertFreeCertificateContext(certificate);
  if (message) CryptMsgClose(message);
  if (store) CertCloseStore(store, 0);
  return ok;
}

bool VerifyPinnedSignature(const std::wstring& path, HANDLE held, const std::string& expected_publisher,
    const std::string& expected_certificate, const std::string& expected_spki) {
  if (!VerifyTrust(path, held) || expected_publisher.empty()
      || expected_certificate.size() != 64 || expected_spki.size() != 64) return false;
  std::wstring publisher;
  std::string certificate, spki;
  std::wstring expected(expected_publisher.begin(), expected_publisher.end());
  return SignerEvidence(held, SignerContent::EmbeddedPe, &publisher, &certificate, &spki)
    && publisher == expected && certificate == expected_certificate && spki == expected_spki;
}

bool PinnedMicrosoftRoot(const std::string& root_spki) {
  return root_spki == "02376d0908ac23041cc7d666d9daf192554f7fc36317aa9cb800908616b28af8"
    || root_spki == "c9905b0ee01202293ca026e64f08412442c5504c06e44ca7e9726d61f20e4089"
    || root_spki == "b2f7298b52bf2c3cac4ddfe72de4d682ac58957595982f2b62301af597c699c5";
}

std::wstring SystemWindowsDirectory();

struct MicrosoftCatalogPolicyEntry {
  const wchar_t* member_name;
  const wchar_t* catalog_name;
  const char* subject_der;
  const char* certificate_sha256;
  const char* spki_sha256;
  const char* catalog_sha256;
};

// Reviewed Windows Server 2025 x64 and Windows 11 25H2 ARM64 servicing policy.
// subject_der is the exact encoded CERT_NAME_BLOB in certificate order
// (C, ST, L, O, CN); it is intentionally independent of CertNameToStr display
// order and aliases such as S/ST. These are fixed byte identities, not values
// learned from CryptCATAdmin on the current host. A servicing rotation is
// intentionally fail-closed until this application policy changes.
constexpr char kMicrosoftWindowsSubjectDer[] =
  "3070310b3009060355040613025553311330110603550408130a57617368696e67746f6e3110300e060355040713075265646d6f6e64311e301c060355040a13154d6963726f736f667420436f72706f726174696f6e311a3018060355040313114d6963726f736f66742057696e646f7773";
constexpr std::array<MicrosoftCatalogPolicyEntry, 8> kMicrosoftCatalogPolicy{{
  {L"csc.exe", L"Package_4_for_KB5066128~31bf3856ad364e35~amd64~~10.0.9321.3.cat",
    kMicrosoftWindowsSubjectDer,
    "1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de",
    "a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1",
    "f447c801fde63f353448d90567363190964bb2e716c271256dba5859aaece7ef"},
  {L"System.dll", L"Package_4_for_KB5066128~31bf3856ad364e35~amd64~~10.0.9321.3.cat",
    kMicrosoftWindowsSubjectDer,
    "1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de",
    "a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1",
    "f447c801fde63f353448d90567363190964bb2e716c271256dba5859aaece7ef"},
  {L"System.Web.Extensions.dll", L"Package_4_for_KB5066128~31bf3856ad364e35~amd64~~10.0.9321.3.cat",
    kMicrosoftWindowsSubjectDer,
    "1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de",
    "a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1",
    "f447c801fde63f353448d90567363190964bb2e716c271256dba5859aaece7ef"},
  {L"powershell.exe", L"Microsoft-Windows-PowerShell-ServerCore-Package~31bf3856ad364e35~amd64~~10.0.26100.32230.cat",
    kMicrosoftWindowsSubjectDer,
    "1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de",
    "a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1",
    "2d2ac25e4f3cc782a886422964dffc851a66af354220923d96153738867d7866"},
  {L"csc.exe", L"Package_2_for_KB5066128~31bf3856ad364e35~arm64~~10.0.9321.3.cat",
    kMicrosoftWindowsSubjectDer,
    "1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de",
    "a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1",
    "fd4c63e1001a82816e4ac3cdc76af05a7a02096a7101b4ddd3963d23ab773b85"},
  {L"System.dll", L"Package_2_for_KB5066128~31bf3856ad364e35~arm64~~10.0.9321.3.cat",
    kMicrosoftWindowsSubjectDer,
    "1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de",
    "a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1",
    "fd4c63e1001a82816e4ac3cdc76af05a7a02096a7101b4ddd3963d23ab773b85"},
  {L"System.Web.Extensions.dll", L"Package_2_for_KB5066128~31bf3856ad364e35~arm64~~10.0.9321.3.cat",
    kMicrosoftWindowsSubjectDer,
    "1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de",
    "a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1",
    "fd4c63e1001a82816e4ac3cdc76af05a7a02096a7101b4ddd3963d23ab773b85"},
  {L"powershell.exe", L"Microsoft-Windows-Client-Features-Package02~31bf3856ad364e35~arm64~~10.0.26100.1.cat",
    kMicrosoftWindowsSubjectDer,
    "ce08760345bd5a18aa9091e6f083522ad593bd42f587699e025afd55be589334",
    "130dc613f271c90adf66157a030391c404f1e4ca21ef8261ac914fc615298b62",
    "08150f5768c0780ab94d998a4302718fd1a69d6e54220a057f2d16f691a4582c"},
}};

const wchar_t* BaseName(const std::wstring& path) {
  const size_t slash = path.find_last_of(L"\\/");
  return path.c_str() + (slash == std::wstring::npos ? 0 : slash + 1);
}

bool ApprovedMicrosoftCatalog(const std::wstring& member_path, const std::wstring& catalog_path,
    const std::string& subject_der, const std::string& certificate, const std::string& spki,
    const std::string& catalog_sha256) {
  const wchar_t* member = BaseName(member_path);
  const wchar_t* catalog = BaseName(catalog_path);
  return std::any_of(kMicrosoftCatalogPolicy.begin(), kMicrosoftCatalogPolicy.end(),
    [&](const MicrosoftCatalogPolicyEntry& approved) {
      return _wcsicmp(member, approved.member_name) == 0 && _wcsicmp(catalog, approved.catalog_name) == 0
        && subject_der == approved.subject_der && certificate == approved.certificate_sha256
        && spki == approved.spki_sha256
        && catalog_sha256 == approved.catalog_sha256;
    });
}

const MicrosoftCatalogPolicyEntry* NamedMicrosoftCatalog(const std::wstring& member_path,
    const std::wstring& catalog_path) {
  const wchar_t* member = BaseName(member_path);
  const wchar_t* catalog = BaseName(catalog_path);
  const auto matching = std::find_if(kMicrosoftCatalogPolicy.begin(), kMicrosoftCatalogPolicy.end(),
    [&](const MicrosoftCatalogPolicyEntry& approved) {
      return _wcsicmp(member, approved.member_name) == 0 && _wcsicmp(catalog, approved.catalog_name) == 0;
    });
  return matching == kMicrosoftCatalogPolicy.end() ? nullptr : &*matching;
}

bool AsciiPolicyName(const wchar_t* value, size_t maximum, std::string* output) {
  output->clear();
  for (const wchar_t* cursor = value; *cursor; ++cursor) {
    const wchar_t ch = *cursor;
    const bool allowed = ch < 0x80 && (iswalnum(ch) || ch == L'_' || ch == L'.' || ch == L'~' || ch == L'-');
    if (!allowed || output->size() == maximum) return false;
    output->push_back(static_cast<char>(ch));
  }
  return !output->empty();
}

bool PolicyDiagnostics(const std::wstring& member_path, const std::wstring& catalog_path,
    const std::string& catalog_sha256, std::vector<std::string>* diagnostics) {
  std::string member, catalog;
  if (catalog_sha256.size() != 64 || !AsciiPolicyName(BaseName(member_path), 64, &member)
      || !AsciiPolicyName(BaseName(catalog_path), 180, &catalog)
      || catalog.size() < 5 || _stricmp(catalog.c_str() + catalog.size() - 4, ".cat") != 0) return false;
  diagnostics->clear();
  diagnostics->push_back("member:" + member);
  diagnostics->push_back("catalog:" + catalog);
  diagnostics->push_back("catalog-sha256:" + catalog_sha256);
  return true;
}

napi_value ApprovedCatalogSignerForTest(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  std::wstring member, catalog;
  std::string subject_der, certificate, spki, catalog_sha256;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || !StringValue(env, args[0], "member", &member) || !StringValue(env, args[0], "catalog", &catalog)
      || !Utf8Value(env, args[0], "subjectDer", &subject_der)
      || !Utf8Value(env, args[0], "certificateSha256", &certificate)
      || !Utf8Value(env, args[0], "spkiSha256", &spki)
      || !Utf8Value(env, args[0], "catalogSha256", &catalog_sha256)) {
    Throw(env, "CATALOG_TEST_ARGUMENT"); return nullptr;
  }
  napi_get_boolean(env, ApprovedMicrosoftCatalog(member, catalog, subject_der, certificate, spki, catalog_sha256),
    &result);
  return result;
}

napi_value CatalogPolicyFailureForTest(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  std::wstring member, catalog;
  std::string subject_der, certificate, spki, catalog_sha256;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || !StringValue(env, args[0], "member", &member) || !StringValue(env, args[0], "catalog", &catalog)
      || !Utf8Value(env, args[0], "subjectDer", &subject_der)
      || !Utf8Value(env, args[0], "certificateSha256", &certificate)
      || !Utf8Value(env, args[0], "spkiSha256", &spki)
      || !Utf8Value(env, args[0], "catalogSha256", &catalog_sha256)) {
    Throw(env, "CATALOG_TEST_ARGUMENT"); return nullptr;
  }
  const MicrosoftCatalogPolicyEntry* approved = NamedMicrosoftCatalog(member, catalog);
  const char* code = !approved ? "POLICY_NAME"
    : catalog_sha256 != approved->catalog_sha256 ? "POLICY_HASH"
      : subject_der != approved->subject_der || certificate != approved->certificate_sha256
        || spki != approved->spki_sha256 ? "POLICY_TUPLE" : "CURRENT_EXACT_TUPLE";
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &result);
  return result;
}

bool CanonicalMicrosoftCatalog(const std::wstring& path, std::string* sha256, FileIdInfo* identity,
    HANDLE* held_catalog) {
  const std::wstring windows = SystemWindowsDirectory();
  const std::wstring catalog_root = windows
    + L"\\System32\\CatRoot\\{F750E6C3-38EE-11D1-85E5-00C04FC295EE}\\";
  if (windows.empty() || path.size() <= catalog_root.size()
      || _wcsnicmp(path.c_str(), catalog_root.c_str(), catalog_root.size()) != 0
      || path.find(L'\\', catalog_root.size()) != std::wstring::npos) return false;
  HANDLE catalog = CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  LARGE_INTEGER size{};
  std::array<wchar_t, 32768> final_path{};
  const DWORD final_length = catalog == INVALID_HANDLE_VALUE ? 0
    : GetFinalPathNameByHandleW(catalog, final_path.data(), static_cast<DWORD>(final_path.size()),
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  const std::wstring expected_final = L"\\\\?\\" + path;
  const bool valid = catalog != INVALID_HANDLE_VALUE && GetFileSizeEx(catalog, &size)
    && size.QuadPart > 0 && size.QuadPart <= kMaxBuildInputBytes
    && final_length > 0 && final_length < final_path.size()
    && _wcsicmp(final_path.data(), expected_final.c_str()) == 0
    && SecureServicedSystemFile(catalog, static_cast<DWORD>(size.QuadPart), identity)
    && Sha256Handle(catalog, static_cast<DWORD>(size.QuadPart), sha256, kMaxBuildInputBytes);
  if (valid) *held_catalog = catalog;
  else if (catalog != INVALID_HANDLE_VALUE) CloseHandle(catalog);
  return valid;
}

bool VerifyCatalogTrust(const std::wstring& path, HANDLE file, std::wstring* catalog_path,
    std::string* catalog_sha256, FileIdInfo* catalog_identity, HANDLE* held_catalog,
    CatalogContextLease* context_lease, CatalogFailure* failure,
    CatalogBindingFault binding_fault = CatalogBindingFault::None) {
  *failure = CatalogFailure::Enumeration;
  HCATADMIN admin = nullptr;
  GUID driver_action = DRIVER_ACTION_VERIFY;
  if (!CryptCATAdminAcquireContext2(&admin, &driver_action, BCRYPT_SHA256_ALGORITHM, nullptr, 0)) return false;
  DWORD hash_bytes = 0;
  bool ok = CryptCATAdminCalcHashFromFileHandle2(admin, file, &hash_bytes, nullptr, 0) != FALSE
    && hash_bytes > 0 && hash_bytes <= 128;
  if (!ok) *failure = CatalogFailure::CatalogHash;
  std::vector<BYTE> hash(hash_bytes);
  ok = ok && SetFilePointer(file, 0, nullptr, FILE_BEGIN) != INVALID_SET_FILE_POINTER
    && CryptCATAdminCalcHashFromFileHandle2(admin, file, &hash_bytes, hash.data(), 0);
  if (!ok) *failure = CatalogFailure::CatalogHash;
  HCATINFO catalog = ok ? CryptCATAdminEnumCatalogFromHash(admin, hash.data(), hash_bytes, 0, nullptr) : nullptr;
  const HCATADMIN acquired_admin = admin;
  const HCATINFO enumerated_catalog = catalog;
  HCATADMIN supplied_admin = admin;
  HCATINFO supplied_catalog = catalog;
  const wchar_t* supplied_hash_algorithm = BCRYPT_SHA256_ALGORITHM;
  bool admin_retained = admin != nullptr;
  bool catalog_retained = catalog != nullptr;
  CatalogContextLease foreign_context{};
  if (binding_fault == CatalogBindingFault::NullAdmin) {
    supplied_admin = nullptr;
  } else if (binding_fault == CatalogBindingFault::MismatchedAdmin) {
    CryptCATAdminAcquireContext2(&foreign_context.admin, &driver_action, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
    supplied_admin = foreign_context.admin;
  } else if (binding_fault == CatalogBindingFault::WrongHashAlgorithm) {
    CryptCATAdminAcquireContext2(&foreign_context.admin, &driver_action, BCRYPT_SHA1_ALGORITHM, nullptr, 0);
    supplied_admin = foreign_context.admin;
    supplied_hash_algorithm = BCRYPT_SHA1_ALGORITHM;
  } else if (binding_fault == CatalogBindingFault::ForeignCatalogContext) {
    if (CryptCATAdminAcquireContext2(&foreign_context.admin, &driver_action,
        BCRYPT_SHA256_ALGORITHM, nullptr, 0)) {
      foreign_context.catalog = CryptCATAdminEnumCatalogFromHash(
        foreign_context.admin, hash.data(), hash_bytes, 0, nullptr);
    }
    supplied_catalog = foreign_context.catalog;
  } else if (binding_fault == CatalogBindingFault::ReleasedEarly) {
    if (catalog) CryptCATAdminReleaseCatalogContext(admin, catalog, 0);
    catalog = nullptr;
    if (admin) CryptCATAdminReleaseContext(admin, 0);
    admin = nullptr;
    admin_retained = false;
    catalog_retained = false;
  }
  const bool catalog_enumerated = ok && enumerated_catalog != nullptr;
  const bool exact_binding = catalog_enumerated
    && ExactCatalogBinding(acquired_admin, enumerated_catalog, supplied_admin, supplied_catalog,
      supplied_hash_algorithm, admin_retained, catalog_retained);
  if (catalog_enumerated && !exact_binding) *failure = CatalogFailure::WinTrustPolicy;
  ok = exact_binding;
  CATALOG_INFO catalog_info{};
  catalog_info.cbStruct = sizeof(catalog_info);
  ok = ok && supplied_catalog && CryptCATCatalogInfoFromContext(supplied_catalog, &catalog_info, 0);
  std::wstring member_tag;
  if (ok) {
    *catalog_path = catalog_info.wszCatalogFile;
    ok = CanonicalMicrosoftCatalog(*catalog_path, catalog_sha256, catalog_identity, held_catalog);
    if (!ok) *failure = CatalogFailure::CatalogLease;
  }
  if (ok) {
    const std::string lower = Hex(hash.data(), hash.size());
    member_tag.assign(lower.begin(), lower.end());
    std::transform(member_tag.begin(), member_tag.end(), member_tag.begin(),
      [](wchar_t value) { return static_cast<wchar_t>(towupper(value)); });
    if (member_tag.empty() || member_tag.size() != hash.size() * 2) {
      ok = false;
      *failure = CatalogFailure::MemberTag;
    }
  }
  if (ok) {
    WINTRUST_CATALOG_INFO member{};
    member.cbStruct = sizeof(member);
    member.pcwszCatalogFilePath = catalog_info.wszCatalogFile;
    member.pcwszMemberTag = member_tag.c_str();
    member.pcwszMemberFilePath = path.c_str();
    member.hMemberFile = file;
    member.pbCalculatedFileHash = hash.data();
    member.cbCalculatedFileHash = hash_bytes;
    // pbCalculatedFileHash/member tag were produced by this exact retained
    // SHA-256 admin. Keep the exact enumerated HCATINFO alive through VERIFY
    // and CLOSE; pcCatalogContext is deliberately absent rather than sourced
    // from a different catalog-admin context.
    member.pcCatalogContext = nullptr;
    member.hCatAdmin = admin;
    WINTRUST_DATA data{};
    data.cbStruct = sizeof(data);
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_CATALOG;
    data.pCatalog = &member;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL;
    GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    const LONG trust_status = WinVerifyTrust(nullptr, &policy, &data);
    ok = trust_status == ERROR_SUCCESS;
    if (!ok) *failure = RevocationFailure(trust_status)
      ? CatalogFailure::Revocation : CatalogFailure::WinTrustPolicy;
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust(nullptr, &policy, &data);
  }
  if (!ok && *held_catalog != INVALID_HANDLE_VALUE) {
    CloseHandle(*held_catalog);
    *held_catalog = INVALID_HANDLE_VALUE;
  }
  if (ok) {
    context_lease->admin = admin;
    context_lease->catalog = catalog;
    admin = nullptr;
    catalog = nullptr;
  }
  if (catalog) CryptCATAdminReleaseCatalogContext(admin, catalog, 0);
  if (admin) CryptCATAdminReleaseContext(admin, 0);
  if (ok) *failure = CatalogFailure::None;
  return ok;
}

bool VerifyMicrosoftCompilerInput(const std::wstring& path, HANDLE file, std::string* certificate,
    std::string* spki, std::string* root_spki, std::string* catalog_sha256,
    std::string* catalog_name, std::wstring* catalog_path, FileIdInfo* catalog_identity,
    HANDLE* held_catalog, CatalogContextLease* context_lease, CatalogFailure* failure,
    CatalogBindingFault binding_fault = CatalogBindingFault::None,
    std::vector<std::string>* policy_diagnostics = nullptr) {
  // Inbox compiler/reference authorization is membership in the immutable,
  // OS-serviced Windows catalog rooted at the canonical CatRoot namespace.
  // An arbitrary embedded Authenticode signature, even under a Microsoft root,
  // is deliberately insufficient.
  std::wstring evidence_path;
  const bool trusted = VerifyCatalogTrust(path, file, &evidence_path, catalog_sha256,
    catalog_identity, held_catalog, context_lease, failure, binding_fault);
  std::string subject_der;
  DWORD chain_errors = 0xffffffff;
  if (!trusted) return false;
  if (!SignerEvidence(*held_catalog, SignerContent::StandaloneCatalog,
      nullptr, certificate, spki, root_spki, &chain_errors, &subject_der)) {
    *failure = (chain_errors & CERT_TRUST_IS_REVOKED) != 0
      ? CatalogFailure::Revocation : chain_errors == 0xffffffff
        ? CatalogFailure::SignerParse : CatalogFailure::WinTrustPolicy;
    return false;
  }
  if (policy_diagnostics) PolicyDiagnostics(path, evidence_path, *catalog_sha256, policy_diagnostics);
  const MicrosoftCatalogPolicyEntry* matching_identity = NamedMicrosoftCatalog(path, evidence_path);
  if (!matching_identity) { *failure = CatalogFailure::PolicyName; return false; }
  if (subject_der != matching_identity->subject_der) {
    *failure = CatalogFailure::ExactPublisher; return false;
  }
  if (!PinnedMicrosoftRoot(*root_spki)) { *failure = CatalogFailure::RootPin; return false; }
  if (*catalog_sha256 != matching_identity->catalog_sha256) { *failure = CatalogFailure::PolicyHash; return false; }
  if (*certificate != matching_identity->certificate_sha256 || *spki != matching_identity->spki_sha256
      || !ApprovedMicrosoftCatalog(path, evidence_path, subject_der, *certificate, *spki, *catalog_sha256)) {
    *failure = CatalogFailure::PolicyTuple; return false;
  }
  const wchar_t* approved_name = BaseName(evidence_path);
  catalog_name->clear();
  for (const wchar_t* cursor = approved_name; *cursor; ++cursor) {
    if (*cursor > 0x7f) { *failure = CatalogFailure::CatalogHash; return false; }
    catalog_name->push_back(static_cast<char>(*cursor));
  }
  *catalog_path = evidence_path;
  *failure = CatalogFailure::None;
  return true;
}

bool ExpectedArchitecture(HANDLE file) {
  IMAGE_DOS_HEADER dos{};
  DWORD read = 0;
  if (!ReadFile(file, &dos, sizeof(dos), &read, nullptr) || read != sizeof(dos) || dos.e_magic != IMAGE_DOS_SIGNATURE
      || SetFilePointer(file, dos.e_lfanew, nullptr, FILE_BEGIN) == INVALID_SET_FILE_POINTER) return false;
  DWORD signature = 0;
  IMAGE_FILE_HEADER header{};
  if (!ReadFile(file, &signature, sizeof(signature), &read, nullptr) || signature != IMAGE_NT_SIGNATURE
      || !ReadFile(file, &header, sizeof(header), &read, nullptr)) return false;
#if defined(_M_ARM64)
  return header.Machine == IMAGE_FILE_MACHINE_ARM64;
#else
  return header.Machine == IMAGE_FILE_MACHINE_AMD64;
#endif
}

std::wstring SystemWindowsDirectory() {
  std::array<wchar_t, kSystemDirectoryChars> path{};
  const UINT length = GetSystemWindowsDirectoryW(path.data(), static_cast<UINT>(path.size()));
  if (length == 0 || length >= path.size() || path[0] == L'\\' || path[1] != L':') return {};
  return std::wstring(path.data(), length);
}

bool CanonicalDirectory(const std::wstring& path, bool allow_current_user = true) {
  HANDLE directory = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  AttributeTagInfo tag{};
  FileIdInfo identity{};
  const bool valid = directory != INVALID_HANDLE_VALUE
    && GetFileInformationByHandleEx(directory, static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileAttributeTagInfo),
      &tag, sizeof(tag)) && FileIdentity(directory, &identity)
    && (tag.attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 && tag.reparse_tag == 0
    && SecureObjectAcl(directory, allow_current_user);
  if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
  return valid;
}

bool ProtectPrivateBuildDirectory(const std::wstring& path) {
  HANDLE directory = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  AttributeTagInfo tag{};
  PSECURITY_DESCRIPTOR current = nullptr;
  PSID owner = nullptr;
  std::wstring user_sid;
  bool valid = directory != INVALID_HANDLE_VALUE
    && GetFileInformationByHandleEx(directory, static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileAttributeTagInfo),
      &tag, sizeof(tag)) && (tag.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0
    && (tag.attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 && tag.reparse_tag == 0
    && GetSecurityInfo(directory, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr,
      &current) == ERROR_SUCCESS && owner && CurrentUserSid(owner) && CurrentUserSidText(&user_sid);
  PSECURITY_DESCRIPTOR replacement = nullptr;
  PACL dacl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  if (valid) {
    const std::wstring sddl = L"D:P(A;OICI;FA;;;" + user_sid
      + L")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    valid = ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
      &replacement, nullptr) && GetSecurityDescriptorDacl(replacement, &present, &dacl, &defaulted)
      && present && dacl && SetSecurityInfo(directory, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS;
  }
  if (replacement) LocalFree(replacement);
  if (current) LocalFree(current);
  if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
  return valid && CanonicalDirectory(path, true);
}

napi_value ProbeSystemDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) { Throw(env, "SYSTEM_PROBE"); return nullptr; }
  std::string fault;
  Utf8Value(env, args[0], "fault", &fault, true);
  const std::wstring windows = SystemWindowsDirectory();
  if (windows.empty()) { Throw(env, "SYSTEM_PROBE"); return nullptr; }
  const std::wstring powershell = windows + L"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const bool directory_valid = CanonicalDirectory(windows, false)
    && CanonicalDirectory(windows + L"\\System32", false)
    && CanonicalDirectory(windows + L"\\System32\\WindowsPowerShell", false)
    && CanonicalDirectory(windows + L"\\System32\\WindowsPowerShell\\v1.0", false);
  if (!directory_valid) { Throw(env, "SYSTEM_DIRECTORY"); return nullptr; }
  HANDLE candidate = CreateFileW(powershell.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (candidate == INVALID_HANDLE_VALUE) { Throw(env, "SYSTEM_CANDIDATE"); return nullptr; }
  LARGE_INTEGER size{};
  FileIdInfo identity{};
  FileIdInfo system_catalog_identity{};
  HANDLE system_catalog = INVALID_HANDLE_VALUE;
  CatalogContextLease system_catalog_context{};
  CatalogFailure catalog_failure = CatalogFailure::None;
  std::vector<std::string> policy_diagnostics;
  std::string system_certificate, system_spki, system_root_spki, system_catalog_sha256, system_catalog_name;
  std::wstring system_catalog_path;
  std::array<wchar_t, 32768> final_path{};
  const DWORD final_length = GetFinalPathNameByHandleW(candidate, final_path.data(), static_cast<DWORD>(final_path.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  const std::wstring expected_final = L"\\\\?\\" + powershell;
  const bool valid = GetFileSizeEx(candidate, &size) && size.QuadPart > 0 && size.QuadPart <= kMaxImageBytes
    && final_length > 0 && final_length < final_path.size() && _wcsicmp(final_path.data(), expected_final.c_str()) == 0
    && SecureServicedSystemFile(candidate, static_cast<DWORD>(size.QuadPart), &identity)
    && VerifyMicrosoftCompilerInput(powershell, candidate, &system_certificate, &system_spki,
      &system_root_spki, &system_catalog_sha256, &system_catalog_name, &system_catalog_path,
      &system_catalog_identity, &system_catalog, &system_catalog_context, &catalog_failure,
      CatalogBindingFaultFromString(fault), &policy_diagnostics);
  if (system_catalog != INVALID_HANDLE_VALUE) CloseHandle(system_catalog);
  CloseHandle(candidate);
  if (!valid) {
    const char* code = catalog_failure == CatalogFailure::None
      ? "SYSTEM_CANDIDATE" : CatalogFailureCode(catalog_failure);
    if ((catalog_failure == CatalogFailure::PolicyName || catalog_failure == CatalogFailure::PolicyHash
        || catalog_failure == CatalogFailure::PolicyTuple) && policy_diagnostics.size() == 3) {
      ThrowWithDiagnostics(env, code, policy_diagnostics);
    } else Throw(env, code);
    return nullptr;
  }
  constexpr std::array<const char*, 14> diagnostic_faults{
    "CATALOG_ENUMERATION", "MEMBER_TAG", "CATALOG_HASH", "POLICY_NAME", "POLICY_HASH", "POLICY_TUPLE",
    "WINTRUST_POLICY", "REVOCATION",
    "CATALOG_LEASE", "SIGNER_PARSE", "EXACT_PUBLISHER", "ROOT_PIN", "CERTIFICATE_PIN", "SPKI_PIN",
  };
  for (const char* code : diagnostic_faults) {
    if (fault == std::string("directory-") + code) { Throw(env, code); return nullptr; }
  }

  std::wstring system_root_hint, windir_hint;
  StringValue(env, args[0], "systemRoot", &system_root_hint);
  StringValue(env, args[0], "windir", &windir_hint);
  auto equal = [](const std::wstring& a, const std::wstring& b) {
    return a.empty() || (a.size() == b.size() && _wcsicmp(a.c_str(), b.c_str()) == 0);
  };
  if (!equal(system_root_hint, windows) || !equal(windir_hint, windows)) { Throw(env, "SYSTEM_HINT"); return nullptr; }

  void* data = nullptr;
  napi_value output;
  const size_t bytes = sizeof(uint16_t) + kSystemDirectoryChars * sizeof(char16_t);
  if (napi_create_buffer(env, bytes, &data, &output) != napi_ok) { Throw(env, "SYSTEM_PROBE"); return nullptr; }
  memset(data, 0, bytes);
  *static_cast<uint16_t*>(data) = static_cast<uint16_t>(windows.size());
  memcpy(static_cast<BYTE*>(data) + sizeof(uint16_t), windows.data(), windows.size() * sizeof(wchar_t));
  return output;
}

bool PipePair(HANDLE* read, HANDLE* write, bool parent_reads) {
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
  if (!CreatePipe(read, write, &attributes, 0)) return false;
  HANDLE parent = parent_reads ? *read : *write;
  return SetHandleInformation(parent, HANDLE_FLAG_INHERIT, 0) != FALSE;
}

bool MutationWasDenied(const std::wstring& path, const std::string& fault) {
  if (fault.find("delete") != std::string::npos) return !DeleteFileW(path.c_str());
  if (fault.find("swap") != std::string::npos || fault.find("rename") != std::string::npos
      || fault.find("aba") != std::string::npos) {
    const std::wstring displaced = path + L".native-barrier";
    if (!MoveFileExW(path.c_str(), displaced.c_str(), MOVEFILE_REPLACE_EXISTING)) return true;
    MoveFileExW(displaced.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING);
    return false;
  }
  if (fault.find("write") != std::string::npos) {
    HANDLE writer = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (writer == INVALID_HANDLE_VALUE) return true;
    CloseHandle(writer);
    return false;
  }
  return true;
}

napi_value LoadVerifiedModule(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  std::wstring path;
  std::string expected_hash, publisher, certificate_pin, spki_pin, fault, authentication_mode;
  uint32_t expected_size = 0;
  bool production = false;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || !StringValue(env, args[0], "path", &path) || !Utf8Value(env, args[0], "sha256", &expected_hash)
      || !Uint32Value(env, args[0], "size", &expected_size) || !BoolValue(env, args[0], "production", &production)
      || expected_hash.size() != 64 || expected_size == 0 || expected_size > kMaxImageBytes) {
    Throw(env, "MODULE_ARGUMENT"); return nullptr;
  }
  Utf8Value(env, args[0], "publisher", &publisher, true);
  Utf8Value(env, args[0], "signerCertificateSha256", &certificate_pin, true);
  Utf8Value(env, args[0], "signerSpkiSha256", &spki_pin, true);
  Utf8Value(env, args[0], "fault", &fault, true);
  if (!Utf8Value(env, args[0], "authenticationMode", &authentication_mode)) {
    Throw(env, "MODULE_ARGUMENT"); return nullptr;
  }
#if defined(PROPR_WINDOWS_BUILD_BOOTSTRAP)
  const bool allow_current_build_owner = authentication_mode == "held-build-artifact" && !production
    && publisher.empty() && certificate_pin.empty() && spki_pin.empty();
  if (!allow_current_build_owner) { Throw(env, "MODULE_ARGUMENT"); return nullptr; }
#else
  const bool allow_current_build_owner = false;
  if (authentication_mode != "runtime") { Throw(env, "MODULE_ARGUMENT"); return nullptr; }
#endif

  // This handle denies write/delete sharing across authentication, loader
  // mapping, loaded-image comparison and N-API registration. Consequently a
  // hostile DllMain/NAPI image cannot be substituted at the pre-load barrier.
  HANDLE held = CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  FileIdInfo held_id{};
  std::string held_hash;
#if defined(PROPR_WINDOWS_BUILD_BOOTSTRAP)
  SecureRegularFileFailure file_failure = SecureRegularFileFailure::None;
  bool regular_file_valid = false;
  bool architecture_valid = false;
  bool hash_valid = false;
  if (held != INVALID_HANDLE_VALUE) {
    file_failure = DiagnoseSecureRegularFile(
      held, expected_size, &held_id, allow_current_build_owner, allow_current_build_owner);
    if (file_failure == SecureRegularFileFailure::None)
      regular_file_valid = SecureRegularFile(
        held, expected_size, &held_id, allow_current_build_owner, allow_current_build_owner);
    if (regular_file_valid) architecture_valid = ExpectedArchitecture(held);
    if (architecture_valid) {
      hash_valid = Sha256Handle(held, expected_size, &held_hash) && held_hash == expected_hash;
    }
  }
  const bool authenticated = held != INVALID_HANDLE_VALUE && regular_file_valid && architecture_valid && hash_valid
    && (!production || VerifyPinnedSignature(path, held, publisher, certificate_pin, spki_pin));
#else
  const bool authenticated = held != INVALID_HANDLE_VALUE
    && SecureRegularFile(held, expected_size, &held_id, allow_current_build_owner, allow_current_build_owner)
    && ExpectedArchitecture(held)
    && Sha256Handle(held, expected_size, &held_hash) && held_hash == expected_hash
    && (!production || VerifyPinnedSignature(path, held, publisher, certificate_pin, spki_pin));
#endif
  if (!authenticated) {
    if (held != INVALID_HANDLE_VALUE) CloseHandle(held);
#if defined(PROPR_WINDOWS_BUILD_BOOTSTRAP)
    if (held == INVALID_HANDLE_VALUE) { Throw(env, "OPEN"); return nullptr; }
    if (file_failure == SecureRegularFileFailure::FileMeta) { Throw(env, "FILE_META"); return nullptr; }
    if (file_failure == SecureRegularFileFailure::Owner) { Throw(env, "OWNER"); return nullptr; }
    if (file_failure == SecureRegularFileFailure::Dacl) { Throw(env, "DACL"); return nullptr; }
    if (file_failure == SecureRegularFileFailure::DaclProtected) { Throw(env, "DACL_PROTECTED"); return nullptr; }
    if (!regular_file_valid) { Throw(env, "MODULE_AUTHORITY"); return nullptr; }
    if (!architecture_valid) { Throw(env, "ARCH"); return nullptr; }
    if (!hash_valid) { Throw(env, "HASH"); return nullptr; }
#endif
    Throw(env, "MODULE_AUTHORITY"); return nullptr;
  }
  if (fault.rfind("barrier-before-module-load-", 0) == 0 && !MutationWasDenied(path, fault)) {
    CloseHandle(held); Throw(env, "MODULE_BARRIER"); return nullptr;
  }

  HMODULE module = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  std::array<wchar_t, 32768> loaded_path{};
  const DWORD loaded_length = module
    ? GetModuleFileNameW(module, loaded_path.data(), static_cast<DWORD>(loaded_path.size())) : 0;
  HANDLE loaded = loaded_length > 0 && loaded_length < loaded_path.size()
    ? CreateFileW(loaded_path.data(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr)
    : INVALID_HANDLE_VALUE;
  FileIdInfo loaded_id{};
  std::string loaded_hash;
  const bool same_image = module && loaded != INVALID_HANDLE_VALUE
    && SecureRegularFile(loaded, expected_size, &loaded_id, allow_current_build_owner, allow_current_build_owner)
    && SameIdentity(held_id, loaded_id)
    && Sha256Handle(loaded, expected_size, &loaded_hash) && loaded_hash == held_hash;
  if (loaded != INVALID_HANDLE_VALUE) CloseHandle(loaded);
  if (!same_image) {
    if (module) FreeLibrary(module);
    CloseHandle(held); Throw(env, "MODULE_IMAGE"); return nullptr;
  }
  using RegisterModule = napi_value (*)(napi_env, napi_value);
  auto* registration = reinterpret_cast<RegisterModule>(GetProcAddress(module, "napi_register_module_v1"));
  napi_value exports;
  if (!registration || napi_create_object(env, &exports) != napi_ok) {
    FreeLibrary(module); CloseHandle(held); Throw(env, "MODULE_REGISTER"); return nullptr;
  }
  napi_value registered = registration(env, exports);
  CloseHandle(held);
  if (!registered) { Throw(env, "MODULE_REGISTER"); return nullptr; }
  // Deliberately retain the authenticated module for the Node environment;
  // unloading while exported functions remain reachable would be unsafe.
  return registered;
}

std::wstring Quote(const std::wstring& value) {
  std::wstring result = L"\"";
  for (wchar_t ch : value) { if (ch == L'\"') result += L'\\'; result += ch; }
  return result + L"\" --broker";
}

napi_value Launch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) { Throw(env, "LAUNCH_ARGUMENT"); return nullptr; }
  std::wstring path;
  std::string expected_hash;
  std::string fault;
  std::string publisher, certificate_pin, spki_pin;
  uint32_t expected_size = 0;
  bool production = false;
  if (!StringValue(env, args[0], "path", &path) || !Utf8Value(env, args[0], "sha256", &expected_hash)
      || !Uint32Value(env, args[0], "size", &expected_size) || expected_hash.size() != 64
      || !BoolValue(env, args[0], "production", &production)
      || expected_size == 0 || expected_size > kMaxImageBytes) { Throw(env, "LAUNCH_ARGUMENT"); return nullptr; }
  Utf8Value(env, args[0], "fault", &fault, true);
  Utf8Value(env, args[0], "publisher", &publisher, true);
  Utf8Value(env, args[0], "signerCertificateSha256", &certificate_pin, true);
  Utf8Value(env, args[0], "signerSpkiSha256", &spki_pin, true);

  HANDLE image = CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (image == INVALID_HANDLE_VALUE) { Throw(env, "HELPER_OPEN"); return nullptr; }
  FileIdInfo held_id{};
  std::string held_hash;
  if (!SecureRegularFile(image, expected_size, &held_id, false)
      || !Sha256Handle(image, expected_size, &held_hash) || held_hash != expected_hash
      || (production && !VerifyPinnedSignature(path, image, publisher, certificate_pin, spki_pin))) {
    CloseHandle(image); Throw(env, "HELPER_AUTHORITY"); return nullptr;
  }
  if (fault.rfind("barrier-after-hash-", 0) == 0 && !MutationWasDenied(path, fault)) {
    CloseHandle(image); Throw(env, "HELPER_BARRIER"); return nullptr;
  }

  HANDLE child_in_read = nullptr, parent_in_write = nullptr;
  HANDLE parent_out_read = nullptr, child_out_write = nullptr;
  HANDLE parent_err_read = nullptr, child_err_write = nullptr;
  if (!PipePair(&child_in_read, &parent_in_write, false)
      || !PipePair(&parent_out_read, &child_out_write, true)
      || !PipePair(&parent_err_read, &child_err_write, true)) {
    if (child_in_read) CloseHandle(child_in_read);
    if (parent_in_write) CloseHandle(parent_in_write);
    if (parent_out_read) CloseHandle(parent_out_read);
    if (child_out_write) CloseHandle(child_out_write);
    if (parent_err_read) CloseHandle(parent_err_read);
    if (child_err_write) CloseHandle(child_err_write);
    CloseHandle(image); Throw(env, "PIPE_CREATE"); return nullptr;
  }

  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<BYTE> attribute_storage(attribute_bytes);
  auto* attributes = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  HANDLE inherited[] = {child_in_read, child_out_write, child_err_write};
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = child_in_read;
  startup.StartupInfo.hStdOutput = child_out_write;
  startup.StartupInfo.hStdError = child_err_write;
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  std::wstring command = Quote(path);
  const std::wstring windows = SystemWindowsDirectory();
  std::wstring environment;
  if (!fault.empty()) {
    std::wstring wide_fault(fault.begin(), fault.end());
    if (fault == "stderr") environment += L"PROPR_WINDOWS_AUTHORITY_TEST_TRANSPORT_FAULT=stderr";
    else if (fault == "process-image") environment += L"PROPR_WINDOWS_AUTHORITY_TEST_IMAGE_FAULT=process-image";
    else environment += L"PROPR_WINDOWS_AUTHORITY_TEST_STAGE=" + wide_fault;
    environment.push_back(L'\0');
  }
  // CreateProcess requires a sorted Unicode environment block. The optional
  // fixed PROPR_* test enum sorts before the sole production SystemRoot entry.
  environment += L"SystemRoot=" + windows;
  environment.push_back(L'\0');
  environment.push_back(L'\0');
  const bool attributes_initialized = InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes) != FALSE;
  const bool precreate_barrier = fault.rfind("barrier-before-create-", 0) != 0 || MutationWasDenied(path, fault);
  bool created = precreate_barrier && attributes_initialized
    && UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)
    && CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
      environment.data(), nullptr, &startup.StartupInfo, &process);
  if (attributes_initialized) DeleteProcThreadAttributeList(attributes);
  CloseHandle(child_in_read); CloseHandle(child_out_write); CloseHandle(child_err_write);
  if (!created) {
    CloseHandle(parent_in_write); CloseHandle(parent_out_read); CloseHandle(parent_err_read); CloseHandle(image);
    Throw(env, "PROCESS_CREATE"); return nullptr;
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  bool proven = job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))
    && AssignProcessToJobObject(job, process.hProcess);
  if (fault == "job-assignment") proven = false;
  if (fault == "extra-child" && proven) {
    STARTUPINFOW extra_startup{};
    extra_startup.cb = sizeof(extra_startup);
    PROCESS_INFORMATION extra{};
    std::wstring extra_command = Quote(path);
    const bool extra_created = CreateProcessW(path.c_str(), extra_command.data(), nullptr, nullptr, FALSE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
      environment.data(), nullptr, &extra_startup, &extra);
    const bool process_limit_enforced = extra_created && !AssignProcessToJobObject(job, extra.hProcess);
    if (extra_created) {
      TerminateProcess(extra.hProcess, 127);
      CloseHandle(extra.hThread);
      CloseHandle(extra.hProcess);
    }
    proven = process_limit_enforced;
  }
  if (fault.rfind("barrier-after-process-", 0) == 0 && !MutationWasDenied(path, fault)) proven = false;
  std::array<wchar_t, 32768> loaded_path{};
  DWORD loaded_length = static_cast<DWORD>(loaded_path.size());
  proven = proven && QueryFullProcessImageNameW(process.hProcess, 0, loaded_path.data(), &loaded_length);
  HANDLE loaded = proven ? CreateFileW(loaded_path.data(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr) : INVALID_HANDLE_VALUE;
  FileIdInfo loaded_id{};
  std::string loaded_hash;
  proven = proven && loaded != INVALID_HANDLE_VALUE && SecureRegularFile(loaded, expected_size, &loaded_id, false)
    && SameIdentity(held_id, loaded_id) && Sha256Handle(loaded, expected_size, &loaded_hash) && loaded_hash == held_hash;
  if (fault == "parent-image-proof" || fault == "pipe-substitution") proven = false;
  if (loaded != INVALID_HANDLE_VALUE) CloseHandle(loaded);
  if (!proven || ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    TerminateProcess(process.hProcess, 127); CloseHandle(process.hThread); CloseHandle(process.hProcess);
    if (job) CloseHandle(job);
    CloseHandle(parent_in_write); CloseHandle(parent_out_read); CloseHandle(parent_err_read); CloseHandle(image);
    Throw(env, proven ? "PROCESS_RESUME" : "PROCESS_IMAGE"); return nullptr;
  }
  CloseHandle(process.hThread);

  auto* lease = new LaunchLease();
  lease->image = image;
  lease->process = process.hProcess;
  lease->job = job;
  lease->stdin_fd = _open_osfhandle(reinterpret_cast<intptr_t>(parent_in_write), _O_WRONLY | _O_BINARY);
  if (lease->stdin_fd >= 0) parent_in_write = nullptr;
  lease->stdout_fd = _open_osfhandle(reinterpret_cast<intptr_t>(parent_out_read), _O_RDONLY | _O_BINARY);
  if (lease->stdout_fd >= 0) parent_out_read = nullptr;
  lease->stderr_fd = _open_osfhandle(reinterpret_cast<intptr_t>(parent_err_read), _O_RDONLY | _O_BINARY);
  if (lease->stderr_fd >= 0) parent_err_read = nullptr;
  if (lease->stdin_fd < 0 || lease->stdout_fd < 0 || lease->stderr_fd < 0) {
    CloseLease(lease);
    if (parent_in_write) CloseHandle(parent_in_write);
    if (parent_out_read) CloseHandle(parent_out_read);
    if (parent_err_read) CloseHandle(parent_err_read);
    delete lease; Throw(env, "PIPE_EXPORT"); return nullptr;
  }
  napi_value result, external, value;
  napi_create_object(env, &result);
  napi_create_external(env, lease, FinalizeLease, nullptr, &external);
  napi_set_named_property(env, result, "lease", external);
  napi_create_int32(env, lease->stdin_fd, &value); napi_set_named_property(env, result, "stdinFd", value);
  napi_create_int32(env, lease->stdout_fd, &value); napi_set_named_property(env, result, "stdoutFd", value);
  napi_create_int32(env, lease->stderr_fd, &value); napi_set_named_property(env, result, "stderrFd", value);
  napi_create_uint32(env, process.dwProcessId, &value); napi_set_named_property(env, result, "pid", value);
  char volume[17]{};
  sprintf_s(volume, "%016llx", held_id.volume);
  napi_create_string_utf8(env, volume, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "volumeSerial", value);
  napi_create_string_utf8(env, Hex(held_id.id, sizeof(held_id.id)).c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "fileId128", value);
  return result;
}

LaunchLease* LeaseArgument(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  void* data = nullptr;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || napi_get_value_external(env, args[0], &data) != napi_ok) return nullptr;
  return static_cast<LaunchLease*>(data);
}

napi_value Status(napi_env env, napi_callback_info info) {
  LaunchLease* lease = LeaseArgument(env, info);
  if (!lease || lease->closed || !lease->process) { Throw(env, "LEASE_CLOSED"); return nullptr; }
  DWORD code = 0;
  if (!GetExitCodeProcess(lease->process, &code)) { Throw(env, "PROCESS_STATUS"); return nullptr; }
  napi_value result;
  if (code == STILL_ACTIVE) napi_get_null(env, &result); else napi_create_uint32(env, code, &result);
  return result;
}

napi_value CloseInput(napi_env env, napi_callback_info info) {
  LaunchLease* lease = LeaseArgument(env, info);
  if (!lease || lease->closed) { Throw(env, "LEASE_CLOSED"); return nullptr; }
  if (lease->stdin_fd >= 0) { _close(lease->stdin_fd); lease->stdin_fd = -1; }
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value Terminate(napi_env env, napi_callback_info info) {
  LaunchLease* lease = LeaseArgument(env, info);
  if (!lease || lease->closed || !lease->process || !TerminateProcess(lease->process, 127)) {
    Throw(env, "PROCESS_TERMINATE"); return nullptr;
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value Close(napi_env env, napi_callback_info info) {
  LaunchLease* lease = LeaseArgument(env, info);
  if (!lease) { Throw(env, "LEASE_CLOSED"); return nullptr; }
  CloseLease(lease);
  napi_value result; napi_get_undefined(env, &result); return result;
}

bool StringArrayValue(napi_env env, napi_value object, const char* name, size_t expected,
    std::vector<std::wstring>* result) {
  napi_value array;
  bool is_array = false;
  uint32_t length = 0;
  if (napi_get_named_property(env, object, name, &array) != napi_ok
      || napi_is_array(env, array, &is_array) != napi_ok || !is_array
      || napi_get_array_length(env, array, &length) != napi_ok || length != expected) return false;
  for (uint32_t index = 0; index < length; ++index) {
    napi_value value;
    size_t chars = 0;
    if (napi_get_element(env, array, index, &value) != napi_ok
        || napi_get_value_string_utf16(env, value, nullptr, 0, &chars) != napi_ok
        || chars == 0 || chars > 32767) return false;
    std::vector<char16_t> buffer(chars + 1);
    if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &chars) != napi_ok) return false;
    result->emplace_back(reinterpret_cast<const wchar_t*>(buffer.data()), chars);
  }
  return true;
}

bool Uint32ArrayValue(napi_env env, napi_value object, const char* name, size_t expected,
    std::vector<uint32_t>* result) {
  napi_value array;
  bool is_array = false;
  uint32_t length = 0;
  if (napi_get_named_property(env, object, name, &array) != napi_ok
      || napi_is_array(env, array, &is_array) != napi_ok || !is_array
      || napi_get_array_length(env, array, &length) != napi_ok || length != expected) return false;
  for (uint32_t index = 0; index < length; ++index) {
    napi_value value;
    uint32_t number = 0;
    if (napi_get_element(env, array, index, &value) != napi_ok
        || napi_get_value_uint32(env, value, &number) != napi_ok || number == 0
        || number > kMaxBuildInputBytes) return false;
    result->push_back(number);
  }
  return true;
}

bool Utf8ArrayValue(napi_env env, napi_value object, const char* name, size_t expected,
    std::vector<std::string>* result) {
  napi_value array;
  bool is_array = false;
  uint32_t length = 0;
  if (napi_get_named_property(env, object, name, &array) != napi_ok
      || napi_is_array(env, array, &is_array) != napi_ok || !is_array
      || napi_get_array_length(env, array, &length) != napi_ok || length != expected) return false;
  for (uint32_t index = 0; index < length; ++index) {
    napi_value value;
    size_t bytes = 0;
    if (napi_get_element(env, array, index, &value) != napi_ok
        || napi_get_value_string_utf8(env, value, nullptr, 0, &bytes) != napi_ok || bytes != 64) return false;
    std::vector<char> buffer(bytes + 1);
    if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &bytes) != napi_ok) return false;
    result->emplace_back(buffer.data(), bytes);
  }
  return true;
}

std::wstring QuoteArgument(const std::wstring& value) {
  if (value.find(L'"') != std::wstring::npos || value.find(L'\0') != std::wstring::npos) return {};
  return L"\"" + value + L"\"";
}

bool SameHeldBuildInput(HANDLE handle, const FileIdInfo& expected_id, DWORD expected_size,
    const std::string& expected_hash) {
  FileIdInfo after_id{};
  std::string after_hash;
  return SecureServicedSystemFile(handle, expected_size, &after_id) && SameIdentity(expected_id, after_id)
    && Sha256Handle(handle, expected_size, &after_hash, kMaxBuildInputBytes) && after_hash == expected_hash;
}

bool SameHeldCatalog(HANDLE handle, const FileIdInfo& expected_id, const std::string& expected_hash) {
  LARGE_INTEGER size{};
  FileIdInfo after_id{};
  std::string after_hash;
  return handle != INVALID_HANDLE_VALUE && GetFileSizeEx(handle, &size)
    && size.QuadPart > 0 && size.QuadPart <= kMaxBuildInputBytes
    && SecureServicedSystemFile(handle, static_cast<DWORD>(size.QuadPart), &after_id)
    && SameIdentity(expected_id, after_id)
    && Sha256Handle(handle, static_cast<DWORD>(size.QuadPart), &after_hash, kMaxBuildInputBytes)
    && after_hash == expected_hash;
}

napi_value CompileHeld(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], source_value;
  std::wstring system_root, output_path, working_directory;
  std::vector<std::wstring> paths;
  std::vector<uint32_t> sizes;
  std::vector<std::string> hashes;
  std::string fault;
  void* source_data = nullptr;
  size_t source_size = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || !StringValue(env, args[0], "systemRoot", &system_root)
      || !StringValue(env, args[0], "output", &output_path)
      || !StringValue(env, args[0], "cwd", &working_directory)
      || !StringArrayValue(env, args[0], "paths", 3, &paths)
      || !Uint32ArrayValue(env, args[0], "sizes", 3, &sizes)
      || !Utf8ArrayValue(env, args[0], "sha256", 3, &hashes)
      || napi_get_named_property(env, args[0], "source", &source_value) != napi_ok
      || napi_get_buffer_info(env, source_value, &source_data, &source_size) != napi_ok
      || source_size == 0 || source_size > kMaxSourceBytes) {
    Throw(env, "COMPILE_ARGUMENT"); return nullptr;
  }
  Utf8Value(env, args[0], "fault", &fault, true);
  const std::wstring expected_output = working_directory + L"\\propr-windows-authority.exe";
  if (_wcsicmp(output_path.c_str(), expected_output.c_str()) != 0
      || std::any_of(paths.begin(), paths.end(), [](const std::wstring& path) {
        return path.find(L'"') != std::wstring::npos || path.find(L'\0') != std::wstring::npos;
      })) {
    Throw(env, "COMPILE_ARGUMENT"); return nullptr;
  }
  if (!CanonicalDirectory(system_root, false) || !ProtectPrivateBuildDirectory(working_directory)) {
    Throw(env, "DIRECTORY_PROBE"); return nullptr;
  }
  HANDLE directory_lease = CreateFileW(working_directory.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  FileIdInfo directory_id{};
  if (directory_lease == INVALID_HANDLE_VALUE || !FileIdentity(directory_lease, &directory_id)
      || !SecureObjectAcl(directory_lease, true)) {
    if (directory_lease != INVALID_HANDLE_VALUE) CloseHandle(directory_lease);
    Throw(env, "DIRECTORY_PROBE"); return nullptr;
  }

  std::array<HANDLE, 3> inputs{INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE};
  std::array<HANDLE, 3> catalogs{INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE};
  std::array<CatalogContextLease, 3> catalog_contexts{};
  std::array<FileIdInfo, 3> identities{};
  std::array<FileIdInfo, 3> catalog_identities{};
  std::array<std::string, 3> certificates, spkis, root_spkis, catalog_hashes, catalog_names;
  std::array<std::wstring, 3> catalog_paths;
  CatalogFailure catalog_failure = CatalogFailure::None;
  std::vector<std::string> policy_diagnostics;
  bool inputs_valid = true;
  size_t failed_input = inputs.size();
  for (size_t index = 0; index < inputs.size(); ++index) {
    inputs[index] = CreateFileW(paths[index].c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (inputs[index] == INVALID_HANDLE_VALUE
        || !SecureServicedSystemFile(inputs[index], sizes[index], &identities[index])
        || !Sha256Handle(inputs[index], sizes[index], &certificates[index], kMaxBuildInputBytes)
        || certificates[index] != hashes[index]) {
      inputs_valid = false;
      failed_input = index;
      break;
    }
  }
  if (!inputs_valid) {
    for (HANDLE handle : inputs) if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    CloseHandle(directory_lease);
    Throw(env, failed_input == 0 ? "COMPILER_OPEN" : "REFERENCE_OPEN"); return nullptr;
  }
  for (size_t index = 0; index < inputs.size(); ++index) {
    // Overwrite the temporary hash slot with actual signer evidence only after
    // exact held-byte authentication. Catalog-signed serviced hard links are
    // accepted; reparse points and user-writable aliases are not.
    if (!VerifyMicrosoftCompilerInput(paths[index], inputs[index], &certificates[index], &spkis[index],
        &root_spkis[index], &catalog_hashes[index], &catalog_names[index], &catalog_paths[index],
        &catalog_identities[index], &catalogs[index], &catalog_contexts[index], &catalog_failure,
        CatalogBindingFault::None, &policy_diagnostics)) {
      inputs_valid = false;
      break;
    }
  }
  if (inputs_valid && fault == "compiler-swapped-catalog") {
    // Perform the pathname replacement while the exact catalog is leased. A
    // denied mutation and a surprising successful mutation are both a fatal
    // test outcome before the compiler process exists.
    const bool denied = MutationWasDenied(catalog_paths[0], "swap");
    inputs_valid = false;
    catalog_failure = denied ? CatalogFailure::CatalogLease : CatalogFailure::CatalogHash;
  }
  if (inputs_valid && fault == "compiler-wrong-catalog") {
    // Materialize the exact held, valid Microsoft catalog bytes under a
    // controlled non-policy identity. This is a real signed catalog attack,
    // not a fabricated proof record or a fault label standing in for one.
    const std::wstring wrong_path = working_directory + L"\\attacker-wrong-catalog.cat";
    HANDLE wrong_output = CreateFileW(wrong_path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    bool presented = wrong_output != INVALID_HANDLE_VALUE
      && SetFilePointer(catalogs[0], 0, nullptr, FILE_BEGIN) != INVALID_SET_FILE_POINTER;
    std::array<BYTE, 64 * 1024> bytes{};
    while (presented) {
      DWORD read = 0, written = 0;
      if (!ReadFile(catalogs[0], bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr)) {
        presented = false; break;
      }
      if (read == 0) break;
      if (!WriteFile(wrong_output, bytes.data(), read, &written, nullptr) || written != read) {
        presented = false; break;
      }
    }
    if (wrong_output != INVALID_HANDLE_VALUE) {
      presented = presented && FlushFileBuffers(wrong_output);
      CloseHandle(wrong_output);
    }
    HANDLE wrong = CreateFileW(wrong_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    LARGE_INTEGER wrong_size{};
    std::string wrong_hash, wrong_certificate, wrong_spki, wrong_root, wrong_subject;
    presented = presented && wrong != INVALID_HANDLE_VALUE && GetFileSizeEx(wrong, &wrong_size)
      && wrong_size.QuadPart > 0 && wrong_size.QuadPart <= kMaxBuildInputBytes
      && Sha256Handle(wrong, static_cast<DWORD>(wrong_size.QuadPart), &wrong_hash, kMaxBuildInputBytes)
      && SignerEvidence(wrong, SignerContent::StandaloneCatalog, nullptr,
        &wrong_certificate, &wrong_spki, &wrong_root, nullptr, &wrong_subject)
      && !ApprovedMicrosoftCatalog(paths[0], wrong_path, wrong_subject, wrong_certificate, wrong_spki, wrong_hash);
    if (wrong != INVALID_HANDLE_VALUE) CloseHandle(wrong);
    DeleteFileW(wrong_path.c_str());
    // The copied, genuinely signed bytes reached the same signer parser and
    // fixed catalog identity policy. A fixture/setup failure is distinct from
    // the expected exact-name/hash rejection and can never be credited as it.
    inputs_valid = false;
    catalog_failure = presented ? CatalogFailure::CatalogHash : CatalogFailure::SignerParse;
  }
  if (!inputs_valid) {
    for (HANDLE handle : inputs) CloseHandle(handle);
    for (HANDLE handle : catalogs) if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    CloseHandle(directory_lease);
    const char* code = catalog_failure == CatalogFailure::None
      ? "SIGNER_CATALOG" : CatalogFailureCode(catalog_failure);
    if ((catalog_failure == CatalogFailure::PolicyName || catalog_failure == CatalogFailure::PolicyHash
        || catalog_failure == CatalogFailure::PolicyTuple) && policy_diagnostics.size() == 3) {
      ThrowWithDiagnostics(env, code, policy_diagnostics);
    } else Throw(env, code);
    return nullptr;
  }
  if ((fault == "compiler-swap-after-open" && !MutationWasDenied(paths[0], "swap"))
      || (fault == "reference-swap-after-open" && !MutationWasDenied(paths[1], "swap"))) {
    for (HANDLE handle : inputs) CloseHandle(handle);
    for (HANDLE handle : catalogs) if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    CloseHandle(directory_lease);
    Throw(env, "LEASE"); return nullptr;
  }

  std::array<BYTE, 16> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    for (HANDLE handle : inputs) CloseHandle(handle);
    for (HANDLE handle : catalogs) if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    CloseHandle(directory_lease);
    Throw(env, "SOURCE_COPY"); return nullptr;
  }
  const std::string random_hex = Hex(random.data(), random.size());
  const std::wstring random_name(random_hex.begin(), random_hex.end());
  const std::wstring source_path = working_directory + L"\\source-" + random_name + L".cs";
  HANDLE source = CreateFileW(source_path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ,
    nullptr, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  DWORD written = 0;
  bool source_valid = source != INVALID_HANDLE_VALUE
    && WriteFile(source, source_data, static_cast<DWORD>(source_size), &written, nullptr) && written == source_size
    && FlushFileBuffers(source) && SetFilePointer(source, 0, nullptr, FILE_BEGIN) != INVALID_SET_FILE_POINTER;
  FileIdInfo source_id{};
  std::string source_hash;
  source_valid = source_valid && SecureRegularFile(source, static_cast<DWORD>(source_size), &source_id, false)
    && Sha256Handle(source, static_cast<DWORD>(source_size), &source_hash);
  if (!source_valid) {
    if (source != INVALID_HANDLE_VALUE) CloseHandle(source);
    DeleteFileW(source_path.c_str());
    for (HANDLE handle : inputs) CloseHandle(handle);
    for (HANDLE handle : catalogs) if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    CloseHandle(directory_lease);
    Throw(env, "SOURCE_COPY"); return nullptr;
  }
  if ((fault == "source-swap-after-copy" || fault == "source-rename" || fault == "source-reparse"
      || fault == "source-replace") && !MutationWasDenied(source_path, "swap")) source_valid = false;
  if (fault == "source-truncate" && !MutationWasDenied(source_path, "write")) source_valid = false;
  if (fault == "source-hardlink") {
    const std::wstring extra_link = source_path + L".link";
    CreateHardLinkW(extra_link.c_str(), source_path.c_str(), nullptr);
    DeleteFileW(extra_link.c_str());
  }
  if ((fault == "compiler-swap-before-create" && !MutationWasDenied(paths[0], "swap"))
      || (fault == "reference-swap-before-create" && !MutationWasDenied(paths[1], "swap"))) source_valid = false;

  SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE};
  HANDLE child_stdin = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE child_stdout = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE child_stderr = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE inherited[] = {child_stdin, child_stdout, child_stderr};
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<BYTE> attribute_storage(attribute_bytes);
  auto* attributes = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = child_stdin;
  startup.StartupInfo.hStdOutput = child_stdout;
  startup.StartupInfo.hStdError = child_stderr;
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  const std::wstring compiler_arg = QuoteArgument(paths[0]);
  const std::wstring output_arg = QuoteArgument(L"/out:" + output_path);
  const std::wstring reference_one = QuoteArgument(L"/reference:" + paths[1]);
  const std::wstring reference_two = QuoteArgument(L"/reference:" + paths[2]);
  const std::wstring source_arg = QuoteArgument(source_path);
  std::wstring command = compiler_arg + L" /nologo /noconfig /target:exe /platform:anycpu /optimize+ /checked+"
    L" /warnaserror+ " + output_arg + L" " + reference_one + L" " + reference_two + L" " + source_arg;
  std::wstring environment = L"SystemRoot=" + system_root + L'\0' + L'\0';
  const bool attributes_initialized = child_stdin != INVALID_HANDLE_VALUE && child_stdout != INVALID_HANDLE_VALUE
    && child_stderr != INVALID_HANDLE_VALUE && source_valid
    && InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes);
  bool created = attributes_initialized
    && UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)
    && CreateProcessW(paths[0].c_str(), command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
      environment.data(), working_directory.c_str(), &startup.StartupInfo, &process);
  if (attributes_initialized) DeleteProcThreadAttributeList(attributes);
  if (child_stdin != INVALID_HANDLE_VALUE) CloseHandle(child_stdin);
  if (child_stdout != INVALID_HANDLE_VALUE) CloseHandle(child_stdout);
  if (child_stderr != INVALID_HANDLE_VALUE) CloseHandle(child_stderr);

  HANDLE job = created ? CreateJobObjectW(nullptr, nullptr) : nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  bool image_proven = created && job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))
    && AssignProcessToJobObject(job, process.hProcess) && fault != "compiler-job";
  std::array<wchar_t, 32768> loaded_path{};
  DWORD loaded_length = static_cast<DWORD>(loaded_path.size());
  image_proven = image_proven && QueryFullProcessImageNameW(process.hProcess, 0, loaded_path.data(), &loaded_length);
  HANDLE loaded = image_proven ? CreateFileW(loaded_path.data(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr) : INVALID_HANDLE_VALUE;
  FileIdInfo loaded_id{};
  std::string loaded_hash;
  image_proven = image_proven && loaded != INVALID_HANDLE_VALUE
    && SecureServicedSystemFile(loaded, sizes[0], &loaded_id) && SameIdentity(identities[0], loaded_id)
    && Sha256Handle(loaded, sizes[0], &loaded_hash, kMaxBuildInputBytes) && loaded_hash == hashes[0]
    && fault != "compiler-image";
  if (fault == "compiler-swap-after-process" && !MutationWasDenied(paths[0], "swap")) image_proven = false;
  if (loaded != INVALID_HANDLE_VALUE) CloseHandle(loaded);
  bool exited = image_proven && ResumeThread(process.hThread) != static_cast<DWORD>(-1)
    && WaitForSingleObject(process.hProcess, 60'000) == WAIT_OBJECT_0;
  DWORD exit_code = 1;
  if (exited) exited = GetExitCodeProcess(process.hProcess, &exit_code) && exit_code == 0 && fault != "compiler-exit";
  if (created && (!exited || !image_proven)) {
    TerminateProcess(process.hProcess, 127);
    WaitForSingleObject(process.hProcess, 5'000);
  }
  if (created) { CloseHandle(process.hThread); CloseHandle(process.hProcess); }

  bool lease_proven = image_proven && exited;
  FileIdInfo directory_after{};
  lease_proven = lease_proven && FileIdentity(directory_lease, &directory_after)
    && SameIdentity(directory_id, directory_after) && SecureObjectAcl(directory_lease, true);
  for (size_t index = 0; index < inputs.size(); ++index) {
    lease_proven = lease_proven && SameHeldBuildInput(inputs[index], identities[index], sizes[index], hashes[index]);
    lease_proven = lease_proven
      && SameHeldCatalog(catalogs[index], catalog_identities[index], catalog_hashes[index]);
  }
  FileIdInfo source_after{};
  std::string source_after_hash;
  lease_proven = lease_proven && SecureRegularFile(source, static_cast<DWORD>(source_size), &source_after, false)
    && SameIdentity(source_id, source_after)
    && Sha256Handle(source, static_cast<DWORD>(source_size), &source_after_hash) && source_after_hash == source_hash;
  CloseHandle(source);
  DeleteFileW(source_path.c_str());
  for (HANDLE handle : inputs) CloseHandle(handle);
  for (HANDLE handle : catalogs) CloseHandle(handle);

  HANDLE output = lease_proven ? CreateFileW(output_path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr) : INVALID_HANDLE_VALUE;
  LARGE_INTEGER output_size{};
  FileIdInfo output_id{};
  std::string output_hash;
  bool output_valid = output != INVALID_HANDLE_VALUE && GetFileSizeEx(output, &output_size)
    && output_size.QuadPart > 0 && output_size.QuadPart <= kMaxImageBytes
    && SecureRegularFile(output, static_cast<DWORD>(output_size.QuadPart), &output_id, false)
    && Sha256Handle(output, static_cast<DWORD>(output_size.QuadPart), &output_hash)
    && fault != "compiler-output";
  if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
  if (job) CloseHandle(job);
  CloseHandle(directory_lease);
  if (!created) { Throw(env, "SPAWN"); return nullptr; }
  if (!image_proven) { Throw(env, "IMAGE"); return nullptr; }
  if (!exited) { Throw(env, "EXIT"); return nullptr; }
  if (!lease_proven) { Throw(env, "LEASE"); return nullptr; }
  if (!output_valid) { Throw(env, "OUTPUT_VALIDATION"); return nullptr; }

  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_uint32(env, static_cast<uint32_t>(output_size.QuadPart), &value);
  napi_set_named_property(env, result, "size", value);
  napi_create_string_utf8(env, output_hash.c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "sha256", value);
  napi_create_string_utf8(env, certificates[0].c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "compilerCertificateSha256", value);
  napi_create_string_utf8(env, spkis[0].c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "compilerSpkiSha256", value);
  napi_create_string_utf8(env, root_spkis[0].c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "compilerRootSpkiSha256", value);
  napi_value certificate_values, spki_values, root_values, catalog_name_values, catalog_values,
    catalog_volume_values, catalog_id_values;
  napi_create_array_with_length(env, inputs.size(), &certificate_values);
  napi_create_array_with_length(env, inputs.size(), &spki_values);
  napi_create_array_with_length(env, inputs.size(), &root_values);
  napi_create_array_with_length(env, inputs.size(), &catalog_name_values);
  napi_create_array_with_length(env, inputs.size(), &catalog_values);
  napi_create_array_with_length(env, inputs.size(), &catalog_volume_values);
  napi_create_array_with_length(env, inputs.size(), &catalog_id_values);
  for (uint32_t index = 0; index < inputs.size(); ++index) {
    napi_create_string_utf8(env, certificates[index].c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, certificate_values, index, value);
    napi_create_string_utf8(env, spkis[index].c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, spki_values, index, value);
    napi_create_string_utf8(env, root_spkis[index].c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, root_values, index, value);
    napi_create_string_utf8(env, catalog_names[index].c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, catalog_name_values, index, value);
    napi_create_string_utf8(env, catalog_hashes[index].c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, catalog_values, index, value);
    char catalog_volume[17]{};
    sprintf_s(catalog_volume, "%016llx", catalog_identities[index].volume);
    napi_create_string_utf8(env, catalog_volume, NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, catalog_volume_values, index, value);
    const std::string catalog_file_id = Hex(catalog_identities[index].id, sizeof(catalog_identities[index].id));
    napi_create_string_utf8(env, catalog_file_id.c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_element(env, catalog_id_values, index, value);
  }
  napi_set_named_property(env, result, "inputCertificateSha256", certificate_values);
  napi_set_named_property(env, result, "inputSpkiSha256", spki_values);
  napi_set_named_property(env, result, "inputRootSpkiSha256", root_values);
  napi_set_named_property(env, result, "inputCatalogName", catalog_name_values);
  napi_set_named_property(env, result, "inputCatalogSha256", catalog_values);
  napi_set_named_property(env, result, "inputCatalogVolumeSerial", catalog_volume_values);
  napi_set_named_property(env, result, "inputCatalogFileId128", catalog_id_values);
  char volume[17]{};
  sprintf_s(volume, "%016llx", identities[0].volume);
  napi_create_string_utf8(env, volume, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "compilerVolumeSerial", value);
  napi_create_string_utf8(env, Hex(identities[0].id, sizeof(identities[0].id)).c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "compilerFileId128", value);
  return result;
}

napi_value LeaseFiles(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  bool array = false;
  uint32_t length = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || napi_is_array(env, args[0], &array) != napi_ok || !array
      || napi_get_array_length(env, args[0], &length) != napi_ok || length != 4) {
    Throw(env, "LEASE_ARGUMENT"); return nullptr;
  }
  auto* leases = new FileLeases();
  for (uint32_t index = 0; index < length; ++index) {
    napi_value value;
    size_t chars = 0;
    if (napi_get_element(env, args[0], index, &value) != napi_ok
        || napi_get_value_string_utf16(env, value, nullptr, 0, &chars) != napi_ok || chars == 0 || chars > 32767) {
      CloseFileLeases(leases); delete leases; Throw(env, "LEASE_ARGUMENT"); return nullptr;
    }
    std::vector<char16_t> buffer(chars + 1);
    napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &chars);
    const bool directory_expected = index == 0;
    HANDLE file = CreateFileW(reinterpret_cast<const wchar_t*>(buffer.data()),
      (directory_expected ? FILE_READ_ATTRIBUTES : GENERIC_READ) | READ_CONTROL,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | (directory_expected ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN),
      nullptr);
    LARGE_INTEGER size{};
    FileIdInfo identity{};
    AttributeTagInfo tag{};
    const bool directory_valid = directory_expected && file != INVALID_HANDLE_VALUE
      && GetFileInformationByHandleEx(file, static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileAttributeTagInfo),
        &tag, sizeof(tag)) && FileIdentity(file, &identity)
      && (tag.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0
      && (tag.attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 && tag.reparse_tag == 0 && SecureObjectAcl(file);
    const bool file_valid = !directory_expected && file != INVALID_HANDLE_VALUE
      && GetFileSizeEx(file, &size) && size.QuadPart > 0 && size.QuadPart <= 32ll * 1024 * 1024
      && SecureRegularFile(file, static_cast<DWORD>(size.QuadPart), &identity, false);
    if (!directory_valid && !file_valid) {
      if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
      CloseFileLeases(leases); delete leases; Throw(env, "LEASE_AUTHORITY"); return nullptr;
    }
    leases->handles.push_back(file);
  }
  napi_value result;
  napi_create_external(env, leases, FinalizeFileLeases, nullptr, &result);
  return result;
}

napi_value CloseFileLease(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  void* data = nullptr;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || napi_get_value_external(env, args[0], &data) != napi_ok) {
    Throw(env, "LEASE_ARGUMENT"); return nullptr;
  }
  CloseFileLeases(static_cast<FileLeases*>(data));
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value DangerousAclForTest(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  std::wstring sddl;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || !StringValue(env, args[0], "sddl", &sddl) || sddl.size() > 4096) {
    Throw(env, "ACL_TEST_ARGUMENT"); return nullptr;
  }
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PACL dacl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  const bool parsed = ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
    &descriptor, nullptr) && GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) && present && dacl;
  if (!parsed) {
    if (descriptor) LocalFree(descriptor);
    Throw(env, "ACL_TEST_PARSE"); return nullptr;
  }
  const bool dangerous = DangerousUntrustedAcl(dacl, false);
  LocalFree(descriptor);
  napi_value result;
  napi_get_boolean(env, dangerous, &result);
  return result;
}

napi_value VerifyModule(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  std::wstring expected_path;
  std::string expected_hash;
  std::string publisher, certificate_pin, spki_pin;
  uint32_t expected_size = 0;
  bool production = false;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1
      || !StringValue(env, args[0], "path", &expected_path)
      || !Utf8Value(env, args[0], "sha256", &expected_hash)
      || !Uint32Value(env, args[0], "size", &expected_size)
      || !BoolValue(env, args[0], "production", &production)) {
    Throw(env, "MODULE_ARGUMENT"); return nullptr;
  }
  Utf8Value(env, args[0], "publisher", &publisher, true);
  Utf8Value(env, args[0], "signerCertificateSha256", &certificate_pin, true);
  Utf8Value(env, args[0], "signerSpkiSha256", &spki_pin, true);
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
      reinterpret_cast<LPCWSTR>(&VerifyModule), &module)) { Throw(env, "MODULE_IMAGE"); return nullptr; }
  std::array<wchar_t, 32768> path{};
  const DWORD length = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size() || _wcsicmp(path.data(), expected_path.c_str()) != 0) {
    Throw(env, "MODULE_IMAGE"); return nullptr;
  }
  HANDLE file = CreateFileW(path.data(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  FileIdInfo identity{};
  std::string hash;
  const bool valid = file != INVALID_HANDLE_VALUE && SecureRegularFile(file, expected_size, &identity, false)
    && ExpectedArchitecture(file) && Sha256Handle(file, expected_size, &hash) && hash == expected_hash
    && (!production || VerifyPinnedSignature(path.data(), file, publisher, certificate_pin, spki_pin));
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  if (!valid) { Throw(env, "MODULE_AUTHORITY"); return nullptr; }
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, hash.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "sha256", value);
#if defined(_M_ARM64)
  napi_create_string_utf8(env, "arm64", NAPI_AUTO_LENGTH, &value);
#else
  napi_create_string_utf8(env, "x64", NAPI_AUTO_LENGTH, &value);
#endif
  napi_set_named_property(env, result, "architecture", value);
  napi_create_string_utf8(env, Hex(identity.id, sizeof(identity.id)).c_str(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "fileId128", value);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
#if defined(PROPR_WINDOWS_MALICIOUS_BOOTSTRAP)
  std::array<wchar_t, 32768> side_effect{};
  const DWORD side_effect_length = GetEnvironmentVariableW(L"PROPR_WINDOWS_MALICIOUS_BOOTSTRAP_SIDE_EFFECT",
    side_effect.data(), static_cast<DWORD>(side_effect.size()));
  if (side_effect_length > 0 && side_effect_length < side_effect.size()) {
    HANDLE marker = CreateFileW(side_effect.data(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
      FILE_ATTRIBUTE_NORMAL, nullptr);
    if (marker != INVALID_HANDLE_VALUE) CloseHandle(marker);
  }
#endif
#if defined(PROPR_WINDOWS_BOOTSTRAP_ONLY)
  napi_property_descriptor properties[] = {
    {"loadVerifiedModule", nullptr, LoadVerifiedModule, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
#else
  napi_property_descriptor properties[] = {
    {"probeSystemDirectory", nullptr, ProbeSystemDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"launch", nullptr, Launch, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeInput", nullptr, CloseInput, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"terminate", nullptr, Terminate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"compileHeld", nullptr, CompileHeld, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"leaseFiles", nullptr, LeaseFiles, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeFileLease", nullptr, CloseFileLease, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dangerousAclForTest", nullptr, DangerousAclForTest, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"approvedCatalogSignerForTest", nullptr, ApprovedCatalogSignerForTest,
      nullptr, nullptr, nullptr, napi_default, nullptr},
    {"catalogPolicyFailureForTest", nullptr, CatalogPolicyFailureForTest,
      nullptr, nullptr, nullptr, napi_default, nullptr},
  };
#endif
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
