import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "3D Design Studio",
  description: "AI-powered 3D design ideation and approval",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
