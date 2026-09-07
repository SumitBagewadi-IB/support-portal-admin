'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/* Index for the admin app.
 *
 * In deployment each panel has its own host, and this page routes to the right
 * one by hostname:
 *
 *   support-admin.*       / uat-support-admin.*       -> /admin/
 *   support-masteradmin.* / uat-support-masteradmin.* -> /masteradmin/
 *
 * The routing lives here rather than in hosting config on purpose. Both hosts
 * are served from one bucket behind a load balancer, and firebase.json rewrites
 * only apply to a Firebase Hosting deploy — so a config-level rewrite would
 * cover one deploy path and not the other. Doing it client-side works on both.
 *
 * The two links below are the fallback, shown on any host that matches neither
 * pattern: localhost during `npm run dev`, a *.web.app preview channel, or the
 * bucket URL. A Next.js app router build also needs a root route to exist.
 *
 * The page carries no data and no authentication state — both panels do their
 * own login, so there is nothing here worth protecting and nothing to leak.
 */

function panelForHost(hostname: string): string | null {
  const h = hostname.toLowerCase();
  // Match the deployed hostnames specifically. A looser test such as
  // h.includes('admin') would also catch ib-admin-uat.web.app and the bucket
  // URL, which should fall through to the two links instead.
  if (h.includes('support-masteradmin')) return '/masteradmin/';
  if (h.includes('support-admin')) return '/admin/';
  return null;
}

export default function Home() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    const panel = panelForHost(window.location.hostname);
    if (!panel) return;
    setTarget(panel);
    // replace() so the bare host does not sit in history behind the panel.
    window.location.replace(panel);
  }, []);

  if (target) {
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        <p style={{ margin: 0, opacity: 0.7, fontSize: '0.9rem' }}>
          Opening the portal… <Link href={target} style={{ color: 'inherit' }}>continue</Link>
        </p>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.5rem',
        padding: '2rem',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
        Indiabulls Securities Support — Admin
      </h1>
      <p style={{ margin: 0, opacity: 0.7, fontSize: '0.9rem', textAlign: 'center' }}>
        Internal panels. Each is served on its own host in deployment.
      </p>
      <nav style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/admin/"
          style={{
            padding: '0.7rem 1.4rem',
            borderRadius: 999,
            border: '1px solid currentColor',
            textDecoration: 'none',
            color: 'inherit',
            fontSize: '0.9rem',
          }}
        >
          Manager portal
        </Link>
        <Link
          href="/masteradmin/"
          style={{
            padding: '0.7rem 1.4rem',
            borderRadius: 999,
            border: '1px solid currentColor',
            textDecoration: 'none',
            color: 'inherit',
            fontSize: '0.9rem',
          }}
        >
          Master admin
        </Link>
      </nav>
    </main>
  );
}
