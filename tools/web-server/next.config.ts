import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    // The drizzle migrations folder is read at runtime by the API routes;
    // make sure serverless output tracing bundles it.
    outputFileTracingIncludes: {
        '/api/**/*': ['./drizzle/**/*'],
    },
};

export default nextConfig;
