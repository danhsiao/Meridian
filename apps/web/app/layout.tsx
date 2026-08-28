import type { ReactNode } from "react";
import "./globals.css";
import "@xyflow/react/dist/style.css";

export const metadata = {
  title: "Workflow Engine",
  description: "An IDE for business workflows — the whiteboard is the source language.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
