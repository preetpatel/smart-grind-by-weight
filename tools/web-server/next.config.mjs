import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The ingest validator imports tools/web-flasher/analytics/parser.js (the
  // single JS parser for the firmware's session structs). Turbopack refuses
  // imports outside the project root, so widen the root to tools/ — the
  // shared parent of web-server and web-flasher.
  turbopack: {
    root: path.join(import.meta.dirname, '..'),
  },
  async rewrites() {
    return {
      // The flasher's index.html (copied into public/ by prepare-static) is
      // the site root; beforeFiles so nothing can shadow it.
      beforeFiles: [{ source: '/', destination: '/index.html' }],
    };
  },
  // The drizzle migrations folder and the shared parser (imported from
  // tools/web-flasher) are read at runtime by the API routes; make sure
  // serverless output tracing bundles them.
  outputFileTracingIncludes: {
    '/api/**/*': ['./drizzle/**/*'],
  },
};

export default nextConfig;
