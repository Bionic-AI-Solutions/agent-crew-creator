import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Player",
  description: "Voice & chat agent interface",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
