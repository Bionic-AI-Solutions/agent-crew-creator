import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  // Expose server-side env vars at runtime (not baked into the build)
  serverExternalPackages: ["next-auth"],
};

export default nextConfig;
