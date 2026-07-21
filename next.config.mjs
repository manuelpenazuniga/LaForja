/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Demo isolation (doc §10): no telemetry that could leak visitor data.
  experimental: {},
};

export default nextConfig;
