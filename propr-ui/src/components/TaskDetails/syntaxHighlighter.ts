import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  docker,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  kotlin,
  php,
  python,
  rust,
  ruby,
  sql,
  tsx,
  swift,
  toml,
  typescript,
  yaml,
};

Object.entries(languages).forEach(([name, grammar]) => {
  SyntaxHighlighter.registerLanguage(name, grammar);
});

type SyntaxLanguage = keyof typeof languages;

const languageAliases: Record<string, SyntaxLanguage> = {
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  html: 'markup',
  js: 'javascript',
  jsonc: 'json',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  xml: 'markup',
  yml: 'yaml',
};

export function resolveSyntaxLanguage(language: string): SyntaxLanguage | 'text' {
  const normalized = language.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(languages, normalized)) {
    return normalized as SyntaxLanguage;
  }
  return languageAliases[normalized] ?? 'text';
}

export { SyntaxHighlighter, vscDarkPlus };
