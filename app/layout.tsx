import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dispatch Load Analyzer',
  description: 'Dry Van dispatch decision-support and training tool',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
