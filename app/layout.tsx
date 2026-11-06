import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vinay Kumar Chopra — AI Representative",
  description: "Chat with Vinay's AI persona. Ask about his background, projects, and book an interview.",
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
