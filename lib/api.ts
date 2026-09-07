/**
 * Single source of truth for the API base URL and common request helpers.
 *
 * NEXT_PUBLIC_API_BASE is set at build time (see .github/workflows/deploy.yml
 * and the Next.js build). All pages and components should import API_BASE
 * from here instead of reading process.env directly — this gives us one
 * place to swap in a different transport (proxy, edge function, etc.) later.
 */

export const API_BASE: string = process.env.NEXT_PUBLIC_API_BASE || '';

/**
 * Build headers for a manager-authenticated request (JWT in Authorization).
 * Pass the manager JWT obtained from POST /auth/login.
 */
export function authHeaders(managerToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${managerToken}`,
  };
}

/**
 * Read the master session token from sessionStorage.
 * Returns '' if not in browser context or token not set.
 *
 * Master token is obtained via POST /auth/masterlogin (server-validated
 * against MASTER_ADMIN_SECRET; the raw password is never in the browser).
 */
export function getMasterToken(): string {
  if (typeof sessionStorage === 'undefined') return '';
  return sessionStorage.getItem('master_token') || '';
}

/**
 * Standard JSON headers for master-authenticated requests.
 * Token is passed via X-Master-Token header — never in the URL to prevent
 * it appearing in GCP logs, browser history, or Referrer headers.
 */
export function getMasterHeaders(): Record<string, string> {
  const token = getMasterToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['X-Master-Token'] = token;
  return headers;
}

/**
 * Build a fully-qualified API URL for a master-admin request.
 * Token is NOT appended to the URL — use getMasterHeaders() for auth.
 */
export function masterUrl(path: string): string {
  return `${API_BASE}${path}`;
}
