/**
 * ib-faq-api  —  Node.js 22.x  GCP Cloud Functions Gen 2 (ES Module)
 *
 * Routes:
 *   GET    /faq                    public
 *   POST   /faq                    manager JWT | master secret
 *   PUT    /faq/{id}               manager JWT | master secret
 *   DELETE /faq/{id}               manager JWT | master secret
 *
 *   GET    /tickets                manager JWT | master secret
 *   POST   /tickets                public (captures IP + UA + sessionId)
 *   PUT    /tickets/{id}           manager JWT | master secret
 *
 *   GET    /audit-log              manager JWT (own entries) | master secret (all)
 *
 *   POST   /auth/login             public  → returns manager JWT
 *   POST   /auth/masterlogin       public  → validates master password server-side, returns master session token
 *   POST   /auth/logout            manager JWT | master session token → writes audit entry
 *
 *   POST   /analytics              public  → writes to analytics collection
 *   GET    /analytics/summary      master session token → aggregated stats
 *
 *   GET    /managers               master session token
 *   POST   /managers               master session token
 *   PUT    /managers/{id}          master session token
 *   DELETE /managers/{id}          master session token
 *
 *   GET    /categories             public
 *   POST   /categories             manager JWT | master secret
 *   PUT    /categories/{id}        manager JWT | master secret
 *   DELETE /categories/{id}        manager JWT | master secret
 *
 * Env vars:
 *   ADMIN_SECRET          shared secret checked against X-Admin-Secret for manager-level access
 *   MASTER_ADMIN_SECRET   master password — NEVER sent to the browser; validated server-side only
 *   JWT_SECRET            HMAC-SHA256 signing key for manager tokens AND master session tokens
 *   GOOGLE_CLOUD_PROJECT  GCP project ID (used by Firestore client)
 *   ALLOWED_ORIGINS       comma-separated list of allowed CORS origins
 *
 * Firestore collection names (mirror DynamoDB table names):
 *   articles      (was ibulls-faq-articles)
 *   tickets       (was ib-tickets)
 *   audit-log     (was ib-audit-log)
 *   analytics     (was ib-analytics)
 *   managers      (was ib-managers)
 *   categories    (was ib-faq-categories)
 */

import functions from '@google-cloud/functions-framework';
import { Firestore } from '@google-cloud/firestore';
import { createHmac, randomUUID, randomInt } from 'crypto';
import { scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import nodemailer from 'nodemailer';

const scryptAsync = promisify(scrypt);

// ─── Config ────────────────────────────────────────────────────────────────

const FAQ_COL       = process.env.FAQ_COLLECTION       || 'articles';
const TICKETS_COL   = process.env.TICKETS_COLLECTION   || 'tickets';
const AUDIT_COL     = process.env.AUDIT_COLLECTION     || 'audit-log';
const ANALYTICS_COL = process.env.ANALYTICS_COLLECTION || 'analytics';
const MANAGERS_COL  = process.env.MANAGERS_COLLECTION  || 'managers';
const CATEGORIES_COL= process.env.CATEGORIES_COLLECTION|| 'categories';
const FEEDBACK_COL  = process.env.FEEDBACK_COLLECTION   || 'feedback';
const OTP_COL       = process.env.OTP_COLLECTION        || 'login-otps';

// ─── Email OTP login ─────────────────────────────────────────────────────────
// Admin / master-admin sign in with their official email + a one-time code.
// Only this domain may authenticate; authorisation still requires the email to
// be provisioned in the managers collection (having a company email ≠ access).
const OTP_ALLOWED_DOMAIN = (process.env.OTP_ALLOWED_DOMAIN || 'indiabulls.com').toLowerCase();
// Google Workspace SSO ("Sign in with Google"). The Client ID is non-secret
// (it also ships in the browser); we verify Google ID tokens against it.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Hard cap on the server-side Google tokeninfo call so a slow/hung Google
// cannot stall a login (and pin function instances) up to the 60s timeout.
const GOOGLE_TOKENINFO_TIMEOUT_MS = 5000;
// When on, any verified @<domain> Google account that has NO existing record
// is auto-provisioned as an ACTIVE manager on first login (govern-after model);
// a master admin can then deactivate/delete them. Master role is NEVER
// auto-granted, and deactivated accounts stay blocked.
const AUTO_PROVISION_MANAGERS = process.env.AUTO_PROVISION_MANAGERS === 'true';
const OTP_TTL_SECS       = 600;  // code valid for 10 minutes
const OTP_MAX_ATTEMPTS   = 5;    // wrong-code attempts before the code is burned
const OTP_LENGTH         = 6;
// Corporate SMTP relay (provisioned as GCP secrets — never in the browser).
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const OTP_FROM_ADDR = process.env.OTP_FROM_ADDR || 'no-reply@indiabulls.com';
// Comma-separated emails seeded as master admins so the first login isn't
// locked out before anyone is provisioned via the Managers screen.
const OTP_SEED_MASTERS = (process.env.OTP_SEED_MASTERS || 'sumit.bagewadi@indiabulls.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Backend-enforced profanity / explicit-language filter for public feedback.
// Frontend checks can be bypassed (direct API calls), so the function is the authority.
const PROFANITY = [
  'fuck','fucking','fucker','motherfucker','shit','bullshit','bitch','bastard',
  'asshole','dick','dickhead','pussy','cunt','slut','whore','wanker','prick',
  'cock','fag','faggot','nigger','retard','rape','rapist',
  // common English respellings / vowel-drops / acronyms
  'fck','fuk','fuq','phuck','phuk','fcuk','shyt','shite','azzhole','biatch',
  'arse','arsehole','twat','wank','wtf','stfu','gtfo',
  // common Hindi / Hinglish abuses (+ acronyms / respellings)
  'chutiya','chutia','chutiye','chutiyapa','bhenchod','behenchod','madarchod','maderchod',
  'gandu','gaand','randi','lund','bhosdike','bhosdi','bhosda','harami','kamina',
  'kamine','kutta','kutte','chinal','lavde','lawde','jhatu','bsdk','bkl','mkc','chodu',
];
// Pass 0 — normalize unicode tricks to plain ASCII before any matching:
// strip diacritics & zero-width chars (NFKD also folds fullwidth ＦＵＣＫ -> FUCK),
// then map common Cyrillic/Greek/symbol homoglyphs so "ѕhit"/"ƒuck" can't slip past.
const CONFUSABLES = {
  'а':'a','е':'e','ё':'e','о':'o','р':'p','с':'c','ѕ':'s','х':'x','у':'y','к':'k','і':'i','ј':'j','м':'m','н':'h','т':'t','в':'b','ԁ':'d',
  'α':'a','ε':'e','ο':'o','υ':'u','ι':'i','κ':'k','ρ':'p','τ':'t','ν':'v',
  'ƒ':'f','ı':'i','ⅼ':'l','ⅰ':'i','ℓ':'l',
};
function normalizeUnicode(text) {
  const t = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')                       // diacritic marks
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '');    // zero-width / soft hyphen
  return t.split('').map((c) => CONFUSABLES[c] || c).join('');
}
// Pass A — fold common leetspeak to letters, then plain word-boundary match.
// Catches: "fuck", "sh1t"->shit, "@ss"->ass, "fuuuck" (elongation collapsed).
function leetFold(text) {
  return String(text).toLowerCase()
    .replace(/[@4]/g, 'a').replace(/[$5]/g, 's').replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/7/g, 't')
    .replace(/(.)\1+/g, '$1');
}
// Pass B — masking-tolerant regex per word (words are plain a-z, no escaping needed):
//  · up to 2 non-letters allowed between letters  -> "f u c k", "f.u.c.k", "f*u*c*k"
//  · at most ONE interior letter may be a single non-letter mask -> "f*ck", "f@ck", "sh!t"
//  · first & last letters stay literal; lookarounds keep word boundaries so
//    "class", "pass", "assist", "cockpit", "grape" never match.
function maskRegex(word) {
  const L = word.split('');
  const gap = '[^a-z]{0,2}';
  const variants = [L.join(gap)];
  for (let i = 1; i < L.length - 1; i++) {
    variants.push(L.map((c, j) => (j === i ? '[^a-z]' : c)).join(gap));
  }
  return new RegExp(`(?<![a-z])(?:${variants.join('|')})(?:es|s)?(?![a-z])`);
}
// Collapse elongation in the denylist too, so doubled-letter words ("bullshit",
// "asshole") still match after the text's own elongation has been collapsed.
const COLLAPSED = PROFANITY.map((w) => w.replace(/(.)\1+/g, '$1'));
const WORD_RES = COLLAPSED.map((w) => new RegExp(`\\b${w}(?:es|s)?\\b`));
const MASK_RES = COLLAPSED.map(maskRegex);

function containsProfanity(text) {
  const norm = normalizeUnicode(text);
  const folded = leetFold(norm);
  if (WORD_RES.some((re) => re.test(folded))) return true;
  // Keep symbols/digits as non-letter masks here; only collapse elongation.
  const masked = norm.toLowerCase().replace(/(.)\1+/g, '$1');
  return MASK_RES.some((re) => re.test(masked));
}

// Data minimization: feedback is anonymous, so sensitive identifiers should never be
// stored. Redact (not reject) so legit feedback still lands, minus the PII. Order matters:
// phone before the longer-digit rules; (?!\d) stops phone matching inside 12-19 digit runs.
function redactPII(text) {
  return String(text)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email removed]')
    .replace(/\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g, '[PAN removed]')               // PAN
    .replace(/(?<!\d)(?:\+?91[ -]?|0)?[6-9](?:[ -]?\d){9}(?!\d)/g, '[phone removed]')
    .replace(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, '[card/account removed]')  // 13-19 digits
    .replace(/(?<!\d)\d(?:[ -]?\d){11}(?!\d)/g, '[ID removed]');              // 12-digit Aadhaar
}

// Sanitize short plain-text fields (article title, category name) that must never
// contain markup. Strips HTML tags + control chars and collapses whitespace.
// (VAPT IDX-001: improper input validation — HTML-like content accepted in title.)
// NOT applied to article CONTENT, which legitimately contains chars like "< 12 months".
function sanitizeText(s, maxLen = 300) {
  return String(s == null ? "" : s)
    .replace(/<[^>]*>/g, "")                       // remove HTML tags
    .replace(/[\u0000-\u001F\u007F]/g, " ")     // strip control chars
    .replace(/\s+/g, " ")                          // collapse whitespace
    .trim()
    .slice(0, maxLen);
}

const ADMIN_SECRET        = process.env.ADMIN_SECRET        || '';
const MASTER_ADMIN_SECRET = process.env.MASTER_ADMIN_SECRET || '';
const JWT_SECRET          = process.env.JWT_SECRET          || (() => { throw new Error('JWT_SECRET env var is required'); })();

// The shared X-Admin-Secret header grants admin-level access with no individual
// login, so any action taken through it is audited only as a generic "admin"
// with no personal accountability. It is RETIRED by default. Set
// ALLOW_LEGACY_ADMIN_SECRET=true only as a temporary rollover valve if some
// out-of-band integration still depends on it — the admin portal itself always
// authenticates with per-manager JWTs and never uses this path.
const ALLOW_LEGACY_ADMIN_SECRET = process.env.ALLOW_LEGACY_ADMIN_SECRET === 'true';

// Fail-fast: warn loudly if privileged secrets are missing
if (!ADMIN_SECRET)        console.error('[STARTUP] WARNING: ADMIN_SECRET is not set — manager header auth is disabled');
if (!MASTER_ADMIN_SECRET) console.error('[STARTUP] WARNING: MASTER_ADMIN_SECRET is not set — /auth/masterlogin will return 503');
if (ADMIN_SECRET && !ALLOW_LEGACY_ADMIN_SECRET) console.warn('[STARTUP] Legacy X-Admin-Secret auth is DISABLED (set ALLOW_LEGACY_ADMIN_SECRET=true to re-enable during rollover)');

