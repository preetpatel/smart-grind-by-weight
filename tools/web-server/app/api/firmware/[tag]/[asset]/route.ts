import { GITHUB_REPO } from '@/lib/firmware';
import { ApiError, handleErrors } from '@/lib/http';

type Context = { params: Promise<{ tag: string; asset: string }> };

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Streams a release asset (USB manifest, bootloader/partition/app binaries,
// OTA patch, sha256 manifest) from GitHub so everything the browser flashes
// is same-origin. esp-web-tools manifests reference sibling files by bare
// filename, which resolves right back into this route.
export async function GET(_request: Request, { params }: Context): Promise<Response> {
    return handleErrors(async () => {
        const { tag, asset } = await params;
        if (!SAFE_SEGMENT.test(tag) || !SAFE_SEGMENT.test(asset)) {
            throw new ApiError(400, 'invalid asset path');
        }

        const upstream = await fetch(
            `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${asset}`,
        );
        if (!upstream.ok || !upstream.body) {
            throw new ApiError(404, `release asset not found (${upstream.status})`);
        }

        const contentType = asset.endsWith('.json')
            ? 'application/json'
            : asset.endsWith('.sha256')
              ? 'text/plain'
              : 'application/octet-stream';
        return new Response(upstream.body, {
            status: 200,
            headers: {
                'Content-Type': contentType,
                // Release assets are immutable per tag.
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        });
    });
}
