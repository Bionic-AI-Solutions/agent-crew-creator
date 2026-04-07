// This file exists solely to export the AppRouter type for the client.
// It re-exports from the server but is only used as `import type`,
// so TypeScript erases it and no server code reaches the client bundle.
export type { AppRouter } from "../server/routers";
