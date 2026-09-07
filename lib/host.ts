/**
 * Which panel a hostname is meant to serve.
 *
 * Both panels ship in one bundle to one bucket, fronted by two hostnames, so
 * nothing at the hosting layer stops /masteradmin/ being fetched from the admin
 * host or vice versa. These helpers put that mapping in one place: the root
 * page uses them to route the bare hostname, and PanelHostGuard uses them to
 * send a panel loaded on the wrong host to the right one.
 *
 * This is tidiness and least surprise, not an authorisation boundary. The
 * Cloud Function checks the master role on every privileged call regardless of
 * which host served the page, and that check is the actual control.
 */

export type Panel = '/admin/' | '/masteradmin/';

/**
 * The panel this hostname is dedicated to, or null if it serves both.
 *
 * Matches "support-admin" / "support-masteradmin" rather than a looser test for
 * "admin", so localhost, ib-admin-uat.web.app and the bucket URL fall through
 * to null and keep working for development and previews. The two patterns do
 * not overlap — "support-masteradmin" does not contain "support-admin" — but
 * masteradmin is still tested first.
 */
export function panelForHost(hostname: string): Panel | null {
  const h = hostname.toLowerCase();
  if (h.includes('support-masteradmin')) return '/masteradmin/';
  if (h.includes('support-admin')) return '/admin/';
  return null;
}

/**
 * The hostname that should serve `panel`, derived from the current one by
 * swapping the sub-domain so UAT stays on UAT and prod stays on prod.
 *
 * Returns null when the current host serves both panels, so callers leave
 * development and preview hosts alone.
 */
export function hostForPanel(hostname: string, panel: Panel): string | null {
  const serves = panelForHost(hostname);
  if (!serves) return null;
  if (serves === panel) return hostname;
  return panel === '/masteradmin/'
    ? hostname.replace('support-admin', 'support-masteradmin')
    : hostname.replace('support-masteradmin', 'support-admin');
}
