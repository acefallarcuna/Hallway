import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hallway — Video Reverb',
  description: 'Add spacious hall reverb to a video privately, right on your device.',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Hallway' },
};

export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, maximumScale: 1, viewportFit: 'cover',
  themeColor: '#101113',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
