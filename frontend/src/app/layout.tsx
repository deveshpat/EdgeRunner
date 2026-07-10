import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Security posture for a static GitHub Pages app:
 * - No third-party analytics
 * - CSP via meta (Pages cannot set most HTTP security headers)
 * - Referrer trimmed; permissions locked down
 * - Secrets + chat encrypted client-side (see src/lib/vault.ts)
 */
export const metadata: Metadata = {
  title: "EdgeRunner — Local & Kaggle Agentic Harness",
  description:
    "Run EdgeRunner locally or launch on Kaggle CPU/GPU with automatic HTTPS tunnels. Credentials and chat encrypted on-device.",
  robots: { index: true, follow: true },
  referrer: "no-referrer",
  other: {
    // CSP: allow self + Kaggle API + arbitrary https backends (tunnels) + loopback.
    // 'unsafe-inline' needed for Next static CSS/style injection; no remote scripts.
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
  themeColor: "#0a0a0a",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
