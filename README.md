# Indiabulls Securities — Admin Portal (private)

Private staff back-office for the Indiabulls Securities support portal. Contains
**only** the Manager (`/admin`) and Master Admin (`/masteradmin`) surfaces, split
out of the public repo (`ib-product-support-portal`) so that:

- admin code is **never served from the public URL** (closes VAPT IDX-002),
- the app is **static** (`output: export`, no SSR) and hostable on GCP as plain files,
- it is **always private / `noindex`** (robots + `X-Robots-Tag`, no public links),
- it authenticates via the **shared backend** (`ib-faq-handler`) with SSO + password.

## Architecture
- **Frontend:** this repo → deployed to its **own GCP/Firebase project** (`ib-admin-uat`).
- **Backend + data:** unchanged — the shared Cloud Function `ib-faq-handler` and
  Firestore stay in `ib-product-application-uat`. This app calls it via
  `NEXT_PUBLIC_API_BASE`. (That function must allow this app's origin in CORS.)

## Required configuration (set before deploy)
| Where | Key | Value |
|---|---|---|
| `firebase.json` | `hosting.site` | your admin Hosting site (default: `ib-admin-uat`) |
| CI / build env | `NEXT_PUBLIC_API_BASE` | `https://asia-south1-ib-product-application-uat.cloudfunctions.net/ib-faq-handler` |
| CI / build env | `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` | the Google Workspace OAuth Web Client ID (enables SSO; app works without it via password) |
| GitHub secret | `GCP_SA_KEY` | service-account key for the **admin** project |
| GitHub secret | `GOOGLE_OAUTH_CLIENT_ID` | same client ID (consumed by the workflow) |

## Local dev
```bash
npm ci
npm run dev        # http://localhost:3000/admin  and  /masteradmin
```

## Build (static export)
```bash
npm run build      # emits ./out — deploy to Firebase Hosting / GCS
```
