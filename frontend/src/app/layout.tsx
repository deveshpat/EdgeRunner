import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Orbitron, Share_Tech_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
});

const shareTech = Share_Tech_Mono({
  variable: "--font-share-tech",
  subsets: ["latin"],
  weight: "400",
});

/**
 * Security posture for a static GitHub Pages app:
 * - No third-party analytics
 * - CSP via meta (Pages cannot set most HTTP security headers)
 * - Referrer trimmed; permissions locked down
 * - Secrets + chat encrypted client-side (see src/lib/vault.ts)
 */
export const metadata: Metadata = {
  title: "EdgeRunner — Night City Agent Harness",
  description:
    "Cyberpunk agentic coding harness. Run on Kaggle CPU/GPU or local — encrypted vault, neon CLI, SOTA models.",
  robots: { index: true, follow: true },
  referrer: "no-referrer",
  other: {
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https: http://127.0.0.1:* http://localhost:* http://[::1]:*",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "upgrade-insecure-requests",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
};

export const viewport: Viewport = {
  themeColor: "#07010f",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${orbitron.variable} ${shareTech.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
