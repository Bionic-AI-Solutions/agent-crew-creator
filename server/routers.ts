import { router, publicProcedure } from "./_core/trpc.js";
import { appRouter } from "./appRouter.js";
import { agentRouter } from "./agentRouter.js";
import { playgroundRouter } from "./playgroundRouter.js";
import { embedRouter } from "./embedRouter.js";

const authRouter = router({
  me: publicProcedure.query(async ({ ctx }) => {
    return { user: ctx.user };
  }),
});

export const appTrpcRouter = router({
  appsCrud: appRouter,
  agentsCrud: agentRouter,
  playground: playgroundRouter,
  embed: embedRouter,
  userSession: authRouter,
});

export type AppRouter = typeof appTrpcRouter;
