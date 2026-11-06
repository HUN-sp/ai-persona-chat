import type { Metadata } from "next";
import "./globals.css";
import { personaUi } from "@/persona/ui";

export const metadata: Metadata = {
  title: personaUi.pageTitle,
  description: personaUi.pageDescription,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
