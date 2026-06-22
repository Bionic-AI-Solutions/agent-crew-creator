"use client";

import dynamic from "next/dynamic";

const AgentPage = dynamic(() => import("@/components/AgentPage"), { ssr: false });

export default function HomePage() {
  return <AgentPage />;
}
