# Google Workspace SSO — setup for the admin portals

Covers `uat-support-admin.indiabullssecurities.com/admin/` and
`uat-support-masteradmin.indiabullssecurities.com/masteradmin/`.

Run everything below in **Cloud Shell** on the Google Cloud Console.

## What SSO needs (and what it doesn't)

There is **no npm package to install**. The sign-in flow is:

- the browser loads Google Identity Services from `https://accounts.google.com/gsi/client`
  (a `<script>` tag added at runtime by `app/admin/page.tsx`), and
- the Cloud Function verifies the returned ID token with a plain `fetch` to
  `https://oauth2.googleapis.com/tokeninfo`.

Neither side needs a library. What SSO *does* need is an **OAuth 2.0 Web client**
whose id is baked into the frontend bundle at build time and matched by the
function at runtime.

The function enforces `claims.aud === GOOGLE_CLIENT_ID`, so these two must hold
the identical value:

| Where | Key |
| --- | --- |
| `gcp-deploy/cloud-build-uat.yaml` | `_GOOGLE_CLIENT_ID` (build-time, becomes `NEXT_PUBLIC_GOOGLE_CLIENT_ID`) |
| `gcp/.env-gcp-uat.yaml` | `GOOGLE_CLIENT_ID` (function runtime) |

A mismatch fails every sign-in with `wrong_audience`.

---

## Step 1 — Create the OAuth client (Console only)

**`gcloud` cannot do this.** There is no command that creates a general-purpose
OAuth 2.0 Web client or sets its JavaScript origins. `gcloud alpha iap
oauth-clients` creates IAP-brand clients only, which is a different thing and
does not accept the origins this flow requires. This one step is manual.

```
Console -> APIs & Services -> Credentials
  -> Create credentials -> OAuth client ID
  -> Application type: Web application
  -> Name: IB Support Admin Portal (UAT)
```

**Authorized JavaScript origins** — both are required. The admin and master
admin sites are separate origins and Google refuses to render the button on an
origin that is not listed:

```
https://uat-support-admin.indiabullssecurities.com
https://uat-support-masteradmin.indiabullssecurities.com
```

**Authorized redirect URIs** — leave empty. This flow returns an ID token
straight to the page; there is no redirect leg.

The client secret Google generates for a Web client is **not used** by this
codebase and does not need to go anywhere.

On the OAuth consent screen, set User type to **Internal** so only
`indiabulls.com` accounts can complete sign-in.

### Then wire the id into the repo

Copy the client id and set it in **both** places:

```bash
CLIENT_ID='<paste-the-new-client-id>.apps.googleusercontent.com'

# build-time (frontend bundle)
sed -i "s|_GOOGLE_CLIENT_ID: '.*'|_GOOGLE_CLIENT_ID: '${CLIENT_ID}'|" \
  gcp-deploy/cloud-build-uat.yaml

# runtime (function audience check)
sed -i "s|^GOOGLE_CLIENT_ID: .*|GOOGLE_CLIENT_ID: \"${CLIENT_ID}\"|" \
  gcp/.env-gcp-uat.yaml

grep -n "GOOGLE_CLIENT_ID" gcp-deploy/cloud-build-uat.yaml gcp/.env-gcp-uat.yaml
```

> The value currently committed (`620876318042-…`) belongs to project
> `ibproduct-vibe-coding`, not `ib-product-application-uat`. It works, but it
> puts the portal's auth trust anchor in a different project. Creating the
> client in `ib-product-application-uat` and replacing the value is the
> cleaner arrangement.

---

## Step 2 — Project context

```bash
export PROJECT_ID=ib-product-application-uat
export REGION=asia-south1
export FUNCTION_NAME=ib-faq-handler-admin
export FRONTEND_BUCKET=ib-product-application-admin-uat

gcloud config set project "$PROJECT_ID"
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
echo "project=$PROJECT_ID number=$PROJECT_NUMBER"
```

## Step 3 — Enable the APIs

```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com
```

## Step 4 — Create the secrets the function mounts

`cloud-build-uat.yaml` deploys with
`--set-secrets=JWT_SECRET=…,ADMIN_SECRET=…,MASTER_ADMIN_SECRET=…`, so all three
must exist or the deploy fails.

```bash
for S in JWT_SECRET ADMIN_SECRET MASTER_ADMIN_SECRET; do
  gcloud secrets describe "$S" >/dev/null 2>&1 \
    || gcloud secrets create "$S" --replication-policy=automatic
done
```

