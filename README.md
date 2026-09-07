# IB Support Portal — Admin

The two internal panels for the Indiabulls Securities support portal: the
**manager portal** (`/admin`) and **master admin** (`/masteradmin`).

They used to be routes on the public support site. They are here instead
because on the public site they resolved for anyone who knew the path —
`support.indiabullssecurities.com/admin` served the panel to the open internet,
with only an `X-Robots-Tag: noindex` header in front of it. That is search
engine hygiene, not access control, and it is the condition **VAPT IDX-002**
was raised against.

The public site removed them in `SupportPortal@54c1f12` ("Stop serving the
admin panels from the public site"). This repo is where they now live.

## Layout

```
app/
  layout.tsx          root shell: globals.css, Font Awesome, theme bootstrap
  page.tsx            local index linking to both panels; not the deployed entry
  admin/              manager portal      — FAQ articles and customer tickets
  masteradmin/        master admin        — manager oversight and audit trail
lib/
  api.ts              API base URL, manager and master auth headers
  constants.ts        static category fallbacks
  jwt.ts              client-side JWT parsing and expiry check
public/               favicon and the two logo variants the panels use
```

`app/admin/page.tsx`, `app/masteradmin/page.tsx`, their layouts, `app/globals.css`
and all three `lib/` modules are byte-for-byte the versions from
`SupportPortal@54c1f12^`, the last commit before the panels were removed from
the public site. Nothing in the panel logic was rewritten in the move.

`app/layout.tsx` and `app/page.tsx` are new, and are the only files written for
this repo. The public site's root layout wrapped every page in `PublicShell`,
which draws the marketing header, footer and nav — both panels explicitly opted
out of it there, so it is not carried over.

## Hosting

One build serves both panels. Each environment has a Firebase Hosting site, and
each site answers on two custom domains, one per panel:

| Environment | Firebase site | Domain | Serves |
|---|---|---|---|
| Prod | `ib-admin` | `support-admin.indiabullssecurities.com` | `/admin/` |
| Prod | `ib-admin` | `support-masteradmin.indiabullssecurities.com` | `/masteradmin/` |
| UAT | `ib-admin-uat` | `uat-support-admin.indiabullssecurities.com` | `/admin/` |
| UAT | `ib-admin-uat` | `uat-support-masteradmin.indiabullssecurities.com` | `/masteradmin/` |

All four are already allowlisted for CORS by the API — see `ALLOWED_ORIGINS` in
`gcp/.env-gcp-prod.yaml` and `gcp/.env-gcp-uat.yaml` in the main repo.

`firebase.json` sets `noindex, nofollow, noarchive` on **every** path here,
rather than on the two admin paths as the public site did. There is no public
page in this repo to exclude it from.

> **Confirm before the first deploy:** `.firebaserc` points both hosting targets
> at project `ibproduct-vibe-coding`, which is the project the public site
> deploys to and the only one named in the source repo. The `ib-admin` and
> `ib-admin-uat` site IDs were read from the API's CORS allowlist, not from a
> hosting config — no `firebase.json` for the admin domains existed to copy. If
> those sites actually live under `ib-product-application-prod` /
> `ib-product-application-uat` (the GCP projects the Cloud Build configs use),
> update `.firebaserc` accordingly. A wrong project id fails loudly at deploy
> with a permission or not-found error; it will not deploy to the wrong place.

## Running it

```bash
npm install
cp .env.example .env.local     # then fill in the two values
npm run dev                    # http://localhost:3000
```

Build a static export:

```bash
NEXT_PUBLIC_API_BASE=... npm run build   # writes out/
```

`next.config.ts` uses `output: 'export'` for production builds only, so dev
keeps working normally.

### Environment

| Variable | Used for |
|---|---|
| `NEXT_PUBLIC_API_BASE` | API origin; read through `lib/api.ts` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google Identity Services sign-in |

Both are `NEXT_PUBLIC_*`, so they are baked into the client bundle at build
time and are not secrets. The master admin password is not among them: it is
validated server-side against `MASTER_ADMIN_SECRET` via `POST /auth/masterlogin`,
and the raw password never reaches the browser.

## Deploying

```bash
NEXT_PUBLIC_API_BASE=... npm run build
firebase deploy --only hosting:admin-uat     # or hosting:admin-prod
```

## Not in this repo

- **The API.** Both panels talk to the `gcp/` cloud function in the main repo,
  which serves the public site as well. Splitting one function into two was not
  part of moving the front end, so it stays where it is; this repo only needs
  its URL.
- **CI.** The public site's `deploy.yml` and `staging.yml` build and deploy that
  site. No equivalent workflow is added here, because the hosting project
  binding above is unconfirmed and a pipeline pointed at the wrong project is
  worse than no pipeline.

## Known issues, inherited

`npm run lint` reports 23 problems (14 errors, 9 warnings), all in
`app/admin/page.tsx` and `app/masteradmin/page.tsx`:

| Count | Rule |
|---|---|
| 8 | `react-hooks/set-state-in-effect` |
| 7 | `typescript-eslint/no-unused-vars` |
| 4 | `react-hooks/preserve-manual-memoization` |
| 2 | `react-hooks/purity` |
| 2 | `react-hooks/exhaustive-deps` |

These predate the move — the panel files are unchanged from the source commit —
and none come from the two files written for this repo. `npm run build` passes,
TypeScript included. They are left alone deliberately: several are hook
ordering and dependency rules whose fixes change render behaviour, and that is
not a change to make blind while relocating a repo.
