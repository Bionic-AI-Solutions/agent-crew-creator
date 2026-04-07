const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const CURRENT_LEVEL: Level = (process.env.LOG_LEVEL as Level) || "info";

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[CURRENT_LEVEL];
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  return " " + JSON.stringify(meta);
}

export function createLogger(name: string) {
  const prefix = `[${name}]`;
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => {
      if (shouldLog("debug")) console.debug(`${prefix} ${msg}${formatMeta(meta)}`);
    },
    info: (msg: string, meta?: Record<string, unknown>) => {
      if (shouldLog("info")) console.info(`${prefix} ${msg}${formatMeta(meta)}`);
    },
    warn: (msg: string, meta?: Record<string, unknown>) => {
      if (shouldLog("warn")) console.warn(`${prefix} ${msg}${formatMeta(meta)}`);
    },
    error: (msg: string, meta?: Record<string, unknown>) => {
      if (shouldLog("error")) console.error(`${prefix} ${msg}${formatMeta(meta)}`);
    },
  };
}
