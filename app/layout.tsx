// app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/Navbar";
import { SessionProvider } from "next-auth/react";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FGC Ranks",
  description: "Fighting Game Community tournament tracker and player records",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      {/* Plain block body, not flex — every page's <main> relies on normal
          block-level auto-margin centering (max-w-4xl mx-auto). A flex
          column body would disable that: auto margins suppress flex-stretch,
          so <main> would shrink to its content width instead of filling up
          to its max-width cap (this bit Events' browse-page cards, fixed
          per-page there before the root cause here was found). */}
      <body className="min-h-full" suppressHydrationWarning>
        <SessionProvider>
          <Navbar />
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
