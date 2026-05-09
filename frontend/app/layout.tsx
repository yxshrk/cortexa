import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cortexa — Project Brain",
  description: "Per-project engineering brain. Voice agent + Hyperspell + Claude.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
