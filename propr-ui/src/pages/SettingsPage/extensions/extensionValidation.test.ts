import { describe, expect, it } from 'vitest';
import { extensionServerNameSchema, type ExtensionLibraryServer } from '@propr/shared';
import { endpointProblem, importCommitLabel, isRepositoryName, serverFieldProblems, serverNameProblem } from './extensionValidation';
import { newHttpsServer, newPackageServer } from './libraryEdits';

const https = newHttpsServer([]) as Extract<ExtensionLibraryServer, { kind: 'https' }>;
const pkg = newPackageServer([]) as Extract<ExtensionLibraryServer, { kind: 'package' }>;

const commit = 'a'.repeat(40);

describe('server name rule', () => {
  it.each([
    ['', 'Enter a name.'],
    ['a'.repeat(49), 'Use at most 48 characters.'],
    ['x'.repeat(2000), 'Use at most 48 characters.'],
    ['1docs', 'Start with a lowercase letter.'],
    ['-docs', 'Start with a lowercase letter.'],
    ['Docs', 'Start with a lowercase letter.'],
    ['docs search', 'Use only lowercase letters, digits, - and _.'],
    ['docs.search', 'Use only lowercase letters, digits, - and _.'],
    ['dOcs', 'Use only lowercase letters, digits, - and _.'],
    ['propr', 'propr is reserved.'],
  ])('refuses %j', (name, message) => {
    expect(serverNameProblem(name)).toBe(message);
  });

  it('accepts names the API accepts, up to 48 characters', () => {
    for (const name of ['d', 'docs', 'docs-2', 'docs_search', `a${'b'.repeat(47)}`]) expect(serverNameProblem(name)).toBeNull();
  });

  it('matches the server schema on every sample', () => {
    const samples = ['', 'a', 'a'.repeat(48), 'a'.repeat(49), 'propr', 'proprx', 'Docs', '1a', 'a b', 'a.b', 'a-b_c9', 'ä', '_a', 'a\n'];
    for (const name of samples) expect(serverNameProblem(name) === null).toBe(extensionServerNameSchema.safeParse(name).success);
  });

  it('refuses a name another server holds', () => {
    expect(serverNameProblem('docs', [{ name: 'docs' }])).toBe('Another server is already named docs.');
  });
});

describe('endpoint rule', () => {
  it.each([
    ['', 'Enter the endpoint URL.'],
    ['http://tools.example.com/mcp', 'Use an https:// address.'],
    ['tools.example.com/mcp', 'Use an https:// address.'],
    ['HTTPS://tools.example.com/mcp', 'Write https:// in lowercase.'],
    ['https://user:secret@tools.example.com/mcp', 'Remove the user name or password from the address.'],
    ['https://tools.example.com/mcp?key=1', 'Remove the query string or fragment.'],
    ['https://tools.example.com/mcp#a', 'Remove the query string or fragment.'],
    ['https://tools.example.com:8443/mcp', 'Use port 443 or leave the port out.'],
    ['https://localhost/mcp', 'Use a public address.'],
    ['https://printer.local/mcp', 'Use a public address.'],
    ['https://', 'Enter a valid URL.'],
    [`https://tools.example.com/${'a'.repeat(2048)}`, 'Use at most 2048 characters.'],
  ])('refuses %j', (url, message) => {
    expect(endpointProblem(url)).toBe(message);
  });

  it('accepts a public HTTPS endpoint, with or without port 443', () => {
    expect(endpointProblem('https://tools.example.com/mcp')).toBeNull();
    expect(endpointProblem('https://tools.example.com:443/mcp')).toBeNull();
  });
});

describe('server field problems', () => {
  it('reports the name and endpoint of an HTTPS draft', () => {
    expect(serverFieldProblems({ ...https, name: '' }, [])).toEqual({ name: 'Enter a name.', url: 'Enter the endpoint URL.' });
    expect(serverFieldProblems({ ...https, url: 'https://tools.example.com/mcp' }, [])).toEqual({});
  });

  it('reports the package and version of a package draft', () => {
    expect(serverFieldProblems(pkg, [])).toEqual({ package: 'Enter the npm package name.', version: 'Enter an exact version.' });
    const ok = { ...pkg, package: '@example/tool', version: '1.2.3' };
    expect(serverFieldProblems(ok, [])).toEqual({});
    expect(serverFieldProblems({ ...ok, version: '^1.2' }, []).version).toMatch(/exact version such as 1\.2\.3/);
  });
});

describe('repository names', () => {
  it('accept only owner/name', () => {
    expect(isRepositoryName('acme/website')).toBe(true);
    for (const value of ['', 'acme', 'acme/', '/website', 'acme/web site', 'a/b/c']) expect(isRepositoryName(value)).toBe(false);
  });
});

describe('import commit label', () => {
  it('is never Confirmed for text that is not a full commit', () => {
    expect(importCommitLabel('', undefined)).toBeNull();
    for (const value of ['not-a-commit', 'a'.repeat(39), 'A'.repeat(40), `${'a'.repeat(40)}0`]) {
      expect(importCommitLabel(value, { commit: value, status: 'verified' })).toEqual({ tone: 'invalid', text: 'Enter the full 40-character commit (0–9, a–f).' });
    }
  });

  it('waits for the lookup of a full commit, then confirms or refuses it', () => {
    expect(importCommitLabel(commit, undefined)?.tone).toBe('pending');
    expect(importCommitLabel(commit, { commit, status: 'checking' })?.tone).toBe('pending');
    expect(importCommitLabel(commit, { commit: 'b'.repeat(40), status: 'verified' })?.tone).toBe('pending');
    expect(importCommitLabel(commit, { commit, status: 'verified' })).toEqual({ tone: 'confirmed', text: 'Confirmed import commit:' });
    expect(importCommitLabel(commit, { commit, status: 'failed' })?.tone).toBe('invalid');
  });
});
