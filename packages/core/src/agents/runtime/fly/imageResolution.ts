import { FLY_REGISTRY, FlyRegistry } from './registry.js';

/**
 * Whether `PROPR_FLY_IMAGE` resolves, without pulling it: the registry
 * returns a linux/amd64 manifest for the reference. Images on
 * registry.fly.io are resolved with the Fly token (the credential Fly uses
 * to pull them); images elsewhere are resolved anonymously, as Fly pulls an
 * image it has no registry credentials for.
 */

export class FlyImageResolutionError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'FlyImageResolutionError';
    }
}

const DOCKER_HUB = 'registry-1.docker.io';
const MANIFEST_ACCEPT = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface ImageReference { host: string; repository: string; reference: string }

const PATH = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG = /^[\w][\w.-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Splits `[host/]path[:tag]` into the registry host (Docker Hub when absent), the path and the tag. */
function splitNamed(named: string): { host: string; path: string; tag?: string } {
    const slash = named.indexOf('/');
    const first = slash < 0 ? '' : named.slice(0, slash);
    const explicitHost = slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost');
    const host = !explicitHost || first === 'docker.io' || first === 'index.docker.io' ? DOCKER_HUB : first;
    const rest = explicitHost ? named.slice(slash + 1) : named;
    const colon = rest.lastIndexOf(':');
    if (colon <= rest.lastIndexOf('/')) return { host, path: rest };
    return { host, path: rest.slice(0, colon), tag: rest.slice(colon + 1) };
}

/** `[host/]repository[:tag][@digest]` with Docker's defaults (Docker Hub, `library/`, `latest`). */
export function parseImageReference(image: string): ImageReference | undefined {
    const [named, digest, extra] = image.split('@');
    if (extra !== undefined || !named) return;
    const { host, path, tag } = splitNamed(named);
    if (!PATH.test(path) || (tag !== undefined && !TAG.test(tag)) || (digest !== undefined && !DIGEST.test(digest))) return;
    const repository = host === DOCKER_HUB && !path.includes('/') ? `library/${path}` : path;
    return { host, repository, reference: digest ?? tag ?? 'latest' };
}

function statusOf(error: unknown): number | undefined {
    const status = (error as { status?: unknown })?.status;
    return typeof status === 'number' ? status : undefined;
}

async function anonymousToken(challenge: string, fetcher: typeof fetch): Promise<string> {
    const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const realm = new URL(fields.realm ?? '');
    if (realm.protocol !== 'https:') throw new FlyImageResolutionError('The image registry asked for a token from a non-HTTPS realm');
    for (const key of ['service', 'scope']) if (fields[key]) realm.searchParams.set(key, fields[key]);
    const response = await fetcher(realm, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new FlyImageResolutionError(`The image registry token exchange returned HTTP ${response.status}`, response.status);
    const body = await response.json() as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new FlyImageResolutionError('The image registry token exchange returned no token');
    return token;
}

/** Anonymous Distribution API manifest lookup for an image outside registry.fly.io. */
async function resolveAnonymously({ host, repository, reference }: ImageReference, fetcher: typeof fetch): Promise<void> {
    const url = `https://${host}/v2/${repository}/manifests/${reference}`;
    let authorization: string | undefined;
    for (let attempt = 0; ; attempt++) {
        const response = await fetcher(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30_000),
            headers: { Accept: MANIFEST_ACCEPT, ...(authorization ? { Authorization: authorization } : {}) } });
        await response.body?.cancel();
        const challenge = response.headers.get('www-authenticate') ?? '';
        if (response.status === 401 && attempt === 0 && /^Bearer\s/i.test(challenge)) {
            authorization = `Bearer ${await anonymousToken(challenge, fetcher)}`;
            continue;
        }
        if (!response.ok) throw new FlyImageResolutionError(`The image registry returned HTTP ${response.status}`, response.status);
        return;
    }
}

/** Resolves `image`; throws {@link FlyImageResolutionError} (with the registry's HTTP status when it answered) when it does not. */
export async function resolveFlyImage(image: string, token: string, fetcher: typeof fetch = fetch): Promise<void> {
    const parsed = parseImageReference(image);
    if (!parsed) throw new FlyImageResolutionError(`${image} is not a valid image reference`);
    try {
        if (parsed.host === FLY_REGISTRY) await new FlyRegistry(token, fetcher).manifest(parsed.repository, parsed.reference);
        else await resolveAnonymously(parsed, fetcher);
    } catch (error) {
        if (error instanceof FlyImageResolutionError) throw error;
        throw new FlyImageResolutionError((error as Error).message, statusOf(error));
    }
}