// 8 hours — one working day, matching MASTER_TOKEN_TTL_SECS below. Was 2 hours,
// which cut off long content sessions (reviewing hundreds of imported drafts,
// or a multi-minute bulk import) with no way to continue: there is no refresh
// endpoint, so exp is fixed at login and activity never extends it.
//
// This does NOT widen the revocation window. A deactivated or demoted account is
// locked out within STATUS_CACHE_TTL_SECS (5 minutes) because revalidateAccount()
// re-reads the manager document once the token's cached status goes stale,
// independent of how long the token itself lives. What the TTL bounds is how long
// a *stolen* token stays usable — acceptable here: the token is held in
// sessionStorage (per-tab, dropped when the tab closes) on an internal portal.
const TOKEN_TTL_SECS        = 28800; // 8 hours — manager JWT
const MASTER_TOKEN_TTL_SECS = 28800; // 8 hours — master session token

//const db = new Firestore();

const db = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
});

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const VALID_FAQ_STATUSES    = ['published', 'draft'];
// What an anonymous caller is allowed to see. Deliberately WIDER than
// `status === 'published'`: rows created before the status field existed have no
// status at all, and older rows use 'active'/'approved'. Every client already
// treats all of those as published (app/faq/page.tsx, app/admin/page.tsx), but
// the Firestore query below used a strict equality match — so those rows were
// silently missing from the public knowledge base, from /faq/search and from the
// chatbot, with nothing anywhere to indicate it.
const PUBLIC_FAQ_STATUSES   = ['published', 'active', 'approved'];
const isPubliclyVisible     = (a) => !a.status || PUBLIC_FAQ_STATUSES.includes(a.status);
const VALID_TICKET_STATUSES = ['open', 'in_progress', 'solved', 'resolved'];
const ALLOWED_TICKET_CATEGORIES = [
  'Getting Started', 'Account Opening', 'Trading', 'Portfolio & Margin',
  'Funds', 'Charges & Brokerage', 'Compliance & Safety', 'Mutual Funds',
  'IPO', 'F&O', 'Pledging', 'MTF', 'Tender Offers', 'Contact & Help',
  'Advanced', 'Account', 'Reports', 'NRI/HUF Accounts', 'Other',
];

// Request body size cap to defend against oversized-payload DoS. The Functions
// Framework already enforces a generous default; we add a tighter cap on the
// JSON-payload routes specifically.
const MAX_BODY_BYTES = 100 * 1024; // 100 KB

// ─── Published-article cache ──────────────────────────────────────────────
//
// Fetching the full article collection on every search is O(n) and wasteful.
// Instead we keep published articles in module-scope memory, refreshed on a
// 5-minute TTL. Any write that changes article data (create, update, delete)
// also calls invalidateArticleCache() so the very next search sees fresh data
// without waiting for the TTL.
//
// Cache is per-container, same as rate limiting — acceptable because Cloud
// Functions Gen 2 reuses containers aggressively and the TTL is a backstop.
//
// Each cached entry pre-computes the lowercase + HTML-stripped fields used
// by the search scorer, so that work happens once at load time rather than
// on every query.

const ARTICLE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _articleCache = null;  // { articles: CachedArticle[], loadedAt: number } | null

// Deliberately shorter than the search cache. Both caches are PER-CONTAINER, and
// invalidateArticleCache() only clears the instance that served the write - with
// max-instances=10 the others keep their copy until it expires. For search that is
// harmless. For the article list it decides how long an article stays reachable by
// customers after being unpublished or deleted, so the TTL is the real worst case
// for withdrawing content. 60s keeps that bound tight while still removing
// essentially all of the per-request read load.
const PUBLIC_LIST_CACHE_TTL_MS = 60 * 1000;

// Second cache, for the full public GET /faq payload. That endpoint read the
// entire collection on EVERY request - ~1.5k documents per home-page or
// Knowledge Base view, uncached - which measured at 2.0s and ~790 KB. The search
// path had a cache; the list path never did. Same TTL, and the same write
// invalidation, so publishing an article is still reflected immediately.
let _publicListCache = null;  // { items, loadedAt } | null

function invalidateArticleCache() {
  _articleCache = null;
  _publicListCache = null;
}

async function getPublishedArticles() {
  const now = Date.now();
  if (_articleCache && now - _articleCache.loadedAt < ARTICLE_CACHE_TTL_MS) {
    return _articleCache.articles;
  }

  // Cache miss — fetch from Firestore. The status filter can't be pushed down
  // any more (a Firestore query can't express "missing field OR in list"), so we
  // read the collection and drop drafts before the map — draft content still
  // never lands in the cache.
  const snap = await db.collection(FAQ_COL).get();

  const articles = snap.docs.filter(d => isPubliclyVisible(d.data())).map(d => {
    const a = d.data();
    // Pre-process fields used by the search scorer.
    // Doing this once at cache-load time vs. on every search query.
    // Title/category are sanitized so search never emits raw markup (IDX-001).
    const title    = sanitizeText(a.title, 300);
    const category = sanitizeText(a.category, 100);
    return {
      id:         a.id,
      title,
      category,
      content:    a.content    || '',
      updatedAt:  a.updatedAt  || a.createdAt || '',
      // Pre-computed for scoring — lowercase + HTML stripped
      _titleLow:    title.toLowerCase(),
      _categoryLow: category.toLowerCase(),
      _contentLow:  (a.content  || '').toLowerCase().replace(/<[^>]+>/g, ' '),
    };
  });

  if (articles.length > 2000) {
    console.warn(JSON.stringify({ severity: 'WARNING', message: 'Article cache is large', count: articles.length }));
  }

  console.log(JSON.stringify({ severity: 'INFO', message: 'Article cache refreshed', count: articles.length }));
  _articleCache = { articles, loadedAt: now };
  return articles;
}

// Full public article list for GET /faq, cached and pre-sorted.
// Returns the shared array; callers MUST NOT mutate it (filter/map, never sort
// or splice) or they corrupt the cache for every later request.
async function getPublicFaqList() {
  const now = Date.now();
  if (_publicListCache && now - _publicListCache.loadedAt < PUBLIC_LIST_CACHE_TTL_MS) {
    return _publicListCache.items;
  }
  const snap = await db.collection(FAQ_COL).get();
  const items = snap.docs
    .map(d => d.data())
    .filter(isPubliclyVisible)
    // Sanitize title/category on the way out so existing raw-markup rows
    // (IDX-001) are never served as HTML to the FAQ page; content is left intact.
    .map(a => ({ ...a, title: sanitizeText(a.title, 300), category: sanitizeText(a.category, 100) }));
  items.sort((a, b) => (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999));
  _publicListCache = { items, loadedAt: now };
  console.log(JSON.stringify({ severity: 'INFO', message: 'Public FAQ list cache refreshed', count: items.length }));
  return items;
}

// ─── Search relevance helpers ─────────────────────────────────────────────
//
// Matching is "prefix-of-word" (anchored at a word start, suffix-flexible) so
// "charge" matches "charges"/"charged" but "sign" does NOT match "eSign".
const escapeRe   = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordStartRe = (w) => new RegExp('(?:^|[^a-z0-9])' + escapeRe(w));

// Multi-word colloquialisms normalised to domain terms BEFORE tokenising.
const SEARCH_PHRASES = [
  [/\bcash(?:ing)?[ -]?out\b/g, 'withdraw'],
  [/\btake out (?:my |the )?(?:money|funds|cash)\b/g, 'withdraw'],
  [/\bmoney out\b/g, 'withdraw'],
  [/\bput (?:my |the )?(?:money|funds|cash) in\b/g, 'add funds'],
  [/\badd (?:money|cash)\b/g, 'add funds'],
  [/\bsign[ -]?in\b/g, 'login'],
  [/\blog[ -]?in\b/g, 'login'],
  [/\bcan'?t (?:log ?in|sign ?in|access)\b/g, 'login'],
];

// Single-word synonyms. A query word also matches its synonyms, but a synonym-only
// hit scores LESS than a literal hit so exact-word articles keep their edge.
const SYNONYMS = {
  withdraw:   ['withdrawal', 'redeem', 'redemption', 'payout'],
  withdrawal: ['withdraw', 'redeem', 'redemption', 'payout'],
  deposit:    ['deposits'],
  login:      ['signin', 'credential', 'credentials'],
  password:   ['passcode', 'credential', 'credentials'],
  fees:       ['fee', 'charge', 'charges', 'brokerage'],
  fee:        ['fees', 'charge', 'charges', 'brokerage'],
  charges:    ['charge', 'fee', 'fees', 'brokerage'],
  charge:     ['charges', 'fee', 'fees', 'brokerage'],
  brokerage:  ['charge', 'charges', 'fee', 'fees'],
  kyc:        ['verification'],
  mtf:        ['margin'],
  margin:     ['mtf'],
  nominee:    ['nomination', 'nominees'],
  nominees:   ['nomination', 'nominee'],
  nomination: ['nominee', 'nominees'],
  statement:  ['statements'],
};

// IDF-lite: words that appear in a large share of titles/categories (e.g.
// "trading", "account", "demat") get a smaller title weight so they don't
// dominate MULTI-word queries. Cached per article-cache generation.
let _dfCache = { ref: null, df: null, n: 0 };
function getSearchDF(articles) {
  if (_dfCache.ref === articles) return _dfCache;
  const df = new Map();
  for (const a of articles) {
    const seen = new Set((a._titleLow + ' ' + a._categoryLow).split(/[^a-z0-9]+/).filter(w => w.length >= 2));
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  _dfCache = { ref: articles, df, n: articles.length || 1 };
  return _dfCache;
}

// ─── Rate limiting (in-memory, per-container) ─────────────────────────────
//
// Per-IP token bucket kept in the container's RAM. Limits work within a
// single container instance only — for distributed brute-force protection
// across many containers, this would need to move to Firestore or Redis.
// This catches ~95% of brute-force scenarios in practice because container
// reuse on Cloud Functions Gen 2 is high for the same caller.
//
// Buckets are pruned lazily when accessed; with low traffic the map stays
// small. Container restarts reset all counters.

const rateLimitBuckets = new Map();

/**
 * Check if a request from `key` (typically IP+endpoint) is allowed.
 * Returns { allowed, retryAfterSecs }.
 *
 * @param {string} key       — bucket identifier
 * @param {number} maxHits   — max requests in the window
 * @param {number} windowSecs — sliding window duration
 */
function checkRateLimit(key, maxHits, windowSecs) {
  const now = Date.now();
  const windowStart = now - windowSecs * 1000;
  let bucket = rateLimitBuckets.get(key);
  if (!bucket) {
    bucket = [];
    rateLimitBuckets.set(key, bucket);
  }
  // Drop hits outside the window
  while (bucket.length && bucket[0] < windowStart) bucket.shift();
  if (bucket.length >= maxHits) {
    const retryAfterSecs = Math.ceil((bucket[0] + windowSecs * 1000 - now) / 1000);
    return { allowed: false, retryAfterSecs };
  }
  bucket.push(now);
  // Soft cap on total tracked IPs to prevent runaway memory growth
  if (rateLimitBuckets.size > 10000) {
    // Drop the oldest 20% — simple LRU-ish behaviour
    const drop = Math.floor(rateLimitBuckets.size * 0.2);
    let i = 0;
    for (const k of rateLimitBuckets.keys()) {
      if (i++ >= drop) break;
      rateLimitBuckets.delete(k);
    }
  }
  return { allowed: true };
}

// ─── CORS ──────────────────────────────────────────────────────────────────

function buildCorsHeaders(origin) {
  // Auth is header-based (X-Admin-Secret, Bearer tokens) — not cookie-based.
  // We never send credentials:true from the browser, so we can safely reflect
  // the requesting origin (or * when no origin header) without needing
  // Access-Control-Allow-Credentials.
  const allowedOrigin = ALLOWED_ORIGINS.length > 0
    ? (ALLOWED_ORIGINS.includes(origin) ? origin : '')
    : (origin || '*');
  // Only emit CORS headers when the origin is actually permitted. A disallowed
  // origin gets a bare response — no ACAO/ACAM/ACAH — so the browser blocks it
  // instead of us advertising the accepted methods and headers to arbitrary
  // sites. Vary: Origin stops shared caches from serving one origin's
  // Access-Control-Allow-Origin to a different origin.
  if (!allowedOrigin) return {};
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Secret,X-Master-Token,Authorization',
  };
  if (allowedOrigin !== '*') headers['Vary'] = 'Origin';
  return headers;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sourceIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || 'unknown';
}

function userAgent(req) {
  return (req.headers['user-agent'] || '').slice(0, 300);
}

function parseBrowser(ua) {
  if (!ua) return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari' :
    /MSIE|Trident/.test(ua) ? 'IE' : 'Other';
  const os =
    /Windows NT/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua) ? 'macOS' :
    /iPhone/.test(ua) ? 'iOS' :
    /iPad/.test(ua) ? 'iPadOS' :
    /Android/.test(ua) ? 'Android' :
    /Linux/.test(ua) ? 'Linux' : 'Other';
  const device =
    /iPhone|Android.*Mobile|Windows Phone/.test(ua) ? 'Mobile' :
    /iPad|Android(?!.*Mobile)/.test(ua) ? 'Tablet' : 'Desktop';
  return { browser, os, device };
}

