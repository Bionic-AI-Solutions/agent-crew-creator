"use client";

import { signIn } from "next-auth/react";
import { useEffect } from "react";

/**
 * Auto-redirect to Keycloak. Users never see this page —
 * they're immediately forwarded to the KC login form.
 */
export default function SignInPage() {
  useEffect(() => {
    signIn("keycloak", { callbackUrl: "/" });
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <p style={{ color: "#888" }}>Redirecting to login...</p>
    </div>
  );
}
