import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    // The ingest validator imports tools/web-flasher/analytics/parser.js (the
    // single JS parser for the firmware's session structs). Turbopack refuses
    // imports outside the project root, so widen the root to tools/ — the
    // shared parent of web-server and web-flasher.
    turbopack: {
        root: path.join(import.meta.dirname, '..'),
    },
    async rewrites() {
        return {
            // The flasher's index.html (copied into public/ by prepare-static)
            // is the site root; beforeFiles so nothing can shadow it.
            beforeFiles: [{ source: '/', destination: '/index.html' }],
            afterFiles: [],
            fallback: [],
        };
    },
    // The drizzle migrations folder is read at runtime by the API routes;
    // make sure serverless output tracing bundles it.
    outputFileTracingIncludes: {
        '/api/**/*': ['./drizzle/**/*'],
    },
};

export default nextConfig;
