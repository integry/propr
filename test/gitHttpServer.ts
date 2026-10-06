import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

export interface GitHttpServer {
    /** Base URL; append the repository path relative to the project root. */
    url: string;
    /** Authorization headers the server received, in order. */
    authorizations: string[];
    close(): Promise<void>;
}

/** Serves repositories under `projectRoot` over smart HTTP through `git http-backend`.
 * With `challenge`, requests without an Authorization header get a Basic challenge (as
 * GitHub does), and any credentials are accepted. Repositories that accept pushes need
 * `http.receivepack=true`. */
export async function startGitHttpServer(projectRoot: string, options: { challenge?: boolean } = {}): Promise<GitHttpServer> {
    const authorizations: string[] = [];
    const server = http.createServer((request, response) => {
        if (request.headers.authorization) authorizations.push(request.headers.authorization);
        else if (options.challenge) {
            response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
            response.end();
            return;
        }
        const url = new URL(request.url ?? '/', 'http://localhost');
        const backend = spawn('git', ['http-backend'], {
            env: {
                ...process.env,
                GIT_PROJECT_ROOT: projectRoot,
                GIT_HTTP_EXPORT_ALL: '1',
                REQUEST_METHOD: request.method ?? 'GET',
                PATH_INFO: decodeURIComponent(url.pathname),
                QUERY_STRING: url.search.slice(1),
                CONTENT_TYPE: request.headers['content-type'] ?? '',
                HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
                GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
                REMOTE_ADDR: '127.0.0.1',
            },
        });
        request.pipe(backend.stdin);
        const chunks: Buffer[] = [];
        backend.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        backend.on('close', () => {
            const output = Buffer.concat(chunks);
            const separator = output.indexOf('\r\n\r\n');
            const headerText = output.subarray(0, separator < 0 ? 0 : separator).toString();
            let status = 200;
            for (const line of headerText.split('\r\n').filter(Boolean)) {
                const colon = line.indexOf(':');
                const name = line.slice(0, colon).trim();
                const value = line.slice(colon + 1).trim();
                if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
                else response.setHeader(name, value);
            }
            response.writeHead(status);
            response.end(output.subarray(separator < 0 ? 0 : separator + 4));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        authorizations,
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
}

/** A credential helper command that appends each operation it is asked to perform. */
export function recordingCredentialHelper(logPath: string): string {
    return `!f() { cat >/dev/null; echo "$1" >> '${logPath}'; }; f`;
}
