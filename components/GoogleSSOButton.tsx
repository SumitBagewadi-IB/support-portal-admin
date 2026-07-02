'use client';

import { useEffect, useRef } from 'react';
import { API_BASE } from '@/lib/api';

// Google Workspace SSO button (Google Identity Services).
//
// DORMANT until NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID is set at build time — the
// component renders nothing without it, so password login keeps working. When
// configured, it renders Google's button, and on sign-in posts the Google ID
// token to the shared backend POST /auth/sso, which verifies the token +
// @indiabulls.com hosted domain + the manager allowlist and returns the app JWT.

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID || '';
const HD = 'indiabulls.com';

interface GoogleCredentialResponse { credential?: string }

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (cfg: Record<string, unknown>) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

export default function GoogleSSOButton({
  onSuccess,
  onError,
}: {
  onSuccess: (data: { token: string; managerId?: string; displayName?: string; role?: string }) => void;
  onError: (msg: string) => void;
}) {
  const btnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!CLIENT_ID || !API_BASE) return;

    const handleCredential = async (resp: GoogleCredentialResponse) => {
      if (!resp?.credential) { onError('Google sign-in was cancelled.'); return; }
      try {
        const r = await fetch(`${API_BASE}/auth/sso`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: resp.credential }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data?.token) {
          onError(data?.error || 'Your account is not authorized for this portal.');
          return;
        }
        onSuccess(data);
      } catch {
        onError('Network error during sign-in. Please try again.');
      }
    };

    const init = () => {
      const gid = window.google?.accounts?.id;
      if (!gid || !btnRef.current) return;
      gid.initialize({ client_id: CLIENT_ID, callback: handleCredential, hd: HD, auto_select: false });
      gid.renderButton(btnRef.current, {
        theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 300,
      });
    };

    if (window.google?.accounts?.id) { init(); return; }
    let s = document.getElementById('gis-client') as HTMLScriptElement | null;
    if (!s) {
      s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true; s.id = 'gis-client';
      document.head.appendChild(s);
    }
    s.addEventListener('load', init);
    return () => s?.removeEventListener('load', init);
  }, [onSuccess, onError]);

  if (!CLIENT_ID) return null; // dormant — password login only

  return (
    <div style={{ marginTop: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.75rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        or
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
      <div ref={btnRef} style={{ display: 'flex', justifyContent: 'center' }} />
      <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.5rem' }}>
        Sign in with your <strong>@indiabulls.com</strong> account
      </p>
    </div>
  );
}
