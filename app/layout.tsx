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
  const title = "Berlin Lost & Found｜Retrace your day, reach the right lost-property offices";
  const description =
    "Lost something in Berlin? Retrace the public transport you took and the sights you visited, find every lost-property office responsible along the way, and generate ready-to-send German/English reports.";

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
          alt: "Berlin Lost & Found — retrace your day and reach the right office",
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
