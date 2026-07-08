/** @type {import('next').NextConfig} */
const isGithubPages = process.env.NEXT_DEPLOY_TARGET === "github-pages";
const repoName = "Stuni-web";

const nextConfig = {
  ...(isGithubPages
    ? {
        output: "export",
        basePath: `/${repoName}`,
        assetPrefix: `/${repoName}/`,
        trailingSlash: true,
      }
    : {
        async headers() {
          return [
            {
              source: "/(.*)",
              headers: [
                { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
                { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
              ],
            },
          ];
        },
      }),
  webpack: (config) => {
    config.resolve.alias["onnxruntime-node"] = false;
    config.resolve.alias.sharp = false;
    return config;
  },
};

export default nextConfig;
