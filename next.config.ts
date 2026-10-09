import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // FFmpeg WebAssembly runs entirely in the browser. Avoid server-side bundling.
  webpack: (config) => {
    config.resolve.alias = { ...config.resolve.alias, fs: false };
    return config;
  },
};

export default nextConfig;
