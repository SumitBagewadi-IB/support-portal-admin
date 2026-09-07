# UAT admin portal — QA & VAPT findings

Black-box assessment of the live UAT admin portals, 2026-09-08.

Targets:

- `https://uat-support-admin.indiabullssecurities.com/admin/`
- `https://uat-support-masteradmin.indiabullssecurities.com/masteradmin/`
- API `https://uat-support-admin.indiabullssecurities.com/ib-faq-handler-admin`

Read-only probing only. Rate-limit testing was stopped at 8 requests rather than
exhausting the 20/min budget, so the limiter itself is unverified in production.

---

## Summary

| # | Finding | Severity | State |
| --- | --- | --- | --- |
| 1 | SSO non-functional — stale frontend build deployed | **High** (availability) | Fix committed, needs deploy |
| 2 | No security headers on the frontend at all | **High** | Needs LB/bucket change |
| 3 | Admin HTML publicly cacheable for 1 hour | **Medium** | Fixed in `cloud-build-uat.yaml` |
| 4 | GCS bucket anonymously listable | **Medium** | Needs IAM change |
| 5 | Both hostnames serve both panels | **Low** | Design decision |
| 6 | No HSTS; plain HTTP returns empty reply | **Low** | Needs LB change |
| — | API authentication and CORS | **Pass** | — |
| — | TLS configuration | **Pass** | — |
| — | Secret/source exposure | **Pass** | — |

---

## 1. SSO non-functional — stale build (High)

The deployed bundle predates the SSO fixes. Two independent causes, both in the
frontend:

```
client id in served JS   ABSENT   -> button returns null, never renders
auth endpoint called     /auth/sso -> backend 404s (it serves /auth/google)
```

Confirmed on both hostnames. The `/auth/sso` string proves the live build comes
from the deleted `GoogleSSOButton.tsx`, i.e. from before the merge.

The backend is already correct:

```
POST /ib-faq-handler-admin/auth/google -> 400 {"error":"Missing Google credential."}
POST /ib-faq-handler-admin/auth/sso    -> 404 {"error":"Not found"}
```

`400` rather than `503` matters: the function returns 503 when `GOOGLE_CLIENT_ID`
is unset, so the audience is configured and the endpoint is live.

**Remediation** — deploy the current `main`. No code change outstanding.

```bash
gcloud builds submit --config=gcp-deploy/cloud-build-uat.yaml .
```

## 2. No security headers on the frontend (High)

Every response is served straight from the bucket (`server: UploadServer`,
`x-goog-*` metadata present). None of the headers defined in `firebase.json`
apply, because that file only governs a Firebase Hosting deploy and this path
publishes to GCS behind a load balancer.

Absent: `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.

For an admin console the missing `X-Frame-Options` / `frame-ancestors` is the
sharpest edge — the panel can be framed, which is the precondition for
clickjacking against authenticated sessions.

**Remediation** — set them on the backend bucket serving these hosts:

```bash
BACKEND_BUCKET=$(gcloud compute backend-buckets list \
  --filter="bucketName=ib-product-application-admin-uat" --format='value(name)')

gcloud compute backend-buckets update "$BACKEND_BUCKET" \
  --custom-response-header="X-Frame-Options: DENY" \
  --custom-response-header="X-Content-Type-Options: nosniff" \
  --custom-response-header="Referrer-Policy: strict-origin-when-cross-origin" \
  --custom-response-header="Permissions-Policy: camera=(), microphone=(), geolocation=()" \
  --custom-response-header="Strict-Transport-Security: max-age=31536000; includeSubDomains" \
  --custom-response-header="Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://kit.fontawesome.com https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com https://accounts.google.com/gsi/style; font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com https://ka-f.fontawesome.com; img-src 'self' data: blob: https://*.googleusercontent.com; connect-src 'self' https://uat-support-admin.indiabullssecurities.com https://accounts.google.com; frame-src 'self' https://accounts.google.com; frame-ancestors 'none';"
```

The CSP must keep `accounts.google.com/gsi/client` in `script-src`,
`accounts.google.com` in `frame-src`, and the admin API origin in `connect-src`
— the master admin host calls the admin host's API cross-origin, and omitting it
blocks sign-in from `/masteradmin/` only. Tighten `'unsafe-inline'` separately;
removing it needs the inline styles in the pages addressed first.

## 3. Admin HTML publicly cacheable (Medium)

Live responses carried `cache-control: public, max-age=3600` on admin HTML —
GCS's default, because `rsync` sets no metadata. `firebase.json` specifies
`no-cache, no-store, must-revalidate` for HTML, but again that path is unused.

Authenticated admin markup sitting in shared caches for an hour is not
acceptable for this console.

**Fixed in this repo** — `cloud-build-uat.yaml` now runs `gsutil setmeta` after
rsync, marking HTML no-store and hashed `_next/static` assets immutable. Takes
effect on the next deploy. To correct the objects already live without waiting:

```bash
gsutil -m setmeta -h "Cache-Control:no-cache, no-store, must-revalidate" \
  "gs://ib-product-application-admin-uat/**/*.html"
