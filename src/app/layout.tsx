import type { Metadata, Viewport } from 'next';
import {
  Bricolage_Grotesque,
  Instrument_Sans,
  Source_Serif_4,
  Spline_Sans_Mono,
} from 'next/font/google';
import { Toaster } from 'sonner';

import './globals.css';

// Display face — headlines and the wordmark. Characterful, youthful, still
// serious enough for a mathematics studio.
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

// Body face — UI copy, labels, running text.
const sans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

// Serif — reserved for authored item content (stems, options, rationales),
// so student-written mathematics reads like a printed problem, not a form.
const serif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
});

// Mono — recorded data: contracts, model ids, diffs, state names.
const mono = Spline_Sans_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LA FORJA — an adversarial learning studio',
  description:
    'Getting the right answer is not enough. Forge it, attack it, defend it. ' +
    'High-school and college mathematics.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1c1610',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${serif.variable} ${mono.variable}`}
    >
      <body>
        {children}
        <Toaster position="top-center" offset={24} gap={10} />
      </body>
    </html>
  );
}