// ─── JWT (library-free HMAC-SHA256) ────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function makeJWT(payload) {
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECS }));
  const sig     = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedBuf = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest();
    const sigBuf = Buffer.from(sig, 'base64url');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Password hashing (scrypt) ──────────────────────────────────────────────

async function hashPassword(password) {
  const salt = randomUUID().replace(/-/g, '');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, hash) {
  try {
    const [salt, stored] = hash.split(':');
    const derived = await scryptAsync(password, salt, 64);
    const storedBuf = Buffer.from(stored, 'hex');
    return timingSafeEqual(derived, storedBuf);
  } catch {
    return false;
  }
}

// ─── Email OTP helpers ───────────────────────────────────────────────────────

// A login email must be a well-formed address on the allowed corporate domain.
function isAllowedLoginEmail(email) {
  return typeof email === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    email.toLowerCase().endsWith('@' + OTP_ALLOWED_DOMAIN);
}

// The managers collection IS the allow-list: an email only authenticates if it
// has an active manager doc. Master admins are managers with role
// 'masteradmin'. Seeded master emails resolve to masteradmin even before a doc
// exists, so the very first login is never locked out. Returns null if the
// email is not authorised (caller must not reveal which).
async function resolveLoginIdentity(emailLower) {
  let docs = [];
  try {
    // Fetch ALL docs for this email (there can be duplicates / a deactivated
    // old record alongside an active one) rather than an arbitrary limit(1).
    const snap = await db.collection(MANAGERS_COL).where('email', '==', emailLower).get();
    docs = snap.docs.map(d => d.data());
  } catch (e) {
    console.error('resolveLoginIdentity query failed:', e.message);
  }
  // Only active accounts count; deactivated duplicates must never block login.
  const active = docs.filter(m => !m.status || m.status === 'active');
  const seeded = OTP_SEED_MASTERS.includes(emailLower);

  // Prefer an explicit active master-admin record.
  const masterDoc = active.find(m => m.role === 'masteradmin');
  if (masterDoc) {
    return { email: emailLower, role: 'masteradmin', displayName: masterDoc.displayName || emailLower, managerId: masterDoc.managerId || null };
  }
  // Seeded bootstrap masters are treated as master even if their DB record is a
  // plain manager (or absent) — so the first master is never locked out.
  if (seeded) {
    return { email: emailLower, role: 'masteradmin', displayName: active[0]?.displayName || emailLower, managerId: active[0]?.managerId || null };
  }
  // Otherwise, any active account grants manager access.
  if (active.length > 0) {
    const m = active[0];
    return { email: emailLower, role: 'manager', displayName: m.displayName || emailLower, managerId: m.managerId || null };
  }
  return null;
}

function generateOtpCode() {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

let _otpTransport = null;
function getOtpTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (!_otpTransport) {
    _otpTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return _otpTransport;
}

async function sendOtpEmail(email, code) {
  const transport = getOtpTransport();
  if (!transport) throw new Error('SMTP not configured');
  const mins = Math.round(OTP_TTL_SECS / 60);
  await transport.sendMail({
    from: OTP_FROM_ADDR,
    to: email,
    subject: `Your Support Portal login code: ${code}`,
    text: `Your one-time login code is ${code}. It expires in ${mins} minutes. If you did not request this, ignore this email.`,
    html: `<p>Your one-time login code for the Indiabulls Securities Support Portal is:</p>`
      + `<p style="font-size:26px;font-weight:700;letter-spacing:4px;margin:12px 0">${code}</p>`
      + `<p>It expires in ${mins} minutes. If you did not request this, you can safely ignore this email.</p>`,
  });
}

// ─── Auth extraction ────────────────────────────────────────────────────────

function makeMasterToken(identity = {}) {
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    role: 'masteradmin',
    email: identity.email || null,
    displayName: identity.displayName || null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + MASTER_TOKEN_TTL_SECS,
  }));
  const sig     = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function verifyMasterToken(token) {
  const payload = verifyJWT(token);
  return payload?.role === 'masteradmin' ? payload : null;
}

function extractAuth(req) {
  const authHdr  = req.headers['authorization'] || '';
  const xMaster  = req.headers['x-master-token'] || '';
  const xSecret  = req.headers['x-admin-secret'] || '';

  const bearerToken = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : null;

  // Master: either a signed session token (preferred) or legacy raw secret (kept for backward compat during rollover)
  const masterTokenPayload = xMaster ? verifyMasterToken(xMaster) : null;
  const isMasterLegacy     = !masterTokenPayload && MASTER_ADMIN_SECRET && xSecret === MASTER_ADMIN_SECRET;
  const isMaster           = !!masterTokenPayload || isMasterLegacy;

  // Legacy shared-secret admin path — disabled unless explicitly re-enabled
  // via ALLOW_LEGACY_ADMIN_SECRET (see the flag definition for rationale).
  const isAdmin    = ALLOW_LEGACY_ADMIN_SECRET && !isMaster && ADMIN_SECRET && xSecret === ADMIN_SECRET;
  const jwtPayload = bearerToken ? verifyJWT(bearerToken) : null;

  // Individual identity of a master session (null for the legacy shared-secret
  // path, which has no personal identity). Google-SSO master tokens also carry
  // managerId + a cached status so the session can be revoked when the account
  // is deactivated/demoted (legacy break-glass tokens carry none of these).
  const masterEmail = masterTokenPayload?.email || null;
  const masterDisplayName = masterTokenPayload?.displayName || null;
  const masterManagerId = masterTokenPayload?.managerId || null;
  const masterStatus = masterTokenPayload?.status || null;
  const masterStatusCachedAt = masterTokenPayload?.statusCachedAt || null;

  return { isMaster, isAdmin, jwtPayload, masterEmail, masterDisplayName, masterManagerId, masterStatus, masterStatusCachedAt };
}

// How long to trust the cached `status` field embedded in the JWT before
// re-validating against Firestore. Deactivated managers stay logged in for
// at most this duration after deactivation.
const STATUS_CACHE_TTL_SECS = 300; // 5 minutes

// Re-validate an account against Firestore, honoring the JWT's short-lived
// status cache to avoid a per-request read. Returns { ok, reason, role } where
// `role` is the FRESH DB role when a lookup happened (used to catch a master
// being demoted to manager) or the cached role when the cache is trusted.
//
// Performance: the token embeds `status` + `statusCachedAt` at login time; we
// trust that for STATUS_CACHE_TTL_SECS, so a deactivated/demoted account keeps
// access for at most that window. Tokens lacking these fields (old JWTs, legacy
// break-glass master tokens) fall through to a DB lookup — and if they carry no
// managerId either, the caller decides whether to trust them for their TTL.
async function revalidateAccount(managerId, token) {
  const now = Math.floor(Date.now() / 1000);
  const cacheAge = token?.statusCachedAt ? now - token.statusCachedAt : Infinity;
  if (token?.status && cacheAge < STATUS_CACHE_TTL_SECS) {
    if (token.status !== 'active') return { ok: false, reason: 'deactivated' };
    return { ok: true, role: token.role };
  }
  try {
    const snap = await db.collection(MANAGERS_COL).doc(managerId).get();
    if (!snap.exists || snap.data().status !== 'active') return { ok: false, reason: 'deactivated' };
    return { ok: true, role: snap.data().role };
  } catch {
    return { ok: false, reason: 'db_error' };
  }
}

// Authorizes manager-or-master actions. A master session arrives either as an
// X-Master-Token or as a Bearer JWT whose role is 'masteradmin' (the dual token
// that lets a master use the admin portal too). Either way, when the token
// identifies a manager record we re-validate it so a deactivated/demoted master
// loses access within the cache window.
async function requireManagerOrMaster(req) {
  const auth = extractAuth(req);

  if (auth.isAdmin && !auth.jwtPayload) return { ok: true, performedBy: 'admin (legacy secret)', role: 'admin' };

  const bearer = auth.jwtPayload;
  const master = auth.isMaster
    ? { email: auth.masterEmail, displayName: auth.masterDisplayName, managerId: auth.masterManagerId, status: auth.masterStatus, statusCachedAt: auth.masterStatusCachedAt, role: 'masteradmin' }
    : (bearer?.role === 'masteradmin' ? bearer : null);

  if (master) {
    // Google-SSO master tokens carry a managerId → revoke if deactivated/demoted.
    // Legacy break-glass master tokens carry none → trusted for their TTL.
    if (master.managerId) {
      const v = await revalidateAccount(master.managerId, master);
      if (!v.ok) return { ok: false, reason: v.reason };
      if (v.role && v.role !== 'masteradmin') return { ok: false, reason: 'demoted' };
    }
    return { ok: true, performedBy: master.email || 'masteradmin', role: 'masteradmin', displayName: master.displayName || master.email || 'Master Admin' };
  }

  // Manager Bearer JWT.
  if (!bearer?.managerId) return { ok: false };
  const v = await revalidateAccount(bearer.managerId, bearer);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, performedBy: bearer.email || bearer.managerId, role: bearer.role, displayName: bearer.displayName };
}

// Master-only endpoints (manager CRUD). Accepts the X-Master-Token session and
// re-validates the account so a deactivated/demoted master is locked out within
// the cache window.
async function requireMaster(req) {
  const auth = extractAuth(req);
  if (!auth.isMaster) return false;
  if (auth.masterManagerId) {
    const v = await revalidateAccount(auth.masterManagerId, { status: auth.masterStatus, statusCachedAt: auth.masterStatusCachedAt, role: 'masteradmin' });
    if (!v.ok) return false;
    if (v.role && v.role !== 'masteradmin') return false;
  }
  return true;
}

// ─── Audit log writer ───────────────────────────────────────────────────────

async function writeAudit({ action, entity, entityId, entityTitle, performedBy, meta = {} }) {
  try {
    const id = randomUUID();
    await db.collection(AUDIT_COL).doc(id).set({
      id,
      timestamp: new Date().toISOString(),
      action,
      entity,
      entityId: entityId || '',
      entityTitle: entityTitle || '',
      performedBy: performedBy || 'unknown',
      meta,
    });
  } catch (e) {
    console.error('Audit write failed:', e.message);
  }
}

// Long field values are truncated so a single audit record stays small and
// well under Firestore's 1 MB document limit even for large FAQ bodies.
const AUDIT_VALUE_CAP = 2000;
function capAuditValue(v) {
  if (v === undefined) return null;
  if (typeof v !== 'string') return v;
  return v.length > AUDIT_VALUE_CAP ? `${v.slice(0, AUDIT_VALUE_CAP)}…[+${v.length - AUDIT_VALUE_CAP} chars]` : v;
}

