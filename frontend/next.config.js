/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Android app verification (see pages/api/assetlinks.js).
  async rewrites() {
    return [{ source: "/.well-known/assetlinks.json", destination: "/api/assetlinks" }];
  },
};

module.exports = nextConfig;
