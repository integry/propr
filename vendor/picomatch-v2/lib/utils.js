'use strict';

const path = require('path');
const win32 = process.platform === 'win32';
const {
  REGEX_BACKSLASH,
  REGEX_SPECIAL_CHARS,
  REGEX_SPECIAL_CHARS_GLOBAL
} = require('./constants');

exports.isObject = val => val !== null && typeof val === 'object' && !Array.isArray(val);
exports.hasRegexChars = str => REGEX_SPECIAL_CHARS.test(str);
exports.isRegexChar = str => str.length === 1 && exports.hasRegexChars(str);
exports.escapeRegex = str => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, '\\$1');
exports.toPosixSlashes = str => str.replace(REGEX_BACKSLASH, '/');

const isLineTerminator = code => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

/**
 * Same result as `str.replace(REGEX_REMOVE_BACKSLASH, m => (m === '\\' ? '' : m))`
 * (upstream's implementation), in linear time: the regex rescans to the end of
 * the line from every `[` that has no closing `]`, which is quadratic on input
 * such as `'['.repeat(n)`.
 *
 * A bracket match runs from a `[` to the first later `]` that is at least two
 * characters on, is not preceded by a backslash, and is reached without
 * crossing a line terminator (the character just before the `]` may be one).
 * It is kept as is. Outside bracket matches, a backslash followed by a
 * character other than a line terminator is removed.
 */
exports.removeBackslashes = str => {
  // Only backslashes are ever removed.
  if (!str.includes('\\')) return str;

  const length = str.length;
  // closeAt[i]: first index >= i of a `]` not preceded by a backslash.
  // lineEndAt[i]: first index >= i of a line terminator. Both default to length.
  const closeAt = new Uint32Array(length + 2).fill(length);
  const lineEndAt = new Uint32Array(length + 2).fill(length);
  for (let i = length - 1; i >= 0; i--) {
    const code = str.charCodeAt(i);
    closeAt[i] = code === 93 && i > 0 && str.charCodeAt(i - 1) !== 92 ? i : closeAt[i + 1];
    lineEndAt[i] = isLineTerminator(code) ? i : lineEndAt[i + 1];
  }

  let output = '';
  let copyFrom = 0;
  let i = 0;
  while (i < length) {
    const code = str.charCodeAt(i);
    if (code === 91) {
      const close = closeAt[i + 2];
      if (close < length && close <= lineEndAt[i + 1] + 1) {
        i = close + 1;
        continue;
      }
    } else if (code === 92 && i + 1 < length && !isLineTerminator(str.charCodeAt(i + 1))) {
      output += str.slice(copyFrom, i);
      copyFrom = i + 1;
    }
    i++;
  }
  return output + str.slice(copyFrom);
};

exports.supportsLookbehinds = () => {
  const segs = process.version.slice(1).split('.').map(Number);
  if (segs.length === 3 && segs[0] >= 9 || (segs[0] === 8 && segs[1] >= 10)) {
    return true;
  }
  return false;
};

exports.isWindows = options => {
  if (options && typeof options.windows === 'boolean') {
    return options.windows;
  }
  return win32 === true || path.sep === '\\';
};

exports.escapeLast = (input, char, lastIdx) => {
  const idx = input.lastIndexOf(char, lastIdx);
  if (idx === -1) return input;
  if (input[idx - 1] === '\\') return exports.escapeLast(input, char, idx - 1);
  return `${input.slice(0, idx)}\\${input.slice(idx)}`;
};

exports.removePrefix = (input, state = {}) => {
  let output = input;
  if (output.startsWith('./')) {
    output = output.slice(2);
    state.prefix = './';
  }
  return output;
};

exports.wrapOutput = (input, state = {}, options = {}) => {
  const prepend = options.contains ? '' : '^';
  const append = options.contains ? '' : '$';

  let output = `${prepend}(?:${input})${append}`;
  if (state.negated === true) {
    output = `(?:^(?!${output}).*$)`;
  }
  return output;
};
