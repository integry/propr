#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define PROPR_AUTHORITY_FD 3
#define PROPR_MAX_ACL_TEXT 24576
#define PROPR_MAX_JSON 32768

static int append_bytes(char *output, size_t *length, const char *value, size_t value_length) {
  if (value_length > PROPR_MAX_JSON - *length) return -1;
  memcpy(output + *length, value, value_length);
  *length += value_length;
  return 0;
}

static int append_json_string(char *output, size_t *length, const char *value, size_t value_length) {
  static const char hex[] = "0123456789abcdef";
  if (append_bytes(output, length, "\"", 1) != 0) return -1;
  for (size_t index = 0; index < value_length; index += 1) {
    unsigned char byte = (unsigned char)value[index];
    if (byte == '"' || byte == '\\') {
      char escaped[2] = {'\\', (char)byte};
      if (append_bytes(output, length, escaped, sizeof(escaped)) != 0) return -1;
    } else if (byte == '\n') {
      if (append_bytes(output, length, "\\n", 2) != 0) return -1;
    } else if (byte == '\r') {
      if (append_bytes(output, length, "\\r", 2) != 0) return -1;
    } else if (byte == '\t') {
      if (append_bytes(output, length, "\\t", 2) != 0) return -1;
    } else if (byte < 0x20) {
      char escaped[6] = {'\\', 'u', '0', '0', hex[byte >> 4], hex[byte & 15]};
      if (append_bytes(output, length, escaped, sizeof(escaped)) != 0) return -1;
    } else if (append_bytes(output, length, (const char *)&value[index], 1) != 0) {
      return -1;
    }
  }
  return append_bytes(output, length, "\"", 1);
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

int main(void) {
  struct stat before;
  struct stat after;
  if (fstat(PROPR_AUTHORITY_FD, &before) != 0) return 10;

  /* Apple's descriptor implementation reports an absent FILESEC_ACL property
     as NULL/ENOENT. Every other NULL/errno pair is a real allocation,
     descriptor, filesystem, or inspection failure and remains fatal. */
  errno = 0;
  acl_t acl = NULL;
  char *allocated_acl_text = NULL;
  const char *acl_text = "!#acl 1\n";
  ssize_t acl_length = 8;
  acl = acl_get_fd_np(PROPR_AUTHORITY_FD, ACL_TYPE_EXTENDED);
  if (acl == NULL) {
    if (errno != ENOENT) return 11;
  } else {
    allocated_acl_text = acl_to_text(acl, &acl_length);
    if (allocated_acl_text == NULL) {
      acl_free(acl);
      return 12;
    }
    acl_text = allocated_acl_text;
  }
  if (acl_length < 0 || acl_length > PROPR_MAX_ACL_TEXT ||
      memchr(acl_text, '\0', (size_t)acl_length) != NULL) {
    if (allocated_acl_text != NULL) acl_free(allocated_acl_text);
    if (acl != NULL) acl_free(acl);
    return 13;
  }
  if (fstat(PROPR_AUTHORITY_FD, &after) != 0 || !same_identity(&before, &after)) {
    if (allocated_acl_text != NULL) acl_free(allocated_acl_text);
    if (acl != NULL) acl_free(acl);
    return 14;
  }

  char device[32];
  char file[32];
  int device_length = snprintf(device, sizeof(device), "%llu", (unsigned long long)(uint64_t)before.st_dev);
  int file_length = snprintf(file, sizeof(file), "%llu", (unsigned long long)(uint64_t)before.st_ino);
  if (device_length <= 0 || (size_t)device_length >= sizeof(device) ||
      file_length <= 0 || (size_t)file_length >= sizeof(file)) {
    if (allocated_acl_text != NULL) acl_free(allocated_acl_text);
    if (acl != NULL) acl_free(acl);
    return 15;
  }

  char output[PROPR_MAX_JSON];
  size_t length = 0;
  if (append_bytes(output, &length, "{\"version\":1,\"device\":", 22) != 0 ||
      append_json_string(output, &length, device, (size_t)device_length) != 0 ||
      append_bytes(output, &length, ",\"file\":", 8) != 0 ||
      append_json_string(output, &length, file, (size_t)file_length) != 0 ||
      append_bytes(output, &length, ",\"acl\":", 7) != 0 ||
      append_json_string(output, &length, acl_text, (size_t)acl_length) != 0 ||
      append_bytes(output, &length, "}\n", 2) != 0) {
    if (allocated_acl_text != NULL) acl_free(allocated_acl_text);
    if (acl != NULL) acl_free(acl);
    return 16;
  }
  if (allocated_acl_text != NULL) acl_free(allocated_acl_text);
  if (acl != NULL) acl_free(acl);

  size_t written = 0;
  while (written < length) {
    ssize_t count = write(STDOUT_FILENO, output + written, length - written);
    if (count <= 0) return 17;
    written += (size_t)count;
  }
  return 0;
}
