import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LA FORJA — an adversarial learning studio',
  description:
    'Getting the right answer is not enough. Forge it, attack it, defend it.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
