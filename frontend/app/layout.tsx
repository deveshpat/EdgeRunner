import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "EdgeRunner",
  description: "High-performance edge AI inference and agent terminal.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener('unhandledrejection', function(event) {
                var r = event.reason;
                if (r === 'Canceled' || (r && (r.message === 'Canceled' || r.name === 'Canceled' || r.type === 'cancel' || String(r).indexOf('Canceled') !== -1))) {
                  event.preventDefault();
                  event.stopImmediatePropagation();
                }
              });
            `,
          }}
        />
      </head>
      <body className="font-mono bg-term-bg text-term-fg antialiased selection:bg-term-green/20 selection:text-term-green">
        {children}
      </body>
    </html>
  );
}
