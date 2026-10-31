/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/landing", destination: "/landing.html" }];
  },
};
