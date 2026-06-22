/**
 * NextAuth configuration for Keycloak OIDC.
 *
 * Env vars injected by K8s deployment:
 *   KEYCLOAK_ISSUER        — e.g. https://auth.bionicaisolutions.com/realms/Bionic
 *   KEYCLOAK_CLIENT_ID     — {slug}-public
 *   KEYCLOAK_CLIENT_SECRET — from confidential client (empty string for public client PKCE)
 *   NEXTAUTH_SECRET        — random secret for session encryption
 *   NEXTAUTH_URL           — public URL of this app (https://{slug}.baisoln.com)
 */
import type { NextAuthOptions } from "next-auth";
import KeycloakProvider from "next-auth/providers/keycloak";

export const authOptions: NextAuthOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID || "",
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || "",
      issuer: process.env.KEYCLOAK_ISSUER || "",
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.sub = (profile as any)?.sub || account.providerAccountId;
        token.accessToken = account.access_token;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session as any).user.sub = token.sub;
        (session as any).accessToken = token.accessToken;
      }
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
};
