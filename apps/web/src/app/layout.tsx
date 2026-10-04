import type { Metadata, Viewport } from "next";
import { AppHeader } from "@/components/studio/app-header";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "3D Studio", template: "%s · 3D Studio" },
  description: "AI-powered 3D design ideation and approval",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col">
        <Providers>
          <AppHeader />
          <div className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-8 sm:px-6 sm:pt-12 lg:px-8">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
