/** @type {import('next').NextConfig} */
const nextConfig = {
  // Agent SDK spawns the claude CLI as a subprocess; keep it external to the server bundle.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
