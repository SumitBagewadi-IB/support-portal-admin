'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { API_BASE } from '@/lib/api';
import { STATIC_CATEGORY_NAMES as FALLBACK_CATEGORIES } from '@/lib/constants';
import { parseValidJwt } from '@/lib/jwt';

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 900; // 15 minutes — matches server-side lockout
const PAGE_SIZE = 10;
const MAX_CONTENT = 50000;
const WARN_CONTENT = 45000;
const TICKETS_PAGE_SIZE = 10;
// Non-secret Google OAuth Web client ID for "Sign in with Google" (build-time).
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';

// Minimal shape of the Google Identity Services API we use.
type GsiApi = { accounts: { id: {
  initialize: (cfg: Record<string, unknown>) => void;
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
} } };

interface Category {
  id: string;
  name: string;
  icon: string;
  parentId: string | null;
  description?: string;
  sortOrder?: number;
  status?: string;
}

interface Article {
  id: string;
  title: string;
  question?: string;
  category: string;
  content: string;
  answer?: string;
  status?: string;
  sortOrder?: number;
}

interface Ticket {
  id: string;
  name: string;
  email: string;
  category: string;
  subject: string;
  status: string;
  date: string;
  description?: string;
  message?: string;
  phone?: string;
}

interface Feedback {
  id: string;
  message: string;
  page?: string;
  status?: string;
  createdAt?: string;
  date?: string;
}

// Mirrors VALID_FAQ_STATUSES on the API — validated in the CSV preview so a bad
// `status` cell is reported as a skipped row instead of 100 opaque HTTP 400s.
const VALID_STATUSES = ['published', 'draft'];

// Mirrors PUBLIC_FAQ_STATUSES in gcp/index.mjs. Anything that isn't an explicit
// draft is live for customers — legacy rows have no status, or use
// 'active'/'approved'. Counting only status === 'published' left those rows out
// of both stat cards and out of both status filters.
const isLive = (status?: string) => !status || status === 'published' || status === 'active' || status === 'approved';

