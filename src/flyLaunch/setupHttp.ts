/** Small HTTP helpers of the Fly launch setup wizard (#3827). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GithubSetupError } from './githubSetup.js';
import { setupAsset } from './setupLayout.js';

const MAX_BODY_BYTES = 16 * 1024;

export function readCookie(request: IncomingMessage, name: string): string | undefined {
    for (const part of (request.headers.cookie ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=');
    }
    return undefined;
}

export async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new GithubSetupError('The form is too large.');
        chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Serves the wizard's logo, favicon and script (GET/HEAD); false for any other request. */
export function sendSetupAsset(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    const asset = request.method === 'GET' || request.method === 'HEAD' ? setupAsset(url.pathname) : undefined;
    if (!asset) return false;
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
    return true;
}
