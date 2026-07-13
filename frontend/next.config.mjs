// For GitHub Pages we build a static export served from a project subpath
// (https://<user>.github.io/EdgeRunner/). The workflow sets GITHUB_PAGES=true;
// local `next dev` / `next build` stay at the root with no export.
const isPages = process.env.GITHUB_PAGES === "true";
const basePath = isPages ? "/EdgeRunner" : "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(isPages ? { output: "export" } : {}),
  basePath,
  images: { unoptimized: true },
  trailingSlash: true,
  // Expose the base path to client code (e.g. for building asset URLs).
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
