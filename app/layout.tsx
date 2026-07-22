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
  const title = "Berlin Trace｜用图钉与丝线串起柏林轨迹";
  const description =
    "在柏林地图上用景点图钉、丝线与拐点记录行动轨迹，推测可能乘坐的公交、地铁、城铁、电车、区域列车与渡轮路线。";

  return {
    metadataBase,
    title,
    description,
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title,
      description,
      images: [{ url: "/og-pin-thread.png", width: 1734, height: 907, alt: "Berlin Trace 图钉、丝线路线与公共交通示意" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og-pin-thread.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} antialiased`}>{children}</body>
    </html>
  );
}
