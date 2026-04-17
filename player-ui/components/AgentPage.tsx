"use client";

import { SessionProvider } from "next-auth/react";
import { AgentApp } from "./AgentApp";

export default function AgentPage() {
  return (
    <SessionProvider>
      <AgentApp />
    </SessionProvider>
  );
}
