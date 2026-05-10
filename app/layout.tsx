import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const siteUrl = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://salomon-gamma.vercel.app"
)

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "Salomon",
    template: "%s | Salomon",
  },
  description: "Live translation for church services across microphone and livestream inputs.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Salomon",
    description: "Live transcription and translation for church services.",
    url: "/",
    siteName: "Salomon",
    images: [
      {
        url: "/salomonog.png",
        width: 1200,
        height: 630,
        alt: "Salomon live transcription and translation",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Salomon",
    description: "Live transcription and translation for church services.",
    images: ["/salomonog.png"],
  },
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        {children}
        <Toaster position="top-center" richColors />
        <Analytics />
      </body>
    </html>
  )
}
