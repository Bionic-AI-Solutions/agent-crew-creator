/**
 * Per-app player UI build context: copy template sources and write generated metadata
 * before `docker build`, so each app image is built from app-specific generated assets.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../_core/logger.js";

const log = createLogger("PlayerUiCodegen");

const DEFAULT_TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "player-ui",
);

function shouldCopySourcePath(srcPath: string): boolean {
  const n = srcPath.replace(/\\/g, "/");
  if (n.includes("/node_modules/") || n.endsWith("/node_modules")) return false;
  if (n.includes("/.next/") || n.endsWith("/.next")) return false;
  if (n.includes("/.git/") || n.endsWith("/.git")) return false;
  return true;
}

export interface PlayerUiCodegenInput {
  slug: string;
  name: string;
  description: string | null;
  livekitUrl: string;
}

/**
 * Copies `player-ui` (or PLAYER_UI_TEMPLATE_DIR) into a temp directory and writes
 * `public/bionic-app.json` consumed at `next build` / runtime.
 */
export async function preparePlayerUiDockerBuildContext(
  input: PlayerUiCodegenInput,
): Promise<{ contextPath: string; cleanup: () => void }> {
  const template = (process.env.PLAYER_UI_TEMPLATE_DIR || "").trim() || DEFAULT_TEMPLATE;
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bionic-player-ui-"));
  const contextPath = path.join(tmpRoot, "buildctx");

  fs.cpSync(template, contextPath, {
    recursive: true,
    filter: (src) => shouldCopySourcePath(src),
  });

  const publicDir = path.join(contextPath, "public");
  await fs.promises.mkdir(publicDir, { recursive: true });
  const payload = {
    slug: input.slug,
    appName: input.name,
    description: input.description,
    livekitUrl: input.livekitUrl,
    generatedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(
    path.join(publicDir, "bionic-app.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  log.info("Generated player-ui Docker build context", { contextPath, slug: input.slug });
  return {
    contextPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch (err) {
        log.warn("Failed to remove temp player-ui build context", { tmpRoot, error: String(err) });
      }
    },
  };
}
