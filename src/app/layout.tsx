import type { Metadata } from "next";
import { headers } from "next/headers";
import { IBM_Plex_Mono, Instrument_Serif, Public_Sans } from "next/font/google";

import "./globals.css";

const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-public-sans",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Praxis CRM Jurídico",
  description: "CRM comercial para escritórios de advocacia.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Lido (não usado diretamente aqui) para o Next aplicar automaticamente
  // este nonce nos próprios scripts que ele injeta — é o que faz a CSP com
  // 'strict-dynamic' do proxy.ts (src/proxy.ts) funcionar sem 'unsafe-inline'
  // em script-src.
  await headers();

  return (
    <html
      lang="pt-BR"
      className={`${publicSans.variable} ${instrumentSerif.variable} ${ibmPlexMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
