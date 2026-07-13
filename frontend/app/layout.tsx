import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EdgeRunner",
  description: "A terminal-themed web app for running agent harnesses.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
