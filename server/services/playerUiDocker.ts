/**
 * Build and push the agent player UI image from `base/player-ui` (or PLAYER_UI_BUILD_CONTEXT),
 * same pattern as shipping a worker image before applying it to the app namespace.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../_core/logger.js";

const log = createLogger("PlayerUiDocker");

const execFileAsync = promisify(execFile);

const DEFAULT_CONTEXT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "player-ui",
);

function dockerTimeoutMs(): number {
  const n = Number(process.env.PLAYER_UI_DOCKER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

export interface BuildPlayerUiImageOptions {
  /** Temp dir from codegen; when omitted, uses PLAYER_UI_BUILD_CONTEXT / default template. */
  contextPath?: string;
}

/**
 * `docker build` + `docker push` → returns image ref `{repository}:{slug}`.
 * Requires Docker CLI and registry auth (`docker login`) on the platform host.
 */
export async function buildAndPushPlayerUiImage(
  slug: string,
  repository: string,
  options?: BuildPlayerUiImageOptions,
): Promise<string> {
  const repo = repository.replace(/\/+$/, "");
  if (!repo) throw new Error("PLAYER_UI_IMAGE_REPOSITORY is empty");

  const context =
    (options?.contextPath || "").trim() ||
    (process.env.PLAYER_UI_BUILD_CONTEXT || "").trim() ||
    DEFAULT_CONTEXT;
  const dockerfile = (process.env.PLAYER_UI_DOCKERFILE || "").trim() || path.join(context, "Dockerfile");
  const tag = `${repo}:${slug}`;
  const timeout = dockerTimeoutMs();

  log.info("Building player-ui image", { tag, context, dockerfile, timeoutMs: timeout });

  try {
    await execFileAsync(
      "docker",
      ["build", "-t", tag, "-f", dockerfile, context],
      { timeout, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err: any) {
    const msg = err?.stderr?.toString?.() || err?.message || String(err);
    throw new Error(`player_ui docker build failed: ${msg}`);
  }

  if (process.env.PLAYER_UI_SKIP_DOCKER_PUSH === "1" || process.env.PLAYER_UI_SKIP_DOCKER_PUSH === "true") {
    log.warn("PLAYER_UI_SKIP_DOCKER_PUSH set — skipping push (cluster must pull this tag from local/build cache)", {
      tag,
    });
    return tag;
  }

  log.info("Pushing player-ui image", { tag });
  try {
    await execFileAsync("docker", ["push", tag], { timeout, maxBuffer: 32 * 1024 * 1024 });
  } catch (err: any) {
    const msg = err?.stderr?.toString?.() || err?.message || String(err);
    throw new Error(`player_ui docker push failed: ${msg}`);
  }

  return tag;
}

export type PlayerUiProvisionContext = {
  slug: string;
  name: string;
  description: string | null;
  livekitUrl: string;
};

/**
 * Resolve the image ref for the player_ui provisioning step.
 * - If PLAYER_UI_IMAGE is set: use as-is (pre-built image, e.g. CI).
 * - Else: generate per-app build context (template copy + bionic-app.json), then
 *   `docker build` + `docker push` to PLAYER_UI_IMAGE_REPOSITORY:{slug}.
 */
export async function resolvePlayerUiImageRef(
  slug: string,
  ctx: PlayerUiProvisionContext,
): Promise<string> {
  const prebuilt = (process.env.PLAYER_UI_IMAGE || "").trim();
  if (prebuilt) {
    log.info("Using prebuilt PLAYER_UI_IMAGE", { image: prebuilt });
    return prebuilt;
  }

  const repository = (process.env.PLAYER_UI_IMAGE_REPOSITORY || "").trim();
  if (!repository) {
    throw new Error(
      "Set PLAYER_UI_IMAGE (pre-built ref) or PLAYER_UI_IMAGE_REPOSITORY (docker build + push, tag = :slug) for player_ui",
    );
  }

  const skipCodegen =
    process.env.PLAYER_UI_SKIP_CODEGEN === "1" || process.env.PLAYER_UI_SKIP_CODEGEN === "true";
  if (skipCodegen) {
    log.info("PLAYER_UI_SKIP_CODEGEN — building from PLAYER_UI_BUILD_CONTEXT / default template", { slug });
    return buildAndPushPlayerUiImage(slug, repository);
  }

  const { preparePlayerUiDockerBuildContext } = await import("./playerUiCodegen.js");
  const { contextPath, cleanup } = await preparePlayerUiDockerBuildContext({
    slug: ctx.slug,
    name: ctx.name,
    description: ctx.description,
    livekitUrl: ctx.livekitUrl,
  });
  try {
    return await buildAndPushPlayerUiImage(slug, repository, { contextPath });
  } finally {
    cleanup();
  }
}
