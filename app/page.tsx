import Link from 'next/link';

/* Index for the admin app.
 *
 * In deployment this page is not the entry point: each host rewrites its own
 * root to a single panel, so support-admin.* serves /admin/ and
 * support-masteradmin.* serves /masteradmin/ (see firebase.json and the
 * README). It exists for two reasons — a Next.js app router build wants a root
 * route, and running the app locally with `npm run dev` needs somewhere to
 * start from.
 *
 * It carries no data and no authentication state: both panels do their own
 * login, so there is nothing here worth protecting and nothing to leak.
 */

export default function Home() {
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
