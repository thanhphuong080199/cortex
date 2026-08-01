import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @cortex/shared is consumed as TypeScript source (its package.json main points at
  // src/index.ts), so Next has to compile it rather than expect prebuilt JS.
  transpilePackages: ["@cortex/shared"],

  webpack: (config) => {
    // packages/* use "moduleResolution": "NodeNext", which REQUIRES the ".js" extension
    // in relative import specifiers even though the files on disk are ".ts". Webpack
    // resolves those literally and looks for a real enums.js, so map the extension back
    // the way tsc does.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
