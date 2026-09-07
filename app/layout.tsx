import type { Metadata } from 'next';
import './globals.css';

/* Root layout for the admin app.
 *
 * The public site's root layout wraps everything in <PublicShell>, which draws
 * the marketing header, footer and nav. Both panels opted out of that shell on
 * the public site — PublicShell carried explicit /admin and /masteradmin arms
 * to render them chromeless — so nothing is lost by not having it here, and
 * carrying it across would have pulled the public site's whole component tree
 * into a repo that has no public pages.
 *
 * Everything below is what the panels actually need:
 *
 *   globals.css   the shared stylesheet; the panels' markup is written against it
 *   Font Awesome  189 icon usages across the two pages, all from the 6.4.0 kit
 *   theme script  the panels read and write data-theme on <html> (5 call sites),
 *                 applied before first paint so a dark session does not flash light
 *
 * next-themes is not used by either panel — the inline script is the whole
 * mechanism — so it is not a dependency of this app.
 */

export const metadata: Metadata = {
  title: 'Indiabulls Securities Support — Admin',
  description: 'Internal administration for the Indiabulls Securities support portal.',
  /* Every route in this repo is an internal panel. On the public site only
     /masteradmin set this; here it belongs at the root, because there is no
     public page under it to exclude. */
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('theme')||'light';if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
        <link rel="shortcut icon" type="image/x-icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/favicon.ico" />
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
          integrity="sha512-iecdLmaskl7CVkqkXNQ/ZH/XLlvWZOJyj7Yy7tcenmpD1ypASozpmT/E0iPtmFIB46ZmdtAc9eNBvH0H/ZpiBw=="
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