// Titles are the dedup key, so normalise the way a human reads them: trim, fold
// case, and collapse runs of whitespace. Without the whitespace collapse,
// "What is  X?" and "What is X?" import as two separate articles.
const normTitle = (t?: string) => (t || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Excel in several locales exports semicolon-separated CSV, and pasting from
// Google Sheets gives tabs. Both used to parse as a single column and surfaced as
// the misleading "CSV needs title, category and content columns".
const detectDelimiter = (text: string): string => {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
  const scored = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  scored.sort((a, b) => b.n - a.n);
  return scored[0].n > 0 ? scored[0].d : ',';
};

// One parsed CSV row. `row` is the ORIGINAL 1-based line number in the user's
// file, so "Row 37" points at line 37 in their spreadsheet even when blank
// lines were dropped during parsing.
interface ImportRow {
  row: number;
  title: string;
  category: string;
  content: string;
  status: string;
}
// A rejected row keeps its parsed values, not just the reason, so the whole
// reject set can be re-exported as a fixable CSV instead of being retyped.
interface ImportIssue extends ImportRow {
  reason: string;
}
// A row whose title already exists in the knowledge base. Carries the existing
// doc id so the import can update it in place instead of only ever skipping it.
interface ImportDup extends ImportRow {
  existingId: string;
  existingStatus: string;
}

const emptyForm = { title: '', category: '', content: '', status: 'published' };

export default function AdminPage() {
  // Auth — lazy-init from sessionStorage to avoid login flash on hard refresh
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [managerToken, setManagerToken] = useState('');
  const [managerInfo, setManagerInfo] = useState<{ managerId: string; displayName: string; role: string } | null>(null);
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  // Sign in with Google is the only admin login (password fallback removed).
  const googleBtnRef = useRef<HTMLDivElement | null>(null);
  // Google Identity Services load state so a blocked/slow script surfaces an
  // actionable error + retry instead of a blank button area.
  const [gsiState, setGsiState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [gsiRetry, setGsiRetry] = useState(0);
  // "Signing you in…" feedback while the token exchange is in flight, plus a
  // welcome toast on landing so the user clearly feels they're signed in.
  const [signingIn, setSigningIn] = useState(false);
  const pendingWelcomeRef = useRef<string | null>(null);
  // The mirror image on the way out: a blocking "Signing you out…" overlay while
  // the session is torn down, then an explicit confirmation on the login card so
  // the user can see the account is actually signed out — not just that the
  // dashboard vanished.
  // `signedOut` is what drives the confirmation — kept separate from the name so
  // the confirmation still shows for an account with no display name.
  const [signingOut, setSigningOut] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [signedOutName, setSignedOutName] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [sessionWarning, setSessionWarning] = useState(false);
  const sessionWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lockoutSecsLeft, setLockoutSecsLeft] = useState(0);
  const lockoutTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Articles
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [error, setError] = useState('');

  // Form
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formMsg, setFormMsg] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [page, setPage] = useState(1);

  // Modals
  const [previewArticle, setPreviewArticle] = useState<Article | null>(null);
  const [previewTicket, setPreviewTicket] = useState<Ticket | null>(null);

  // Sidebar view
  const [activeView, setActiveView] = useState<'articles' | 'add' | 'tickets' | 'audit' | 'categories' | 'feedback'>('articles');

  // Categories
  const [dynamicCategories, setDynamicCategories] = useState<Category[]>([]);
  const [catLoading, setCatLoading] = useState(false);
  const [catError, setCatError] = useState('');
  const [catForm, setCatForm] = useState({ name: '', icon: 'fas fa-folder', parentId: '', description: '' });
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [catFormMsg, setCatFormMsg] = useState('');
  const [catSubmitting, setCatSubmitting] = useState(false);
  const [deletingCatId, setDeletingCatId] = useState<string | null>(null);
  // Name of the category being turned into a record, or '__all__' for the batch.
  const [adoptingCat, setAdoptingCat] = useState<string | null>(null);

  // Audit log
  const [auditLogs, setAuditLogs] = useState<{ id: string; timestamp: string; action: string; entity: string; entityId: string; entityTitle: string; performedBy: string; meta?: Record<string, string> }[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Tickets
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState('');

  // Feedback
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackConfirmId, setFeedbackConfirmId] = useState<string | null>(null);
  const [feedbackDeletingId, setFeedbackDeletingId] = useState<string | null>(null);

  // Mobile sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Dark mode
  const [darkMode, setDarkMode] = useState(false);
  // Status filter
  const [statusFilter, setStatusFilter] = useState('');
  // Sort
  const [sortBy, setSortBy] = useState<'default' | 'title' | 'category'>('default');
  const [orderChanged, setOrderChanged] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [reorderCategory, setReorderCategory] = useState<string>('');
  // Delete confirm modal
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // Toast notification
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bulk CSV import
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importPreview, setImportPreview] = useState<{ valid: ImportRow[]; duplicates: ImportDup[]; issues: ImportIssue[]; newCategories: string[]; delimiter: string } | null>(null);
  // What to do with rows whose title already exists: leave them alone (default,
  // so a re-upload is never destructive) or overwrite them from the file.
  const [importMode, setImportMode] = useState<'skip' | 'update'>('skip');
  // What a row with an EMPTY status cell becomes. Defaults to draft (safe), but
  // the choice is now shown and counted in the preview: an all-blank status column
  // silently turning 182 articles into invisible drafts is the exact failure this
  // replaces. Applies to NEW rows only — updating an existing article never
  // changes its status unless the file says so explicitly.
  const [blankStatusMode, setBlankStatusMode] = useState<'draft' | 'published'>('draft');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0 });
  const [importResult, setImportResult] = useState<{ created: number; updated: number; failed: { row: number; title: string; reason: string }[]; cancelled: boolean } | null>(null);
  // Set by the Cancel button so a long import can be stopped without leaving the
  // operator guessing how far it got — the result modal still reports the batch.
  const importAbortRef = useRef(false);
  // Bulk actions: reviewing 300+ drafts one toggle at a time is not a workflow.
  // Publish and unpublish are reversible; delete is not, so it is gated behind a
  // type-the-count confirmation and is only offered when a filter is active — the
  // whole library must never be one click from deletion.
  const [bulkAction, setBulkAction] = useState<'publish' | 'unpublish' | 'delete' | null>(null);
  const [bulkConfirmText, setBulkConfirmText] = useState('');
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  // Ticket search + pagination
  const [ticketSearch, setTicketSearch] = useState('');
  const [ticketPage, setTicketPage] = useState(1);

  // Auth effects — restore JWT session synchronously before first paint
  useEffect(() => {
    const token = sessionStorage.getItem('mgr_token');
    const info = sessionStorage.getItem('mgr_info');
    if (token && info) {
      const payload = parseValidJwt(token);
      if (payload && payload.exp) {
        setManagerToken(token);
        try { setManagerInfo(JSON.parse(info)); } catch { /* ignore bad info */ }
        setSessionExpiresAt(payload.exp);
        setAuthed(true);
      } else {
        sessionStorage.removeItem('mgr_token');
        sessionStorage.removeItem('mgr_info');
      }
    }
    const theme = localStorage.getItem('theme');
    if (theme === 'dark') setDarkMode(true);
    setAuthChecked(true);
  }, []);

  useEffect(() => {
    if (lockoutUntil) {
      const tick = () => {
        const remaining = Math.ceil((lockoutUntil - Date.now()) / 1000);
        if (remaining <= 0) {
          setLockoutUntil(null);
          setLockoutSecsLeft(0);
          if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current);
        } else {
          setLockoutSecsLeft(remaining);
        }
      };
      tick();
      lockoutTimerRef.current = setInterval(tick, 1000);
      return () => { if (lockoutTimerRef.current) clearInterval(lockoutTimerRef.current); };
    }
  }, [lockoutUntil]);

  // Session expiry warning — show banner 5 minutes before token expires
  useEffect(() => {
    if (!sessionExpiresAt) return;
    const msUntilWarning = (sessionExpiresAt * 1000) - Date.now() - 5 * 60 * 1000;
    if (msUntilWarning <= 0) { setSessionWarning(true); return; }
    sessionWarningTimerRef.current = setTimeout(() => setSessionWarning(true), msUntilWarning);
    return () => { if (sessionWarningTimerRef.current) clearTimeout(sessionWarningTimerRef.current); };
  }, [sessionExpiresAt]);

  const authHeaders = useCallback((token: string) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  }), []);

  const fetchTickets = useCallback((token: string) => {
    if (!API_BASE) return;
    setTicketsLoading(true);
    setTicketsError('');
    fetch(`${API_BASE}/tickets`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((data) => setTickets(Array.isArray(data) ? data : []))
      .catch(() => setTicketsError('Could not load tickets. Check your connection or API config.'))
      .finally(() => setTicketsLoading(false));
  }, []);

  const fetchFeedback = useCallback((token: string) => {
    if (!API_BASE) return;
    setFeedbackLoading(true);
    setFeedbackError('');
    fetch(`${API_BASE}/feedback`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((data) => setFeedback(Array.isArray(data) ? data : []))
      .catch(() => setFeedbackError('Could not load feedback. Check your connection or API config.'))
      .finally(() => setFeedbackLoading(false));
  }, []);

  const deleteFeedback = async (id: string) => {
    if (!API_BASE) return;
    setFeedbackDeletingId(id);
    try {
      const res = await fetch(`${API_BASE}/feedback/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${managerToken}` } });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (!res.ok) throw new Error(`${res.status}`);
      setFeedback((prev) => prev.filter((f) => f.id !== id));
      setFeedbackConfirmId(null);
      showToast('Feedback deleted');
    } catch {
      showToast('Could not delete feedback. Try again.');
    } finally {
      setFeedbackDeletingId(null);
    }
  };

  const handleSessionExpired = useCallback(() => {
    setManagerToken('');
    setAuthed(false);
    setSessionWarning(false);
    setSessionExpiresAt(null);
    sessionStorage.removeItem('mgr_token');
    sessionStorage.removeItem('mgr_info');
    setAuthError('Your session has expired. Please log in again.');
  }, []);

  const fetchAuditLogs = useCallback((token: string) => {
    if (!API_BASE) return;
    setAuditLoading(true);
    fetch(`${API_BASE}/audit-log`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then((r) => {
        if (r.status === 401) { handleSessionExpired(); return []; }
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => { if (data) setAuditLogs(Array.isArray(data) ? data : []); })
      .catch(() => {})
      .finally(() => setAuditLoading(false));
  }, [handleSessionExpired]);

  const fetchCategories = useCallback(async () => {
    if (!API_BASE) return;
    setCatLoading(true);
    setCatError('');
    try {
      const res = await fetch(`${API_BASE}/categories`);
      if (res.ok) setDynamicCategories(await res.json());
      else setCatError('Failed to load categories.');
    } catch { setCatError('Could not reach API.'); }
    finally { setCatLoading(false); }
  }, []);

  useEffect(() => {
    if (authed && managerToken) {
      fetchTickets(managerToken);
      fetchFeedback(managerToken);
      fetchAuditLogs(managerToken);
      fetchCategories();
    }
  }, [authed, managerToken, fetchTickets, fetchFeedback, fetchAuditLogs, fetchCategories]);

  // Receives the Google ID token from the Sign-in button, exchanges it for our
  // manager session, and signs in. Master admins are allowed here too (their
  // token doubles as a manager token), so they can use both portals.
  const handleGoogleCredential = useCallback(async (resp: { credential?: string }) => {
    if (!resp?.credential) return;
    setAuthError('');
    setSignedOut(false);
    setSignedOutName('');
    setSigningIn(true);
    try {
      const res = await fetch(`${API_BASE}/auth/google`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: resp.credential }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setAuthError(data.error || 'Google sign-in failed.'); setSigningIn(false); return; }
      setManagerToken(data.token);
      setManagerInfo({ managerId: data.managerId || data.email, displayName: data.displayName, role: data.role });
      sessionStorage.setItem('mgr_token', data.token);
      sessionStorage.setItem('mgr_info', JSON.stringify({ managerId: data.managerId || data.email, displayName: data.displayName, role: data.role }));
      pendingWelcomeRef.current = data.displayName || data.email || 'there';
      setAuthed(true);
    } catch { setAuthError('Network error. Please try again.'); setSigningIn(false); }
  }, []);

  // Load Google Identity Services and render the sign-in button. Surfaces a
  // clear error + retry if the script is blocked/slow, so an ad-blocker or
  // network hiccup can't leave the user stranded on a blank login card.
  useEffect(() => {
    if (authed || !GOOGLE_CLIENT_ID) return;
    let cancelled = false;
    setGsiState('loading');
    const fail = () => { if (!cancelled) setGsiState('error'); };
    const render = () => {
      if (cancelled) return;
      const g = (window as unknown as { google?: GsiApi }).google;
      if (!g?.accounts?.id || !googleBtnRef.current) { fail(); return; }
      try {
        g.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential, hd: 'indiabulls.com', auto_select: false });
        googleBtnRef.current.innerHTML = '';
        g.accounts.id.renderButton(googleBtnRef.current, { theme: 'filled_blue', size: 'large', width: 320, text: 'signin_with', shape: 'rectangular' });
        setGsiState('ready');
      } catch { fail(); }
    };
    // Watchdog: if it hasn't rendered in time, show the retry path.
    const watchdog = setTimeout(() => { if (!cancelled) setGsiState((s) => (s === 'ready' ? s : 'error')); }, 8000);
    const hasGoogle = () => !!(window as unknown as { google?: GsiApi }).google?.accounts?.id;
    const existing = document.getElementById('gsi-script') as HTMLScriptElement | null;
    if (existing && hasGoogle()) {
      render();
    } else if (existing) {
      existing.addEventListener('load', render, { once: true });
      existing.addEventListener('error', fail, { once: true });
    } else {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true; s.id = 'gsi-script';
      s.onload = render;
      s.onerror = fail;
      document.body.appendChild(s);
    }
    return () => { cancelled = true; clearTimeout(watchdog); };
  }, [authed, handleGoogleCredential, gsiRetry]);

  // Retry a failed Google-script load: drop the dead <script> so it refetches.
  const retryGsi = useCallback(() => {
    document.getElementById('gsi-script')?.remove();
    setGsiState('loading');
    setGsiRetry((n) => n + 1);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockoutUntil && Date.now() < lockoutUntil) return;
    if (!usernameInput || !passwordInput) { setAuthError('Enter your username and password.'); return; }
    setLoginLoading(true);
    setAuthError('');
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, password: passwordInput }),
      });
      if (res.ok) {
        const data = await res.json();
        // IDX-002: don't trust the 200 alone — only authenticate the UI when the
        // response actually carries a structurally valid, unexpired JWT. A forced/
        // tampered 200 with no real token now fails closed instead of rendering admin.
        const payload = parseValidJwt(data?.token);
        if (!payload) {
          setAuthError('Login failed. Please try again.');
          return;
        }
        sessionStorage.setItem('mgr_token', data.token);
        sessionStorage.setItem('mgr_info', JSON.stringify({ managerId: data.managerId, displayName: data.displayName, role: data.role }));
        setManagerToken(data.token);
        setManagerInfo({ managerId: data.managerId, displayName: data.displayName, role: data.role });
        if (payload.exp) setSessionExpiresAt(payload.exp);
        setAuthed(true);
        setAttempts(0);
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        if (newAttempts >= MAX_ATTEMPTS) {
          const until = Date.now() + LOCKOUT_SECONDS * 1000;
          setLockoutUntil(until);
          setAuthError(`Too many failed attempts. Login disabled for 15 minutes.`);
        } else {
          setAuthError(`Invalid credentials. ${MAX_ATTEMPTS - newAttempts} attempt(s) remaining.`);
        }
      }
    } catch {
      setAuthError('Connection error. Please try again.');
    } finally {
      setLoginLoading(false);
      setPasswordInput('');
    }
  };

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    setError('');
    if (API_BASE) {
      try {
        // Authenticated on purpose: GET /faq returns ONLY published articles to
        // anonymous callers, so an unauthenticated fetch here made every draft
        // invisible in the admin — including everything a CSV import creates
        // (imports land as drafts), which looked like the import did nothing.
        const res = await fetch(`${API_BASE}/faq`, managerToken ? { headers: authHeaders(managerToken) } : undefined);
        if (res.status === 401) { handleSessionExpired(); return; }
        if (res.ok) {
          const data = await res.json();
          const apiItems: Article[] = Array.isArray(data) ? data : (data.items || data.articles || []);
          setArticles(apiItems);
        } else {
          setError('Failed to load articles from API.');
          setArticles([]);
        }
      } catch {
        setError('Could not reach the API. Check your connection.');
        setArticles([]);
      }
    } else {
      setError('API not configured.');
      setArticles([]);
    }
    setLoading(false);
    setLastRefreshed(new Date());
  }, [handleSessionExpired, managerToken, authHeaders]);

  useEffect(() => { if (authed) fetchArticles(); }, [authed, fetchArticles]);

  const moveArticle = (globalIndex: number, direction: 'up' | 'down', category?: string) => {
    const next = [...articles];
    if (category) {
      // Find the adjacent article in the same category
      const peers = next
        .map((a, gi) => ({ gi, cat: a.category }))
        .filter((x) => x.cat === category);
      const peerPos = peers.findIndex((x) => x.gi === globalIndex);
      const adjacentPeer = direction === 'up' ? peers[peerPos - 1] : peers[peerPos + 1];
      if (!adjacentPeer) return;
      [next[globalIndex], next[adjacentPeer.gi]] = [next[adjacentPeer.gi], next[globalIndex]];
    } else {
      const swapIndex = direction === 'up' ? globalIndex - 1 : globalIndex + 1;
      if (swapIndex < 0 || swapIndex >= next.length) return;
      [next[globalIndex], next[swapIndex]] = [next[swapIndex], next[globalIndex]];
    }
    setArticles(next);
    setOrderChanged(true);
    setSortBy('default');
    if (category) setReorderCategory(category);
  };

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 3500);
  }, []);

  // Confirm a fresh sign-in with a welcome toast (only on real login, not on a
  // page reload that restores the session).
  useEffect(() => {
    if (authed && pendingWelcomeRef.current) {
      showToast(`Signed in as ${pendingWelcomeRef.current}`);
      pendingWelcomeRef.current = null;
      setSigningIn(false);
    }
  }, [authed, showToast]);

  // A refresh or tab close mid-batch leaves articles half-created with no record
  // of where it stopped, so warn while any write loop is in flight.
  useEffect(() => {
    if (!importing && !bulkRunning) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [importing, bulkRunning]);

  const saveOrder = useCallback(async () => {
    if (!API_BASE || !managerToken) return;
    setSavingOrder(true);
    try {
      const toUpdate = reorderCategory
        ? articles.filter(a => a.category === reorderCategory)
        : articles;
      // A category-scoped reorder reuses the sortOrder slots that category
      // already occupies. Renumbering it 0..n (the old behaviour) collided with
      // every other category's numbering and yanked the whole category to the
      // top of the list — the reorder "worked" but the list looked scrambled.
      const slots = reorderCategory
        ? toUpdate.map((a, i) => (typeof a.sortOrder === 'number' ? a.sortOrder : i)).sort((x, y) => x - y)
        : toUpdate.map((_, i) => i);
      for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
      const results = await Promise.all(toUpdate.map((a, i) =>
        fetch(`${API_BASE}/faq/${a.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${managerToken}` },
          body: JSON.stringify({ sortOrder: slots[i] }),
        })
      ));
      const unauthorized = results.find(r => r.status === 401);
      if (unauthorized) { handleSessionExpired(); return; }
      const failed = results.filter(r => !r.ok);
      if (failed.length > 0) {
        showToast(`Failed to save order (${failed.length} errors). Please try again.`);
      } else {
        setOrderChanged(false);
        setReorderCategory('');
        showToast('Order saved!');
      }
    } catch {
      showToast('Network error. Failed to save order.');
    }
    setSavingOrder(false);
  }, [articles, managerToken, reorderCategory, showToast]);

  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title || !form.category || !form.content) { setFormMsg('All fields are required.'); return; }
    if (form.content.length > MAX_CONTENT) { setFormMsg(`Content exceeds ${MAX_CONTENT.toLocaleString()} characters.`); return; }
    const isDuplicate = articles.some(a => a.title.trim().toLowerCase() === form.title.trim().toLowerCase() && a.id !== editingId);
    if (isDuplicate) { setFormMsg('An article with this title already exists.'); return; }
    setSubmitting(true);
    setFormMsg('');
    try {
      const method = editingId ? 'PUT' : 'POST';
      const url = editingId ? `${API_BASE}/faq/${editingId}` : `${API_BASE}/faq`;
      // Assign new articles the next sortOrder so they don't default to last
      const catPeers = articles.filter(a => a.category === form.category);
      const nextSortOrder = catPeers.length > 0 ? Math.max(...catPeers.map(a => a.sortOrder ?? 0)) + 1 : 0;
      const body = editingId ? { ...form } : { ...form, sortOrder: nextSortOrder };
      const res = await fetch(url, {
        method,
        headers: authHeaders(managerToken),
        body: JSON.stringify(body),
      });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (!res.ok) throw new Error('Failed');
      setFormMsg(editingId ? 'Article updated successfully!' : 'Article added successfully!');
      setForm(emptyForm);
      setEditingId(null);
      fetchArticles();
      setTimeout(() => { setActiveView('articles'); setFormMsg(''); }, 1200);
    } catch { setFormMsg(editingId ? 'Failed to update article.' : 'Failed to add article.'); }
    finally { setSubmitting(false); }
  };

  const handleEdit = (article: Article) => {
    setForm({ title: article.title || article.question || '', category: article.category || '', content: article.content || article.answer || '', status: article.status || 'published' });
    setEditingId(article.id);
    setFormMsg('');
    setActiveView('add');
  };

  // ── Bulk CSV import ─────────────────────────────────────────────────────────
  // Minimal RFC-4180 parser: handles quoted fields, escaped "" quotes, and
  // commas/newlines inside quoted values (FAQ content routinely has both).
  const parseCSV = (text: string, delim = ','): string[][] => {
    const rows: string[][] = [];
    let field = '', row: string[] = [], inQuotes = false;
    // Strip the UTF-8 BOM Excel writes on "CSV UTF-8" export — otherwise the
    // first header cell reads as "\uFEFFtitle" and the title column is "missing".
    const s = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  };

  // Read + validate the chosen CSV. Nothing is uploaded here — we build a
  // preview so the user confirms before any write. Rows whose title already
  // exists (or repeats within the file) are skipped to avoid duplicates.
  const IMPORT_MAX_ROWS = 2000;
  const IMPORT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

  const readApiError = async (res: Response): Promise<string> => {
    try { const j = await res.json(); if (j?.error) return String(j.error); } catch { /* fall through */ }
    return `HTTP ${res.status}`;
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (importInputRef.current) importInputRef.current.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) { showToast(`File too large (max ${IMPORT_MAX_BYTES / 1024 / 1024} MB).`); return; }
    try {
      const text = await file.text();
      const delimiter = detectDelimiter(text);
      // Keep each row's original file line number before blank lines are dropped,
      // so reported row numbers still line up with the user's spreadsheet.
      const parsed = parseCSV(text, delimiter).map((cells, idx) => ({ cells, line: idx + 1 }));
      const rows = parsed.filter(r => r.cells.some(c => c.trim() !== ''));
      if (rows.length < 2) { showToast('CSV is empty or has no data rows.'); return; }
      if (rows.length - 1 > IMPORT_MAX_ROWS) { showToast(`Too many rows (${(rows.length - 1).toLocaleString()}). Split into files of ${IMPORT_MAX_ROWS.toLocaleString()} or fewer.`); return; }
      const header = rows[0].cells.map(h => h.trim().toLowerCase());
      const col = (names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
      const ti = col(['title', 'question']);
      const ci = col(['category']);
      const coi = col(['content', 'answer']);
      const si = col(['status']);
      if (ti < 0 || ci < 0 || coi < 0) {
        showToast(`CSV needs title, category and content columns. Found: ${header.join(', ') || '(none)'}`);
        return;
      }

      // Match against ALL existing articles — including drafts — not just the
      // published set. Managers see everything via an authed GET /faq; fall back
      // to the already-loaded set if that call fails, so we never match against
      // an empty list (which would duplicate every row).
      // We keep the existing id + status, not just the title, so a matching row
      // can be updated in place rather than only ever skipped.
      const indexOf = (list: Article[]) => new Map(
        list.map(a => [normTitle(a.title || a.question), { id: a.id, status: a.status || 'published' }] as const)
      );
      let existing: Map<string, { id: string; status: string }>;
      try {
        const res = await fetch(`${API_BASE}/faq`, { headers: authHeaders(managerToken) });
        if (res.status === 401) { handleSessionExpired(); return; }
        if (res.ok) {
          const all = await res.json();
          const list: Article[] = Array.isArray(all) ? all : (all.items || all.articles || []);
          existing = indexOf(list);
        } else {
          existing = indexOf(articles);
        }
      } catch {
        existing = indexOf(articles);
      }

      const valid: ImportRow[] = [];
      const duplicates: ImportDup[] = [];
      const issues: ImportIssue[] = [];
      const seenInFile = new Map<string, number>();
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i].cells;
        const row = rows[i].line;
        const title = (r[ti] || '').trim();
        const category = (r[ci] || '').trim();
        const content = (r[coi] || '').trim();
        const status = si >= 0 ? (r[si] || '').trim().toLowerCase() : '';
        const base = { row, title, category, content, status };
        const missing = [!title && 'title', !category && 'category', !content && 'content'].filter(Boolean).join(', ');
        if (missing) { issues.push({ ...base, reason: `Missing ${missing}` }); continue; }
        if (content.length > MAX_CONTENT) { issues.push({ ...base, reason: `Content is ${content.length.toLocaleString()} chars — limit is ${MAX_CONTENT.toLocaleString()}` }); continue; }
        if (status && !VALID_STATUSES.includes(status)) { issues.push({ ...base, reason: `Invalid status "${status}" — use published or draft` }); continue; }
        const key = normTitle(title);
        // Within-file duplicates are checked BEFORE existing ones. The other way
        // round, a re-run labelled both copies "Already exists" and the real
        // problem — two identical titles in the file — stayed invisible.
        const twin = seenInFile.get(key);
        if (twin !== undefined) { issues.push({ ...base, reason: `Same title as row ${twin} in this file` }); continue; }
        seenInFile.set(key, row);
        const hit = existing.get(key);
        // Existing title: offer it as an update candidate rather than burying it
        // in the skipped list with no way to act on it. `status` stays blank when
        // the file didn't set one, so an update never silently unpublishes.
        if (hit) { duplicates.push({ ...base, existingId: hit.id, existingStatus: hit.status }); continue; }
        // Keep an empty status EMPTY here. Baking in 'draft' at this point is what
        // made the default invisible — the preview could not tell you how many
        // rows were relying on it. runImport() resolves it via blankStatusMode.
        valid.push({ ...base, status });
      }

      // A mistyped category silently creates an orphan topic that no customer can
      // navigate to, so name them up front instead of letting them through mute.
      const knownCats = new Set<string>([
        ...dynamicCategories.map(c => c.name.toLowerCase()),
        ...articles.map(a => (a.category || '').toLowerCase()),
      ]);
      const newCategories = Array.from(new Set(
        [...valid, ...duplicates].map(r => r.category).filter(c => !knownCats.has(c.toLowerCase()))
      ));

      setImportResult(null);
      setImportMode('skip');
      setBlankStatusMode('draft');
      setImportPreview({ valid, duplicates, issues, newCategories, delimiter });
    } catch { showToast('Could not read the CSV file.'); }
  };

  // Re-export the rejected rows as a CSV with a `reason` column so they can be
  // corrected in the spreadsheet and re-imported, rather than hand-copied out of
  // a scrolling list.
  const downloadSkipped = () => {
    if (!importPreview) return;
    const rowsOut = [
      ...importPreview.issues.map(i => ({ ...i, reason: i.reason })),
      ...(importMode === 'skip' ? importPreview.duplicates.map(d => ({ ...d, reason: `Already exists as ${d.existingStatus}` })) : []),
    ].sort((a, b) => a.row - b.row);
    if (rowsOut.length === 0) { showToast('Nothing was skipped.'); return; }
    // Excel and Sheets evaluate a cell that begins with = + - @ (or a leading tab
    // / CR), so neutralise those with a leading apostrophe. This export exists to
    // be opened in a spreadsheet, and the content is arbitrary text from the file
    // the operator uploaded.
    const q = (v: string) => {
      const raw = String(v ?? '');
      const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = 'row,reason,title,category,content,status\n'
      + rowsOut.map(r => [r.row, q(r.reason), q(r.title), q(r.category), q(r.content), q(r.status)].join(',')).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'faq-import-skipped-rows.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Upload the confirmed rows one at a time via POST /faq (new) and PUT /faq/{id}
  // (existing, only in "update" mode) so each row is validated server-side and a
  // per-row failure never aborts the batch.
  const runImport = async () => {
    if (!importPreview || !managerToken) return;
    const { valid, duplicates } = importPreview;
    const toUpdate = importMode === 'update' ? duplicates : [];
    const total = valid.length + toUpdate.length;
    if (total === 0) { setImportPreview(null); return; }
    importAbortRef.current = false;
    setImporting(true);
    setImportProgress({ done: 0, total });
    const failed: { row: number; title: string; reason: string }[] = [];
    let created = 0, updated = 0, done = 0;

    // Stamp every row of this run with one batch id. Without it there is no way
    // to ask "what did that import create?" after the fact — which is exactly
    // the question that could not be answered about the earlier IPO import.
    const batchId = `imp-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

    // Next sortOrder per category, seeded from every article (drafts included) so
    // imported rows land after that category's existing ones. The old code seeded
    // from the published-only list, so two draft imports in a row were handed the
    // SAME starting slot and silently double-booked each other's sortOrder.
    const maxOrder = new Map<string, number>();
    for (const a of articles) {
      const k = (a.category || '').toLowerCase();
      maxOrder.set(k, Math.max(maxOrder.get(k) ?? -1, a.sortOrder ?? -1));
    }
    const nextSortOrder = (category: string) => {
      const k = (category || '').toLowerCase();
      const next = (maxOrder.get(k) ?? -1) + 1;
      maxOrder.set(k, next);
      return next;
    };

    for (const row of valid) {
      if (importAbortRef.current) break;
      try {
        const res = await fetch(`${API_BASE}/faq`, {
          method: 'POST',
          headers: authHeaders(managerToken),
          body: JSON.stringify({
            title: row.title, category: row.category, content: row.content,
            status: row.status || blankStatusMode,
            sortOrder: nextSortOrder(row.category), importBatch: batchId,
          }),
        });
        if (res.status === 401) { setImporting(false); setImportPreview(null); handleSessionExpired(); return; }
        if (!res.ok) failed.push({ row: row.row, title: row.title, reason: await readApiError(res) });
        else created++;
      } catch { failed.push({ row: row.row, title: row.title, reason: 'Network error' }); }
      setImportProgress({ done: ++done, total });
    }

    for (const row of toUpdate) {
      if (importAbortRef.current) break;
      try {
        const body: Record<string, string> = { title: row.title, category: row.category, content: row.content };
        if (row.status) body.status = row.status; // only when the file said so
        const res = await fetch(`${API_BASE}/faq/${row.existingId}`, {
          method: 'PUT',
          headers: authHeaders(managerToken),
          body: JSON.stringify(body),
        });
        if (res.status === 401) { setImporting(false); setImportPreview(null); handleSessionExpired(); return; }
        if (!res.ok) failed.push({ row: row.row, title: row.title, reason: await readApiError(res) });
        else updated++;
      } catch { failed.push({ row: row.row, title: row.title, reason: 'Network error' }); }
      setImportProgress({ done: ++done, total });
    }

    const cancelled = importAbortRef.current;
    importAbortRef.current = false;
    setImporting(false);
    setImportPreview(null);
    setImportResult({ created, updated, failed, cancelled });
    showToast(`${cancelled ? 'Import stopped' : 'Import complete'}: ${created} added${updated ? `, ${updated} updated` : ''}${failed.length ? `, ${failed.length} failed` : ''}.`);
    setPage(1);
    fetchArticles();
  };

  // Which articles a bulk action would touch. Always derived from `filtered`, so
  // the set is exactly what the operator can see on screen under the current
  // search / category / status filters — never a hidden superset.
  const bulkTargetsFor = (action: 'publish' | 'unpublish' | 'delete' | null): Article[] =>
    action === 'publish' ? filtered.filter((a) => !isLive(a.status))
      : action === 'unpublish' ? filtered.filter((a) => isLive(a.status))
        : action === 'delete' ? filtered
          : [];

  // One sequential loop for all three bulk operations. Sequential on purpose: the
  // function runs with max-instances=10 and every write invalidates the server's
  // article cache, so firing hundreds of parallel requests would both throttle
  // and thrash that cache for concurrent customer searches.
  const runBulkAction = async () => {
    const action = bulkAction;
    const targets = bulkTargetsFor(action);
    setBulkAction(null);
    setBulkConfirmText('');
    if (!action || !managerToken || targets.length === 0) return;
    setBulkRunning(true);
    setBulkProgress({ done: 0, total: targets.length });
    let ok = 0, bad = 0;
    for (let i = 0; i < targets.length; i++) {
      try {
        const res = action === 'delete'
          ? await fetch(`${API_BASE}/faq/${targets[i].id}`, { method: 'DELETE', headers: authHeaders(managerToken) })
          : await fetch(`${API_BASE}/faq/${targets[i].id}`, {
            method: 'PUT',
            headers: authHeaders(managerToken),
            body: JSON.stringify({ status: action === 'publish' ? 'published' : 'draft' }),
          });
        if (res.status === 401) { setBulkRunning(false); handleSessionExpired(); return; }
        if (res.ok) ok++; else bad++;
      } catch { bad++; }
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkRunning(false);
    const verb = action === 'publish' ? 'Published' : action === 'unpublish' ? 'Unpublished' : 'Deleted';
    showToast(`${verb} ${ok} article${ok !== 1 ? 's' : ''}${bad ? `, ${bad} failed` : ''}.`);
    setPage(1);
    fetchArticles();
  };

  const downloadTemplate = () => {
    // Two rows on purpose: one published, one draft. The single-example template
    // left it unclear that the column had to be filled in at all, and a blank
    // status column is what silently drafted two entire imports.
    const sample = 'title,category,content,status\n'
      + '"How do I reset my password?","Account","Go to Settings then Security and choose Reset Password.",published\n'
      + '"Draft example - not yet live","Account","Leave status as draft while this is still being reviewed.",draft\n';
    const url = URL.createObjectURL(new Blob([sample], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'faq-import-template.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCancelEdit = () => { setForm(emptyForm); setEditingId(null); setFormMsg(''); setActiveView('articles'); };

  const handleDelete = async (id: string) => {
    setDeleteConfirmId(id);
  };

  const confirmDelete = async () => {
    if (!deleteConfirmId) return;
    const id = deleteConfirmId;
    setDeletingId(id);
    try {
      const res = await fetch(`${API_BASE}/faq/${id}`, { method: 'DELETE', headers: authHeaders(managerToken) });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (!res.ok) throw new Error('Failed');
      setArticles((prev) => prev.filter((a) => a.id !== id));
      setDeleteConfirmId(null);
      showToast('Article deleted successfully.');
    } catch { showToast('Failed to delete article. Please try again.'); }
    finally { setDeletingId(null); }
  };

  // Create a real category record for a topic that exists only as text on
  // articles. Icon, description, subcategories and ordering all hang off a
  // record, so without one a topic holding hundreds of articles cannot be
  // managed at all — it simply does not appear on the Categories screen.
  const adoptCategory = async (name: string): Promise<boolean> => {
    if (!managerToken) return false;
    // Canonical Knowledge Base topics keep their KB position; anything new lands
    // after them rather than on the API's 999999 default.
    const idx = FALLBACK_CATEGORIES.findIndex(c => c.toLowerCase() === name.toLowerCase());
    try {
      const res = await fetch(`${API_BASE}/categories`, {
        method: 'POST',
        headers: authHeaders(managerToken),
        body: JSON.stringify({ name, icon: 'fas fa-folder', parentId: null, description: '', sortOrder: idx >= 0 ? idx : 500 }),
      });
      if (res.status === 401) { handleSessionExpired(); return false; }
      return res.ok;
    } catch { return false; }
  };

  const adoptOneCategory = async (name: string) => {
    setAdoptingCat(name);
    const ok = await adoptCategory(name);
    setAdoptingCat(null);
    showToast(ok ? `"${name}" added — you can now set its icon and description.` : `Could not add "${name}".`);
    if (ok) fetchCategories();
  };

  const adoptAllCategories = async (names: string[]) => {
    if (names.length === 0) return;
    setAdoptingCat('__all__');
    let ok = 0;
    for (const n of names) { if (await adoptCategory(n)) ok++; }
    setAdoptingCat(null);
    showToast(`${ok} categor${ok === 1 ? 'y' : 'ies'} added${ok < names.length ? `, ${names.length - ok} failed` : ''}.`);
    fetchCategories();
  };

  const handleToggleStatus = async (article: Article) => {
    const isPublished = isLive(article.status);
    const newStatus = isPublished ? 'draft' : 'published';
    setTogglingId(article.id);
    // Optimistic update
    setArticles((prev) => prev.map((a) => (a.id === article.id ? { ...a, status: newStatus } : a)));
    try {
      const res = await fetch(`${API_BASE}/faq/${article.id}`, { method: 'PUT', headers: authHeaders(managerToken), body: JSON.stringify({ status: newStatus }) });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (!res.ok) throw new Error('Failed');
    } catch {
      // Roll back optimistic update
      setArticles((prev) => prev.map((a) => (a.id === article.id ? { ...a, status: article.status } : a)));
      setError('Failed to update status. Please try again.');
    }
    finally { setTogglingId(null); }
  };

  const handleMarkResolved = async (ticketId: string) => {
    const ticket = tickets.find((t) => t.id === ticketId);
    if (!ticket) return;
    // Use 'solved' to match the system-wide ticket status schema (open → in_progress → solved)
    const updated = { ...ticket, status: 'solved' };
    setTickets((prev) => prev.map((t) => t.id === ticketId ? updated : t));
    if (previewTicket?.id === ticketId) setPreviewTicket(updated);
    if (API_BASE) {
      try {
        const res = await fetch(`${API_BASE}/tickets/${ticketId}`, {
          method: 'PUT',
          headers: authHeaders(managerToken),
          body: JSON.stringify({ status: 'solved' }),
        });
        if (res.status === 401) { handleSessionExpired(); return; }
        if (!res.ok) throw new Error('Failed');
      } catch {
        // Roll back optimistic update on failure
        setTickets((prev) => prev.map((t) => t.id === ticketId ? ticket : t));
        if (previewTicket?.id === ticketId) setPreviewTicket(ticket);
        setError('Failed to update ticket status. Please try again.');
      }
    }
  };

  // Sign out. Three things have to be true afterwards, and the user has to be
  // able to SEE that they are:
  //   1. the server recorded it (LOGOUT audit entry) — so we wait for that call
  //      rather than firing it off and racing it against the token being dropped;
  //   2. nothing of the session survives in this tab — token, identity, and the
  //      account-scoped data we had loaded in memory (tickets, feedback, audit);
  //   3. they land on the login card with an explicit confirmation.
  // A slow or offline network must never trap someone in a session, so the local
  // sign-out proceeds regardless of what the server says.
  const logout = useCallback(async () => {
    if (signingOut) return;
    const who = managerInfo?.displayName || '';
    setSigningOut(true);
    if (API_BASE && managerToken) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
          await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: authHeaders(managerToken), signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      } catch { /* offline, slow, or already-expired token — sign out locally anyway */ }
    }
    sessionStorage.removeItem('mgr_token');
    sessionStorage.removeItem('mgr_info');
    setManagerToken('');
    setManagerInfo(null);
    // Drop the previous account's data so none of it survives in memory or
    // flashes on screen if a different person signs in on this device.
    setTickets([]);
    setFeedback([]);
    setAuditLogs([]);
    setSessionExpiresAt(null);
    setSessionWarning(false);
    setAuthError('');
    setToast('');
    setSidebarOpen(false);
    setActiveView('articles');
    setSignedOutName(who);
    setSignedOut(true);
    setSigningOut(false);
    setAuthed(false);
  }, [signingOut, managerInfo, managerToken, authHeaders]);

  const toggleDarkMode = () => {
    const next = !darkMode;
    setDarkMode(next);
    if (next) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'light');
    }
  };

  const filtered = articles.filter((a) => {
    const matchSearch = !search || (a.title || a.question || '').toLowerCase().includes(search.toLowerCase()) || a.category?.toLowerCase().includes(search.toLowerCase());
    const matchCat = !catFilter || a.category === catFilter;
    const matchStatus = !statusFilter || (statusFilter === 'published' ? isLive(a.status) : !isLive(a.status));
    return matchSearch && matchCat && matchStatus;
  }).sort((a, b) => {
    if (sortBy === 'title') return (a.title || '').localeCompare(b.title || '');
    if (sortBy === 'category') return (a.category || '').localeCompare(b.category || '');
    return 0;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const contentLen = form.content.length;

  // Ticket search + pagination
  const filteredTickets = tickets.filter((t) => {
    if (!ticketSearch) return true;
    const q = ticketSearch.toLowerCase();
    return t.name?.toLowerCase().includes(q) || t.email?.toLowerCase().includes(q) || t.subject?.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
  });
  const totalTicketPages = Math.max(1, Math.ceil(filteredTickets.length / TICKETS_PAGE_SIZE));
  const safeTicketPage = Math.min(ticketPage, totalTicketPages);
  const paginatedTickets = filteredTickets.slice((safeTicketPage - 1) * TICKETS_PAGE_SIZE, safeTicketPage * TICKETS_PAGE_SIZE);

  const topLevelCats = dynamicCategories.filter(c => !c.parentId);
  const getSubcats = (parentId: string) => dynamicCategories.filter(c => c.parentId === parentId);

  // Always include all article categories even if not yet in dynamic categories DB,
  // so existing articles never lose their category assignment in the dropdown.
  const dynamicCatNames = new Set(dynamicCategories.map(c => c.name.toLowerCase()));
  const articleOnlyCategories = Array.from(
    new Set(articles.map(a => a.category).filter(c => c && !dynamicCatNames.has(c.toLowerCase())))
  );
  // Order the category filter to match the Knowledge Base: the canonical
  // topics first (Getting Started, Account Opening, Trading, …), then any extra
  // DB/article-only categories after — rather than the DB sortOrder, which
  // buried "Getting Started" in the middle of the list.
  const kbOrderIndex = (name: string) => {
    const i = FALLBACK_CATEGORIES.findIndex(c => c.toLowerCase() === name.toLowerCase());
    return i === -1 ? FALLBACK_CATEGORIES.length + 1 : i;
  };
  const allCategoryNames: string[] = dynamicCategories.length > 0
    ? [...dynamicCategories.map(c => c.name), ...articleOnlyCategories]
        .sort((a, b) => kbOrderIndex(a) - kbOrderIndex(b) || a.localeCompare(b))
    : FALLBACK_CATEGORIES;

  // Stat cards scope to the selected category filter, so admins see
  // category-wise counts (Total / Published / Drafts for that category);
  // with "All Categories" selected they show the whole library.
  // Topics articles actually use that have no category record. These were absent
  // from the Categories screen entirely, so the majority of the library sat in
  // categories nobody could edit.
  const unmanagedCategories = articleOnlyCategories
    .map((name) => ({ name, count: articles.filter((a) => a.category === name).length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const unmanagedArticleCount = unmanagedCategories.reduce((n, u) => n + u.count, 0);

  const scopedArticles = catFilter ? articles.filter((a) => a.category === catFilter) : articles;
  const totalCount = scopedArticles.length;
  const publishedCount = scopedArticles.filter((a) => isLive(a.status)).length;
  const draftCount = scopedArticles.filter((a) => !isLive(a.status)).length;
  // Unscoped on purpose. The entire failure mode was 310 drafts sitting unnoticed
  // behind whatever filter happened to be selected, so this number has to be
  // visible regardless of the current category or status filter.
  const libraryDraftCount = articles.filter((a) => !isLive(a.status)).length;
  const openTickets = tickets.filter((t) => t.status !== 'solved' && t.status !== 'resolved').length;

  // ── LOGIN SCREEN ──────────────────────────────────────────────────────────
  if (!authChecked) {
    return <div style={{ position: 'fixed', inset: 0, background: '#0F172A', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="fas fa-spinner fa-spin" style={{ color: '#00AB4E', fontSize: '2rem' }}></i></div>;
  }

  if (!authed) {
    const isLocked = lockoutUntil !== null && Date.now() < lockoutUntil;
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'linear-gradient(135deg, #0F172A 0%, #1A202C 50%, #2D3748 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '1rem' }}>
        <div style={{ background: '#FFFFFF', borderRadius: 16, padding: '3rem 2.5rem', width: '100%', maxWidth: 420, boxShadow: '0 25px 50px rgba(0,0,0,0.4)', textAlign: 'center' }}>
          <div style={{ marginBottom: '2rem' }}>
            <Image src="/logo-dark.svg" alt="Indiabulls Securities" width={120} height={43} style={{ width: 120, height: 'auto', margin: '0 auto', display: 'block' }} />
          </div>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 800, color: '#1A202C', marginBottom: '0.375rem' }}>Manager Portal</h1>
          <p style={{ fontSize: '0.875rem', color: '#718096', marginBottom: signedOut ? '1.25rem' : '2rem' }}>Sign in to manage FAQ articles and support tickets</p>
          {signedOut && !signingIn && (
            <div style={{ background: '#F0FFF4', border: '1px solid #9AE6B4', borderRadius: 10, padding: '0.875rem 1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'flex-start', gap: '0.625rem', textAlign: 'left' }}>
              <i className="fas fa-circle-check" style={{ color: '#25855A', fontSize: '1rem', marginTop: '0.15rem', flexShrink: 0 }}></i>
              <div>
                <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 700, color: '#22543D' }}>You&apos;re signed out</p>
                <p style={{ margin: '0.2rem 0 0', fontSize: '0.8125rem', color: '#2F6F4F', lineHeight: 1.45 }}>
                  {signedOutName ? `${signedOutName}'s session has ended on this device.` : 'Your session has ended on this device.'} Sign in again to continue.
                </p>
              </div>
            </div>
          )}
          <div>
            {GOOGLE_CLIENT_ID ? signingIn ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '1rem 0' }}>
                <span className="admin-spinner" style={{ width: 28, height: 28, border: '3px solid #E2E8F0', borderTopColor: '#2B6CB0', borderRadius: '50%', display: 'inline-block', animation: 'admin-spin 0.7s linear infinite' }} />
                <p style={{ fontSize: '0.875rem', color: '#2D3748', fontWeight: 600, margin: 0 }}>Signing you in…</p>
              </div>
            ) : (
              <>
                <p style={{ fontSize: '0.8125rem', color: '#718096', marginBottom: '1rem' }}>Sign in with your @indiabulls.com Google account.</p>
                <div ref={googleBtnRef} style={{ display: 'flex', justifyContent: 'center', minHeight: 44 }} />
                {gsiState === 'loading' && (
                  <p style={{ fontSize: '0.8125rem', color: '#A0AEC0', marginTop: '0.5rem' }}>Loading Google sign-in…</p>
                )}
                {gsiState === 'error' && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{ background: '#FFFAF0', border: '1px solid #FBD38D', color: '#C05621', padding: '0.75rem 1rem', borderRadius: 8, fontSize: '0.8125rem', textAlign: 'left' }}>
                      Couldn&apos;t load Google sign-in. Check your connection or any ad/script blocker, then retry.
                    </div>
                    <button onClick={retryGsi} style={{ marginTop: '0.5rem', padding: '0.5rem 1rem', borderRadius: 8, border: '1px solid #CBD5E0', background: '#fff', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600 }}>Retry</button>
                  </div>
                )}
              </>
            ) : (
              <p style={{ fontSize: '0.875rem', color: '#DD6B20' }}>Google sign-in isn&apos;t configured yet.</p>
            )}
            {/* Suppressed while the sign-out confirmation is showing so a late 401
                from an in-flight request can't contradict it. A new sign-in attempt
                clears the confirmation first, so real errors still surface. */}
            {authError && !signedOut && (
              <div style={{ background: '#FFF5F5', border: '1px solid #FEB2B2', color: '#C53030', padding: '0.75rem 1rem', borderRadius: 8, fontSize: '0.875rem', marginTop: '1rem', textAlign: 'left' }}>{authError}</div>
            )}
          </div>
          <p style={{ marginTop: '2rem', fontSize: '0.75rem', color: '#A0AEC0' }}>Authorized Indiabulls Securities Internal System · Authorized Access Only</p>
        </div>
      </div>
    );
  }

  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  return (
    <div className="admin-layout" style={{ display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", position: 'relative' }}>

      {/* MOBILE OVERLAY */}
      <div
        onClick={() => setSidebarOpen(false)}
        className={`admin-sidebar-overlay${sidebarOpen ? ' active' : ''}`}
      />

      {/* SIDEBAR */}
      <aside className={`admin-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #2D3748', display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 56 }}>
          <Image src="/logo.svg" alt="Indiabulls Securities" width={110} height={42} style={{ width: 110, height: 'auto', minWidth: 0, flexShrink: 1, display: 'block' }} />
          <button onClick={() => setSidebarOpen(false)} className="admin-sidebar-close" style={{ background: 'none', border: 'none', color: '#A0AEC0', cursor: 'pointer', fontSize: '1rem', padding: '0.25rem', alignItems: 'center', justifyContent: 'center' }}>
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div style={{ padding: '0.5rem 0.75rem', flex: 1 }}>
          <p style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#4A5568', padding: '1.25rem 0.5rem 0.5rem' }}>Content</p>
          {[
            { id: 'articles', label: 'FAQ Articles', icon: 'fa-list' },
            { id: 'add', label: editingId ? 'Edit Article' : 'Add Article', icon: 'fa-plus' },
            { id: 'tickets', label: 'Support Tickets', icon: 'fa-envelope' },
            { id: 'feedback', label: 'Feedback', icon: 'fa-comment-dots' },
            { id: 'audit', label: 'Audit Log', icon: 'fa-scroll' },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => { setActiveView(item.id as 'articles' | 'add' | 'tickets' | 'audit' | 'categories' | 'feedback'); if (item.id !== 'add') { setEditingId(null); setForm(emptyForm); setFormMsg(''); } }}
              style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0.875rem', borderRadius: 8, color: activeView === item.id ? 'white' : '#A0AEC0', background: activeView === item.id ? '#2D3748' : 'none', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500, transition: 'all 0.15s', marginBottom: '0.125rem', border: 'none', width: '100%', textAlign: 'left' }}
            >
              <i className={`fas ${item.icon}`} style={{ width: 16, textAlign: 'center' }}></i>
              {item.label}
              {item.id === 'tickets' && openTickets > 0 && (
                <span style={{ marginLeft: 'auto', background: '#E53E3E', color: 'white', fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: 20 }}>{openTickets}</span>
              )}
            </button>
          ))}
          <p style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#4A5568', padding: '1.25rem 0.5rem 0.5rem' }}>Site</p>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0.875rem', borderRadius: 8, color: 'var(--admin-text-muted)', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none' }}>
            <i className="fas fa-arrow-up-right-from-square" style={{ width: 16, textAlign: 'center', fontSize: '0.75rem' }}></i> View Site
          </Link>
        </div>
        <div style={{ padding: '1rem 0.75rem', borderTop: '1px solid #2D3748' }}>
          <button onClick={logout} disabled={signingOut} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0.875rem', borderRadius: 8, color: '#FC8181', background: 'none', cursor: signingOut ? 'wait' : 'pointer', fontSize: '0.875rem', fontWeight: 500, border: 'none', width: '100%', textAlign: 'left', opacity: signingOut ? 0.6 : 1 }}>
            <i className={`fas ${signingOut ? 'fa-spinner fa-spin' : 'fa-right-from-bracket'}`} style={{ width: 16, textAlign: 'center' }}></i> {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
          <p style={{ fontSize: '0.65rem', color: '#4A5568', textAlign: 'center', padding: '0.5rem' }}>v1.0 · Manager Portal</p>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--admin-bg)', flex: 1, minWidth: 0 }}>
        {/* TOPBAR */}
        <div style={{ background: 'var(--admin-topbar)', borderBottom: '1px solid var(--admin-border)', padding: '0 1.25rem', height: 56, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
            <button onClick={() => setSidebarOpen(true)} className="admin-hamburger" aria-label="Open menu" style={{ width: 36, height: 36, borderRadius: 8, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: 'pointer', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.875rem', flexShrink: 0 }}>
              <i className="fas fa-bars"></i>
            </button>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#00AB4E', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <i className="fas fa-shield-alt" style={{ color: '#fff', fontSize: '0.875rem' }}></i>
            </div>
            <span style={{ fontWeight: 800, color: 'var(--admin-text-primary)', fontSize: '0.9375rem', whiteSpace: 'nowrap' }}>Manager Portal</span>
            <span className="hide-mobile" style={{ fontSize: '0.7rem', background: '#FEF3C7', color: '#92400E', padding: '0.1rem 0.5rem', borderRadius: 20, fontWeight: 600, whiteSpace: 'nowrap' }}>{managerInfo?.role?.toUpperCase() || 'MANAGER'}</span>
            {managerInfo?.displayName && (
              <span className="hide-mobile" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem', color: 'var(--admin-text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#38A169', display: 'inline-block', flexShrink: 0 }} />
                {managerInfo.displayName}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
            <button onClick={fetchArticles} disabled={loading} aria-label="Refresh articles" title={lastRefreshed ? `Refreshed ${lastRefreshed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'} style={{ background: 'none', border: '1px solid var(--admin-border)', borderRadius: 8, padding: '0.4rem 0.625rem', cursor: loading ? 'not-allowed' : 'pointer', color: 'var(--admin-text-secondary)', fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '0.375rem', opacity: loading ? 0.6 : 1 }}>
              <i className={`fas fa-sync-alt ${loading ? 'fa-spin' : ''}`}></i>
              <span className="hide-mobile">{lastRefreshed ? `Refreshed ${lastRefreshed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'}</span>
            </button>
            <button onClick={toggleDarkMode} aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} style={{ background: 'none', border: '1px solid var(--admin-border)', borderRadius: 8, padding: '0.4rem 0.625rem', cursor: 'pointer', color: 'var(--admin-text-secondary)', fontSize: '0.875rem', display: 'flex', alignItems: 'center' }}>
              <i className={`fas ${darkMode ? 'fa-sun' : 'fa-moon'}`}></i>
            </button>
            <button onClick={logout} disabled={signingOut} aria-label="Sign out" title="Sign out" style={{ background: 'none', border: 'none', cursor: signingOut ? 'wait' : 'pointer', color: '#EF4444', fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '0.375rem', opacity: signingOut ? 0.6 : 1 }}>
              <i className={`fas ${signingOut ? 'fa-spinner fa-spin' : 'fa-right-from-bracket'}`}></i>
              <span className="hide-mobile">{signingOut ? 'Signing out…' : 'Sign out'}</span>
            </button>
          </div>
        </div>

        {/* TAB NAV — matches masteradmin style */}
        <div style={{ borderBottom: '1px solid var(--admin-border)', background: 'var(--admin-topbar)', padding: '0 1.25rem', display: 'flex', gap: '0.25rem', overflowX: 'auto', flexShrink: 0 }}>
          {[
            { id: 'articles',   label: 'FAQ Articles', icon: 'fa-list' },
            { id: 'add',        label: editingId ? 'Edit Article' : 'Add Article', icon: 'fa-plus' },
            { id: 'categories', label: 'Categories', icon: 'fa-folder-tree' },
            { id: 'tickets',    label: 'Tickets', icon: 'fa-envelope' },
            { id: 'feedback',   label: 'Feedback', icon: 'fa-comment-dots' },
            { id: 'audit',      label: 'Audit Log', icon: 'fa-scroll' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => { setActiveView(tab.id as 'articles' | 'add' | 'tickets' | 'audit' | 'categories' | 'feedback'); if (tab.id !== 'add') { setEditingId(null); setForm(emptyForm); setFormMsg(''); } setSidebarOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.75rem 0.875rem', background: 'none', border: 'none', borderBottom: `2px solid ${activeView === tab.id ? '#00AB4E' : 'transparent'}`, color: activeView === tab.id ? '#00AB4E' : 'var(--admin-text-secondary)', cursor: 'pointer', fontSize: '0.875rem', fontWeight: activeView === tab.id ? 700 : 500, whiteSpace: 'nowrap', flexShrink: 0, transition: 'color 0.15s' }}
            >
              <i className={`fas ${tab.icon}`} style={{ fontSize: '0.8rem' }}></i>
              {tab.label}
              {tab.id === 'tickets' && openTickets > 0 && (
                <span style={{ background: '#F97316', color: 'white', fontSize: '0.65rem', fontWeight: 700, padding: '0.1rem 0.4rem', borderRadius: 20 }}>{openTickets} open</span>
              )}
            </button>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingLeft: '1rem' }}>
            <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.75rem 0.5rem', color: 'var(--admin-text-muted)', fontSize: '0.8125rem', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              <i className="fas fa-arrow-up-right-from-square" style={{ fontSize: '0.75rem' }}></i>
              <span className="hide-mobile">View Site</span>
            </Link>
          </div>
        </div>

        {/* SESSION EXPIRY WARNING */}
        {sessionWarning && (
          <div style={{ background: '#FFFBEB', borderBottom: '1px solid #F59E0B', padding: '0.625rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
            <i className="fas fa-clock" style={{ color: '#D97706', fontSize: '0.875rem' }}></i>
            <span style={{ fontSize: '0.8125rem', color: '#92400E', fontWeight: 600, flex: 1 }}>
              Your session expires soon. Save any unsaved work before you&apos;re signed out.
            </span>
            <button onClick={() => setSessionWarning(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#92400E', fontSize: '1rem', lineHeight: 1 }}>×</button>
          </div>
        )}

        {/* SCROLLABLE CONTENT */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.75rem' }}>

          {/* STATS */}
          {activeView === 'articles' && (
            <>
            {catFilter && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', fontSize: '0.8125rem', color: 'var(--admin-text-secondary)' }}>
                <i className="fas fa-filter" style={{ fontSize: '0.7rem' }}></i>
                Counts for <strong style={{ color: 'var(--admin-text-primary)' }}>{catFilter}</strong>
                <button onClick={() => { setCatFilter(''); setPage(1); }} style={{ background: 'none', border: 'none', color: '#3B82F6', cursor: 'pointer', fontSize: 'inherit', fontWeight: 600, padding: 0 }}>Show all categories</button>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              {[
                { label: catFilter ? `${catFilter} Articles` : 'Total Articles', value: totalCount, icon: 'fa-file-lines', color: '#EFF6FF', iconColor: '#3B82F6' },
                { label: 'Published', value: publishedCount, icon: 'fa-circle-check', color: '#F0FFF4', iconColor: '#38A169' },
                { label: 'Drafts', value: draftCount, icon: 'fa-file-pen', color: '#FFFBEB', iconColor: '#D97706' },
                { label: 'Open Tickets', value: openTickets, icon: 'fa-ticket', color: '#FAF5FF', iconColor: '#7C3AED' },
              ].map((s) => (
                <div key={s.label} style={{ background: 'var(--admin-surface)', borderRadius: 12, border: '1px solid var(--admin-border)', padding: '1.125rem 1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div style={{ width: 44, height: 44, borderRadius: 10, background: s.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.125rem', flexShrink: 0, color: s.iconColor }}><i className={`fas ${s.icon}`}></i></div>
                  <div>
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--admin-text-secondary)', marginBottom: '0.25rem' }}>{s.label}</div>
                    {loading ? (
                      <div style={{ width: 48, height: 26, borderRadius: 6, background: 'var(--admin-border)', animation: 'pulse 1.5s ease-in-out infinite' }} />
                    ) : (
                      <div style={{ fontSize: '1.625rem', fontWeight: 800, color: 'var(--admin-text-primary)', lineHeight: 1 }}>{s.value}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            </>
          )}

          {/* ARTICLES VIEW */}
          {activeView === 'articles' && (
            <>
              {/* Drafts-awaiting-review banner. The original incident was 310
                  imported drafts nobody could see; this makes that state loud and
                  gives it a one-click route, so it can't quietly accumulate. */}
              {!loading && libraryDraftCount > 0 && statusFilter !== 'draft' && (
                <div style={{ background: '#FFFBEB', border: '1.5px solid #FCD34D', borderRadius: 12, padding: '0.875rem 1.125rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <i className="fas fa-file-pen" style={{ color: '#D97706', fontSize: '1rem' }}></i>
                  <span style={{ fontSize: '0.875rem', color: '#78350F', fontWeight: 600, flex: 1, minWidth: 200 }}>
                    {libraryDraftCount.toLocaleString()} article{libraryDraftCount !== 1 ? 's' : ''} {libraryDraftCount !== 1 ? 'are' : 'is'} still a draft and {libraryDraftCount !== 1 ? 'are' : 'is'} not visible to customers.
                  </span>
                  <button
                    onClick={() => { setStatusFilter('draft'); setCatFilter(''); setSearch(''); setPage(1); }}
                    style={{ padding: '0.4rem 0.875rem', background: '#D97706', color: 'white', border: 'none', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    Review {libraryDraftCount.toLocaleString()} draft{libraryDraftCount !== 1 ? 's' : ''}
                  </button>
                </div>
              )}
              {/* Filter bar */}
              <div style={{ background: 'var(--admin-surface)', borderRadius: 12, border: '1px solid var(--admin-border)', padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 160, position: 'relative' }}>
                  <i className="fas fa-search" style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--admin-text-muted)', fontSize: '0.75rem', pointerEvents: 'none' }}></i>
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                    placeholder="Search articles..."
                    style={{ width: '100%', padding: '0.5rem 0.875rem 0.5rem 2rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)' }}
                  />
                </div>
                <select
                  value={catFilter}
                  onChange={(e) => { setCatFilter(e.target.value); setPage(1); }}
                  style={{ padding: '0.5rem 0.75rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--admin-surface)', color: 'var(--admin-text-primary)', cursor: 'pointer' }}
                >
                  <option value="">All Categories</option>
                  {allCategoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                  style={{ padding: '0.5rem 0.75rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--admin-surface)', color: 'var(--admin-text-primary)', cursor: 'pointer' }}
                >
                  <option value="">All Status</option>
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </select>
                <select
                  value={sortBy}
                  onChange={(e) => { setSortBy(e.target.value as 'default' | 'title' | 'category'); setPage(1); }}
                  style={{ padding: '0.5rem 0.75rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--admin-surface)', color: 'var(--admin-text-primary)', cursor: 'pointer' }}
                >
                  <option value="default">Default Order</option>
                  <option value="title">Sort: Title A–Z</option>
                  <option value="category">Sort: Category</option>
                </select>
                <button onClick={fetchArticles} aria-label="Refresh articles" title="Refresh" style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--admin-text-secondary)', flexShrink: 0 }}>
                  <i className="fas fa-rotate-right"></i>
                </button>
              </div>

              {/* Table */}
              <div style={{ background: 'var(--admin-surface)', borderRadius: 12, border: '1px solid var(--admin-border)', overflow: 'hidden' }}>
                <div style={{ padding: '1.125rem 1.25rem', borderBottom: '1px solid var(--admin-border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--admin-text-primary)' }}>
                    Articles <span style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: 500 }}>({filtered.length} total)</span>
                  </h2>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {bulkRunning ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.875rem', fontSize: '0.8125rem', fontWeight: 700, color: 'var(--admin-text-secondary)' }}>
                        <i className="fas fa-spinner fa-spin" style={{ fontSize: '0.7rem' }}></i>
                        {bulkProgress.done}/{bulkProgress.total}…
                      </span>
                    ) : (<>
                      {bulkTargetsFor('publish').length > 0 && statusFilter === 'draft' && (
                        <button onClick={() => setBulkAction('publish')} title="Publish every draft currently listed" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.875rem', background: '#38A169', color: 'white', border: 'none', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer' }}>
                          <i className="fas fa-circle-check" style={{ fontSize: '0.7rem' }}></i> Publish all {bulkTargetsFor('publish').length}
                        </button>
                      )}
                      {bulkTargetsFor('unpublish').length > 0 && statusFilter === 'published' && (
                        <button onClick={() => setBulkAction('unpublish')} title="Take every listed article off the public portal (reversible)" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.875rem', background: 'var(--admin-surface)', color: '#D97706', border: '1.5px solid #FCD34D', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer' }}>
                          <i className="fas fa-eye-slash" style={{ fontSize: '0.7rem' }}></i> Unpublish all {bulkTargetsFor('unpublish').length}
                        </button>
                      )}
                      {/* Delete needs an active filter (without one, "everything
                          listed" is the entire knowledge base) AND the master-admin
                          role. Self-signup provisions managers automatically, and
                          the API applies no role check to DELETE /faq/{id}; before
                          bulk delete existed, clearing the library meant ~1,500
                          separate confirmations. Don't hand that away to every
                          auto-provisioned account. */}
                      {managerInfo?.role === 'masteradmin' && (catFilter || search || statusFilter) && filtered.length > 0 && (
                        <button onClick={() => { setBulkConfirmText(''); setBulkAction('delete'); }} title="Permanently delete every listed article" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.875rem', background: 'var(--admin-surface)', color: '#E53E3E', border: '1.5px solid #FEB2B2', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer' }}>
                          <i className="fas fa-trash" style={{ fontSize: '0.7rem' }}></i> Delete all {filtered.length}
                        </button>
                      )}
                    </>)}
                    {orderChanged && (
                      <button onClick={saveOrder} disabled={savingOrder} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.875rem', background: '#00AB4E', color: 'white', border: 'none', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 700, cursor: savingOrder ? 'not-allowed' : 'pointer', opacity: savingOrder ? 0.7 : 1 }}>
                        <i className={`fas ${savingOrder ? 'fa-spinner fa-spin' : 'fa-save'}`} style={{ fontSize: '0.7rem' }}></i>
                        {savingOrder ? 'Saving...' : 'Save Order'}
                      </button>
                    )}
                    <input ref={importInputRef} type="file" accept=".csv,text/csv" onChange={handleImportFile} style={{ display: 'none' }} />
                    <button onClick={downloadTemplate} title="Download a CSV template" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.75rem', background: 'var(--admin-surface)', color: 'var(--admin-text-secondary)', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                      <i className="fas fa-file-csv" style={{ fontSize: '0.7rem' }}></i> Template
                    </button>
                    <button onClick={() => importInputRef.current?.click()} title="Bulk-import articles from a CSV file" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.875rem', background: 'var(--admin-surface)', color: 'var(--admin-text-primary)', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer' }}>
                      <i className="fas fa-file-import" style={{ fontSize: '0.7rem' }}></i> Import CSV
                    </button>
                    <button onClick={() => { setEditingId(null); setForm(emptyForm); setFormMsg(''); setActiveView('add'); }} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.875rem', background: '#1A202C', color: 'white', border: 'none', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer' }}>
                      <i className="fas fa-plus" style={{ fontSize: '0.7rem' }}></i> Add Article
                    </button>
                  </div>
                </div>
                {loading ? (
                  <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--admin-text-muted)' }}>Loading articles...</div>
                ) : error ? (
                  <div style={{ textAlign: 'center', padding: '3rem' }}>
                    <p style={{ color: '#E53E3E', marginBottom: '1rem' }}>{error}</p>
                    <button onClick={fetchArticles} style={{ padding: '0.5rem 1rem', background: '#1A202C', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600 }}>Retry</button>
                  </div>
                ) : filtered.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--admin-text-muted)' }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '1rem', color: 'var(--admin-text-muted)' }}><i className="fas fa-file-lines"></i></div>
                    <p style={{ fontSize: '0.875rem' }}>{search || catFilter || statusFilter ? 'No articles match your filters.' : 'No articles yet. Add your first article!'}</p>
                  </div>
                ) : (
                  <>
                    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
                      <thead>
                        <tr style={{ background: 'var(--admin-row-hover)' }}>
                          {['#', 'Question / Title', 'Category', 'Status', 'Actions'].map((h) => (
                            <th key={h} style={{ textAlign: 'left', padding: '0.75rem 1.25rem', borderBottom: '2px solid #EDF2F7', color: 'var(--admin-text-secondary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {paginated.map((article, i) => {
                          const isPublished = isLive(article.status);
                          const isToggling = togglingId === article.id;
                          const isDeleting = deletingId === article.id;
                          const lastAudit = auditLogs
                            .filter(l => l.entityId === article.id && (l.action === 'UPDATE_FAQ' || l.action === 'CREATE_FAQ'))
                            .sort((x, y) => new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime())[0];
                          return (
                            <tr key={article.id} style={{ borderBottom: '1px solid var(--admin-border-subtle)' }}>
                              <td style={{ padding: '0.875rem 1.25rem', color: 'var(--admin-text-muted)', fontWeight: 600, fontSize: '0.8125rem', width: 48 }}>
                                {(safePage - 1) * PAGE_SIZE + i + 1}
                              </td>
                              <td style={{ padding: '0.875rem 1.25rem', maxWidth: 380 }}>
                                <div style={{ fontWeight: 600, color: 'var(--admin-text-primary)', fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {article.title || article.question || 'Untitled'}
                                </div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-muted)', fontFamily: 'monospace', marginTop: 2 }}>{article.id}</div>
                                {lastAudit && (
                                  <div style={{ fontSize: '0.68rem', color: 'var(--admin-text-muted)', marginTop: 3 }}>
                                    Updated: {new Date(lastAudit.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} by {lastAudit.performedBy}
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: '0.875rem 1.25rem', width: 160 }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', padding: '0.2rem 0.6rem', borderRadius: 20, fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', background: '#EFF6FF', color: '#3B82F6', whiteSpace: 'nowrap' }}>
                                  {article.category}
                                </span>
                              </td>
                              <td style={{ padding: '0.875rem 1.25rem', width: 140 }}>
                                <button
                                  onClick={() => handleToggleStatus(article)}
                                  disabled={isToggling}
                                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'none', border: 'none', cursor: isToggling ? 'wait' : 'pointer', padding: 0 }}
                                >
                                  <div style={{ position: 'relative', width: 40, height: 22 }}>
                                    <div style={{ position: 'absolute', inset: 0, background: isPublished ? '#38A169' : '#CBD5E0', borderRadius: 22, transition: 'background 0.2s' }} />
                                    <div style={{ position: 'absolute', width: 16, height: 16, background: 'var(--admin-surface)', borderRadius: '50%', top: 3, left: isPublished ? 21 : 3, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
                                  </div>
                                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: isPublished ? '#38A169' : '#E53E3E' }}>
                                    {isToggling ? '...' : isPublished ? 'Published' : 'Draft'}
                                  </span>
                                </button>
                              </td>
                              <td style={{ padding: '0.875rem 1.25rem', width: 130 }}>
                                <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
                                  {sortBy === 'default' && !!catFilter && (() => {
                                    // Index into `articles`, NOT into the filtered/paginated
                                    // page: with a category filter on, the visual row index
                                    // pointed at a different article entirely, so Move Up/Down
                                    // silently no-op'd or swapped the wrong two rows.
                                    const gi = articles.findIndex((a) => a.id === article.id);
                                    const cat = catFilter;
                                    const peers = articles.map((a, idx) => idx).filter((idx) => articles[idx].category === cat);
                                    const peerPos = peers.indexOf(gi);
                                    const isFirst = peerPos === 0;
                                    const isLast = peerPos === peers.length - 1;
                                    return (<>
                                      <button onClick={() => moveArticle(gi, 'up', cat)} disabled={isFirst} title="Move Up" style={{ width: 34, height: 34, borderRadius: 6, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: isFirst ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#718096', opacity: isFirst ? 0.3 : 1 }}>
                                        <i className="fas fa-arrow-up" style={{ fontSize: '0.75rem' }}></i>
                                      </button>
                                      <button onClick={() => moveArticle(gi, 'down', cat)} disabled={isLast} title="Move Down" style={{ width: 34, height: 34, borderRadius: 6, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: isLast ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#718096', opacity: isLast ? 0.3 : 1 }}>
                                        <i className="fas fa-arrow-down" style={{ fontSize: '0.75rem' }}></i>
                                      </button>
                                    </>);
                                  })()}
                                  <button onClick={() => setPreviewArticle(article)} title="Preview" style={{ width: 34, height: 34, borderRadius: 6, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-secondary)' }}>
                                    <i className="fas fa-eye" style={{ fontSize: '0.8rem' }}></i>
                                  </button>
                                  <button onClick={() => handleEdit(article)} title="Edit" style={{ width: 34, height: 34, borderRadius: 6, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3B82F6' }}>
                                    <i className="fas fa-pen" style={{ fontSize: '0.8rem' }}></i>
                                  </button>
                                  <button onClick={() => handleDelete(article.id)} disabled={isDeleting} title="Delete" style={{ width: 34, height: 34, borderRadius: 6, border: '1.5px solid #FEB2B2', background: 'var(--admin-surface)', cursor: isDeleting ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#E53E3E', opacity: isDeleting ? 0.5 : 1 }}>
                                    <i className="fas fa-trash" style={{ fontSize: '0.8rem' }}></i>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div style={{ padding: '1rem 1.25rem', borderTop: '1px solid #EDF2F7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1} style={{ padding: '0.375rem 0.875rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, background: 'var(--admin-surface)', cursor: safePage === 1 ? 'not-allowed' : 'pointer', opacity: safePage === 1 ? 0.4 : 1, fontSize: '0.8125rem', fontWeight: 600, color: '#4A5568' }}>Previous</button>
                        <span style={{ fontSize: '0.8125rem', color: 'var(--admin-text-secondary)' }}>Page {safePage} of {totalPages}</span>
                        <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages} style={{ padding: '0.375rem 0.875rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, background: 'var(--admin-surface)', cursor: safePage === totalPages ? 'not-allowed' : 'pointer', opacity: safePage === totalPages ? 0.4 : 1, fontSize: '0.8125rem', fontWeight: 600, color: '#4A5568' }}>Next</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {/* ADD / EDIT ARTICLE VIEW */}
          {activeView === 'add' && (
            <div style={{ maxWidth: 720 }}>
              <div style={{ background: 'var(--admin-surface)', borderRadius: 12, border: '1px solid var(--admin-border)', padding: '1.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                  <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--admin-text-primary)' }}>{editingId ? 'Edit Article' : 'Add New Article'}</h2>
                  {editingId && (
                    <button onClick={handleCancelEdit} style={{ fontSize: '0.8125rem', color: 'var(--admin-text-secondary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Cancel Edit</button>
                  )}
                </div>
                <form onSubmit={handleSubmitForm}>
                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#4A5568', marginBottom: '0.375rem' }}>Title / Question *</label>
                    <input
                      type="text"
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      placeholder="e.g. How to place a GTT order?"
                      style={{ width: '100%', padding: '0.625rem 0.875rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#4A5568', marginBottom: '0.375rem' }}>Category *</label>
                    <select
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                      style={{ width: '100%', padding: '0.625rem 0.875rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--admin-surface)', color: 'var(--admin-text-primary)', boxSizing: 'border-box' }}
                    >
                      <option value="">Select a category...</option>
                      {dynamicCategories.length > 0 ? (<>
                        {topLevelCats.map(cat => {
                          const subs = getSubcats(cat.id);
                          return subs.length > 0 ? (
                            <optgroup key={cat.id} label={cat.name}>
                              <option value={cat.name}>{cat.name} (general)</option>
                              {subs.map(sub => <option key={sub.id} value={sub.name}>{sub.name}</option>)}
                            </optgroup>
                          ) : (
                            <option key={cat.id} value={cat.name}>{cat.name}</option>
                          );
                        })}
                        {articleOnlyCategories.length > 0 && (
                          <optgroup label="— Existing (not yet in Categories) —">
                            {articleOnlyCategories.map(c => <option key={c} value={c}>{c}</option>)}
                          </optgroup>
                        )}
                      </>) : (
                        FALLBACK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)
                      )}
                    </select>
                  </div>
                  <div style={{ marginBottom: '1.25rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                      <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#4A5568' }}>Content / Answer *</label>
                      <span style={{ fontSize: '0.75rem', color: contentLen > MAX_CONTENT ? '#E53E3E' : contentLen > WARN_CONTENT ? '#DD6B20' : '#A0AEC0', fontWeight: contentLen > WARN_CONTENT ? 600 : 400 }}>
                        {contentLen} / {MAX_CONTENT}
                      </span>
                    </div>
                    <textarea
                      value={form.content}
                      onChange={(e) => setForm({ ...form, content: e.target.value })}
                      placeholder="Write the answer or article content here..."
                      rows={8}
                      style={{ width: '100%', padding: '0.625rem 0.875rem', border: `1.5px solid ${contentLen > MAX_CONTENT ? '#FC8181' : contentLen > WARN_CONTENT ? '#F6AD55' : '#E2E8F0'}`, borderRadius: 8, fontSize: '0.875rem', outline: 'none', resize: 'vertical', minHeight: 120, fontFamily: 'inherit', boxSizing: 'border-box' }}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'var(--admin-text-muted)', marginTop: '0.25rem' }}>Write a clear, detailed answer. Max 50,000 characters.</p>
                  </div>
                  <div style={{ marginBottom: '1.25rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#4A5568', marginBottom: '0.375rem' }}>Status</label>
                    <div style={{ display: 'flex', gap: '1rem' }}>
                      {['published', 'draft'].map((s) => (
                        <label key={s} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500 }}>
                          <input type="radio" name="status" value={s} checked={form.status === s} onChange={() => setForm({ ...form, status: s })} />
                          {s.charAt(0).toUpperCase() + s.slice(1)}
                        </label>
                      ))}
                    </div>
                  </div>
                  {formMsg && (
                    <div style={{ padding: '0.75rem 1rem', borderRadius: 8, fontSize: '0.875rem', marginBottom: '1rem', background: formMsg.includes('success') ? '#F0FFF4' : '#FFF5F5', border: `1px solid ${formMsg.includes('success') ? '#9AE6B4' : '#FEB2B2'}`, color: formMsg.includes('success') ? '#276749' : '#C53030', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {formMsg}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '1.5rem', borderTop: '1px solid #EDF2F7' }}>
                    <button type="submit" disabled={submitting || contentLen > MAX_CONTENT} style={{ padding: '0.75rem 1.5rem', background: '#1A202C', color: 'white', border: 'none', borderRadius: 8, fontSize: '0.875rem', fontWeight: 700, cursor: submitting || contentLen > MAX_CONTENT ? 'not-allowed' : 'pointer', opacity: submitting || contentLen > MAX_CONTENT ? 0.6 : 1 }}>
                      {submitting ? (editingId ? 'Updating...' : 'Adding...') : (editingId ? 'Update Article' : 'Add Article')}
                    </button>
                    <button type="button" onClick={() => setActiveView('articles')} style={{ padding: '0.75rem 1.5rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', color: '#4A5568' }}>
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* CATEGORIES VIEW */}
          {activeView === 'categories' && (
            <div style={{ maxWidth: 900 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div>
                  <h2 style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--admin-text-primary)', marginBottom: '0.2rem' }}>Category Management</h2>
                  <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.8125rem' }}>Organise top-level categories and subcategories shown on the Knowledge Base.</p>
                </div>
                <button onClick={fetchCategories} style={{ padding: '0.5rem 1rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 8, cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--admin-text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <i className="fas fa-rotate-right"></i> Refresh
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1.25rem', alignItems: 'start' }}>
                {/* ── Form panel ── */}
                <div style={{ background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 14, padding: '1.25rem', position: 'sticky', top: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.125rem' }}>
                    <div style={{ width: 30, height: 30, borderRadius: 8, background: editingCatId ? '#EFF6FF' : '#F0FFF4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <i className={editingCatId ? 'fas fa-pen' : 'fas fa-plus'} style={{ fontSize: '0.7rem', color: editingCatId ? '#1E40AF' : '#00AB4E' }}></i>
                    </div>
                    <h3 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--admin-text-primary)' }}>
                      {editingCatId ? 'Edit Category' : 'New Category'}
                    </h3>
                  </div>

                  <form onSubmit={async (e) => {
                    e.preventDefault();
                    if (!catForm.name.trim()) { setCatFormMsg('Name is required.'); return; }
                    setCatSubmitting(true); setCatFormMsg('');
                    try {
                      const method = editingCatId ? 'PUT' : 'POST';
                      const url = editingCatId ? `${API_BASE}/categories/${editingCatId}` : `${API_BASE}/categories`;
                      const res = await fetch(url, { method, headers: authHeaders(managerToken), body: JSON.stringify({ name: catForm.name.trim(), icon: catForm.icon, parentId: catForm.parentId || null, description: catForm.description.trim() }) });
                      if (res.status === 401) { handleSessionExpired(); return; }
                      if (!res.ok) throw new Error('Failed');
                      setCatFormMsg(editingCatId ? '✓ Category updated!' : '✓ Category created!');
                      setCatForm({ name: '', icon: 'fas fa-folder', parentId: '', description: '' });
                      setEditingCatId(null);
                      fetchCategories();
                      setTimeout(() => setCatFormMsg(''), 3000);
                    } catch { setCatFormMsg('Something went wrong. Please try again.'); }
                    finally { setCatSubmitting(false); }
                  }}>
                    <div style={{ marginBottom: '0.75rem' }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Name *</label>
                      <input type="text" value={catForm.name} onChange={e => setCatForm({ ...catForm, name: e.target.value })} placeholder="e.g. Funds, Trading…" maxLength={100} style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)' }} />
                    </div>
                    <div style={{ marginBottom: '0.75rem' }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Description <span style={{ textTransform: 'none', fontWeight: 400, color: 'var(--admin-text-muted)' }}>— shown under the category on the site (optional)</span></label>
                      <input type="text" value={catForm.description} onChange={e => setCatForm({ ...catForm, description: e.target.value })} placeholder="e.g. Orders, GTT, Basket, AMO" maxLength={120} style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)' }} />
                      <div style={{ fontSize: '0.65rem', color: 'var(--admin-text-muted)', marginTop: '0.25rem', textAlign: 'right' }}>{catForm.description.length}/120</div>
                    </div>
                    <div style={{ marginBottom: '0.75rem' }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Type</label>
                      <select value={catForm.parentId} onChange={e => setCatForm({ ...catForm, parentId: e.target.value })} style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--admin-surface)', color: 'var(--admin-text-primary)', boxSizing: 'border-box' }}>
                        <option value="">📁 Top-level category</option>
                        {dynamicCategories.filter(c => !c.parentId).map(c => <option key={c.id} value={c.id}>↳ Subcategory of: {c.name}</option>)}
                      </select>
                    </div>
                    <div style={{ marginBottom: '1rem' }}>
                      <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Icon</label>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <div style={{ width: 36, height: 36, borderRadius: 9, background: '#F0FFF4', border: '1.5px solid #9AE6B4', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <i className={catForm.icon || 'fas fa-folder'} style={{ fontSize: '0.875rem', color: '#00AB4E' }}></i>
                        </div>
                        <input type="text" value={catForm.icon} onChange={e => setCatForm({ ...catForm, icon: e.target.value })} placeholder="fas fa-folder" style={{ flex: 1, padding: '0.5rem 0.75rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.8rem', outline: 'none', boxSizing: 'border-box', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)', fontFamily: 'monospace' }} />
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                        {['fas fa-wallet','fas fa-chart-line','fas fa-rocket','fas fa-shield-halved','fas fa-headset','fas fa-file-invoice','fas fa-building-columns','fas fa-layer-group','fas fa-bolt','fas fa-link','fas fa-seedling','fas fa-globe','fas fa-id-card','fas fa-briefcase','fas fa-tags','fas fa-robot'].map(ic => (
                          <button key={ic} type="button" title={ic} onClick={() => setCatForm({ ...catForm, icon: ic })}
                            style={{ width: 28, height: 28, borderRadius: 6, border: `1.5px solid ${catForm.icon === ic ? '#00AB4E' : 'var(--admin-border)'}`, background: catForm.icon === ic ? '#F0FFF4' : 'var(--admin-surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: catForm.icon === ic ? '#00AB4E' : 'var(--admin-text-muted)', fontSize: '0.7rem' }}>
                            <i className={ic}></i>
                          </button>
                        ))}
                      </div>
                    </div>
                    {catFormMsg && (
                      <div style={{ padding: '0.5rem 0.75rem', borderRadius: 8, fontSize: '0.8rem', marginBottom: '0.75rem', background: catFormMsg.startsWith('✓') ? '#F0FFF4' : '#FFF5F5', border: `1px solid ${catFormMsg.startsWith('✓') ? '#9AE6B4' : '#FEB2B2'}`, color: catFormMsg.startsWith('✓') ? '#276749' : '#C53030', fontWeight: 500 }}>
                        {catFormMsg}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button type="submit" disabled={catSubmitting} style={{ flex: 1, padding: '0.5rem', background: '#1A202C', color: 'white', border: 'none', borderRadius: 8, fontSize: '0.875rem', fontWeight: 700, cursor: catSubmitting ? 'not-allowed' : 'pointer', opacity: catSubmitting ? 0.7 : 1 }}>
                        {catSubmitting ? <><i className="fas fa-spinner fa-spin" style={{ marginRight: '0.375rem' }}></i>{editingCatId ? 'Saving…' : 'Creating…'}</> : (editingCatId ? 'Save Changes' : 'Create Category')}
                      </button>
                      {editingCatId && (
                        <button type="button" onClick={() => { setEditingCatId(null); setCatForm({ name: '', icon: 'fas fa-folder', parentId: '', description: '' }); setCatFormMsg(''); }} style={{ padding: '0.5rem 0.75rem', background: 'none', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', color: 'var(--admin-text-secondary)' }}>Cancel</button>
                      )}
                    </div>
                  </form>
                </div>

                {/* ── Category tree panel ── */}
                <div>
                  <div style={{ marginBottom: '0.75rem' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {topLevelCats.length} {topLevelCats.length === 1 ? 'Category' : 'Categories'} · {dynamicCategories.filter(c => c.parentId).length} Subcategories
                    </span>
                  </div>
                  {catLoading ? (
                    <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--admin-text-muted)', background: 'var(--admin-surface)', borderRadius: 14, border: '1.5px solid var(--admin-border)' }}>
                      <i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem', marginBottom: '0.75rem', display: 'block' }}></i>Loading…
                    </div>
                  ) : catError ? (
                    <div style={{ padding: '3rem', textAlign: 'center', color: '#C53030', background: '#FFF5F5', borderRadius: 14, border: '1px solid #FEB2B2', fontSize: '0.875rem' }}>{catError}</div>
                  ) : dynamicCategories.length === 0 ? (
                    <div style={{ padding: '4rem', textAlign: 'center', background: 'var(--admin-surface)', borderRadius: 14, border: '1.5px dashed var(--admin-border)' }}>
                      <i className="fas fa-folder-open" style={{ fontSize: '2rem', color: 'var(--admin-text-muted)', marginBottom: '0.75rem', display: 'block' }}></i>
                      <p style={{ color: 'var(--admin-text-muted)', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>No categories yet</p>
                      <p style={{ color: 'var(--admin-text-muted)', fontSize: '0.8rem' }}>Create your first category using the form.</p>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {topLevelCats.map(cat => {
                        const subs = getSubcats(cat.id);
                        return (
                          <div key={cat.id} style={{ background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 12, overflow: 'hidden' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.875rem 1rem', background: editingCatId === cat.id ? '#EFF6FF' : 'var(--admin-surface)' }}>
                              <div style={{ width: 36, height: 36, borderRadius: 9, background: '#F0FFF4', border: '1.5px solid #9AE6B4', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <i className={cat.icon} style={{ color: '#00AB4E', fontSize: '0.875rem' }}></i>
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--admin-text-primary)', marginBottom: '0.1rem' }}>{cat.name}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--admin-text-muted)' }}>{subs.length > 0 ? `${subs.length} subcategor${subs.length === 1 ? 'y' : 'ies'}` : 'Top-level · no subcategories'}</div>
                              </div>
                              <div style={{ display: 'flex', gap: '0.375rem' }}>
                                <button title="Add subcategory" onClick={() => { setCatForm({ name: '', icon: 'fas fa-folder', parentId: cat.id, description: '' }); setEditingCatId(null); setCatFormMsg(''); }} style={{ height: 28, padding: '0 0.5rem', borderRadius: 6, border: '1.5px solid #9AE6B4', background: '#F0FFF4', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#00AB4E', fontSize: '0.7rem', fontWeight: 600 }}>
                                  <i className="fas fa-plus" style={{ fontSize: '0.55rem' }}></i> Sub
                                </button>
                                <button title="Edit" onClick={() => { setEditingCatId(cat.id); setCatForm({ name: cat.name, icon: cat.icon, parentId: '', description: cat.description || '' }); setCatFormMsg(''); }} style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3B82F6' }}>
                                  <i className="fas fa-pen" style={{ fontSize: '0.6rem' }}></i>
                                </button>
                                <button title="Delete" disabled={!!deletingCatId} onClick={async () => {
                                  if (!confirm(`Delete "${cat.name}"?${subs.length > 0 ? `\n\nThis will also delete its ${subs.length} subcategor${subs.length === 1 ? 'y' : 'ies'}.` : ''}`)) return;
                                  setDeletingCatId(cat.id);
                                  try {
                                    for (const sub of subs) { await fetch(`${API_BASE}/categories/${sub.id}`, { method: 'DELETE', headers: authHeaders(managerToken) }); }
                                    const res = await fetch(`${API_BASE}/categories/${cat.id}`, { method: 'DELETE', headers: authHeaders(managerToken) });
                                    if (res.status === 401) { handleSessionExpired(); return; }
                                    if (!res.ok) throw new Error('Failed');
                                    fetchCategories(); showToast('Category deleted.');
                                  } catch { showToast('Failed to delete category.'); }
                                  finally { setDeletingCatId(null); }
                                }} style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid #FEB2B2', background: '#FFF5F5', cursor: deletingCatId ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#E53E3E', opacity: deletingCatId === cat.id ? 0.5 : 1 }}>
                                  {deletingCatId === cat.id ? <i className="fas fa-spinner fa-spin" style={{ fontSize: '0.6rem' }}></i> : <i className="fas fa-trash" style={{ fontSize: '0.6rem' }}></i>}
                                </button>
                              </div>
                            </div>
                            {subs.length > 0 && (
                              <div style={{ borderTop: '1px solid var(--admin-border)' }}>
                                {subs.map((sub, idx) => (
                                  <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 1rem', background: editingCatId === sub.id ? '#EFF6FF' : idx % 2 === 0 ? 'var(--admin-row-hover)' : 'var(--admin-surface)', borderBottom: idx < subs.length - 1 ? '1px solid var(--admin-border)' : 'none' }}>
                                    <div style={{ width: 8 }}></div>
                                    <i className="fas fa-corner-down-right" style={{ fontSize: '0.55rem', color: 'var(--admin-text-muted)', flexShrink: 0 }}></i>
                                    <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--admin-surface)', border: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                      <i className={sub.icon} style={{ color: '#718096', fontSize: '0.7rem' }}></i>
                                    </div>
                                    <span style={{ flex: 1, fontSize: '0.875rem', color: 'var(--admin-text-primary)', fontWeight: 500 }}>{sub.name}</span>
                                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                                      <button title="Edit" onClick={() => { setEditingCatId(sub.id); setCatForm({ name: sub.name, icon: sub.icon, parentId: sub.parentId || '', description: sub.description || '' }); setCatFormMsg(''); }} style={{ width: 26, height: 26, borderRadius: 6, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3B82F6' }}>
                                        <i className="fas fa-pen" style={{ fontSize: '0.55rem' }}></i>
                                      </button>
                                      <button title="Delete" disabled={!!deletingCatId} onClick={async () => {
                                        if (!confirm(`Delete subcategory "${sub.name}"?`)) return;
                                        setDeletingCatId(sub.id);
                                        try {
                                          const res = await fetch(`${API_BASE}/categories/${sub.id}`, { method: 'DELETE', headers: authHeaders(managerToken) });
                                          if (res.status === 401) { handleSessionExpired(); return; }
                                          if (!res.ok) throw new Error('Failed');
                                          fetchCategories(); showToast('Subcategory deleted.');
                                        } catch { showToast('Failed to delete subcategory.'); }
                                        finally { setDeletingCatId(null); }
                                      }} style={{ width: 26, height: 26, borderRadius: 6, border: '1.5px solid #FEB2B2', background: '#FFF5F5', cursor: deletingCatId ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#E53E3E', opacity: deletingCatId === sub.id ? 0.5 : 1 }}>
                                        {deletingCatId === sub.id ? <i className="fas fa-spinner fa-spin" style={{ fontSize: '0.55rem' }}></i> : <i className="fas fa-trash" style={{ fontSize: '0.55rem' }}></i>}
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {dynamicCategories.filter(c => c.parentId && !dynamicCategories.find(p => p.id === c.parentId)).map(cat => (
                        <div key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 1rem', background: '#FFFBEB', borderRadius: 10, border: '1px solid #FCD34D' }}>
                          <i className="fas fa-triangle-exclamation" style={{ color: '#D97706', fontSize: '0.75rem' }}></i>
                          <span style={{ flex: 1, fontSize: '0.8125rem', color: '#92400E', fontWeight: 500 }}>{cat.name} <span style={{ fontWeight: 400, opacity: 0.8 }}>— orphaned subcategory (parent deleted)</span></span>
                          <button onClick={() => { setEditingCatId(cat.id); setCatForm({ name: cat.name, icon: cat.icon, parentId: cat.parentId || '', description: cat.description || '' }); setCatFormMsg(''); }} style={{ width: 26, height: 26, borderRadius: 6, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3B82F6' }}>
                            <i className="fas fa-pen" style={{ fontSize: '0.55rem' }}></i>
                          </button>
                        </div>
                      ))}

                      {/* Topics articles use that have no category record. This screen
                          listed only the categories collection, so the majority of the
                          library lived in topics that could not be edited here at all —
                          no icon, no description, no subcategories, no ordering. A CSV
                          import creates a category by writing its name onto an article,
                          which is how the gap opens without anyone doing wrong. */}
                      {unmanagedCategories.length > 0 && (
                        <div style={{ marginTop: '0.5rem', border: '1.5px solid #FCD34D', background: '#FFFBEB', borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ padding: '0.875rem 1rem', display: 'flex', alignItems: 'flex-start', gap: '0.625rem', flexWrap: 'wrap' }}>
                            <i className="fas fa-triangle-exclamation" style={{ color: '#D97706', fontSize: '0.875rem', marginTop: '0.15rem' }}></i>
                            <div style={{ flex: 1, minWidth: 240 }}>
                              <div style={{ fontWeight: 700, fontSize: '0.875rem', color: '#78350F', marginBottom: '0.2rem' }}>
                                {unmanagedCategories.length} categor{unmanagedCategories.length === 1 ? 'y is' : 'ies are'} used by articles but not set up here
                              </div>
                              <div style={{ fontSize: '0.75rem', color: '#92400E', lineHeight: 1.5 }}>
                                {unmanagedArticleCount.toLocaleString()} article{unmanagedArticleCount === 1 ? '' : 's'} sit in {unmanagedCategories.length === 1 ? 'it' : 'them'}. Customers can browse {unmanagedCategories.length === 1 ? 'it' : 'them'} on the Knowledge Base, but until a category record exists you cannot give {unmanagedCategories.length === 1 ? 'it' : 'them'} an icon, a description, subcategories or an order.
                              </div>
                            </div>
                            <button
                              onClick={() => adoptAllCategories(unmanagedCategories.map(u => u.name))}
                              disabled={!!adoptingCat}
                              style={{ padding: '0.4rem 0.875rem', borderRadius: 8, border: 'none', background: '#D97706', color: 'white', fontSize: '0.8125rem', fontWeight: 700, cursor: adoptingCat ? 'wait' : 'pointer', opacity: adoptingCat ? 0.7 : 1, whiteSpace: 'nowrap' }}
                            >
                              {adoptingCat === '__all__'
                                ? <><i className="fas fa-spinner fa-spin" style={{ fontSize: '0.7rem' }}></i> Adding…</>
                                : `Add all ${unmanagedCategories.length}`}
                            </button>
                          </div>
                          <div style={{ borderTop: '1px solid #FCD34D' }}>
                            {unmanagedCategories.map((u, idx) => (
                              <div key={u.name} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 1rem', borderBottom: idx < unmanagedCategories.length - 1 ? '1px solid #FDE68A' : 'none' }}>
                                <i className="fas fa-folder" style={{ color: '#D97706', fontSize: '0.75rem', flexShrink: 0 }}></i>
                                <span style={{ flex: 1, fontSize: '0.875rem', color: '#78350F', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                                <span style={{ fontSize: '0.75rem', color: '#92400E', flexShrink: 0 }}>{u.count.toLocaleString()} article{u.count === 1 ? '' : 's'}</span>
                                <button
                                  onClick={() => adoptOneCategory(u.name)}
                                  disabled={!!adoptingCat}
                                  style={{ height: 26, padding: '0 0.625rem', borderRadius: 6, border: '1.5px solid #D97706', background: 'var(--admin-surface)', color: '#B45309', fontSize: '0.7rem', fontWeight: 700, cursor: adoptingCat ? 'wait' : 'pointer', flexShrink: 0 }}
                                >
                                  {adoptingCat === u.name ? <i className="fas fa-spinner fa-spin" style={{ fontSize: '0.6rem' }}></i> : 'Add'}
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TICKETS VIEW */}
          {activeView === 'tickets' && (
            <div>
              {/* Ticket search bar */}
              <div style={{ background: 'var(--admin-surface)', borderRadius: 12, border: '1px solid var(--admin-border)', padding: '0.875rem 1.25rem', marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <i className="fas fa-search" style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--admin-text-muted)', fontSize: '0.75rem', pointerEvents: 'none' }}></i>
                  <input
                    type="text"
                    value={ticketSearch}
                    onChange={(e) => { setTicketSearch(e.target.value); setTicketPage(1); }}
                    placeholder="Search by name, email, subject or ID..."
                    style={{ width: '100%', padding: '0.5rem 0.875rem 0.5rem 2rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)' }}
                  />
                </div>
                {ticketSearch && (
                  <button onClick={() => { setTicketSearch(''); setTicketPage(1); }} style={{ padding: '0.4rem 0.75rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.8125rem', cursor: 'pointer', color: 'var(--admin-text-secondary)' }}>Clear</button>
                )}
              </div>
              <div style={{ background: 'var(--admin-surface)', borderRadius: 12, border: '1px solid var(--admin-border)', overflow: 'hidden' }}>
                <div style={{ padding: '1.125rem 1.25rem', borderBottom: '1px solid var(--admin-border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--admin-text-primary)' }}>
                    Support Tickets <span style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: 500 }}>({filteredTickets.length}{ticketSearch ? ` of ${tickets.length}` : ''} total, {openTickets} open)</span>
                  </h2>
                </div>
                {ticketsLoading ? (
                  <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--admin-text-muted)' }}>
                    <i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem', marginBottom: '0.75rem', display: 'block' }}></i>
                    <p style={{ fontSize: '0.875rem' }}>Loading tickets…</p>
                  </div>
                ) : ticketsError ? (
                  <div style={{ textAlign: 'center', padding: '3rem' }}>
                    <div style={{ fontSize: '2rem', marginBottom: '0.75rem', color: '#E53E3E' }}><i className="fas fa-exclamation-circle"></i></div>
                    <p style={{ color: '#E53E3E', fontSize: '0.875rem', marginBottom: '1rem' }}>{ticketsError}</p>
                    <button onClick={() => fetchTickets(managerToken)} style={{ padding: '0.5rem 1rem', background: '#1A202C', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600 }}>Retry</button>
                  </div>
                ) : filteredTickets.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--admin-text-muted)' }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '1rem', color: 'var(--admin-text-muted)' }}><i className="fas fa-ticket"></i></div>
                    <p style={{ fontSize: '0.875rem' }}>{ticketSearch ? `No tickets match "${ticketSearch}".` : 'No support tickets yet. Tickets submitted via the Contact page will appear here.'}</p>
                  </div>
                ) : (
                  <>
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
                    <thead>
                      <tr style={{ background: 'var(--admin-row-hover)' }}>
                        {['Ticket ID', 'Name', 'Email', 'Category', 'Subject', 'Status', 'Date', ''].map((h) => (
                          <th key={h} style={{ textAlign: 'left', padding: '0.75rem 1.25rem', borderBottom: '2px solid #EDF2F7', color: 'var(--admin-text-secondary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedTickets.map((ticket) => (
                        <tr key={ticket.id} style={{ borderBottom: '1px solid var(--admin-border-subtle)' }}>
                          <td style={{ padding: '0.875rem 1.25rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--admin-text-secondary)' }}>{ticket.id}</td>
                          <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--admin-text-primary)' }}>{ticket.name}</td>
                          <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.8125rem', color: 'var(--admin-text-secondary)' }}>{ticket.email}</td>
                          <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.8125rem', color: 'var(--admin-text-secondary)' }}>{ticket.category}</td>
                          <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.8125rem', color: 'var(--admin-text-primary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ticket.subject}</td>
                          <td style={{ padding: '0.875rem 1.25rem' }}>
                            <span style={{ display: 'inline-flex', padding: '0.2rem 0.6rem', borderRadius: 20, fontSize: '0.7rem', fontWeight: 700,
                              background: (ticket.status === 'solved' || ticket.status === 'resolved') ? '#F0FFF4' : ticket.status === 'in_progress' ? '#EFF6FF' : '#FFFBEB',
                              color: (ticket.status === 'solved' || ticket.status === 'resolved') ? '#276749' : ticket.status === 'in_progress' ? '#1E40AF' : '#744210' }}>
                              {ticket.status === 'in_progress' ? 'In Progress' : ticket.status === 'solved' || ticket.status === 'resolved' ? 'Solved' : ticket.status || 'Open'}
                            </span>
                          </td>
                          <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.75rem', color: 'var(--admin-text-muted)', whiteSpace: 'nowrap' }}>{ticket.date}</td>
                          <td style={{ padding: '0.875rem 1.25rem' }}>
                            <button onClick={() => setPreviewTicket(ticket)} style={{ padding: '0.3125rem 0.625rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', color: '#4A5568' }}>View</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  {totalTicketPages > 1 && (
                    <div style={{ padding: '1rem 1.25rem', borderTop: '1px solid #EDF2F7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <button onClick={() => setTicketPage(p => Math.max(1, p - 1))} disabled={safeTicketPage === 1} style={{ padding: '0.375rem 0.875rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, background: 'var(--admin-surface)', cursor: safeTicketPage === 1 ? 'not-allowed' : 'pointer', opacity: safeTicketPage === 1 ? 0.4 : 1, fontSize: '0.8125rem', fontWeight: 600, color: '#4A5568' }}>Previous</button>
                      <span style={{ fontSize: '0.8125rem', color: 'var(--admin-text-secondary)' }}>Page {safeTicketPage} of {totalTicketPages}</span>
                      <button onClick={() => setTicketPage(p => Math.min(totalTicketPages, p + 1))} disabled={safeTicketPage === totalTicketPages} style={{ padding: '0.375rem 0.875rem', border: '1.5px solid var(--admin-border)', borderRadius: 8, background: 'var(--admin-surface)', cursor: safeTicketPage === totalTicketPages ? 'not-allowed' : 'pointer', opacity: safeTicketPage === totalTicketPages ? 0.4 : 1, fontSize: '0.8125rem', fontWeight: 600, color: '#4A5568' }}>Next</button>
                    </div>
                  )}
                  </>
                )}
              </div>
            </div>
          )}
          {/* FEEDBACK VIEW */}
          {activeView === 'feedback' && (
            <div style={{ background: 'var(--admin-surface)', borderRadius: 12, border: '1px solid var(--admin-border)', overflow: 'hidden' }}>
              <div style={{ padding: '1.125rem 1.25rem', borderBottom: '1px solid var(--admin-border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--admin-text-primary)' }}>
                  User Feedback <span style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: 500 }}>({feedback.length} {feedback.length === 1 ? 'submission' : 'submissions'})</span>
                </h2>
                <button onClick={() => fetchFeedback(managerToken)} aria-label="Refresh feedback" style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 8, cursor: 'pointer', color: 'var(--admin-text-secondary)', fontSize: '0.875rem' }}>
                  <i className={`fas fa-sync-alt ${feedbackLoading ? 'fa-spin' : ''}`}></i>
                </button>
              </div>
              {feedbackLoading ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--admin-text-muted)' }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem', marginBottom: '0.75rem', display: 'block' }}></i>
                  <p style={{ fontSize: '0.875rem' }}>Loading feedback…</p>
                </div>
              ) : feedbackError ? (
                <div style={{ textAlign: 'center', padding: '3rem' }}>
                  <div style={{ fontSize: '2rem', marginBottom: '0.75rem', color: '#E53E3E' }}><i className="fas fa-exclamation-circle"></i></div>
                  <p style={{ color: '#E53E3E', fontSize: '0.875rem', marginBottom: '1rem' }}>{feedbackError}</p>
                  <button onClick={() => fetchFeedback(managerToken)} style={{ padding: '0.5rem 1rem', background: '#1A202C', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600 }}>Retry</button>
                </div>
              ) : feedback.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--admin-text-muted)' }}>
                  <div style={{ fontSize: '2.5rem', marginBottom: '1rem', color: 'var(--admin-text-muted)' }}><i className="fas fa-comment-dots"></i></div>
                  <p style={{ fontSize: '0.875rem' }}>No feedback yet. Comments submitted via the Feedback button on the site will appear here.</p>
                </div>
              ) : (
                <div style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {feedback.map((fb) => (
                    <div key={fb.id} style={{ border: '1px solid var(--admin-border-subtle)', borderRadius: 10, padding: '1rem 1.125rem', background: 'var(--admin-bg)', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: '0.875rem', color: 'var(--admin-text-primary)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{fb.message}</p>
                        <div style={{ marginTop: '0.625rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', fontSize: '0.7rem', color: 'var(--admin-text-muted)' }}>
                          <span style={{ fontFamily: 'monospace' }}>{fb.id}</span>
                          {fb.page && <span><i className="fas fa-location-dot" style={{ marginRight: '0.3rem' }}></i>{fb.page}</span>}
                          {fb.createdAt && <span><i className="fas fa-clock" style={{ marginRight: '0.3rem' }}></i>{new Date(fb.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
                        </div>
                      </div>
                      {feedbackConfirmId === fb.id ? (
                        <div style={{ display: 'flex', gap: '0.35rem', flexShrink: 0 }}>
                          <button onClick={() => deleteFeedback(fb.id)} disabled={feedbackDeletingId === fb.id} style={{ padding: '0.3rem 0.6rem', background: '#E53E3E', color: 'white', border: 'none', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700, cursor: feedbackDeletingId === fb.id ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
                            {feedbackDeletingId === fb.id ? <i className="fas fa-spinner fa-spin"></i> : 'Delete'}
                          </button>
                          <button onClick={() => setFeedbackConfirmId(null)} disabled={feedbackDeletingId === fb.id} style={{ padding: '0.3rem 0.6rem', background: 'var(--admin-surface)', color: 'var(--admin-text-secondary)', border: '1.5px solid var(--admin-border)', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setFeedbackConfirmId(fb.id)} aria-label="Delete feedback" title="Delete feedback" style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 6, border: '1.5px solid var(--admin-border)', background: 'var(--admin-surface)', cursor: 'pointer', color: '#E53E3E', fontSize: '0.8rem' }}>
                          <i className="fas fa-trash"></i>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* AUDIT LOG VIEW */}
          {activeView === 'audit' && (
            <div style={{ background: 'var(--admin-surface)', borderRadius: 12, border: '1px solid var(--admin-border)', overflow: 'hidden' }}>
              <div style={{ padding: '1.125rem 1.25rem', borderBottom: '1px solid var(--admin-border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--admin-text-primary)' }}>
                  Audit Log <span style={{ fontSize: '0.75rem', color: 'var(--admin-text-secondary)', fontWeight: 500 }}>({auditLogs.length} entries — your actions only)</span>
                </h2>
                <button onClick={() => fetchAuditLogs(managerToken)} style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 8, cursor: 'pointer', color: 'var(--admin-text-secondary)', fontSize: '0.875rem' }}>
                  <i className="fas fa-rotate-right"></i>
                </button>
              </div>
              {auditLoading ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--admin-text-muted)' }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '1.25rem', marginBottom: '0.5rem', display: 'block' }}></i> Loading…
                </div>
              ) : auditLogs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--admin-text-muted)', fontSize: '0.875rem' }}>No audit entries yet. Your actions will appear here.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
                    <thead>
                      <tr style={{ background: 'var(--admin-row-hover)' }}>
                        {['Time', 'Action', 'Entity', 'Title / ID', 'Details'].map(h => (
                          <th key={h} style={{ textAlign: 'left', padding: '0.75rem 1.25rem', borderBottom: '2px solid #EDF2F7', color: 'var(--admin-text-secondary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((log) => (
                        <tr key={log.id} style={{ borderBottom: '1px solid var(--admin-border-subtle)' }}>
                          <td style={{ padding: '0.75rem 1.25rem', fontSize: '0.75rem', color: 'var(--admin-text-muted)', whiteSpace: 'nowrap' }}>{new Date(log.timestamp).toLocaleString('en-IN')}</td>
                          <td style={{ padding: '0.75rem 1.25rem', fontSize: '0.8rem', fontWeight: 600, color: 'var(--admin-text-primary)', whiteSpace: 'nowrap' }}>{log.action}</td>
                          <td style={{ padding: '0.75rem 1.25rem', fontSize: '0.8rem', color: 'var(--admin-text-secondary)' }}>{log.entity}</td>
                          <td style={{ padding: '0.75rem 1.25rem', fontSize: '0.8rem', color: 'var(--admin-text-primary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.entityTitle || log.entityId || '—'}</td>
                          <td style={{ padding: '0.75rem 1.25rem', fontSize: '0.75rem', color: 'var(--admin-text-muted)' }}>{log.meta ? Object.entries(log.meta).map(([k, v]) => `${k}: ${v}`).join(', ') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* ARTICLE PREVIEW MODAL */}
      {previewArticle && (
        <div onClick={() => setPreviewArticle(null)} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--admin-surface)', borderRadius: 16, border: '1px solid var(--admin-border)', boxShadow: '0 25px 50px rgba(0,0,0,0.15)', maxWidth: 540, width: '100%', maxHeight: '80vh', overflowY: 'auto', padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <h3 style={{ fontWeight: 700, color: 'var(--admin-text-primary)', fontSize: '1.0625rem', lineHeight: 1.4, paddingRight: '1rem' }}>{previewArticle.title || previewArticle.question || 'Untitled'}</h3>
              <button onClick={() => setPreviewArticle(null)} style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.25rem', color: 'var(--admin-text-muted)', lineHeight: 1 }}>X</button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <span style={{ padding: '0.2rem 0.6rem', borderRadius: 20, fontSize: '0.7rem', fontWeight: 700, background: '#EFF6FF', color: '#3B82F6' }}>{previewArticle.category}</span>
              {previewArticle.status && <span style={{ padding: '0.2rem 0.6rem', borderRadius: 20, fontSize: '0.7rem', fontWeight: 700, background: '#F0FFF4', color: '#276749' }}>{previewArticle.status}</span>}
            </div>
            <p style={{ fontSize: '0.875rem', color: '#4A5568', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{previewArticle.content || previewArticle.answer || ''}</p>
          </div>
        </div>
      )}

      {/* TICKET DETAIL MODAL */}
      {previewTicket && (
        <div onClick={() => setPreviewTicket(null)} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--admin-surface)', borderRadius: 16, border: '1px solid var(--admin-border)', boxShadow: '0 25px 50px rgba(0,0,0,0.15)', maxWidth: 540, width: '100%', maxHeight: '80vh', overflowY: 'auto', padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontWeight: 700, color: 'var(--admin-text-primary)', fontSize: '1.0625rem' }}>Ticket Details</h3>
              <button onClick={() => setPreviewTicket(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.25rem', color: 'var(--admin-text-muted)' }}>X</button>
            </div>
            <dl style={{ marginBottom: '1.5rem' }}>
              {[['Ticket ID', previewTicket.id], ['Name', previewTicket.name], ['Email', previewTicket.email], ['Phone', previewTicket.phone], ['Category', previewTicket.category], ['Subject', previewTicket.subject], ['Status', previewTicket.status || 'open'], ['Date', previewTicket.date]].map(([label, value]) =>
                value ? (
                  <div key={label} style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
                    <dt style={{ width: 90, flexShrink: 0, color: 'var(--admin-text-secondary)', fontWeight: 600 }}>{label}</dt>
                    <dd style={{ color: 'var(--admin-text-primary)' }}>{value}</dd>
                  </div>
                ) : null
              )}
              {(previewTicket.description || previewTicket.message) && (
                <div style={{ marginTop: '0.75rem' }}>
                  <dt style={{ fontSize: '0.875rem', color: 'var(--admin-text-secondary)', fontWeight: 600, marginBottom: '0.5rem' }}>Description</dt>
                  <dd style={{ background: '#F7FAFC', borderRadius: 8, padding: '0.875rem', fontSize: '0.875rem', color: 'var(--admin-text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{previewTicket.description || previewTicket.message}</dd>
                </div>
              )}
            </dl>
            {previewTicket.status !== 'solved' && previewTicket.status !== 'resolved' ? (
              <button onClick={() => handleMarkResolved(previewTicket.id)} style={{ width: '100%', padding: '0.875rem', background: '#38A169', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700, cursor: 'pointer' }}>
                Mark as Solved
              </button>
            ) : (
              <div style={{ textAlign: 'center', padding: '0.75rem', background: '#F0FFF4', borderRadius: 10, border: '1px solid #9AE6B4' }}>
                <i className="fas fa-check-circle" style={{ color: '#38A169', marginRight: '0.5rem' }}></i>
                <span style={{ color: '#276749', fontWeight: 600, fontSize: '0.875rem' }}>Ticket has been solved.</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TOAST NOTIFICATION */}
      {toast && (
        <div style={{ position: 'fixed', bottom: '1.5rem', left: '50%', transform: 'translateX(-50%)', background: '#1A202C', color: 'white', padding: '0.75rem 1.5rem', borderRadius: 10, fontSize: '0.875rem', fontWeight: 600, zIndex: 80, boxShadow: '0 8px 24px rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <i className="fas fa-check-circle" style={{ color: '#68D391' }}></i>
          {toast}
        </div>
      )}

      {/* SIGNING-OUT OVERLAY — covers the dashboard the moment Sign out is clicked,
          so the session teardown is a visible action rather than a sudden blank. */}
      {signingOut && (
        <div role="status" aria-live="polite" style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,23,42,0.72)', backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
          <span style={{ width: 34, height: 34, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'admin-spin 0.7s linear infinite' }} />
          <p style={{ margin: 0, color: '#fff', fontSize: '0.9375rem', fontWeight: 600 }}>Signing you out…</p>
        </div>
      )}

      {/* DELETE CONFIRM MODAL */}
      {deleteConfirmId && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: 'var(--admin-modal-bg)', borderRadius: 16, border: '1px solid var(--admin-border)', boxShadow: '0 25px 50px rgba(0,0,0,0.2)', maxWidth: 400, width: '100%', padding: '2rem' }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: '#FFF5F5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem', fontSize: '1.25rem', color: '#E53E3E' }}>
              <i className="fas fa-trash"></i>
            </div>
            <h3 style={{ textAlign: 'center', fontWeight: 800, color: 'var(--admin-text-primary)', marginBottom: '0.5rem', fontSize: '1.0625rem' }}>Delete Article?</h3>
            <p style={{ textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
              This action cannot be undone. The article will be permanently removed.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={() => setDeleteConfirmId(null)}
                disabled={!!deletingId}
                style={{ flex: 1, padding: '0.75rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 600, cursor: deletingId ? 'not-allowed' : 'pointer', color: 'var(--admin-text-primary)', opacity: deletingId ? 0.5 : 1 }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={!!deletingId}
                style={{ flex: 1, padding: '0.75rem', background: '#E53E3E', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700, cursor: deletingId ? 'wait' : 'pointer', opacity: deletingId ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
              >
                {deletingId ? <><i className="fas fa-spinner fa-spin" style={{ fontSize: '0.875rem' }}></i> Deleting...</> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BULK ACTION CONFIRM */}
      {bulkAction && (() => {
        const targets = bulkTargetsFor(bulkAction);
        const isDelete = bulkAction === 'delete';
        // Delete is gated on typing the exact count: it forces the number to be
        // read rather than clicked past, and it cannot be satisfied by muscle
        // memory the way a fixed word like "DELETE" can.
        const armed = !isDelete || bulkConfirmText.trim() === String(targets.length);
        const scope = <>
          {catFilter ? <> in <strong>{catFilter}</strong></> : null}
          {statusFilter ? <> with status <strong>{statusFilter}</strong></> : null}
          {search ? <> matching &ldquo;{search}&rdquo;</> : null}
        </>;
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
            <div style={{ background: 'var(--admin-modal-bg)', borderRadius: 16, border: '1px solid var(--admin-border)', boxShadow: '0 25px 50px rgba(0,0,0,0.2)', maxWidth: 480, width: '100%', padding: '1.75rem' }}>
              <h3 style={{ fontWeight: 800, color: 'var(--admin-text-primary)', marginBottom: '0.75rem', fontSize: '1.0625rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <i className={`fas ${isDelete ? 'fa-triangle-exclamation' : bulkAction === 'publish' ? 'fa-circle-check' : 'fa-eye-slash'}`} style={{ color: isDelete ? '#E53E3E' : bulkAction === 'publish' ? '#38A169' : '#D97706' }}></i>
                {isDelete ? 'Delete' : bulkAction === 'publish' ? 'Publish' : 'Unpublish'} {targets.length} article{targets.length !== 1 ? 's' : ''}?
              </h3>
              <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.875rem', marginBottom: '1rem', lineHeight: 1.55 }}>
                {bulkAction === 'publish' && <>All {targets.length} listed draft{targets.length !== 1 ? 's' : ''}{scope} go live on the public portal immediately.</>}
                {bulkAction === 'unpublish' && <>All {targets.length} listed article{targets.length !== 1 ? 's' : ''}{scope} come off the public portal and become drafts. Reversible — publish them again any time.</>}
                {isDelete && <>This permanently removes all {targets.length} listed article{targets.length !== 1 ? 's' : ''}{scope}. There is no undo in this portal; recovery means reading the content back out of the audit log by hand.</>}
              </p>
              <p style={{ color: 'var(--admin-text-muted)', fontSize: '0.8125rem', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                Narrow the search, category or status filters first if you only want some of them.
              </p>
              {isDelete && (
                <div style={{ marginBottom: '1.25rem' }}>
                  <label htmlFor="bulk-confirm" style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--admin-text-primary)', marginBottom: '0.375rem' }}>
                    Type <strong>{targets.length}</strong> to confirm
                  </label>
                  <input
                    id="bulk-confirm"
                    value={bulkConfirmText}
                    onChange={(e) => setBulkConfirmText(e.target.value)}
                    placeholder={String(targets.length)}
                    autoComplete="off"
                    style={{ width: '100%', padding: '0.5rem 0.75rem', border: `1.5px solid ${armed ? '#E53E3E' : 'var(--admin-border)'}`, borderRadius: 8, fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box', background: 'var(--admin-input-bg)', color: 'var(--admin-text-primary)' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button onClick={() => { setBulkAction(null); setBulkConfirmText(''); }} style={{ flex: 1, padding: '0.75rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 600, cursor: 'pointer', color: 'var(--admin-text-primary)' }}>
                  Cancel
                </button>
                <button onClick={runBulkAction} disabled={!armed} style={{ flex: 1, padding: '0.75rem', background: !armed ? 'var(--admin-border)' : isDelete ? '#E53E3E' : bulkAction === 'publish' ? '#38A169' : '#D97706', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700, cursor: !armed ? 'not-allowed' : 'pointer' }}>
                  {isDelete ? 'Delete' : bulkAction === 'publish' ? 'Publish' : 'Unpublish'} {targets.length}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* IMPORT PREVIEW / PROGRESS MODAL */}
      {importPreview && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: 'var(--admin-modal-bg)', borderRadius: 16, border: '1px solid var(--admin-border)', boxShadow: '0 25px 50px rgba(0,0,0,0.2)', maxWidth: 520, width: '100%', padding: '1.75rem', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ fontWeight: 800, color: 'var(--admin-text-primary)', marginBottom: '0.5rem', fontSize: '1.0625rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <i className="fas fa-file-import" style={{ color: '#00AB4E' }}></i> Import Articles from CSV
            </h3>
            {importing ? (
              <div style={{ padding: '1rem 0' }}>
                <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                  Uploading… {importProgress.done} of {importProgress.total}
                </p>
                <div style={{ height: 8, background: 'var(--admin-border)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${importProgress.total ? (importProgress.done / importProgress.total) * 100 : 0}%`, background: '#00AB4E', transition: 'width 0.2s' }}></div>
                </div>
                <p style={{ color: 'var(--admin-text-muted)', fontSize: '0.75rem', marginTop: '0.75rem' }}>
                  Keep this tab open. Rows already uploaded are saved.
                </p>
                <button onClick={() => { importAbortRef.current = true; }} style={{ marginTop: '0.875rem', width: '100%', padding: '0.625rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 10, fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', color: 'var(--admin-text-primary)' }}>
                  Stop after the current row
                </button>
              </div>
            ) : (
              <>
                <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.875rem', marginBottom: '0.5rem', lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--admin-text-primary)' }}>{importPreview.valid.length}</strong> new article{importPreview.valid.length !== 1 ? 's' : ''}
                  {importPreview.duplicates.length > 0 && <> · <strong style={{ color: '#3B82F6' }}>{importPreview.duplicates.length}</strong> already in the knowledge base</>}
                  {importPreview.issues.length > 0 && <> · <strong style={{ color: '#DD6B20' }}>{importPreview.issues.length}</strong> row{importPreview.issues.length !== 1 ? 's' : ''} skipped</>}.
                </p>
                {(() => {
                  const blank = importPreview.valid.filter(v => !v.status).length;
                  const willPublish = importPreview.valid.filter(v => v.status === 'published').length + (blankStatusMode === 'published' ? blank : 0);
                  const willDraft = importPreview.valid.length - willPublish;
                  return (
                    <>
                      {/* The outcome, stated as counts. The old copy buried this in a
                          parenthetical — "(unless a row sets status)" — so an entirely
                          blank status column read as "fine" and drafted the whole file. */}
                      {importPreview.valid.length > 0 && (
                        <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.8125rem', marginBottom: blank > 0 ? '0.75rem' : '1rem', lineHeight: 1.5, display: 'flex', gap: '0.4rem' }}>
                          <i className="fas fa-circle-info" style={{ color: '#00AB4E', marginTop: '0.15rem' }}></i>
                          <span>
                            After import: <strong style={{ color: '#38A169' }}>{willPublish}</strong> live for customers
                            {' · '}<strong style={{ color: '#D97706' }}>{willDraft}</strong> draft{willDraft !== 1 ? 's' : ''} awaiting review.
                          </span>
                        </p>
                      )}
                      {blank > 0 && (
                        <div style={{ border: '1.5px solid #FCD34D', background: '#FFFBEB', borderRadius: 8, padding: '0.75rem 0.875rem', marginBottom: '1rem' }}>
                          <p style={{ fontSize: '0.8125rem', fontWeight: 700, color: '#78350F', marginBottom: '0.5rem', display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                            <i className="fas fa-triangle-exclamation" style={{ color: '#D97706', marginTop: '0.15rem' }}></i>
                            <span>
                              {blank === importPreview.valid.length
                                ? <>Every row leaves the <code>status</code> column empty.</>
                                : <>{blank} of {importPreview.valid.length} rows leave the <code>status</code> column empty.</>}
                            </span>
                          </p>
                          {([['draft', 'Import them as drafts — nobody sees them until you publish (recommended)'], ['published', 'Import them as published — live for customers immediately']] as const).map(([mode, label]) => (
                            <label key={mode} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', cursor: 'pointer', padding: '0.2rem 0', fontSize: '0.8125rem', color: '#78350F' }}>
                              <input type="radio" name="import-blank-status" checked={blankStatusMode === mode} onChange={() => setBlankStatusMode(mode)} style={{ marginTop: '0.2rem', accentColor: '#D97706' }} />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
                {importPreview.delimiter !== ',' && (
                  <p style={{ fontSize: '0.8125rem', color: 'var(--admin-text-secondary)', marginBottom: '0.75rem', display: 'flex', gap: '0.4rem' }}>
                    <i className="fas fa-circle-info" style={{ color: '#3B82F6', marginTop: '0.15rem' }}></i>
                    <span>Read as <strong>{importPreview.delimiter === ';' ? 'semicolon' : 'tab'}-separated</strong> — that&apos;s what this file uses.</span>
                  </p>
                )}
                {importPreview.newCategories.length > 0 && (
                  <div style={{ border: '1.5px solid #FCD34D', background: '#FFFBEB', borderRadius: 8, padding: '0.75rem 0.875rem', marginBottom: '1rem' }}>
                    <p style={{ fontSize: '0.8125rem', fontWeight: 700, color: '#78350F', marginBottom: '0.35rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <i className="fas fa-triangle-exclamation" style={{ color: '#D97706' }}></i>
                      New categor{importPreview.newCategories.length !== 1 ? 'ies' : 'y'} not used by any existing article
                    </p>
                    <p style={{ fontSize: '0.8125rem', color: '#78350F', lineHeight: 1.5 }}>
                      {importPreview.newCategories.map(c => `"${c}"`).join(', ')} — check for a typo. A mistyped category still imports, but customers won&apos;t find it under any existing topic.
                    </p>
                  </div>
                )}
                {importPreview.duplicates.length > 0 && (
                  <div style={{ border: '1px solid var(--admin-border)', borderRadius: 8, padding: '0.75rem 0.875rem', marginBottom: '1rem', background: 'var(--admin-row-hover)' }}>
                    <p style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--admin-text-primary)', marginBottom: '0.5rem' }}>
                      {importPreview.duplicates.length} title{importPreview.duplicates.length !== 1 ? 's' : ''} already exist{importPreview.duplicates.length === 1 ? 's' : ''} — what should happen to them?
                    </p>
                    {([['skip', 'Leave them as they are'], ['update', 'Update them with the content from this file']] as const).map(([mode, label]) => (
                      <label key={mode} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', cursor: 'pointer', padding: '0.2rem 0', fontSize: '0.8125rem', color: 'var(--admin-text-secondary)' }}>
                        <input type="radio" name="import-dup-mode" checked={importMode === mode} onChange={() => setImportMode(mode)} style={{ marginTop: '0.2rem', accentColor: '#00AB4E' }} />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                )}
                {(importPreview.duplicates.length > 0 || importPreview.issues.length > 0) && (
                  <div style={{ overflowY: 'auto', maxHeight: 200, border: '1px solid var(--admin-border)', borderRadius: 8, marginBottom: '1.25rem' }}>
                    {importPreview.duplicates.map((d) => (
                      <div key={`dup-${d.row}`} style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', borderBottom: '1px solid var(--admin-border-subtle)', color: 'var(--admin-text-secondary)' }}>
                        <span style={{ fontWeight: 700, color: importMode === 'update' ? '#3B82F6' : '#718096', flexShrink: 0 }}>Row {d.row}</span>
                        <span>{importMode === 'update' ? 'Will update' : 'Skipping'} existing {d.existingStatus}: &ldquo;{d.title}&rdquo;</span>
                      </div>
                    ))}
                    {importPreview.issues.map((iss) => (
                      <div key={`iss-${iss.row}`} style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', borderBottom: '1px solid var(--admin-border-subtle)', color: 'var(--admin-text-secondary)' }}>
                        <span style={{ fontWeight: 700, color: '#DD6B20', flexShrink: 0 }}>Row {iss.row}</span>
                        <span>{iss.reason}{iss.title ? `: "${iss.title}"` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
                {(importPreview.issues.length > 0 || (importMode === 'skip' && importPreview.duplicates.length > 0)) && (
                  <button onClick={downloadSkipped} style={{ alignSelf: 'flex-start', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.75rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 8, fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer', color: 'var(--admin-text-secondary)' }}>
                    <i className="fas fa-download" style={{ fontSize: '0.7rem' }}></i> Download skipped rows as CSV
                  </button>
                )}
                {(() => {
                  const count = importPreview.valid.length + (importMode === 'update' ? importPreview.duplicates.length : 0);
                  // Rows upload one at a time (~0.3s each measured against the live
                  // API), so a large batch takes minutes with the tab held open.
                  // Say so up front rather than letting the progress bar reveal it.
                  const secs = Math.round(count * 0.3);
                  const eta = secs < 45 ? null : secs < 90 ? 'about a minute' : `about ${Math.ceil(secs / 60)} minutes`;
                  return (<>
                    {eta && (
                      <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.8125rem', marginBottom: '0.75rem', display: 'flex', gap: '0.4rem' }}>
                        <i className="fas fa-clock" style={{ color: '#D97706', marginTop: '0.15rem' }}></i>
                        <span>This will take <strong>{eta}</strong> — keep the tab open. Prefer a quiet period: each row refreshes the server&apos;s search cache.</span>
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: '0.75rem' }}>
                      <button onClick={() => setImportPreview(null)} style={{ flex: 1, padding: '0.75rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 600, cursor: 'pointer', color: 'var(--admin-text-primary)' }}>
                        Cancel
                      </button>
                      <button onClick={runImport} disabled={count === 0} style={{ flex: 1, padding: '0.75rem', background: count === 0 ? 'var(--admin-border)' : '#00AB4E', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700, cursor: count === 0 ? 'not-allowed' : 'pointer' }}>
                        {count === 0 ? 'Nothing to import' : `Import ${count}`}
                      </button>
                    </div>
                  </>);
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {/* IMPORT RESULT MODAL */}
      {importResult && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: 'var(--admin-modal-bg)', borderRadius: 16, border: '1px solid var(--admin-border)', boxShadow: '0 25px 50px rgba(0,0,0,0.2)', maxWidth: 520, width: '100%', padding: '1.75rem', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ fontWeight: 800, color: 'var(--admin-text-primary)', marginBottom: '0.75rem', fontSize: '1.0625rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <i className={`fas ${importResult.cancelled ? 'fa-circle-pause' : 'fa-circle-check'}`} style={{ color: importResult.cancelled ? '#D97706' : '#00AB4E' }}></i> {importResult.cancelled ? 'Import Stopped' : 'Import Complete'}
            </h3>
            <p style={{ color: 'var(--admin-text-secondary)', fontSize: '0.875rem', marginBottom: importResult.failed.length ? '1rem' : '1.5rem' }}>
              <strong style={{ color: '#00AB4E' }}>{importResult.created}</strong> article{importResult.created !== 1 ? 's' : ''} added
              {importResult.updated > 0 && <> · <strong style={{ color: '#3B82F6' }}>{importResult.updated}</strong> updated</>}
              {importResult.failed.length > 0 && <> · <strong style={{ color: '#E53E3E' }}>{importResult.failed.length}</strong> failed</>}.
              {importResult.cancelled && <><br /><span style={{ fontSize: '0.8125rem' }}>Stopped early — rows already uploaded are saved. Re-import the same file to finish; rows that exist will be listed as already present.</span></>}
            </p>
            {importResult.failed.length > 0 && (
              <div style={{ overflowY: 'auto', maxHeight: 220, border: '1px solid var(--admin-border)', borderRadius: 8, marginBottom: '1.25rem' }}>
                {importResult.failed.map((f, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', borderBottom: '1px solid var(--admin-border-subtle)' }}>
                    <span style={{ fontWeight: 600, color: 'var(--admin-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Row {f.row} · {f.title}</span>
                    <span style={{ color: '#E53E3E' }}>{f.reason}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => setImportResult(null)} style={{ flex: 1, padding: '0.75rem', background: 'var(--admin-surface)', border: '1.5px solid var(--admin-border)', color: 'var(--admin-text-primary)', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 600, cursor: 'pointer' }}>
                Done
              </button>
              {libraryDraftCount > 0 && (
                <button onClick={() => { setImportResult(null); setStatusFilter('draft'); setCatFilter(''); setSearch(''); setPage(1); }} style={{ flex: 1, padding: '0.75rem', background: '#D97706', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.9375rem', fontWeight: 700, cursor: 'pointer' }}>
                  Review drafts
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
