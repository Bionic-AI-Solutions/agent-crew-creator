import { router, publicProcedure } from "./_core/trpc.js";
import { appRouter } from "./appRouter.js";
import { agentRouter } from "./agentRouter.js";

const authRouter = router({
  me: publicProcedure.query(async ({ ctx }) => {
    return { user: ctx.user };
  }),
});

export const appTrpcRouter = router({
  appsCrud: appRouter,
  agentsCrud: agentRouter,
  userSession: authRouter,
});

export type AppRouter = typeof appTrpcRouter;