Add a value to each. `JWT_SECRET` signs the portal's own session tokens, so it
should be random. `ADMIN_SECRET` and `MASTER_ADMIN_SECRET` are the password-login
credentials — choose them deliberately rather than generating them, if people
still use that path.

```bash
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add JWT_SECRET --data-file=-

printf '%s' 'CHOOSE-A-STRONG-VALUE' | gcloud secrets versions add ADMIN_SECRET --data-file=-
printf '%s' 'CHOOSE-A-STRONG-VALUE' | gcloud secrets versions add MASTER_ADMIN_SECRET --data-file=-
```

Using `printf` rather than `echo` avoids a trailing newline becoming part of the
secret. Nothing is echoed to the terminal or written to shell history as a file.

## Step 5 — Let the function read them

```bash
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for S in JWT_SECRET ADMIN_SECRET MASTER_ADMIN_SECRET; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor
done
```

If the function runs as a dedicated service account rather than the default
compute one, substitute it in `RUNTIME_SA`.

## Step 6 — Buckets

```bash
# frontend bundle
gcloud storage buckets describe "gs://${FRONTEND_BUCKET}" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://${FRONTEND_BUCKET}" --location="$REGION"

# Cloud Build logs (logsBucket in cloud-build-uat.yaml)
gcloud storage buckets describe "gs://${PROJECT_ID}-cloud-build-logs" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://${PROJECT_ID}-cloud-build-logs" --location="$REGION"
```

## Step 7 — Firestore

The function reads `FIRESTORE_DATABASE_ID: support-portal-faqs`, a **named**
database, not `(default)`.

```bash
gcloud firestore databases describe --database=support-portal-faqs \
  || gcloud firestore databases create \
       --database=support-portal-faqs \
       --location="$REGION" \
       --type=firestore-native
```

## Step 8 — Deploy

```bash
git clone https://github.com/SumitBagewadi-IB/support-portal-admin.git
cd support-portal-admin

gcloud builds submit --config=gcp-deploy/cloud-build-uat.yaml .
```

---

## Verify

```bash
# function is up and serving the endpoint the frontend calls
gcloud functions describe "$FUNCTION_NAME" --gen2 --region="$REGION" \
  --format='value(serviceConfig.uri,state)'

# the audience the function will enforce
gcloud functions describe "$FUNCTION_NAME" --gen2 --region="$REGION" \
  --format='value(serviceConfig.environmentVariables.GOOGLE_CLIENT_ID)'

# the id actually baked into the shipped bundle - must be identical.
# NEXT_PUBLIC_* values are inlined into the JS chunks, so search those.
mkdir -p /tmp/bundle && gcloud storage rsync -r \
  "gs://${FRONTEND_BUCKET}/_next/static" /tmp/bundle >/dev/null
grep -rho '[0-9]\{6,\}-[a-z0-9]*\.apps\.googleusercontent\.com' /tmp/bundle | sort -u
```

Those last two must match. Then open
`https://uat-support-admin.indiabullssecurities.com/admin/` and check that the
Google button renders. If it does not, the client id did not reach the bundle.
If it renders but sign-in is rejected, read the reason:

```bash
gcloud functions logs read "$FUNCTION_NAME" --gen2 --region="$REGION" --limit=50 \
  | grep -i 'LOGIN_FAIL\|wrong_audience\|wrong_domain\|token_invalid'
```

| Reason | Meaning |
| --- | --- |
| `wrong_audience` | build-time and runtime client ids differ |
| `wrong_domain` | account is not `@indiabulls.com`, or `hd` claim missing |
| `email_unverified` | Google account has no verified email |
| `token_invalid` | token rejected by `tokeninfo` |
| HTTP 503 | `GOOGLE_CLIENT_ID` is unset on the function |

## Two things this repo cannot control

**Authorized JavaScript origins** live on the OAuth client (Step 1). Both admin
hostnames must be listed or the button will not render, no matter what the code
does.

**CSP headers on the Cloud Build path.** `firebase.json` sets
`connect-src` to allow the cross-origin call the master admin host makes to the
admin host's API — but those headers only apply to a **Firebase Hosting**
deploy. `cloud-build-uat.yaml` publishes to a GCS bucket fronted by a load
balancer, which supplies its own headers. If SSO works on the Firebase URL but
fails from `uat-support-masteradmin…` with a CSP violation in the browser
console, mirror this into the load balancer's response-header policy:

```
connect-src 'self' https://uat-support-admin.indiabullssecurities.com https://accounts.google.com;
script-src  'self' 'unsafe-inline' https://accounts.google.com/gsi/client;
frame-src   'self' https://accounts.google.com;
```
