import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Manager Portal | Indiabulls Securities Support',
  description: 'Manager portal for managing support FAQ articles and customer tickets.',
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
