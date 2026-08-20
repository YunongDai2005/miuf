import type { Metadata } from "next";
import { Fira_Mono, Fira_Sans } from "next/font/google";
import { headers } from "next/headers";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const firaSans = Fira_Sans({
  variable: "--font-fira-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const firaMono = Fira_Mono({
  variable: "--font-fira-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
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
    icons: {
      icon: [{ url: "/app-icon.svg", type: "image/svg+xml" }],
      apple: "/apple-touch-icon.png",
    },
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
      <body className={`${firaSans.variable} ${firaMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
