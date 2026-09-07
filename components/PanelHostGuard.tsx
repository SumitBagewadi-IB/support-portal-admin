'use client';

import { useEffect } from 'react';
import { panelForHost, hostForPanel, type Panel } from '@/lib/host';

/**
 * Sends a panel opened on the wrong hostname to the host that owns it.
 *
 * One bucket holds both panels behind two hostnames, so
 * uat-support-admin.../masteradmin/ resolves and serves the master admin panel
 * from the manager host. This keeps each panel on its own domain.
 *
 * Renders nothing, and does nothing on hosts that serve both panels
 * (localhost, preview channels, the bucket URL) so development is unaffected.
 * The swap keeps the environment: a UAT host redirects to the UAT counterpart.
 *
 * Defence in depth only — a client-side redirect is not a security control.
 * Authorisation is enforced server-side on every privileged call.
 */
export default function PanelHostGuard({ panel }: { panel: Panel }) {
  useEffect(() => {
    const hostname = window.location.hostname;
    const serves = panelForHost(hostname);
    // Host serves both panels (dev/preview), or already the right one.
    if (!serves || serves === panel) return;

    const target = hostForPanel(hostname, panel);
    if (!target || target === hostname) return;

    // replace() so the wrong-host URL does not linger in history. Once there,
    // the hostname matches the panel and this is a no-op, so it cannot loop.
    window.location.replace(`${window.location.protocol}//${target}${panel}`);
  }, [panel]);

  return null;
}
