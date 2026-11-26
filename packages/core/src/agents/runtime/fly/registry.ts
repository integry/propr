import crypto from 'node:crypto';
import fs from 'node:fs/promises';

/** The Fly registry, where `PROPR_FLY_IMAGE` and the derived package images live. */
export const FLY_REGISTRY = 'registry.fly.io';
const REFERENCE = /^registry\.fly\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::([\w][\w.-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_LIMIT = 4 * 1024 * 1024;
const UPLOAD_CHUNK = 32 * 1024 * 1024;

export const MEDIA = {
    dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
    dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
    dockerLayer: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
    ociManifest: 'application/vnd.oci.image.manifest.v1+json',
    ociIndex: 'application/vnd.oci.image.index.v1+json',
    ociLayer: 'application/vnd.oci.image.layer.v1.tar+gzip',
} as const;

export interface Descriptor { mediaType: string; digest: string; size: number; platform?: { os?: string; architecture?: string } }
export interface ImageManifest { schemaVersion: 2; mediaType?: string; config: Descriptor; layers: Descriptor[]; manifests?: Descriptor[]; [key: string]: unknown }

/** `registry.fly.io/<repository>[:tag][@digest]`, or undefined for an image elsewhere. */
export function parseFlyImage(image: string): { repository: string; reference: string } | undefined {
    const match = REFERENCE.exec(image);
    if (!match || (!match[2] && !match[3])) return;
    return { repository: match[1], reference: match[3] ?? match[2] };
}

export const sha256 = (data: Buffer | string) => 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');

export interface RegistryApi {
    /** The linux/amd64 image manifest for `reference` (an index is resolved), with its digest. */
    manifest(repository: string, reference: string): Promise<{ digest: string; manifest: ImageManifest }>;
    /** The digest a tag points at, or undefined when the tag does not exist. */
    resolve(repository: string, tag: string): Promise<string | undefined>;
    blob(repository: string, digest: string): Promise<Buffer>;
    /** Uploads `content` (bytes, or a file path) unless the repository already has the blob. */
    upload(repository: string, digest: string, size: number, content: Buffer | string): Promise<void>;
    /** Tags `manifest` and returns its digest. */
    push(repository: string, tag: string, mediaType: string, manifest: Buffer): Promise<string>;
}

class RegistryHttpError extends Error {
    constructor(method: string, path: string, readonly status: number) {
        super(`Fly registry ${method} ${path.replace(/\?.*$/, '')} returned HTTP ${status}`);
    }
}

async function readLimited(response: Response, limit: number) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('Fly registry response exceeds ' + limit + ' bytes');
    return bytes;
}

/** Distribution API client authenticated with the Fly token (Basic `x:<token>`, or the Bearer exchange the registry asks for). */
export class FlyRegistry implements RegistryApi {
    private bearer?: string;
    constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

    private async request(method: string, path: string, init: { headers?: Record<string, string>; body?: Buffer; ok?: number[]; follow?: boolean; timeout?: number } = {}) {
        const url = path.startsWith('https://') ? path : `https://${FLY_REGISTRY}${path}`;
        if (new URL(url).host !== FLY_REGISTRY) throw new Error('Refusing to send the Fly token outside ' + FLY_REGISTRY);
        for (let attempt = 0; ; attempt++) {
            const authorization = this.bearer ? 'Bearer ' + this.bearer : 'Basic ' + Buffer.from('x:' + this.token).toString('base64');
            // Blob reads may redirect to storage; fetch drops Authorization on a cross-origin redirect.
            const response = await this.fetcher(url, { method, redirect: init.follow ? 'follow' : 'error', body: init.body,
                headers: { ...init.headers, Authorization: authorization }, signal: AbortSignal.timeout(init.timeout ?? 60_000) });
            const challenge = response.headers.get('www-authenticate') ?? '';
            if (response.status === 401 && attempt === 0 && /^Bearer\s/i.test(challenge)) {
                await response.body?.cancel();
                this.bearer = await this.exchange(challenge);
                continue;
            }
            if (!response.ok && !(init.ok ?? []).includes(response.status)) {
                await response.body?.cancel();
                throw new RegistryHttpError(method, path, response.status);
            }
            return response;
        }
    }

    private async exchange(challenge: string) {
        const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        const realm = new URL(fields.realm ?? '');
        if (realm.protocol !== 'https:' || !(realm.host === FLY_REGISTRY || realm.host.endsWith('.fly.io'))) throw new Error('Unexpected Fly registry token realm');
        for (const key of ['service', 'scope']) if (fields[key]) realm.searchParams.set(key, fields[key]);
        const response = await this.fetcher(realm, { headers: { Authorization: 'Basic ' + Buffer.from('x:' + this.token).toString('base64') }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Fly registry token exchange returned HTTP ${response.status}`);
        const body = await response.json() as { token?: string; access_token?: string };
        const token = body.token ?? body.access_token;
        if (!token) throw new Error('Fly registry token exchange returned no token');
        return token;
    }

    private async getManifest(repository: string, reference: string) {
        const accept = [MEDIA.ociIndex, MEDIA.dockerList, MEDIA.ociManifest, MEDIA.dockerManifest].join(', ');
        const response = await this.request('GET', `/v2/${repository}/manifests/${reference}`, { headers: { Accept: accept } });
        const bytes = await readLimited(response, MANIFEST_LIMIT);
        const digest = sha256(bytes);
        if (DIGEST.test(reference) && reference !== digest) throw new Error('Fly registry manifest does not match its digest');
        return { digest, manifest: JSON.parse(bytes.toString()) as ImageManifest };
    }

    async manifest(repository: string, reference: string): Promise<{ digest: string; manifest: ImageManifest }> {
        const found = await this.getManifest(repository, reference);
        const { manifest } = found;
        if (manifest.mediaType === MEDIA.ociIndex || manifest.mediaType === MEDIA.dockerList || (!manifest.config && manifest.manifests)) {
            // Fly Machines run linux/amd64; attestation entries carry no such platform.
            const entry = manifest.manifests?.find(m => m.platform?.os === 'linux' && m.platform.architecture === 'amd64');
            if (!entry) throw new Error(`Fly image ${repository}@${found.digest} has no linux/amd64 manifest`);
            return this.manifest(repository, entry.digest);
        }
        if (!manifest.config || !Array.isArray(manifest.layers)) throw new Error('Unsupported Fly image manifest');
        return found;
    }

    async resolve(repository: string, tag: string) {
        const accept = [MEDIA.ociManifest, MEDIA.dockerManifest].join(', ');
        const response = await this.request('HEAD', `/v2/${repository}/manifests/${tag}`, { headers: { Accept: accept }, ok: [404] });
        if (response.status === 404) return;
        const digest = response.headers.get('docker-content-digest') ?? '';
        if (DIGEST.test(digest)) return digest;
        return (await this.getManifest(repository, tag)).digest;
    }

    async blob(repository: string, digest: string) {
        const bytes = await readLimited(await this.request('GET', `/v2/${repository}/blobs/${digest}`, { follow: true }), MANIFEST_LIMIT);
        if (sha256(bytes) !== digest) throw new Error('Fly registry blob does not match its digest');
        return bytes;
    }

    async upload(repository: string, digest: string, size: number, content: Buffer | string) {
        const head = await this.request('HEAD', `/v2/${repository}/blobs/${digest}`, { ok: [404] });
        if (head.status !== 404) return;
        let location = this.location(await this.request('POST', `/v2/${repository}/blobs/uploads/`, { headers: { 'Content-Length': '0' } }));
        const file = typeof content === 'string' ? await fs.open(content, 'r') : undefined;
        try {
            // Chunked upload: no file is held in memory whole.
            for (let offset = 0; offset < size; offset += UPLOAD_CHUNK) {
                const length = Math.min(UPLOAD_CHUNK, size - offset);
                let chunk: Buffer;
                if (file) {
                    chunk = Buffer.alloc(length);
                    const { bytesRead } = await file.read(chunk, 0, length, offset);
                    if (bytesRead !== length) throw new Error('Layer file shorter than recorded');
                } else chunk = (content as Buffer).subarray(offset, offset + length);
                location = this.location(await this.request('PATCH', location, { body: chunk, timeout: 10 * 60_000, headers: {
                    'Content-Type': 'application/octet-stream', 'Content-Length': String(length), 'Content-Range': `${offset}-${offset + length - 1}` } }));
            }
        } finally { await file?.close(); }
        const url = new URL(location);
        url.searchParams.set('digest', digest);
        await this.request('PUT', url.toString(), { headers: { 'Content-Length': '0' } });
    }

    private location(response: Response) {
        void response.body?.cancel();
        const header = response.headers.get('location');
        if (!header) throw new Error('Fly registry upload returned no location');
        return new URL(header, `https://${FLY_REGISTRY}`).toString();
    }

    async push(repository: string, tag: string, mediaType: string, manifest: Buffer) {
        const response = await this.request('PUT', `/v2/${repository}/manifests/${tag}`, { body: manifest, headers: { 'Content-Type': mediaType } });
        await response.body?.cancel();
        return sha256(manifest);
    }
}
