// Build-context inputs of Dockerfile.agent, shared by the source-tree unit test
// and scripts/smoke-check-app-agent-build-context.sh, which checks a built app
// image. The worker builds custom agent bundles with `docker build -f
// Dockerfile.agent /usr/src/app` inside the app image, so every local COPY/ADD
// source named here must be shipped there by docker/Dockerfile.app.prod.
//
// CLI (used by the image smoke, which feeds it the image's own Dockerfile):
//   node scripts/lib/agent-build-context.mjs sources <Dockerfile>
//   node scripts/lib/agent-build-context.mjs copy-check-dockerfile <Dockerfile>

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Joins backslash continuations and drops comments and blank lines. */
function dockerfileInstructions(text) {
    const instructions = [];
    let current = '';
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!current && (!line || line.startsWith('#'))) continue;
        if (current && line.startsWith('#')) continue;
        if (line.endsWith('\\')) {
            current += `${line.slice(0, -1).trim()} `;
            continue;
        }
        instructions.push(`${current}${line}`.trim());
        current = '';
    }
    if (current.trim()) instructions.push(current.trim());
    return instructions;
}

/**
 * Local COPY/ADD instructions of a Dockerfile: those that read the build
 * context rather than another stage or image (`--from=`). Flags are dropped.
 */
export function localContextCopies(dockerfileText) {
    const copies = [];
    for (const instruction of dockerfileInstructions(dockerfileText)) {
        const match = instruction.match(/^(COPY|ADD)\s+(.*)$/i);
        if (!match) continue;
        const words = match[2].trim().split(/\s+/);
        if (words[0]?.startsWith('[')) {
            throw new Error(`JSON-form ${match[1]} is not supported by the agent build-context check: ${instruction}`);
        }
        const flags = [];
        while (words[0]?.startsWith('--')) flags.push(words.shift());
        if (flags.some(flag => /^--from=/i.test(flag))) continue;
        if (words.length < 2) throw new Error(`Malformed ${match[1]} instruction: ${instruction}`);
        const destination = words.pop();
        for (const source of words) {
            if (/[*?[]/.test(source) || /^[a-z]+:\/\//i.test(source) || source.startsWith('<<')) {
                throw new Error(`Wildcard, remote or heredoc sources are not supported by the agent build-context check: ${source}`);
            }
        }
        copies.push({ sources: words.map(source => source.replace(/^\.\//, '')), destination });
    }
    return copies;
}

/** Every build-context path Dockerfile.agent reads, in first-use order. */
export function agentBuildContextSources(dockerfileText) {
    return [...new Set(localContextCopies(dockerfileText).flatMap(copy => copy.sources))];
}

/**
 * A FROM-scratch Dockerfile that performs exactly the local COPY steps of the
 * given Dockerfile against the same context, with no network or base image.
 * Ownership flags are dropped because scratch has no user database.
 */
export function copyCheckDockerfile(dockerfileText) {
    const lines = ['FROM scratch'];
    localContextCopies(dockerfileText).forEach((copy, index) => {
        lines.push(`COPY ${copy.sources.join(' ')} /agent-build-context/${index}/`);
    });
    return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    const [command, file] = process.argv.slice(2);
    if (!file || !['sources', 'copy-check-dockerfile'].includes(command)) {
        console.error('usage: agent-build-context.mjs sources|copy-check-dockerfile <Dockerfile>');
        process.exit(2);
    }
    const text = fs.readFileSync(file, 'utf8');
    process.stdout.write(command === 'sources'
        ? `${agentBuildContextSources(text).join('\n')}\n`
        : copyCheckDockerfile(text));
}