```

## 4. Bucket anonymously listable (Medium)

```
GET https://storage.googleapis.com/ib-product-application-admin-uat -> 200
59 objects enumerated anonymously
```

Contents are benign — only expected static assets, **no source maps and no
secrets** — so impact is limited to disclosing the asset inventory. The
misconfiguration is that `allUsers` holds a bucket-level read role; serving a
public site only needs object read.

**Remediation**

```bash
gcloud storage buckets get-iam-policy gs://ib-product-application-admin-uat \
  --format=json | grep -A3 allUsers

# drop bucket-level listing, keep object reads
gcloud storage buckets remove-iam-policy-binding gs://ib-product-application-admin-uat \
  --member=allUsers --role=roles/storage.legacyBucketReader
gcloud storage buckets add-iam-policy-binding gs://ib-product-application-admin-uat \
  --member=allUsers --role=roles/storage.objectViewer
```

Re-test: the list URL should return 403 while `/admin/` still loads.

## 5. Both hostnames serve both panels (Low)

```
uat-support-admin        /admin/        200
uat-support-admin        /masteradmin/  200
uat-support-masteradmin  /admin/        200
uat-support-masteradmin  /masteradmin/  200
```

Both hosts map to one bucket holding both panels, and `app/page.tsx` only routes
the site root. The master admin panel is therefore reachable at
`uat-support-admin.indiabullssecurities.com/masteradmin/`.

This is not an authorisation bypass — the function checks the master role on
every privileged call regardless of origin — but it means the two domains are
presentational rather than a real boundary. If the intent is genuine separation,
serve each panel from its own bucket, or have the load balancer reject the
foreign path per host.

## 6. No HSTS; plain HTTP returns an empty reply (Low)

Port 80 closes the connection instead of redirecting (`curl: (52) Empty reply
from server`), and no `Strict-Transport-Security` header is sent. Cleartext is
never served, which is the important part, but a user typing `http://` gets a
broken connection rather than an upgrade, and without HSTS the first request is
unprotected. The HSTS header in finding 2 addresses the second half; a 301 on
port 80 addresses the first.

---

## Passing checks

**API authentication** — every privileged endpoint refuses unauthenticated
callers:

```
GET /managers   403    GET /audit-log  401    GET /tickets  401
GET /feedback   401    GET /analytics  404
```

**CORS** — correctly restrictive, not reflective:

```
Origin: https://uat-support-masteradmin.indiabullssecurities.com
  -> access-control-allow-origin echoed
Origin: https://evil.example.com
  -> no access-control-allow-origin header
```

**TLS** — valid chain, HTTP/2, TLS 1.2 accepted, **TLS 1.0 refused**.

**Secret and source exposure** — `/.env`, `/gcp/.env-gcp-uat.yaml`, `/.git/config`,
`/package.json`, `/firebase.json`, `/gcp/index.mjs` all return 404. No source
maps in the bucket. The OAuth client secret is not used by this codebase and
appears nowhere in the tree or its history.

---

## Order of work

1. Deploy current `main` — resolves finding 1 and applies finding 3's fix.
2. Set the backend-bucket response headers — finding 2.
3. Correct the bucket IAM — finding 4.
4. Re-run the checks below.
5. Decide on findings 5 and 6.

## Re-test commands

```bash
H=https://uat-support-admin.indiabullssecurities.com

# 1. client id present in the shipped bundle
curl -s $H/admin/ | grep -oE '/_next/static/[^"]+\.js' | sort -u | while read -r p; do
  curl -s "$H$p"; done | grep -o '[0-9]\{6,\}-[a-z0-9]*\.apps\.googleusercontent\.com' | sort -u

# 2. no /auth/sso left in the bundle
curl -s $H/admin/ | grep -oE '/_next/static/[^"]+\.js' | sort -u | while read -r p; do
  curl -s "$H$p"; done | grep -c '/auth/sso'      # expect 0

# 3. security headers present
curl -sI $H/admin/ | grep -iE 'content-security-policy|x-frame-options|strict-transport|x-content-type'

# 4. admin HTML not publicly cached
curl -sI $H/admin/ | grep -i cache-control        # expect no-store

# 5. bucket no longer listable
curl -s -o /dev/null -w '%{http_code}\n' \
  https://storage.googleapis.com/ib-product-application-admin-uat   # expect 403
```
