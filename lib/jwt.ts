// Client-side JWT structural validation.
//
// This does NOT verify the token's signature — that is enforced server-side on
// every authenticated API call. Its job is to defeat the "client-side auth
// bypass via response manipulation" finding (VAPT IDX-002): an attacker who
// forces the login response to `200 OK` with an empty/garbage body must NOT be
// able to make the UI render the admin shell. We only treat a login (or a
// restored session) as valid when a structurally valid, unexpired JWT is
// actually present in memory.

export interface JwtPayload {
  exp?: number;
  managerId?: string;
  role?: string;
  displayName?: string;
  [k: string]: unknown;
}

// Returns the decoded payload when `token` is a well-formed, unexpired JWT,
// otherwise null. A token with no `exp`, a past `exp`, a wrong part-count, or an
// undecodable payload is rejected.
export function parseValidJwt(token: unknown): JwtPayload | null {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    ) as JwtPayload;
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
