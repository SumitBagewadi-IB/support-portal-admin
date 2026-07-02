import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === 'development';

// Fully STATIC export for production (no SSR, no Node server) so this admin app
// can be hosted as plain static files on GCP (GCS bucket / Firebase Hosting).
// All pages are client components; there are no server components, route
// handlers, server actions or middleware.
const nextConfig: NextConfig = {
  ...(isDev ? {} : { output: 'export', trailingSlash: true }),
};

export default nextConfig;
