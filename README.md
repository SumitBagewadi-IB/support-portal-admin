# Indiabulls Securities — Admin Portal (private)

Private staff back-office for the Indiabulls Securities support portal. Contains
**only** the Manager (`/admin`) and Master Admin (`/masteradmin`) surfaces, split
out of the public repo (`ib-product-support-portal`) so that:

- admin code is **never served from the public URL** (closes VAPT IDX-002),
- the app is **static** (`output: export`, no SSR) and hostable on GCP as plain files,
- it is **always private / `noindex`** (robots + `X-Robots-Tag`, no public links),
- it authenticates via the **shared backend** (`ib-faq-handler`) with SSO + password.

## Architecture
- **Frontend:** this repo → its own Firebase **Hosting site** (`ib-admin-uat`, a
  separate origin, `noindex`) inside the shared UAT project
  `ib-product-application-uat`. It can be moved to a dedicated GCP project later
  by changing `GCP_PROJECT` in the workflow and swapping `GCP_SA_KEY`.
- **Backend + data:** unchanged — the shared Cloud Function `ib-faq-handler` and
  Firestore stay in `ib-product-application-uat`. This app calls it via
  `NEXT_PUBLIC_API_BASE` = `https://uat-support.indiabullssecurities.com/ib-faq-handler`
  (the LB path; the bare `cloudfunctions.net` URL is not reachable from outside).
  That function's `ALLOWED_ORIGINS` must include this app's origin (done in the
  public repo's `gcp/.env.yaml`).

## Required configuration (set before deploy)
| Where | Key | Value |
|---|---|---|
| GitHub secret | `GCP_SA_KEY` | the **same** service-account key the public repo (`ib-product-support-portal`) uses — copy it into this repo's Actions secrets |
| GitHub secret | `GOOGLE_OAUTH_CLIENT_ID` | Google Workspace OAuth Web Client ID (optional — enables SSO; password login works without it) |
| `firebase.json` | `hosting.site` | admin Hosting site (default: `ib-admin-uat`; CI creates it if missing) |

## Local dev
```bash
npm ci
npm run dev        # http://localhost:3000/admin  and  /masteradmin
```

## Build (static export)
```bash
npm run build      # emits ./out — deploy to Firebase Hosting / GCS
```
