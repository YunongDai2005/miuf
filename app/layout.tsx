import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const requestedHost =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const host = /^[a-z0-9.:[\]-]+$/i.test(requestedHost) ? requestedHost : "localhost";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "http" || host.startsWith("localhost") ? "http" : "https";
  const metadataBase = new URL(`${protocol}://${host}`);
  const title =
    "Berlin Lost & Found｜Find the right office and prepare your report";
  const description =
    "Lost something in Berlin? Rebuild your route, find the official services that may have your item, and prepare German/English reports to review and submit yourself.";

  return {
    metadataBase,
    title,
    description,
    openGraph: {
      type: "website",
      locale: "en_US",
      title,
      description,
      images: [
        {
          url: "/og-lost-found.png",
          width: 1732,
          height: 908,
          alt: "Berlin Lost & Found — find the right office and prepare your report",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og-lost-found.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} antialiased`}>{children}</body>
    </html>
  );
}
