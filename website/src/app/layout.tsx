import type { Metadata } from "next";
import { MotionProvider } from "@/components/MotionProvider";
import { site } from "@/content/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.canonical),
  title: site.title,
  description: site.description,
  keywords: [...site.keywords],
  authors: [{ name: site.name }],
  alternates: {
    canonical: site.canonical,
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: site.canonical,
    title: site.title,
    description: site.description,
    siteName: site.name,
    images: [
      {
        url: "/brand/icon-256.png",
        width: 256,
        height: 256,
        alt: "白球 AI",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: site.title,
    description: site.description,
    images: ["/brand/icon-256.png"],
  },
  icons: {
    icon: [
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/icon-256.png", sizes: "256x256", type: "image/png" },
    ],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180" }],
  },
  robots: {
    index: true,
    follow: true,
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: site.name,
  applicationCategory: "DesktopApplication",
  operatingSystem: "Windows",
  softwareVersion: site.version,
  description: site.description,
  url: site.canonical,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "CNY",
    availability: "https://schema.org/PreOrder",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-full antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
