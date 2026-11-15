import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Construction RCM', template: '%s · Construction RCM' },
  description: 'Subcontractor billing intake, verification and approval for general contractors.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast: '!rounded-lg !border !border-line !bg-surface !text-ink !shadow-pop !text-[13px] !font-sans',
              description: '!text-ink-2',
            },
          }}
        />
      </body>
    </html>
  );
}
