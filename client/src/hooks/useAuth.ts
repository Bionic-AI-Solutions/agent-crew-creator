import { trpc } from "../lib/trpc";

export function useAuth() {
  const { data, isLoading } = trpc.userSession.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });

  return {
    user: data?.user ?? null,
    isLoading,
    isAuthenticated: !!data?.user,
    isAdmin: data?.user?.role === "admin",
  };
}
