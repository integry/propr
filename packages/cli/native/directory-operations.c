#define NAPI_VERSION 8
#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static napi_value throw_errno(napi_env env, const char *operation) {
  int error = errno;
  char message[512];
  const char *description = strerror(error);
  size_t operation_length = strlen(operation);
  size_t description_length = strlen(description);
  if (operation_length + description_length + 3 > sizeof(message)) {
    description_length = sizeof(message) - operation_length - 3;
  }
  memcpy(message, operation, operation_length);
  memcpy(message + operation_length, ": ", 2);
  memcpy(message + operation_length + 2, description, description_length);
  message[operation_length + description_length + 2] = '\0';

  const char *code = "EIO";
  switch (error) {
    case EACCES: code = "EACCES"; break;
    case EEXIST: code = "EEXIST"; break;
    case EINVAL: code = "EINVAL"; break;
    case EISDIR: code = "EISDIR"; break;
    case ELOOP: code = "ELOOP"; break;
    case ENOENT: code = "ENOENT"; break;
    case ENOTDIR: code = "ENOTDIR"; break;
    case ENOTEMPTY: code = "ENOTEMPTY"; break;
    case EPERM: code = "EPERM"; break;
  }
  napi_throw_error(env, code, message);
  return NULL;
}

static int32_t int32_argument(napi_env env, napi_value value) {
  int32_t result = 0;
  napi_get_value_int32(env, value, &result);
  return result;
}

static uint32_t uint32_argument(napi_env env, napi_value value) {
  uint32_t result = 0;
  napi_get_value_uint32(env, value, &result);
  return result;
}

static int path_argument(napi_env env, napi_value value, char *path, size_t capacity) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, path, capacity, &length) != napi_ok || length == 0 || length >= capacity) {
    napi_throw_type_error(env, "EINVAL", "path must be a non-empty filesystem component");
    return 0;
  }
  if (strchr(path, '/') != NULL || strcmp(path, ".") == 0 || strcmp(path, "..") == 0) {
    napi_throw_type_error(env, "EINVAL", "path must be one filesystem component");
    return 0;
  }
  return 1;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  size_t count = 4;
  napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
  if (count < 4) {
    napi_throw_type_error(env, "EINVAL", "openAt requires dirfd, name, flags, and mode");
    return NULL;
  }
  char path[4096];
  if (!path_argument(env, arguments[1], path, sizeof(path))) return NULL;
  int result = openat(int32_argument(env, arguments[0]), path, int32_argument(env, arguments[2]),
                      (mode_t)uint32_argument(env, arguments[3]));
  if (result == -1) return throw_errno(env, "openat");
  napi_value value;
  napi_create_int32(env, result, &value);
  return value;
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  size_t count = 3;
  napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
  if (count < 3) {
    napi_throw_type_error(env, "EINVAL", "mkdirAt requires dirfd, name, and mode");
    return NULL;
  }
  char path[4096];
  if (!path_argument(env, arguments[1], path, sizeof(path))) return NULL;
  if (mkdirat(int32_argument(env, arguments[0]), path, (mode_t)uint32_argument(env, arguments[2])) == -1) {
    return throw_errno(env, "mkdirat");
  }
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  size_t count = 4;
  napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
  if (count < 4) {
    napi_throw_type_error(env, "EINVAL", "renameAt requires old dirfd/name and new dirfd/name");
    return NULL;
  }
  char old_path[4096];
  char new_path[4096];
  if (!path_argument(env, arguments[1], old_path, sizeof(old_path)) ||
      !path_argument(env, arguments[3], new_path, sizeof(new_path))) return NULL;
  if (renameat(int32_argument(env, arguments[0]), old_path, int32_argument(env, arguments[2]), new_path) == -1) {
    return throw_errno(env, "renameat");
  }
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value link_at(napi_env env, napi_callback_info info) {
  napi_value arguments[5];
  size_t count = 5;
  napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
  if (count < 5) {
    napi_throw_type_error(env, "EINVAL", "linkAt requires old dirfd/name, new dirfd/name, and flags");
    return NULL;
  }
  char old_path[4096];
  char new_path[4096];
  if (!path_argument(env, arguments[1], old_path, sizeof(old_path)) ||
      !path_argument(env, arguments[3], new_path, sizeof(new_path))) return NULL;
  if (linkat(int32_argument(env, arguments[0]), old_path, int32_argument(env, arguments[2]), new_path,
             int32_argument(env, arguments[4])) == -1) {
    return throw_errno(env, "linkat");
  }
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  size_t count = 3;
  napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
  if (count < 3) {
    napi_throw_type_error(env, "EINVAL", "unlinkAt requires dirfd, name, and flags");
    return NULL;
  }
  char path[4096];
  if (!path_argument(env, arguments[1], path, sizeof(path))) return NULL;
  if (unlinkat(int32_argument(env, arguments[0]), path, int32_argument(env, arguments[2])) == -1) {
    return throw_errno(env, "unlinkat");
  }
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static const char *entry_kind(mode_t mode) {
  if (S_ISDIR(mode)) return "directory";
  if (S_ISLNK(mode)) return "symbolic-link";
  if (S_ISREG(mode)) return "file";
  return "other";
}

static napi_value lstat_at(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  size_t count = 2;
  napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
  if (count < 2) {
    napi_throw_type_error(env, "EINVAL", "lstatAt requires dirfd and name");
    return NULL;
  }
  char path[4096];
  if (!path_argument(env, arguments[1], path, sizeof(path))) return NULL;
  struct stat status;
  if (fstatat(int32_argument(env, arguments[0]), path, &status, AT_SYMLINK_NOFOLLOW) == -1) {
    return throw_errno(env, "fstatat");
  }

  napi_value result;
  napi_value value;
  napi_create_object(env, &result);
  napi_create_double(env, (double)status.st_dev, &value);
  napi_set_named_property(env, result, "dev", value);
  napi_create_double(env, (double)status.st_ino, &value);
  napi_set_named_property(env, result, "ino", value);
  napi_create_string_utf8(env, entry_kind(status.st_mode), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "kind", value);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL},
    {"mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL},
    {"renameAt", NULL, rename_at, NULL, NULL, NULL, napi_default, NULL},
    {"linkAt", NULL, link_at, NULL, NULL, NULL, napi_default, NULL},
    {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
    {"lstatAt", NULL, lstat_at, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
