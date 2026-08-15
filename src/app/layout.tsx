import type { Metadata } from 'next';

import { getSiteContent } from '@/lib/content';
import '@/styles/globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const content = await getSiteContent();
  return {
    title: {
      default: content.brandName,
      template: `%s | ${content.brandName}`,
    },
    description: content.tagline,
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