// Builds a { field: { from, to } } diff for the fields that actually changed
// between the stored document and the incoming update, so the audit log
// records WHAT a value was before an edit — not just which field names changed.
function buildChangeSet(oldData, updateData, fields) {
  const changes = {};
  for (const f of fields) {
    if (!(f in updateData)) continue;
    const before = oldData ? oldData[f] : undefined;
    const after = updateData[f];
    if (before === after) continue;
    changes[f] = { from: capAuditValue(before), to: capAuditValue(after) };
  }
  return changes;
}

// Captures a bounded snapshot of a document's key fields — used on deletes so
// the audit log preserves what was removed (otherwise unrecoverable).
function auditSnapshot(data, fields) {
  const out = {};
  for (const f of fields) if (data && data[f] !== undefined) out[f] = capAuditValue(data[f]);
  return out;
}

// ─── Cloud Function entry point ────────────────────────────────────────────

functions.http('handler', async (req, res) => {
  const origin = req.headers['origin'] || '';
  const corsHeaders = buildCorsHeaders(origin);

  // Set CORS headers on every response
  res.set(corsHeaders);
  res.set('Content-Type', 'application/json');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).send('');
    return;
  }

  try {
    await _handler(req, res, corsHeaders);
  } catch (err) {
    // Structured log so Cloud Logging can index + alert on these
    console.error(JSON.stringify({
      severity: 'ERROR',
      message: 'Unhandled Cloud Function error',
      error: err?.message || String(err),
      stack: err?.stack,
      method: req.method,
      path: req.path,
    }));
    res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

async function _handler(req, res) {
  const method = req.method;
  const rawPath = req.path || '/';
  const path = rawPath.replace(/\/$/, '') || '/';

  // req.body is already parsed by the Functions Framework (express under the hood)
  const body = req.body || {};

  // Shorthand response helper
  const r = (status, data) => res.status(status).json(data);

  // ── Body size guard ──────────────────────────────────────────────────────
  // Reject oversized JSON payloads as cheap DoS defense. We rely on
  // Content-Length here since Functions Framework has already buffered the body.
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return r(413, { error: 'Request body too large' });
  }

  // ── GET /_health ─────────────────────────────────────────────────────────
  // Lightweight liveness probe for monitoring tools. Does NOT touch Firestore
  // so it stays fast and won't burn quota.
  if (method === 'GET' && path === '/_health') {
    return r(200, { status: 'ok', timestamp: new Date().toISOString() });
  }

  // ── POST /auth/google ─────────────────────────────────────────────────────
  // "Sign in with Google": the browser sends the Google-issued ID token
  // (credential). We validate it, confirm it's a verified @indiabulls.com
  // Google Workspace account, then apply the same allow-list as OTP and issue
  // the session token — no passwords or SMTP involved.
  if (method === 'POST' && path === '/auth/google') {
    const credential = String(body.credential || '');
    const ip = sourceIp(req);
    const ua = userAgent(req);

    const gRl = checkRateLimit(`google-auth:${ip}`, 20, 60);
    if (!gRl.allowed) { res.set('Retry-After', String(gRl.retryAfterSecs)); return r(429, { error: 'Too many attempts. Try again shortly.' }); }
    if (!credential) return r(400, { error: 'Missing Google credential.' });
    if (!GOOGLE_CLIENT_ID) return r(503, { error: 'Google sign-in is not configured yet.' });

    // Validate the ID token via Google's tokeninfo endpoint (checks signature
    // + expiry server-side); we then enforce audience, issuer, domain and
    // verification. A hard timeout keeps a slow/hung Google from stalling the
    // login (and pinning function instances) up to the 60s function timeout.
    let claims;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), GOOGLE_TOKENINFO_TIMEOUT_MS);
      let gr;
      try {
        gr = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!gr.ok) throw new Error('tokeninfo rejected');
      claims = await gr.json();
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      await writeAudit({ action: 'LOGIN_FAIL', entity: 'auth', entityId: 'google', entityTitle: 'google', performedBy: 'system', meta: { ip, userAgent: ua, reason: timedOut ? 'tokeninfo_timeout' : 'token_invalid' } });
      return r(timedOut ? 504 : 401, { error: timedOut ? 'Sign-in timed out. Please try again.' : 'Google sign-in failed. Please try again.' });
    }

    const email = String(claims.email || '').trim().toLowerCase();
    const audOk = claims.aud === GOOGLE_CLIENT_ID;
    // Defense-in-depth: tokeninfo only returns genuine Google tokens, but we
    // still assert the issuer explicitly.
    const issOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com';
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    const domainOk = !!email && email.endsWith('@' + OTP_ALLOWED_DOMAIN) &&
      (!claims.hd || String(claims.hd).toLowerCase() === OTP_ALLOWED_DOMAIN);

    if (!audOk || !issOk || !verified || !domainOk) {
      const reason = !audOk ? 'wrong_audience' : !issOk ? 'wrong_issuer' : !verified ? 'email_unverified' : 'wrong_domain';
      await writeAudit({ action: 'LOGIN_FAIL', entity: 'auth', entityId: email || 'google', entityTitle: email || 'google', performedBy: 'system', meta: { ip, userAgent: ua, reason } });
      return r(403, { error: `Sign in with your @${OTP_ALLOWED_DOMAIN} Google account.` });
    }

    let identity = await resolveLoginIdentity(email);
    if (!identity) {
      // Govern-after self-signup: a verified company email with NO existing
      // record is auto-provisioned as an active manager on first login. If a
      // record exists but none is active, they were deactivated — keep them out.
      if (AUTO_PROVISION_MANAGERS) {
        let existing;
        try { existing = await db.collection(MANAGERS_COL).where('email', '==', email).get(); }
        catch { return r(500, { error: 'Login temporarily unavailable' }); }
        if (!existing.empty) {
          await writeAudit({ action: 'LOGIN_FAIL', entity: 'auth', entityId: email, entityTitle: email, performedBy: 'system', meta: { ip, userAgent: ua, reason: 'deactivated' } });
          return r(403, { error: 'Your admin access has been disabled. Contact a master admin.' });
        }
        // Deterministic doc id keyed to the email so two simultaneous first
        // logins collide on the SAME document (idempotent) instead of creating
        // duplicate manager records for one person.
        const managerId = `self_${email.replace(/[^a-z0-9]+/g, '_')}`;
        const now = new Date().toISOString();
        const displayName = String(claims.name || '').trim() || email;
        // create-if-absent: never clobber an existing record (e.g. one a master
        // just created/deactivated in the race window).
        try {
          await db.collection(MANAGERS_COL).doc(managerId).create({
            id: managerId, managerId, username: email, displayName, email,
            role: 'manager', status: 'active',
            createdAt: now, createdBy: 'self-signup:google', lastLoginAt: now, deactivatedAt: null,
          });
          await writeAudit({ action: 'MANAGER_SELF_PROVISIONED', entity: 'manager', entityId: managerId, entityTitle: displayName, performedBy: email, meta: { ip, userAgent: ua, email } });
        } catch {
          // Lost the create race (doc now exists) — re-resolve and honor the
          // winner's record, rejecting if it turns out to be deactivated.
          const again = await resolveLoginIdentity(email);
          if (!again) {
            await writeAudit({ action: 'LOGIN_FAIL', entity: 'auth', entityId: email, entityTitle: email, performedBy: 'system', meta: { ip, userAgent: ua, reason: 'deactivated' } });
            return r(403, { error: 'Your admin access has been disabled. Contact a master admin.' });
          }
          identity = again;
        }
        if (!identity) identity = { email, role: 'manager', displayName, managerId };
      } else {
        await writeAudit({ action: 'LOGIN_FAIL', entity: 'auth', entityId: email, entityTitle: email, performedBy: 'system', meta: { ip, userAgent: ua, reason: 'not_authorised' } });
        return r(403, { error: 'This account is not authorised. Ask a master admin to add you.' });
      }
    }

    // Issue a signed JWT carrying the role + email. A masteradmin token is
    // dual-purpose: sent as X-Master-Token it satisfies the master session
    // check, and sent as a Bearer token it satisfies the manager check — so a
    // master admin can use BOTH the master and the admin/manager portals.
    const token = makeJWT({
      managerId: identity.managerId, email: identity.email, displayName: identity.displayName,
      role: identity.role, status: 'active', statusCachedAt: Math.floor(Date.now() / 1000),
    });
    const tokenField = { token, role: identity.role, email: identity.email, displayName: identity.displayName, managerId: identity.managerId };
    if (identity.managerId) await db.collection(MANAGERS_COL).doc(identity.managerId).update({ lastLoginAt: new Date().toISOString() }).catch(() => {});
    await writeAudit({ action: 'LOGIN_SUCCESS', entity: 'auth', entityId: email, entityTitle: identity.displayName, performedBy: email, meta: { ip, userAgent: ua, role: identity.role, method: 'google' } });
    return r(200, tokenField);
  }

  // ── POST /auth/request-otp ────────────────────────────────────────────────
  // Step 1 of email-OTP login: caller submits their official email; if it is a
  // valid @<domain> address AND is provisioned (active manager / seeded
  // master), we email a one-time code. The response is deliberately generic so
  // it never reveals whether an address is registered.
  if (method === 'POST' && path === '/auth/request-otp') {
    const email = String(body.email || '').trim().toLowerCase();
    const ip = sourceIp(req);
    const ua = userAgent(req);

    // Rate-limit by IP and by email to blunt spamming / enumeration.
    const ipRl = checkRateLimit(`otp-req-ip:${ip}`, 5, 60);
    if (!ipRl.allowed) { res.set('Retry-After', String(ipRl.retryAfterSecs)); return r(429, { error: 'Too many requests. Try again shortly.' }); }

    if (!isAllowedLoginEmail(email)) {
      // Wrong domain / malformed — safe to be explicit about the domain rule.
      return r(400, { error: `Use your @${OTP_ALLOWED_DOMAIN} email address.` });
    }

    const emailRl = checkRateLimit(`otp-req-email:${email}`, 3, 300);
    const generic = { ok: true, message: 'If that email is authorised, a code has been sent.' };

    const identity = await resolveLoginIdentity(email);
    // Only actually send when authorised AND under the per-email limit; always
    // return the same generic response either way.
    if (identity && emailRl.allowed) {
      const code = generateOtpCode();
      let codeHash;
      try { codeHash = await hashPassword(code); } catch { return r(500, { error: 'Login temporarily unavailable' }); }
      try {
        await db.collection(OTP_COL).doc(email).set({
          email,
          codeHash,
          expiresAt: new Date(Date.now() + OTP_TTL_SECS * 1000).toISOString(),
          attempts: 0,
          createdAt: new Date().toISOString(),
        });
        await sendOtpEmail(email, code);
        await writeAudit({ action: 'OTP_REQUESTED', entity: 'auth', entityId: email, entityTitle: email, performedBy: 'system', meta: { ip, userAgent: ua, role: identity.role } });
      } catch (e) {
        console.error('OTP send failed:', e.message);
        if (String(e.message).includes('SMTP not configured')) return r(503, { error: 'Login email is not configured yet.' });
        return r(502, { error: 'Could not send the code. Try again shortly.' });
      }
    }
    return r(200, generic);
  }

  // ── POST /auth/verify-otp ─────────────────────────────────────────────────
  // Step 2: caller submits email + code. On success we issue the session token
  // for their role (manager JWT or master session token), both stamped with the
  // email so every subsequent action is audited to the individual.
  if (method === 'POST' && path === '/auth/verify-otp') {
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const ip = sourceIp(req);
    const ua = userAgent(req);

    const vRl = checkRateLimit(`otp-verify:${ip}`, 10, 60);
    if (!vRl.allowed) { res.set('Retry-After', String(vRl.retryAfterSecs)); return r(429, { error: 'Too many attempts. Try again shortly.' }); }
    if (!isAllowedLoginEmail(email) || !code) return r(400, { error: 'Email and code are required.' });

    const otpRef = db.collection(OTP_COL).doc(email);
    let otp;
    try { const snap = await otpRef.get(); otp = snap.exists ? snap.data() : null; }
    catch { return r(500, { error: 'Login temporarily unavailable' }); }

    const invalid = async (reason) => {
      await writeAudit({ action: 'OTP_FAIL', entity: 'auth', entityId: email, entityTitle: email, performedBy: 'system', meta: { ip, userAgent: ua, reason } });
      return r(401, { error: 'Invalid or expired code.' });
    };

    if (!otp) return invalid('no_code');
    if (new Date(otp.expiresAt) < new Date()) { await otpRef.delete().catch(() => {}); return invalid('expired'); }
    if ((otp.attempts || 0) >= OTP_MAX_ATTEMPTS) { await otpRef.delete().catch(() => {}); return invalid('too_many_attempts'); }

    const okCode = await verifyPassword(code, otp.codeHash || '');
    if (!okCode) {
      await otpRef.update({ attempts: (otp.attempts || 0) + 1 }).catch(() => {});
      return invalid('wrong_code');
    }

    // Code is single-use.
    await otpRef.delete().catch(() => {});

    const identity = await resolveLoginIdentity(email);
    if (!identity) return invalid('not_authorised'); // e.g. deactivated between request and verify

    let token, tokenField;
    if (identity.role === 'masteradmin') {
      token = makeMasterToken({ email: identity.email, displayName: identity.displayName });
      tokenField = { token, role: 'masteradmin', email: identity.email, displayName: identity.displayName, expiresIn: MASTER_TOKEN_TTL_SECS };
    } else {
      token = makeJWT({
        managerId: identity.managerId,
        email: identity.email,
        displayName: identity.displayName,
        role: 'manager',
        status: 'active',
        statusCachedAt: Math.floor(Date.now() / 1000),
      });
      tokenField = { token, role: 'manager', email: identity.email, displayName: identity.displayName, managerId: identity.managerId };
      if (identity.managerId) {
        await db.collection(MANAGERS_COL).doc(identity.managerId).update({ lastLoginAt: new Date().toISOString() }).catch(() => {});
      }
    }
    await writeAudit({ action: 'LOGIN_SUCCESS', entity: 'auth', entityId: email, entityTitle: identity.displayName, performedBy: email, meta: { ip, userAgent: ua, role: identity.role, method: 'otp' } });
    return r(200, tokenField);
  }

  // ── POST /auth/login ─────────────────────────────────────────────────────
  if (method === 'POST' && path === '/auth/login') {
    const { username, password } = body;
    if (!username || !password) return r(400, { error: 'username and password required' });
    if (typeof username !== 'string' || typeof password !== 'string') return r(400, { error: 'username and password must be strings' });

    const ip = sourceIp(req);
    const ua = userAgent(req);

    // Rate limit: 10 login attempts per IP per minute (defense against brute-force)
    const rl = checkRateLimit(`login:${ip}`, 10, 60);
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfterSecs));
      return r(429, { error: 'Too many login attempts. Try again shortly.' });
    }

    let manager;
    try {
      const snap = await db.collection(MANAGERS_COL).where('username', '==', username).get();
      manager = snap.empty ? null : snap.docs[0].data();
    } catch (e) {
      console.error('Login query failed:', e);
      return r(500, { error: 'Login temporarily unavailable' });
    }

    const MAX_ATTEMPTS = 5;
    const LOCKOUT_SECS = 900; // 15 minutes

    const fail = async (reason) => {
      if (manager) {
        const attempts = (manager.failedLoginAttempts || 0) + 1;
        const lockedUntil = attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_SECS * 1000).toISOString() : null;
        const updateData = lockedUntil
          ? { failedLoginAttempts: attempts, lockedUntil }
          : { failedLoginAttempts: attempts };
        await db.collection(MANAGERS_COL).doc(manager.managerId).update(updateData);
      }
      await writeAudit({
        action: 'LOGIN_FAIL', entity: 'manager', entityId: username,
        entityTitle: username, performedBy: 'system',
        meta: { ip, userAgent: ua, reason },
      });
      return r(401, { error: 'Invalid credentials' });
    };

    if (!manager || manager.status !== 'active') return fail('not_found_or_inactive');

    if (manager.lockedUntil && new Date(manager.lockedUntil) > new Date()) {
      await writeAudit({
        action: 'LOGIN_BLOCKED', entity: 'manager', entityId: username,
        entityTitle: username, performedBy: 'system',
        meta: { ip, userAgent: ua, lockedUntil: manager.lockedUntil },
      });
      return r(429, { error: 'Account temporarily locked. Try again in 15 minutes.' });
    }

    const valid = await verifyPassword(password, manager.passwordHash || '');
    if (!valid) return fail('wrong_password');

    // Embed status + cache timestamp so requireManagerOrMaster can skip the
    // per-request DB lookup. Re-checks status from DB after 5 minutes elapse.
    const token = makeJWT({
      managerId: manager.managerId,
      username: manager.username,
      displayName: manager.displayName,
      role: manager.role,
      status: manager.status,
      statusCachedAt: Math.floor(Date.now() / 1000),
    });

    await db.collection(MANAGERS_COL).doc(manager.managerId).update({
      lastLoginAt: new Date().toISOString(),
      failedLoginAttempts: 0,
      lockedUntil: Firestore.FieldValue ? Firestore.FieldValue.delete() : null,
    });

    await writeAudit({
      action: 'LOGIN_SUCCESS', entity: 'manager',
      entityId: manager.managerId, entityTitle: manager.displayName,
      performedBy: manager.managerId, meta: { ip, userAgent: ua },
    });

    return r(200, { token, managerId: manager.managerId, displayName: manager.displayName, role: manager.role });
  }

  // ── POST /auth/masterlogin ───────────────────────────────────────────────
  // Validates master password server-side; returns a signed session token.
  // The raw MASTER_ADMIN_SECRET never leaves the function — it is NOT in the browser bundle.
  if (method === 'POST' && path === '/auth/masterlogin') {
    const { password } = body;
    if (!password) return r(400, { error: 'password required' });
    if (!MASTER_ADMIN_SECRET) return r(503, { error: 'Master auth not configured' });

    // Rate limit: 5 master-login attempts per IP per minute (stricter than
    // manager login because there's only one valid password)
    const mlIp = sourceIp(req);
    const mlRl = checkRateLimit(`masterlogin:${mlIp}`, 5, 60);
    if (!mlRl.allowed) {
      res.set('Retry-After', String(mlRl.retryAfterSecs));
      return r(429, { error: 'Too many master login attempts. Try again shortly.' });
    }

    // Constant-time comparison to prevent timing attacks
    const provided = Buffer.from(String(password));
    const expected = Buffer.from(MASTER_ADMIN_SECRET);
    const valid = provided.length === expected.length && timingSafeEqual(provided, expected);

    if (!valid) {
      await writeAudit({
        action: 'MASTER_LOGIN_FAIL', entity: 'masteradmin', entityId: 'masteradmin',
        entityTitle: 'masteradmin', performedBy: 'system',
        meta: { ip: sourceIp(req), userAgent: userAgent(req) },
      });
      return r(401, { error: 'Invalid master password' });
    }

    const token = makeMasterToken();
    await writeAudit({
      action: 'MASTER_LOGIN_SUCCESS', entity: 'masteradmin', entityId: 'masteradmin',
      entityTitle: 'masteradmin', performedBy: 'masteradmin',
      meta: { ip: sourceIp(req), userAgent: userAgent(req) },
    });
    return r(200, { token, expiresIn: MASTER_TOKEN_TTL_SECS });
  }

  // ── POST /auth/logout ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/auth/logout') {
    // Logout accepts JWT or master secret; do not do active-status DB check here
    // (manager should be able to log out even if deactivated)
    const auth = extractAuth(req);
    const isMaster = auth.isMaster;
    const isAdmin  = auth.isAdmin;
    const jwt      = auth.jwtPayload;
    if (!isMaster && !isAdmin && !jwt?.managerId) return r(401, { error: 'Unauthorized' });
    const performedBy   = isMaster ? 'masteradmin' : isAdmin ? 'admin' : jwt.managerId;
    const displayName   = jwt?.displayName || performedBy;
    await writeAudit({
      action: 'LOGOUT', entity: 'manager', entityId: performedBy,
      entityTitle: displayName, performedBy,
      meta: { ip: sourceIp(req) },
    });
    return r(200, { ok: true });
  }

  // ── POST /analytics ──────────────────────────────────────────────────────
  if (method === 'POST' && path === '/analytics') {
    const ALLOWED_TYPES = ['article_view','search','chatbot_open','chatbot_persona_select','chatbot_message','ticket_submit','faq_feedback','admin_login_fail','cta_click','page_view'];
    const { eventType, sessionId, articleId, articleTitle, category, searchTerm, searchResultCount, feedbackType, persona, chatInput, ticketCategory, ctaName, ctaTarget, page, referrer, screenResolution, timezone } = body;
    if (!ALLOWED_TYPES.includes(eventType)) return r(400, { error: 'Invalid eventType' });

    // faq_feedback: use deterministic id = sessionId#articleId so a session can
    // only cast one vote per article — second write silently overwrites (idempotent).
    const resolvedSessionId = sessionId || 'unknown';
    const itemId = (eventType === 'faq_feedback' && resolvedSessionId !== 'unknown' && articleId)
      ? `fb#${resolvedSessionId}#${articleId}`
      : randomUUID();

    const ua = userAgent(req);
    const browserInfo = parseBrowser(ua);
    await db.collection(ANALYTICS_COL).doc(itemId).set({
      id: itemId,
      eventType,
      timestamp: new Date().toISOString(),
      sessionId: resolvedSessionId,
      articleId: articleId || null,
      articleTitle: articleTitle || null,
      category: category || null,
      searchTerm: searchTerm || null,
      searchResultCount: searchResultCount ?? null,
      feedbackType: feedbackType || null,
      persona: persona || null,
      chatInput: chatInput ? String(chatInput).slice(0, 200) : null,
      ticketCategory: ticketCategory || null,
      ctaName: ctaName || null,
      ctaTarget: ctaTarget || null,
      page: page || null,
      referrer: referrer || null,
      screenResolution: screenResolution || null,
      timezone: timezone || null,
      ipAddress: sourceIp(req),
      userAgent: ua,
      browser: browserInfo.browser,
      os: browserInfo.os,
      device: browserInfo.device,
    });
    return r(200, { ok: true });
  }

  // ── GET /analytics/summary ───────────────────────────────────────────────
  if (method === 'GET' && path === '/analytics/summary') {
    if (!(await requireMaster(req))) return r(403, { error: 'Forbidden' });
    const days = parseInt(req.query?.days || '30', 10);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    try {
      const snap = await db.collection(ANALYTICS_COL).where('timestamp', '>=', since).get();
      const items = snap.docs.map(d => d.data());
      const summary = {
        period_days: days,
        article_views: 0,
        searches: 0,
        chatbot_opens: 0,
        chatbot_messages: 0,
        ticket_submits: 0,
        faq_feedback_helpful: 0,
        faq_feedback_not_helpful: 0,
        top_articles: {},
        top_searches: {},
        persona_counts: {},
        tickets_by_category: {},
        article_feedback: {},
        zero_result_searches: 0,
        cta_open_account: 0,
        cta_login: 0,
        browser_counts: {},
        os_counts: {},
        device_counts: {},
      };
      for (const item of items) {
        if (item.eventType === 'article_view') {
          summary.article_views++;
          if (item.articleTitle) summary.top_articles[item.articleTitle] = (summary.top_articles[item.articleTitle] || 0) + 1;
        } else if (item.eventType === 'search') {
          summary.searches++;
          if (item.searchTerm) summary.top_searches[item.searchTerm] = (summary.top_searches[item.searchTerm] || 0) + 1;
          if (item.searchResultCount === 0) summary.zero_result_searches++;
        } else if (item.eventType === 'chatbot_open') {
          summary.chatbot_opens++;
        } else if (item.eventType === 'chatbot_message') {
          summary.chatbot_messages++;
        } else if (item.eventType === 'ticket_submit') {
          summary.ticket_submits++;
          if (item.ticketCategory) summary.tickets_by_category[item.ticketCategory] = (summary.tickets_by_category[item.ticketCategory] || 0) + 1;
        } else if (item.eventType === 'faq_feedback') {
          if (item.feedbackType === 'helpful') summary.faq_feedback_helpful++;
          else summary.faq_feedback_not_helpful++;
          const fbKey = item.articleTitle || item.articleId || null;
          if (fbKey) {
            if (!summary.article_feedback[fbKey]) summary.article_feedback[fbKey] = { helpful: 0, not_helpful: 0, category: item.category || '' };
            if (item.feedbackType === 'helpful') summary.article_feedback[fbKey].helpful++;
            else summary.article_feedback[fbKey].not_helpful++;
          }
        } else if (item.eventType === 'chatbot_persona_select') {
          if (item.persona) summary.persona_counts[item.persona] = (summary.persona_counts[item.persona] || 0) + 1;
        } else if (item.eventType === 'cta_click') {
          if (item.ctaName === 'open_account') summary.cta_open_account++;
          else if (item.ctaName === 'login') summary.cta_login++;
        }
        if (item.browser) summary.browser_counts[item.browser] = (summary.browser_counts[item.browser] || 0) + 1;
        if (item.os) summary.os_counts[item.os] = (summary.os_counts[item.os] || 0) + 1;
        if (item.device) summary.device_counts[item.device] = (summary.device_counts[item.device] || 0) + 1;
      }
      summary.top_articles = Object.entries(summary.top_articles).sort((a, b) => b[1] - a[1]).slice(0, 10);
      summary.top_searches = Object.entries(summary.top_searches).sort((a, b) => b[1] - a[1]).slice(0, 20);
      summary.article_feedback = Object.entries(summary.article_feedback)
        .map(([title, d]) => ({ title, category: d.category, helpful: d.helpful, not_helpful: d.not_helpful, total: d.helpful + d.not_helpful, pct: Math.round((d.helpful / (d.helpful + d.not_helpful)) * 100) }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 20);
      return r(200, summary);
    } catch (e) {
      console.error('Analytics summary error:', e);
      return r(500, { error: 'Failed to load analytics' });
    }
  }

  // ── GET /managers ─────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/managers') {
    if (!(await requireMaster(req))) return r(403, { error: 'Forbidden' });
    const snap = await db.collection(MANAGERS_COL).get();
    const items = snap.docs
      .map(d => {
        const m = d.data();
        // Only return safe fields (exclude passwordHash)
        return {
          managerId: m.managerId,
          username: m.username,
          displayName: m.displayName,
          email: m.email,
          role: m.role,
          status: m.status,
          createdAt: m.createdAt,
          lastLoginAt: m.lastLoginAt,
          deactivatedAt: m.deactivatedAt,
          createdBy: m.createdBy,
        };
      })
      .filter(m => m.managerId && m.username);
    return r(200, items);
  }

  // ── POST /managers ────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/managers') {
    if (!(await requireMaster(req))) return r(403, { error: 'Forbidden' });
    const { username, displayName, password } = body;
    // Email is the OTP login identity — store it lowercased so the login lookup
    // (which lowercases its input) matches.
    const email = String(body.email || '').trim().toLowerCase();
    const role = body.role;
    if (!username || !displayName || !email || !password) return r(400, { error: 'username, displayName, email, password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return r(400, { error: 'Invalid email format' });
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return r(400, { error: 'Username must be 3-30 alphanumeric/underscore characters' });
    if (password.length < 8) return r(400, { error: 'Password must be at least 8 characters' });
    const allowed_roles = ['manager', 'senior_manager', 'masteradmin'];
    if (role && !allowed_roles.includes(role)) return r(400, { error: `Invalid role. Allowed: ${allowed_roles.join(', ')}` });
    const managerRole = role || 'manager';

    // Check username uniqueness
    const existingByUsername = await db.collection(MANAGERS_COL).where('username', '==', username).get();
    if (!existingByUsername.empty) return r(409, { error: 'Username already exists' });

    // Check email uniqueness
    const existingByEmail = await db.collection(MANAGERS_COL).where('email', '==', email).get();
    if (!existingByEmail.empty) return r(409, { error: 'Email already in use' });

    const managerId = `mgr_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const passwordHash = await hashPassword(password);

    await db.collection(MANAGERS_COL).doc(managerId).set({
      id: managerId, managerId, username, displayName, email, role: managerRole,
      status: 'active', passwordHash,
      createdAt: new Date().toISOString(),
      createdBy: 'masteradmin',
      lastLoginAt: null, deactivatedAt: null,
    });

    await writeAudit({
      action: 'MANAGER_CREATED', entity: 'manager',
      entityId: managerId, entityTitle: displayName,
      performedBy: 'masteradmin', meta: { username, email, role: managerRole },
    });

    return r(201, { managerId, ok: true });
  }

  // ── PUT /managers/{id} ────────────────────────────────────────────────────
  const managerPutMatch = path.match(/^\/managers\/([^/]+)$/);
  if (method === 'PUT' && managerPutMatch) {
    if (!(await requireMaster(req))) return r(403, { error: 'Forbidden' });
    const managerId = managerPutMatch[1];
    const updateData = {};
    const updates = {};

    if (body.status !== undefined) {
      const allowed = ['active', 'deactivated'];
      if (!allowed.includes(body.status)) return r(400, { error: 'Invalid status' });
      updateData.status = body.status;
      updates.status = body.status;
      if (body.status === 'deactivated') {
        updateData.deactivatedAt = new Date().toISOString();
      }
    }
    if (body.password) {
      if (body.password.length < 8) return r(400, { error: 'Password too short' });
      updateData.passwordHash = await hashPassword(body.password);
      updates.passwordReset = true;
    }
    if (body.displayName) {
      updateData.displayName = body.displayName;
      updates.displayName = body.displayName;
    }
    if (body.role) {
      const allowed = ['manager', 'senior_manager', 'masteradmin'];
      if (!allowed.includes(body.role)) return r(400, { error: 'Invalid role' });
      updateData.role = body.role;
      updates.role = body.role;
    }
    if (!Object.keys(updateData).length) return r(400, { error: 'Nothing to update' });

    const existingSnap = await db.collection(MANAGERS_COL).doc(managerId).get();
    if (!existingSnap.exists) return r(404, { error: 'Manager not found' });

    await db.collection(MANAGERS_COL).doc(managerId).update(updateData);

    await writeAudit({
      action: 'MANAGER_UPDATED', entity: 'manager',
      entityId: managerId, entityTitle: managerId,
      performedBy: 'masteradmin', meta: updates,
    });

    return r(200, { ok: true });
  }

  // ── DELETE /managers/{id} ─────────────────────────────────────────────────
  const managerDeleteMatch = path.match(/^\/managers\/([^/]+)$/);
  if (method === 'DELETE' && managerDeleteMatch) {
    if (!(await requireMaster(req))) return r(403, { error: 'Forbidden' });
    const managerId = managerDeleteMatch[1];
    const existingSnap = await db.collection(MANAGERS_COL).doc(managerId).get();
    if (!existingSnap.exists) return r(404, { error: 'Manager not found' });
    const existing = existingSnap.data();
    await db.collection(MANAGERS_COL).doc(managerId).delete();
    await writeAudit({
      action: 'MANAGER_DELETED', entity: 'manager',
      entityId: managerId, entityTitle: existing.username || managerId,
      performedBy: 'masteradmin', meta: { username: existing.username },
    });
    return r(200, { ok: true });
  }

  // ── GET /faq ──────────────────────────────────────────────────────────────
  // Public users get only published articles; authenticated managers get all.
  // Optional ?category=X filter (case-insensitive).
  //
  // The public status filter is applied in memory, not pushed to Firestore: a
  // `where('status','==','published')` pushdown also excluded legacy rows with
  // no status field and rows using 'active'/'approved', hiding real published
  // content from customers. See isPubliclyVisible(). Category filter is
  // in-memory too, so it stays case-insensitive.
  if (method === 'GET' && path === '/faq') {
    const auth = await requireManagerOrMaster(req);
    const categoryFilter = req.query?.category;

    let items;
    if (auth.ok) {
      // Never cache the authenticated view. A manager has to see the article they
      // just imported or published, not a copy up to five minutes old.
      const snap = await db.collection(FAQ_COL).get();
      items = snap.docs
        .map(d => d.data())
        .map(a => ({ ...a, title: sanitizeText(a.title, 300), category: sanitizeText(a.category, 100) }));
      items.sort((a, b) => (a.sortOrder ?? 999999) - (b.sortOrder ?? 999999));
    } else {
      items = await getPublicFaqList();   // shared, pre-sorted — do not mutate
    }
    if (categoryFilter) {
      const filterLower = String(categoryFilter).toLowerCase();
      items = items.filter(i => i.category?.toLowerCase() === filterLower);  // new array
    }
    return r(200, items);
  }

  // ── GET /faq/search?q=... ─────────────────────────────────────────────────
  // Smart KB search: returns top N articles ranked by relevance to query.
  // Public endpoint — only returns published articles.
  // Scoring: title (10x, literal > synonym, IDF-lite downweight for common words)
  //   > category (3x) > content (1x), with full-phrase title boost, typo-tolerant
  //   fuzzy fallback, colloquial-phrase + synonym expansion, and a relevance floor
  //   so out-of-domain / barely-related queries return an explicit empty set.
  //
  // Articles are served from an in-memory cache (5-min TTL, invalidated on
  // writes) so the common search path makes zero Firestore reads.
  if (method === 'GET' && path === '/faq/search') {
    const searchIp = sourceIp(req);
    const searchRl = checkRateLimit(`search:${searchIp}`, 30, 60);
    if (!searchRl.allowed) {
      res.set('Retry-After', String(searchRl.retryAfterSecs));
      return r(429, { error: 'Too many requests. Please slow down.' });
    }
    const q = String(req.query?.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query?.limit || '5', 10) || 5, 20);
    // Min 3 chars: 1-2 char queries ("ac", "mt") only ever return substring noise.
    if (!q || q.length < 3) return r(200, { results: [], total: 0, query: q });

    // Normalise colloquial phrases ("cash out" -> "withdraw", "sign in" -> "login")
    // before tokenising, so everyday wording maps onto the KB's domain terms.
    let qNorm = q;
    for (const [re, canon] of SEARCH_PHRASES) qNorm = qNorm.replace(re, canon);

    // Split query into individual words for multi-word matching.
    // Drop stop-words so filler ("what can you do") doesn't match noise; keep meaningful terms.
    const STOPWORDS = new Set(['the','is','a','an','of','to','for','in','on','at','my','me','do','does','you','your','can','could','how','what','where','when','why','which','who','are','am','was','be','will','should','would','if','it','this','that','and','or','with','about','from','as','by','i']);
    const words = qNorm.split(/\s+/).filter(w => w.length >= 2 && !STOPWORDS.has(w));
    if (words.length === 0) return r(200, { results: [], total: 0, query: q });

    // Capped Levenshtein + token fuzzy-match for typo tolerance ("withdrawl" -> "withdrawal").
    const lev = (a, b) => {
      const m = a.length, n = b.length;
      if (Math.abs(m - n) > 2) return 3;
      let prev = Array.from({ length: n + 1 }, (_, j) => j);
      for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
      }
      return prev[n];
    };
    const fuzzyInTokens = (word, tokens) => {
      const tol = word.length >= 6 ? 2 : 1;
      const wp = word.slice(0, 2);
      for (const t of tokens) {
        // Require a shared 2-char prefix before a fuzzy match: keeps real typos
        // (witdraw->withdraw, brokrage->brokerage, trding->trading) but drops
        // out-of-domain near-misses like "weather"->"whether".
        if (t.slice(0, 2) !== wp) continue;
        if (Math.abs(t.length - word.length) <= tol && lev(word, t) <= tol) return true;
      }
      return false;
    };

    // Each query word -> a "group": the literal word plus its synonyms, pre-compiled
    // to prefix-of-word matchers. A literal hit outscores a synonym-only hit.
    const groups = words.map(w => ({
      primary: w,
      primRe:  wordStartRe(w),
      synRes:  (SYNONYMS[w] || []).map(wordStartRe),
    }));

    // Fetch from cache (or Firestore on miss). Pre-computed lowercase fields
    // (_titleLow, _categoryLow, _contentLow) are used directly — no per-query
    // toLowerCase() or HTML stripping.
    const articles = await getPublishedArticles();
    const { df, n: docCount } = getSearchDF(articles);
    const multi = groups.length > 1;
    // IDF-lite: common words ("trading","account") get a smaller title weight so
    // they don't dominate multi-word queries. Single-word queries stay full-weight.
    const idf = (w) => {
      if (!multi) return 1;
      const f = (df.get(w) || 0) / docCount;
      if (f > 0.30) return 0.25;
      if (f > 0.15) return 0.6;
      return 1;
    };

    const scored = articles.map(article => {
      const title    = article._titleLow;
      const category = article._categoryLow;
      const content  = article._contentLow;

      let score = 0;
      let matched = 0;
      let titleTokens = null;
      const hitPos = [];

      for (const g of groups) {
        const litTitle = g.primRe.test(title);
        const litCat   = g.primRe.test(category);
        let cPos = -1; { const m = content.match(g.primRe); if (m) cPos = m.index; }
        let synTitle = false, synCat = false;
        for (const re of g.synRes) {
          if (!litTitle && !synTitle && re.test(title)) synTitle = true;
          if (!litCat   && !synCat   && re.test(category)) synCat = true;
          if (cPos < 0) { const m = content.match(re); if (m) cPos = m.index; }
        }
        const inTitle = litTitle || synTitle, inCat = litCat || synCat, inContent = cPos >= 0;
        if (inTitle || inCat || inContent) {
          matched++;
          if (inTitle) score += (litTitle ? 10 : 7) * idf(g.primary);
          if (inCat)   score += litCat ? 3 : 2;
          if (inContent) { score += 1; hitPos.push(cPos); }
        } else if (g.primary.length >= 4) {
          // No literal/synonym match — try a typo-tolerant match against title + category tokens.
          if (titleTokens === null) titleTokens = (title + ' ' + category).split(/\s+/).filter(Boolean);
          if (fuzzyInTokens(g.primary, titleTokens)) { matched++; score += 6; }
        }
      }

      // Boost: exact full-phrase match in title is the strongest signal.
      if (title.includes(qNorm))    score += 25;
      if (category.includes(qNorm)) score += 8;

      // Penalty: only some query words matched (likely less relevant).
      if (matched < groups.length) score = score * (matched / groups.length);

      // Snippet: pick the densest match region (most hits nearby), not just the
      // first match, and trim to word boundaries so it starts/ends cleanly.
      let snippet = '';
      if (content) {
        let center = -1;
        if (hitPos.length) {
          let best = -1;
          for (const p of hitPos) {
            const near = hitPos.filter(o => o >= p - 40 && o <= p + 180).length;
            if (near > best) { best = near; center = p; }
          }
        }
        if (center >= 0) {
          let start = Math.max(0, center - 50);
          let end   = Math.min(content.length, center + 150);
          if (start > 0) { const sp = content.indexOf(' ', start); if (sp >= 0 && sp < center) start = sp + 1; }
          if (end < content.length) { const sp = content.lastIndexOf(' ', end); if (sp > center) end = sp; }
          snippet = (start > 0 ? '…' : '') + content.slice(start, end).trim() + (end < content.length ? '…' : '');
        } else {
          snippet = content.slice(0, 150).trim() + (content.length > 150 ? '…' : '');
        }
      }

      return {
        id:        article.id,
        title:     article.title,
        category:  article.category,
        snippet,
        updatedAt: article.updatedAt,
        score,
      };
    });

    const ranked = scored.filter(a => a.score > 0).sort((a, b) => b.score - a.score);
    // Relevance floor: once there is a clear top result, drop weak tails (a single
    // incidental hit) so barely-related / out-of-domain noise is filtered out.
    const floor = ranked.length ? Math.max(1, ranked[0].score * 0.12) : 0;
    const results = ranked
      .filter(a => a.score >= floor)
      .slice(0, limit)
      .map(({ score, ...rest }) => rest);

    return r(200, { results, total: results.length, query: q });
  }

  // ── POST /faq ─────────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/faq') {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const { title, category, content, status = 'published', id, sortOrder, importBatch } = body;

    if (id && !title && !content) {
      // Status-only toggle
      if (body.status && !VALID_FAQ_STATUSES.includes(body.status)) return r(400, { error: `Invalid status. Allowed: ${VALID_FAQ_STATUSES.join(', ')}` });
      const existingSnap = await db.collection(FAQ_COL).doc(id).get();
      if (!existingSnap.exists) return r(404, { error: 'Article not found' });
      await db.collection(FAQ_COL).doc(id).update({
        status: body.status || 'published',
        updatedAt: new Date().toISOString(),
      });
      invalidateArticleCache();
      await writeAudit({ action: 'UPDATE_FAQ', entity: 'faq', entityId: id, entityTitle: existingSnap.data().title, performedBy: auth.performedBy, meta: { changes: { status: { from: existingSnap.data().status ?? null, to: body.status || 'published' } } } });
      return r(200, { ok: true });
    }

    if (!title || !category || !content) return r(400, { error: 'title, category, content required' });
    if (title.length > 300) return r(400, { error: 'title too long (max 300 chars)' });
    if (content.length > 50000) return r(400, { error: 'content too long (max 50000 chars)' });
    if (!VALID_FAQ_STATUSES.includes(status)) return r(400, { error: `Invalid status. Allowed: ${VALID_FAQ_STATUSES.join(', ')}` });
    // IDX-001: strip markup/control chars from the plain-text title & category.
    const cleanTitle = sanitizeText(title, 300);
    const cleanCategory = sanitizeText(category, 100);
    if (!cleanTitle) return r(400, { error: 'title must contain valid text' });
    if (!cleanCategory) return r(400, { error: 'category must contain valid text' });
    // Title is the de-facto key managers dedup on (both the CSV import and the
    // Add Article form match on it), so enforce it server-side too: a purely
    // client-side check loses the race between two concurrent imports and there
    // is nothing in the doc id to stop a second copy of the same article.
    const dupSnap = await db.collection(FAQ_COL).where('title', '==', cleanTitle).limit(1).get();
    if (!dupSnap.empty && dupSnap.docs[0].id !== (id || '')) {
      return r(409, { error: `An article titled "${cleanTitle}" already exists` });
    }
    const newId = id || `art-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = new Date().toISOString();
    const item = { id: newId, title: cleanTitle, category: cleanCategory, content, status, createdAt: now, updatedAt: now };
    if (sortOrder !== undefined) item.sortOrder = sortOrder;
    // Optional provenance tag from the bulk importer. Stamping it on the doc (and
    // in the audit entry) is what makes "which articles did that import create?"
    // answerable later — previously there was no way to attribute a row to a run.
    const batch = typeof importBatch === 'string' ? sanitizeText(importBatch, 64) : '';
    if (batch) item.importBatch = batch;
    await db.collection(FAQ_COL).doc(newId).set(item);
    invalidateArticleCache();
    await writeAudit({ action: 'CREATE_FAQ', entity: 'faq', entityId: newId, entityTitle: cleanTitle, performedBy: auth.performedBy, meta: { category: cleanCategory, status, ...(batch ? { importBatch: batch } : {}) } });
    return r(201, { id: newId, ok: true });
  }

  // ── PUT /faq/{id} ─────────────────────────────────────────────────────────
  const faqPutMatch = path.match(/^\/faq\/([^/]+)$/);
  if (method === 'PUT' && faqPutMatch) {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const id = faqPutMatch[1];
    const { title, category, content, status, sortOrder } = body;

    // Reject empty body PUTs
    if (!title && !category && !content && status === undefined && sortOrder === undefined) return r(400, { error: 'Nothing to update' });

    if (status !== undefined && !VALID_FAQ_STATUSES.includes(status)) {
      return r(400, { error: `Invalid status. Allowed: ${VALID_FAQ_STATUSES.join(', ')}` });
    }

    const existingSnap = await db.collection(FAQ_COL).doc(id).get();
    if (!existingSnap.exists) return r(404, { error: 'Article not found' });

    const updateData = { updatedAt: new Date().toISOString() };
    if (title) {
      const cleanTitle = sanitizeText(title, 300);   // IDX-001
      if (!cleanTitle) return r(400, { error: 'title must contain valid text' });
      updateData.title = cleanTitle;
    }
    if (category) updateData.category = sanitizeText(category, 100);
    if (content) updateData.content = content;
    if (status !== undefined) updateData.status = status;
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

    await db.collection(FAQ_COL).doc(id).update(updateData);
    invalidateArticleCache();
    const faqChanges = buildChangeSet(existingSnap.data(), updateData, ['title', 'category', 'content', 'status', 'sortOrder']);
    await writeAudit({ action: 'UPDATE_FAQ', entity: 'faq', entityId: id, entityTitle: title || existingSnap.data().title || id, performedBy: auth.performedBy, meta: { fieldsChanged: Object.keys(faqChanges), changes: faqChanges } });
    return r(200, { ok: true });
  }

  // ── DELETE /faq/{id} ──────────────────────────────────────────────────────
  const faqDeleteMatch = path.match(/^\/faq\/([^/]+)$/);
  if (method === 'DELETE' && faqDeleteMatch) {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const id = faqDeleteMatch[1];
    const existingSnap = await db.collection(FAQ_COL).doc(id).get();
    if (!existingSnap.exists) return r(404, { error: 'Article not found' });
    const title = existingSnap.data().title || id;
    const deletedSnapshot = auditSnapshot(existingSnap.data(), ['title', 'category', 'content', 'status']);
    await db.collection(FAQ_COL).doc(id).delete();
    invalidateArticleCache();
    await writeAudit({ action: 'DELETE_FAQ', entity: 'faq', entityId: id, entityTitle: title, performedBy: auth.performedBy, meta: { deleted: deletedSnapshot } });
    return r(200, { ok: true });
  }

  // ── GET /tickets ──────────────────────────────────────────────────────────
  // Returns all tickets, newest first. Uses Firestore orderBy() for the
  // sort so we don't load + sort the entire collection in memory.
  if (method === 'GET' && path === '/tickets') {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const snap = await db.collection(TICKETS_COL).orderBy('createdAt', 'desc').get();
    const items = snap.docs.map(d => d.data());
    await writeAudit({
      action: 'TICKETS_VIEWED', entity: 'ticket', entityId: 'all',
      entityTitle: `${items.length} tickets`, performedBy: auth.performedBy,
      meta: { count: items.length },
    });
    return r(200, items);
  }

  // ── POST /tickets ─────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/tickets') {
    // Rate limit: 5 tickets per IP per minute (prevents spam without blocking
    // legitimate users who might re-submit)
    const tkIp = sourceIp(req);
    const tkRl = checkRateLimit(`ticket:${tkIp}`, 5, 60);
    if (!tkRl.allowed) {
      res.set('Retry-After', String(tkRl.retryAfterSecs));
      return r(429, { error: 'Too many ticket submissions. Please wait a moment.' });
    }

    const { name, email, category, subject, description, status = 'open', createdAt, sessionId, phone } = body;

    // Required field validation
    if (!name || !email || !subject) return r(400, { error: 'name, email, subject required' });

    // Whitespace-only check
    if (!name.trim()) return r(400, { error: 'name cannot be blank' });
    if (!subject.trim()) return r(400, { error: 'subject cannot be blank' });
    if (description !== undefined && description !== null && !String(description).trim()) return r(400, { error: 'description cannot be blank' });

    // Length limits
    if (name.trim().length > 100) return r(400, { error: 'name too long (max 100 chars)' });
    if (subject.length > 300) return r(400, { error: 'subject too long (max 300 chars)' });
    if (description && description.length > 5000) return r(400, { error: 'description too long (max 5000 chars)' });

    // Email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return r(400, { error: 'Invalid email format' });

    // Phone format (optional field — if provided must be digits/spaces/+/-)
    if (phone !== undefined && phone !== null && phone !== '') {
      if (!/^[+\d\s\-()]{7,20}$/.test(String(phone))) return r(400, { error: 'Invalid phone format' });
    }

    // Category allow-list (optional, defaults to Other)
    const resolvedCategory = category || 'Other';
    if (!ALLOWED_TICKET_CATEGORIES.includes(resolvedCategory)) {
      return r(400, { error: `Invalid category. Allowed: ${ALLOWED_TICKET_CATEGORIES.join(', ')}` });
    }

    // Status check
    if (status !== 'open' && !VALID_TICKET_STATUSES.includes(status)) return r(400, { error: 'Invalid ticket status' });

    const ticketId = `TIC-${Math.floor(100000 + Math.random() * 900000)}`;
    const now = new Date().toISOString();
    const ticketItem = {
      id: ticketId, name: name.trim(), email, category: resolvedCategory,
      subject: subject.trim(), description: description ? String(description).trim() : '',
      status,
      createdAt: now, date: now.slice(0, 10),
      ipAddress: sourceIp(req),
      userAgent: userAgent(req),
      sessionId: sessionId || 'unknown',
    };
    if (phone) ticketItem.phone = String(phone).trim();
    await db.collection(TICKETS_COL).doc(ticketId).set(ticketItem);
    await writeAudit({
      action: 'CREATE_TICKET', entity: 'ticket',
      entityId: ticketId, entityTitle: subject,
      performedBy: 'public', meta: { name, email, category: resolvedCategory, ip: sourceIp(req) },
    });
    return r(201, { id: ticketId, ok: true });
  }

  // ── POST /feedback (public) ───────────────────────────────────────────────
  // Site-wide feedback. Public, rate-limited, and profanity-filtered server-side.
  if (method === 'POST' && path === '/feedback') {
    const fbIp = sourceIp(req);
    const fbRl = checkRateLimit(`feedback:${fbIp}`, 5, 60);
    if (!fbRl.allowed) {
      res.set('Retry-After', String(fbRl.retryAfterSecs));
      return r(429, { error: 'Too many submissions. Please wait a moment.' });
    }
    const message = String(body?.message ?? '').replace(/<[^>]+>/g, '').trim();
    const page = String(body?.page ?? '').slice(0, 300);
    if (!message)              return r(400, { error: 'Feedback message is required.' });
    if (message.length < 3)    return r(400, { error: 'Please add a little more detail.' });
    if (message.length > 2000) return r(400, { error: 'Feedback too long (max 2000 characters).' });
    if (containsProfanity(message)) {
      return r(400, { error: 'Please remove inappropriate language and resubmit your feedback.' });
    }
    // Strip any PII before storing — feedback is anonymous and must not retain
    // PAN / Aadhaar / card / account / phone / email.
    const cleanMessage = redactPII(message);
    const fbId = `FB-${Math.floor(100000 + Math.random() * 900000)}`;
    const now = new Date().toISOString();
    await db.collection(FEEDBACK_COL).doc(fbId).set({
      id: fbId, message: cleanMessage, page, status: 'new',
      createdAt: now, date: now.slice(0, 10),
      ipAddress: fbIp, userAgent: userAgent(req),
    });
    await writeAudit({
      action: 'CREATE_FEEDBACK', entity: 'feedback', entityId: fbId,
      entityTitle: cleanMessage.slice(0, 60), performedBy: 'public', meta: { page, ip: fbIp },
    });
    return r(201, { id: fbId, ok: true });
  }

  // ── GET /feedback (admin / master) ────────────────────────────────────────
  if (method === 'GET' && path === '/feedback') {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const snap = await db.collection(FEEDBACK_COL).orderBy('createdAt', 'desc').get();
    return r(200, snap.docs.map(d => d.data()));
  }

  // ── DELETE /feedback/{id} (admin / master) ────────────────────────────────
  const feedbackDeleteMatch = path.match(/^\/feedback\/([^/]+)$/);
  if (method === 'DELETE' && feedbackDeleteMatch) {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const fbId = feedbackDeleteMatch[1];
    const existingSnap = await db.collection(FEEDBACK_COL).doc(fbId).get();
    if (!existingSnap.exists) return r(404, { error: 'Feedback not found' });
    await db.collection(FEEDBACK_COL).doc(fbId).delete();
    await writeAudit({ action: 'DELETE_FEEDBACK', entity: 'feedback', entityId: fbId, entityTitle: (existingSnap.data().message || '').slice(0, 60), performedBy: auth.performedBy });
    return r(200, { ok: true });
  }

  // ── PUT /tickets/{id} ─────────────────────────────────────────────────────
  const ticketPutMatch = path.match(/^\/tickets\/([^/]+)$/);
  if (method === 'PUT' && ticketPutMatch) {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const id = ticketPutMatch[1];

    // Reject empty body PUTs
    if (!body.status && !body.notes && !body.assignedTo) return r(400, { error: 'Nothing to update' });

    const existingSnap = await db.collection(TICKETS_COL).doc(id).get();
    if (!existingSnap.exists) return r(404, { error: 'Ticket not found' });
    const existing = existingSnap.data();
    const oldStatus = existing.status;
    const newStatus = body.status || oldStatus;
    if (!VALID_TICKET_STATUSES.includes(newStatus)) return r(400, { error: 'Invalid status. Allowed: open, in_progress, solved, resolved' });
    await db.collection(TICKETS_COL).doc(id).update({
      status: newStatus,
      updatedAt: new Date().toISOString(),
    });
    await writeAudit({
      action: 'UPDATE_TICKET', entity: 'ticket',
      entityId: id, entityTitle: existing.subject || id,
      performedBy: auth.performedBy,
      meta: { oldStatus, newStatus },
    });
    return r(200, { ok: true });
  }

  // ── GET /audit-log ─────────────────────────────────────────────────────────
  // Supports date-range filtering and "load older" pagination so history is no
  // longer hidden behind a fixed cap. `timestamp` is an ISO-8601 string, so
  // lexicographic range comparisons are chronological.
  //   ?from=ISO   inclusive lower bound (oldest to include)
  //   ?to=ISO     inclusive upper bound (newest to include)
  //   ?before=ISO inclusive cursor for the next older page (client dedups)
  //   ?limit=N    page size (manager ≤500, master ≤1000)
  // Response stays a plain array (newest first); callers page by passing the
  // oldest returned timestamp back as `before`. All range filters stay on the
  // single `timestamp` field, so the existing (performedBy, timestamp) index
  // covers the manager path and no new index is required.
  if (method === 'GET' && path === '/audit-log') {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });

    const from   = req.query?.from   ? String(req.query.from)   : null;
    const to     = req.query?.to     ? String(req.query.to)     : null;
    const before = req.query?.before ? String(req.query.before) : null;
    const isManager = auth.role === 'manager';
    const cap = isManager ? 500 : 1000;
    // Clamp to [1, cap] so a malformed or negative ?limit can't throw.
    const limit = Math.min(Math.max(parseInt(req.query?.limit || String(cap), 10) || cap, 1), cap);

    let query = db.collection(AUDIT_COL);
    // Managers only ever see their own entries (unchanged behaviour).
    if (isManager) query = query.where('performedBy', '==', auth.performedBy);
    if (from)   query = query.where('timestamp', '>=', from);
    if (to)     query = query.where('timestamp', '<=', to);
    // Inclusive cursor: callers pass the oldest loaded timestamp as `before`.
    // The boundary row re-appears but the client dedups by id, and same-
    // timestamp siblings at the boundary are no longer skipped.
    if (before) query = query.where('timestamp', '<=', before);
    query = query.orderBy('timestamp', 'desc').limit(limit);

    const snap = await query.get();
    return r(200, snap.docs.map(d => d.data()));
  }

  // ── GET /categories ──────────────────────────────────────────────────────
  // Returns all categories sorted by sortOrder. Sort pushed to Firestore.
  if (method === 'GET' && path === '/categories') {
    const snap = await db.collection(CATEGORIES_COL).orderBy('sortOrder', 'asc').get();
    const items = snap.docs.map(d => d.data());
    return r(200, items);
  }

  // ── POST /categories ──────────────────────────────────────────────────────
  if (method === 'POST' && path === '/categories') {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const { name, icon, parentId, sortOrder, description } = body;
    if (!name || !name.trim()) return r(400, { error: 'name required' });
    if (name.length > 100) return r(400, { error: 'name too long (max 100 chars)' });
    if (description && String(description).length > 120) return r(400, { error: 'description too long (max 120 chars)' });
    const id = `cat-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = new Date().toISOString();
    await db.collection(CATEGORIES_COL).doc(id).set({
      id,
      name: name.trim(),
      icon: icon || 'fas fa-folder',
      parentId: parentId || null,
      description: description ? String(description).replace(/<[^>]+>/g, '').trim() : '',
      sortOrder: sortOrder ?? 999999,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit({ action: 'CREATE_CATEGORY', entity: 'category', entityId: id, entityTitle: name.trim(), performedBy: auth.performedBy, meta: { parentId: parentId || 'none' } });
    return r(201, { id, ok: true });
  }

  // ── PUT /categories/{id} ──────────────────────────────────────────────────
  const catPutMatch = path.match(/^\/categories\/([^/]+)$/);
  if (method === 'PUT' && catPutMatch) {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const catId = catPutMatch[1];
    const existingSnap = await db.collection(CATEGORIES_COL).doc(catId).get();
    if (!existingSnap.exists) return r(404, { error: 'Category not found' });
    const updateData = { updatedAt: new Date().toISOString() };
    if (body.name) updateData.name = body.name.trim();
    if (body.icon !== undefined) updateData.icon = body.icon;
    if (body.description !== undefined) {
      if (String(body.description).length > 120) return r(400, { error: 'description too long (max 120 chars)' });
      updateData.description = String(body.description).replace(/<[^>]+>/g, '').trim();
    }
    if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;
    if (body.status !== undefined) {
      if (!['active', 'inactive'].includes(body.status)) return r(400, { error: 'Invalid status' });
      updateData.status = body.status;
    }
    await db.collection(CATEGORIES_COL).doc(catId).update(updateData);
    const catChanges = buildChangeSet(existingSnap.data(), updateData, ['name', 'icon', 'description', 'sortOrder', 'status']);
    await writeAudit({ action: 'UPDATE_CATEGORY', entity: 'category', entityId: catId, entityTitle: body.name || existingSnap.data().name, performedBy: auth.performedBy, meta: { fieldsChanged: Object.keys(catChanges), changes: catChanges } });
    return r(200, { ok: true });
  }

  // ── DELETE /categories/{id} ───────────────────────────────────────────────
  const catDeleteMatch = path.match(/^\/categories\/([^/]+)$/);
  if (method === 'DELETE' && catDeleteMatch) {
    const auth = await requireManagerOrMaster(req);
    if (!auth.ok) return r(auth.reason === 'deactivated' ? 403 : 401, { error: auth.reason === 'deactivated' ? 'Account deactivated' : 'Unauthorized' });
    const catId = catDeleteMatch[1];
    const existingSnap = await db.collection(CATEGORIES_COL).doc(catId).get();
    if (!existingSnap.exists) return r(404, { error: 'Category not found' });
    const deletedCat = auditSnapshot(existingSnap.data(), ['name', 'icon', 'description', 'parentId', 'status']);
    await db.collection(CATEGORIES_COL).doc(catId).delete();
    await writeAudit({ action: 'DELETE_CATEGORY', entity: 'category', entityId: catId, entityTitle: existingSnap.data().name, performedBy: auth.performedBy, meta: { deleted: deletedCat } });
    return r(200, { ok: true });
  }

  return r(404, { error: 'Not found' });
}
