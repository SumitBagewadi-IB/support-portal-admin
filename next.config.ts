import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
  // Static export for production build/deploy; disabled in dev so dynamic routes work
  ...(isDev ? {} : { output: 'export', trailingSlash: true }),
};

export default nextConfig;
