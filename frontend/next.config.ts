import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/EdgeRunner";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  // Used by client code to fetch public/kernel-bundle.json under GH Pages.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;