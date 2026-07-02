'use client';

import { useEffect, useState } from 'react';

// Both private admin domains point at this one static app; the root routes each
// domain to its panel:
//   uat-support-admin.indiabullssecurities.com        -> /admin
//   uat-support-masteradmin.indiabullssecurities.com  -> /masteradmin
// (Client-side redirect — fine for a private, noindex app.)
export default function RootRedirect() {
  const [href, setHref] = useState('/admin/');
  useEffect(() => {
    const host = window.location.hostname;
    const target = host.includes('masteradmin') ? '/masteradmin/' : '/admin/';
    setHref(target);
    window.location.replace(target);
  }, []);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0F172A', color: '#E2E8F0', fontFamily: 'system-ui, sans-serif' }}>
      <p>Redirecting to the portal… <a href={href} style={{ color: '#00AB4E' }}>continue</a></p>
    </div>
  );
}
