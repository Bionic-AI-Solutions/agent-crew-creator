import { createTRPCReact } from "@trpc/react-query";

/**
 * tRPC React client.
 *
 * We avoid importing AppRouter type directly from the server because
 * Vite follows the import chain and pulls server dependencies (pg,
 * kubernetes, multer) into the client bundle, causing runtime errors.
 *
 * Type safety is maintained via tsconfig paths in the IDE.
 */
export const trpc = createTRPCReact<any>();
