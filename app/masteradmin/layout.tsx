import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Master Admin | Indiabulls Securities Support',
  description: 'Master admin — oversees managers, full audit trail and system-wide activity.',
  robots: { index: false, follow: false },
}

export default function MasterAdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
