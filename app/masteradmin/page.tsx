'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Image from 'next/image';
import { API_BASE, getMasterToken, getMasterHeaders, masterUrl } from '@/lib/api';
import { parseValidJwt } from '@/lib/jwt';
import GoogleSSOButton from '@/components/GoogleSSOButton';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditLog {
  id: string;
  timestamp: string;
  action: string;
  entity: string;
  entityId: string;
  entityTitle?: string;
  performedBy: string;
  meta?: Record<string, string>;
}

interface Manager {
  managerId: string;
  username: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt?: string;
}

interface ArticleFeedback { title: string; category: string; helpful: number; not_helpful: number; total: number; pct: number; }
interface AnalyticsSummary {
  period_days: number;
  article_views: number;
  searches: number;
  chatbot_opens: number;
  chatbot_messages: number;
  ticket_submits: number;
  faq_feedback_helpful: number;
  faq_feedback_not_helpful: number;
  top_articles: [string, number][];
  top_searches: [string, number][];
  persona_counts: Record<string, number>;
  tickets_by_category: Record<string, number>;
  article_feedback: ArticleFeedback[];
  zero_result_searches: number;
  cta_open_account: number;
  cta_login: number;
  browser_counts: Record<string, number>;
  os_counts: Record<string, number>;
  device_counts: Record<string, number>;
}

interface Ticket {
  id: string;
  name: string;
  email: string;
  category: string;
  subject: string;
  status: 'open' | 'in_progress' | 'solved' | 'resolved';
  createdAt: string;
  description?: string;
  phone?: string;
}

interface Article {
  id: string;
  title: string;
  category: string;
  status: string;
  updatedAt?: string;
}

interface Feedback {
  id: string;
  message: string;
  page?: string;
  status?: string;
  createdAt?: string;
  date?: string;
}

type Tab = 'overview' | 'managers' | 'audit' | 'tickets' | 'faq' | 'analytics' | 'categories' | 'feedback';

// Master token helpers (getMasterToken, getMasterHeaders, masterUrl) are imported from @/lib/api

const ACTION_CONFIG: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  CREATE_FAQ:          { label: 'FAQ Created',          icon: 'fa-plus-circle',   color: '#065F46', bg: '#D1FAE5' },
  UPDATE_FAQ:          { label: 'FAQ Updated',          icon: 'fa-edit',          color: '#1E40AF', bg: '#DBEAFE' },
  DELETE_FAQ:          { label: 'FAQ Deleted',          icon: 'fa-trash',         color: '#991B1B', bg: '#FEE2E2' },
  UPDATE_TICKET:       { label: 'Ticket Updated',       icon: 'fa-ticket-alt',    color: '#92400E', bg: '#FEF3C7' },
  CREATE_TICKET:       { label: 'Ticket Submitted',     icon: 'fa-inbox',         color: '#5B21B6', bg: '#EDE9FE' },
  LOGIN:               { label: 'Manager Login',        icon: 'fa-sign-in-alt',   color: '#374151', bg: '#F3F4F6' },
  LOGIN_SUCCESS:       { label: 'Manager Login',        icon: 'fa-sign-in-alt',   color: '#065F46', bg: '#D1FAE5' },
  LOGIN_FAIL:          { label: 'Login Failed',         icon: 'fa-times-circle',  color: '#991B1B', bg: '#FEE2E2' },
  LOGIN_BLOCKED:       { label: 'Login Blocked',        icon: 'fa-ban',           color: '#991B1B', bg: '#FEE2E2' },
  LOGOUT:              { label: 'Logged Out',           icon: 'fa-sign-out-alt',  color: '#374151', bg: '#F3F4F6' },
  MASTER_LOGIN_SUCCESS:{ label: 'Master Login',         icon: 'fa-shield-alt',    color: '#1E40AF', bg: '#DBEAFE' },
  MASTER_LOGIN_FAIL:   { label: 'Master Login Failed',  icon: 'fa-shield-exclamation', color: '#991B1B', bg: '#FEE2E2' },
  CREATE_MANAGER:      { label: 'Manager Created',      icon: 'fa-user-plus',     color: '#065F46', bg: '#D1FAE5' },
  UPDATE_MANAGER:      { label: 'Manager Updated',      icon: 'fa-user-edit',     color: '#1E40AF', bg: '#DBEAFE' },
  DELETE_MANAGER:      { label: 'Manager Deleted',      icon: 'fa-user-minus',    color: '#991B1B', bg: '#FEE2E2' },
};

// Manager accounts derived from audit log — anyone who has performed an action
// In a real system these would come from an ib-managers table; here we infer from audit logs.

const STATUS_CONFIG = {
  open:        { label: 'Open',        bg: '#FEF3C7', color: '#92400E' },
  in_progress: { label: 'In Progress', bg: '#DBEAFE', color: '#1E40AF' },
  solved:      { label: 'Solved',      bg: '#D1FAE5', color: '#065F46' },
};

const MAX_ATTEMPTS = 3;
const LOCKOUT_SECONDS = 60;

// ─── Component ────────────────────────────────────────────────────────────────

export default function MasterAdminPage() {
  const [mounted, setMounted] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [lockSecs, setLockSecs] = useState(0);

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [feedbackConfirmId, setFeedbackConfirmId] = useState<string | null>(null);
  const [feedbackDeletingId, setFeedbackDeletingId] = useState<string | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [auditFilter, setAuditFilter] = useState<string>('all');
  const [ticketFilter, setTicketFilter] = useState<string>('all');
  const [auditSearch, setAuditSearch] = useState('');
  const [ticketSearch, setTicketSearch] = useState('');
  const [faqSearch, setFaqSearch] = useState('');

  // Managers CRUD
  const [managers, setManagers] = useState<Manager[]>([]);
  const [managersLoading, setManagersLoading] = useState(false);
  const [managersError, setManagersError] = useState('');
  const [showCreateManager, setShowCreateManager] = useState(false);
  const [managerForm, setManagerForm] = useState({ username: '', displayName: '', email: '', role: 'manager', password: '' });
  const [showManagerPassword, setShowManagerPassword] = useState(false);
  const [managerFormMsg, setManagerFormMsg] = useState('');
  const [managerFormSaving, setManagerFormSaving] = useState(false);
  const [managerSearch, setManagerSearch] = useState('');
  const [confirmManagerAction, setConfirmManagerAction] = useState<{ managerId: string; newStatus: string; displayName: string } | null>(null);

  // Analytics
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState('');
  const [analyticsDays, setAnalyticsDays] = useState(30);

  // Categories
  const [maCats, setMaCats] = useState<{ id: string; name: string; icon: string; parentId: string | null; description?: string; sortOrder?: number; status?: string }[]>([]);
  const [maCatLoading, setMaCatLoading] = useState(false);
  const [maCatError, setMaCatError] = useState('');
  const [maCatForm, setMaCatForm] = useState({ name: '', icon: 'fas fa-folder', parentId: '', description: '' });
  const [editingMaCatId, setEditingMaCatId] = useState<string | null>(null);
  const [maCatFormMsg, setMaCatFormMsg] = useState('');
  const [maCatSubmitting, setMaCatSubmitting] = useState(false);
  const [deletingMaCatId, setDeletingMaCatId] = useState<string | null>(null);
  const [seedingProgress, setSeedingProgress] = useState('');

  useEffect(() => {
    setMounted(true);
    const theme = localStorage.getItem('theme');
    if (theme === 'dark') {
      setDarkMode(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    // Validate stored master token expiry on mount — don't wait for first API call
    const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('master_token') : null;
    if (stored) {
      if (parseValidJwt(stored)) {
        setAuthed(true);
      } else {
        sessionStorage.removeItem('master_token');
      }
    }
  }, []);

  // Lockout countdown
  useEffect(() => {
    if (!lockedUntil) return;
    const iv = setInterval(() => {
      const left = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (left <= 0) { setLockedUntil(null); setLockSecs(0); clearInterval(iv); }
      else setLockSecs(left);
    }, 1000);
    return () => clearInterval(iv);
  }, [lockedUntil]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockedUntil && Date.now() < lockedUntil) return;
    if (!API_BASE) { setAuthError('System misconfiguration: API not configured.'); return; }

    try {
      const res = await fetch(`${API_BASE}/auth/masterlogin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput }),
      });
      setPasswordInput('');

      if (res.ok) {
        const data = await res.json();
        // IDX-002: require a structurally valid, unexpired JWT — a forced/tampered
        // 200 with no real token must not unlock the master-admin UI.
        if (!parseValidJwt(data?.token)) {
          setAuthError('Login failed. Please try again.');
          return;
        }
        sessionStorage.setItem('master_token', data.token);
        setAuthed(true);
        setAuthError('');
        setAttempts(0);
      } else {
        const next = attempts + 1;
        setAttempts(next);
        if (next >= MAX_ATTEMPTS) {
          const until = Date.now() + LOCKOUT_SECONDS * 1000;
          setLockedUntil(until);
          setAuthError(`Too many attempts. Locked for ${LOCKOUT_SECONDS}s.`);
        } else {
          setAuthError(`Invalid password. ${MAX_ATTEMPTS - next} attempt(s) remaining.`);
        }
      }
    } catch {
      setPasswordInput('');
      setAuthError('Network error. Please try again.');
    }
  };

  // SSO (Google Workspace) success — only accounts issued a masteradmin-role token
  // may enter the master portal (the backend gates this via the allowlist).
  const handleSsoSuccess = (data: { token: string; role?: string }) => {
    const payload = parseValidJwt(data?.token);
    if (!payload || payload.role !== 'masteradmin') {
      setAuthError('This account is not authorized for Master Admin.');
      return;
    }
    sessionStorage.setItem('master_token', data.token);
    setAuthed(true);
    setAuthError('');
  };

  const handleSessionExpired = useCallback(() => {
    sessionStorage.removeItem('master_token');
    setAuthed(false);
    setAuthError('Your session has expired. Please log in again.');
  }, []);

  const deleteFeedback = async (id: string) => {
    if (!API_BASE) return;
    setFeedbackDeletingId(id);
    try {
      const res = await fetch(masterUrl(`/feedback/${id}`), { method: 'DELETE', headers: getMasterHeaders() });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (!res.ok) throw new Error(`${res.status}`);
      setFeedback((prev) => prev.filter((f) => f.id !== id));
      setFeedbackConfirmId(null);
    } catch {
      alert('Could not delete feedback. Please try again.');
    } finally {
      setFeedbackDeletingId(null);
    }
  };

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

  const fetchManagers = useCallback(async () => {
    if (!API_BASE) return;
    setManagersLoading(true);
    setManagersError('');
    try {
      const res = await fetch(masterUrl('/managers'), { headers: getMasterHeaders() });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (res.ok) setManagers(await res.json());
      else setManagersError(`Failed to load managers (${res.status}). Try refreshing.`);
    } catch { setManagersError('Could not reach the API. Check your connection.'); }
    finally { setManagersLoading(false); }
  }, []);

  const fetchAnalytics = useCallback(async (days: number) => {
    if (!API_BASE) return;
    setAnalyticsLoading(true);
    setAnalyticsError('');
    try {
      const res = await fetch(masterUrl(`/analytics/summary?days=${days}`), { headers: getMasterHeaders() });
      if (res.status === 401) { handleSessionExpired(); return; }
      if (res.ok) setAnalytics(await res.json());
      else setAnalyticsError('Failed to load analytics. Try refreshing.');
    } catch { setAnalyticsError('Could not reach the API. Check your connection.'); }
    finally { setAnalyticsLoading(false); }
  }, [handleSessionExpired]);

  const fetchAll = useCallback(async () => {
    if (!API_BASE) { setLoadError('API not configured.'); return; }
    setLoading(true);
    setLoadError('');
    try {
      const [ticketsRes, faqRes, auditRes, feedbackRes] = await Promise.allSettled([
        fetch(masterUrl('/tickets'), { headers: getMasterHeaders() }),
        // Authenticated: an anonymous GET /faq returns published articles only,
        // so the article list, the Total/Published cards and the CSV export all
        // silently omitted every draft.
        fetch(masterUrl('/faq'), { headers: getMasterHeaders() }),
        fetch(masterUrl('/audit-log'), { headers: getMasterHeaders() }),
        fetch(masterUrl('/feedback'), { headers: getMasterHeaders() }),
      ]);

      // Any 401 on authenticated resources means the master session expired
      if (
        (ticketsRes.status === 'fulfilled' && ticketsRes.value.status === 401) ||
        (auditRes.status === 'fulfilled' && auditRes.value.status === 401)
      ) { handleSessionExpired(); return; }

      if (ticketsRes.status === 'fulfilled' && ticketsRes.value.ok) {
        setTickets(await ticketsRes.value.json());
      }
      if (feedbackRes.status === 'fulfilled' && feedbackRes.value.ok) {
        const fb = await feedbackRes.value.json();
        setFeedback(Array.isArray(fb) ? fb : []);
      }
      if (faqRes.status === 'fulfilled' && faqRes.value.ok) {
        setArticles(await faqRes.value.json());
      }
      if (auditRes.status === 'fulfilled' && auditRes.value.ok) {
        const logs: AuditLog[] = await auditRes.value.json();
        setAuditLogs(logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      }
    } catch {
      setLoadError('Failed to load data from API.');
    } finally {
      setLoading(false);
      setLastRefreshed(new Date());
    }
  }, [handleSessionExpired]);

  useEffect(() => {
    if (authed) {
      fetchAll();
      fetchManagers();
      fetchAnalytics(analyticsDays);
    }
  }, [authed, fetchAll, fetchManagers, fetchAnalytics, analyticsDays]);

  // ── Derived stats ────────────────────────────────────────────────────────
  const stats = {
    totalTickets: tickets.length,
    openTickets: tickets.filter(t => t.status === 'open' || t.status === 'in_progress').length,
    solvedTickets: tickets.filter(t => t.status === 'solved').length,
    totalFaq: articles.length,
    publishedFaq: articles.filter(a => a.status === 'published').length,
    totalAuditLogs: auditLogs.length,
    todayActions: auditLogs.filter(l => {
      const d = new Date(l.timestamp);
      const now = new Date();
      return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length,
  };

  const filteredLogs = auditLogs.filter(l => {
    const matchFilter = auditFilter === 'all' || l.action === auditFilter || l.entity === auditFilter;
    const q = auditSearch.toLowerCase();
    const matchSearch = !q || l.entityTitle?.toLowerCase().includes(q) || l.entityId.toLowerCase().includes(q) || l.performedBy.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  const filteredTickets = tickets.filter(t => {
    // Treat legacy 'resolved' as 'solved' for filter consistency
    const status = t.status === 'resolved' ? 'solved' : t.status;
    const matchFilter = ticketFilter === 'all' || status === ticketFilter;
    const q = ticketSearch.toLowerCase();
    const matchSearch = !q || t.subject?.toLowerCase().includes(q) || t.email?.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || t.name?.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  const filteredArticles = articles.filter(a => {
    const q = faqSearch.toLowerCase();
    return !q || a.title?.toLowerCase().includes(q) || a.category?.toLowerCase().includes(q) || a.id.toLowerCase().includes(q);
  });

  // Accept any object array — TypeScript's generic relaxes the parameter so
  // callers don't need the `as unknown as Record<string, unknown>[]` cast that
  // was previously required by the stricter signature.
  const exportCSV = <T extends object>(data: T[], filename: string) => {
    if (!data.length) return;
    const keys = Object.keys(data[0]);
    // Excel and Sheets evaluate a cell beginning with = + - @ (or a leading tab /
    // CR) as a formula, and these exports carry article titles and content that
    // anyone with admin access can set. JSON.stringify quotes and escapes but does
    // nothing about a leading '='. Prefix an apostrophe to neutralise it.
    const cell = (v: unknown) => {
      const raw = String(v ?? '');
      return JSON.stringify(/^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw);
    };
    const rows = [keys.join(','), ...data.map(row => keys.map(k => cell((row as Record<string, unknown>)[k])).join(','))];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Must be defined before any early return (Rules of Hooks) ─────────────
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'overview',    label: 'Overview',        icon: 'fa-tachometer-alt' },
    { id: 'managers',    label: 'Manager Accounts', icon: 'fa-users-cog' },
    { id: 'audit',       label: 'Audit Log',        icon: 'fa-history' },
    { id: 'analytics',   label: 'Analytics',        icon: 'fa-chart-bar' },
    { id: 'tickets',     label: 'Tickets',          icon: 'fa-ticket-alt' },
    { id: 'feedback',    label: 'Feedback',         icon: 'fa-comment-dots' },
    { id: 'faq',         label: 'FAQ Articles',     icon: 'fa-book' },
    { id: 'categories',  label: 'Categories',       icon: 'fa-folder-tree' },
  ];

  const fetchMaCats = useCallback(async () => {
    if (!API_BASE) return;
    setMaCatLoading(true); setMaCatError('');
    try {
      const res = await fetch(`${API_BASE}/categories`);
      if (res.ok) setMaCats(await res.json());
      else setMaCatError('Failed to load categories.');
    } catch { setMaCatError('Could not reach API.'); }
    finally { setMaCatLoading(false); }
  }, []);

  const maTopLevelCats = maCats.filter(c => !c.parentId);
  const getMaSubcats = (parentId: string) => maCats.filter(c => c.parentId === parentId);

  const managerSummary = useMemo(() => {
    const map: Record<string, { name: string; actions: number; lastSeen: string; faqCreated: number; faqUpdated: number; faqDeleted: number; ticketsUpdated: number }> = {};
    for (const log of auditLogs) {
      const who = log.performedBy || 'admin';
      if (who === 'public') continue;
      if (!map[who]) map[who] = { name: who, actions: 0, lastSeen: log.timestamp, faqCreated: 0, faqUpdated: 0, faqDeleted: 0, ticketsUpdated: 0 };
      map[who].actions++;
      if (new Date(log.timestamp) > new Date(map[who].lastSeen)) map[who].lastSeen = log.timestamp;
      if (log.action === 'CREATE_FAQ') map[who].faqCreated++;
      if (log.action === 'UPDATE_FAQ') map[who].faqUpdated++;
      if (log.action === 'DELETE_FAQ') map[who].faqDeleted++;
      if (log.action === 'UPDATE_TICKET') map[who].ticketsUpdated++;
    }
    return Object.values(map).sort((a, b) => b.actions - a.actions);
  }, [auditLogs]);

  const filteredManagers = useMemo(() => {
    if (!managerSearch) return managers;
    const q = managerSearch.toLowerCase();
    return managers.filter(m => m.username?.toLowerCase().includes(q) || m.displayName?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q));
  }, [managers, managerSearch]);

  if (!mounted) return <div style={{ position: 'fixed', inset: 0, background: '#0F172A', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="fas fa-spinner fa-spin" style={{ color: '#00AB4E', fontSize: '2rem' }}></i></div>;

  // ── Login screen ──────────────────────────────────────────────────────────
  if (!authed) {
    const isLocked = !!lockedUntil && Date.now() < lockedUntil;
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'linear-gradient(135deg, #0F172A 0%, #1A202C 50%, #2D3748 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 9999 }}>
        <div style={{ background: '#FFFFFF', borderRadius: 16, padding: '3rem 2.5rem', width: '100%', maxWidth: 420, boxShadow: '0 25px 50px rgba(0,0,0,0.4)', textAlign: 'center' }}>
          <div style={{ marginBottom: '2rem' }}>
            <Image src="/logo-dark.svg" alt="Indiabulls Securities" width={120} height={43} style={{ width: 120, height: 'auto', margin: '0 auto' }} />
          </div>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 800, color: '#1A202C', marginBottom: '0.375rem' }}>Master Admin</h1>
          <p style={{ fontSize: '0.875rem', color: '#718096', marginBottom: '2rem' }}>Manager of Admins — restricted access only</p>

          <form onSubmit={handleLogin}>
            <div style={{ position: 'relative', marginBottom: '1rem' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={passwordInput}
                onChange={e => setPasswordInput(e.target.value)}
                placeholder="Master password"
                disabled={isLocked}
                autoComplete="current-password"
                style={{ width: '100%', padding: '0.875rem 2.5rem 0.875rem 1rem', border: '2px solid #E2E8F0', borderRadius: 10, fontSize: '0.9375rem', outline: 'none', background: '#fff', color: '#1A202C', boxSizing: 'border-box' }}
              />
              <button type="button" onClick={() => setShowPassword(p => !p)} style={{ position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#A0AEC0', fontSize: '0.875rem' }}>
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>

            {(authError || isLocked) && (
              <div style={{ background: '#FFF5F5', border: '1px solid #FEB2B2', color: '#C53030', padding: '0.75rem 1rem', borderRadius: 8, fontSize: '0.875rem', marginBottom: '0.75rem', textAlign: 'left' }}>
                {isLocked ? `Account locked. Try again in ${lockSecs}s.` : authError}
              </div>
            )}

            <button type="submit" disabled={isLocked || !passwordInput} style={{ width: '100%', padding: '0.875rem', background: '#1A202C', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.9375rem', cursor: isLocked || !passwordInput ? 'not-allowed' : 'pointer', opacity: isLocked || !passwordInput ? 0.5 : 1 }}>
              {isLocked ? `Locked (${lockSecs}s)` : 'Sign In'}
            </button>
          </form>
          <GoogleSSOButton onSuccess={handleSsoSuccess} onError={setAuthError} />
          <p style={{ marginTop: '2rem', fontSize: '0.75rem', color: '#A0AEC0' }}>Authorized Indiabulls Securities Internal System · Restricted Access Only</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-subtle)' }}>
      {/* Top bar */}
      <div style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)', padding: '0 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60, position: 'sticky', top: 0, zIndex: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg,#00AB4E,#007a37)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <i className="fas fa-shield-alt" style={{ color: '#fff', fontSize: '0.875rem' }}></i>
          </div>
          <div>
            <span style={{ fontWeight: 800, color: 'var(--text-dark)', fontSize: '0.9375rem' }}>Master Admin</span>
            <span className="hide-mobile" style={{ marginLeft: '0.5rem', fontSize: '0.7rem', background: '#FEF3C7', color: '#92400E', padding: '0.1rem 0.5rem', borderRadius: 20, fontWeight: 600 }}>MANAGER OF ADMINS</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button onClick={fetchAll} disabled={loading} aria-label="Refresh data" title={lastRefreshed ? `Refreshed ${lastRefreshed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '0.4rem 0.625rem', cursor: loading ? 'not-allowed' : 'pointer', color: 'var(--text-muted)', fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '0.375rem', opacity: loading ? 0.6 : 1 }}>
            <i className={`fas fa-sync-alt ${loading ? 'fa-spin' : ''}`}></i>
            <span className="hide-mobile">{lastRefreshed ? `Refreshed ${lastRefreshed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'}</span>
          </button>
          <button onClick={toggleDarkMode} aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '0.4rem 0.625rem', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.875rem', display: 'flex', alignItems: 'center' }}>
            <i className={`fas ${darkMode ? 'fa-sun' : 'fa-moon'}`}></i>
          </button>
          <button onClick={() => { sessionStorage.removeItem('master_token'); setAuthed(false); }} aria-label="Sign out" title="Sign out" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#EF4444', fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <i className="fas fa-sign-out-alt"></i>
            <span className="hide-mobile">Sign out</span>
          </button>
        </div>
      </div>

      {/* Tab nav */}
      <div style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)', padding: '0 1rem', display: 'flex', gap: '0.125rem', overflowX: 'auto', WebkitOverflowScrolling: 'touch' as const, scrollbarWidth: 'none' as const }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); if (tab.id === 'categories') fetchMaCats(); }}
            style={{ padding: '0.875rem 0.875rem', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: activeTab === tab.id ? 700 : 500, color: activeTab === tab.id ? '#00AB4E' : 'var(--text-muted)', borderBottom: `2px solid ${activeTab === tab.id ? '#00AB4E' : 'transparent'}`, display: 'flex', alignItems: 'center', gap: '0.375rem', transition: 'color 0.15s', whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            <i className={`fas ${tab.icon}`}></i> {tab.label}
            {tab.id === 'tickets' && stats.openTickets > 0 && (
              <span style={{ background: '#F59E0B', color: '#fff', borderRadius: 20, fontSize: '0.65rem', padding: '0.1rem 0.45rem', fontWeight: 700 }}>{stats.openTickets} open</span>
            )}
            {tab.id === 'audit' && auditLogs.length > 0 && (
              <span style={{ background: '#6B7280', color: '#fff', borderRadius: 20, fontSize: '0.65rem', padding: '0.1rem 0.45rem', fontWeight: 700 }}>{auditLogs.length}</span>
            )}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '2rem 1.5rem' }}>
        {loadError && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '0.875rem 1.25rem', marginBottom: '1.5rem', color: '#B91C1C', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <i className="fas fa-exclamation-circle"></i> {loadError}
          </div>
        )}

        {/* ── OVERVIEW TAB ── */}
        {activeTab === 'overview' && (
          <>
            <h2 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-dark)', marginBottom: '1.5rem' }}>System Overview</h2>

            {/* KPI grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
              {[
                { label: 'Active Managers', value: managers.filter(m => m.status === 'active').length, icon: 'fa-users-cog', color: '#00AB4E', bg: '#D1FAE5' },
                { label: 'Total Tickets',   value: stats.totalTickets,      icon: 'fa-ticket-alt',    color: '#5B21B6', bg: '#EDE9FE' },
                { label: 'Open / In-Progress', value: stats.openTickets,   icon: 'fa-hourglass-half', color: '#92400E', bg: '#FEF3C7' },
                { label: 'Solved',          value: stats.solvedTickets,     icon: 'fa-check-circle',  color: '#065F46', bg: '#D1FAE5' },
                { label: 'FAQ Articles',    value: stats.totalFaq,          icon: 'fa-book',          color: '#1E40AF', bg: '#DBEAFE' },
                { label: "Today's Actions", value: stats.todayActions,      icon: 'fa-bolt',          color: '#92400E', bg: '#FEF3C7' },
                { label: 'Total Audit Logs',value: stats.totalAuditLogs,    icon: 'fa-history',       color: '#374151', bg: '#F3F4F6' },
              ].map(kpi => (
                <div key={kpi.label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1.25rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div style={{ width: 42, height: 42, borderRadius: 10, background: kpi.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <i className={`fas ${kpi.icon}`} style={{ color: kpi.color, fontSize: '1.125rem' }}></i>
                  </div>
                  <div>
                    <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{kpi.label}</p>
                    <p style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-dark)', lineHeight: 1 }}>{loading ? '—' : kpi.value}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Manager quick view */}
            {managerSummary.length > 0 && (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: '1.5rem' }}>
                <div style={{ padding: '1.125rem 1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem' }}>Manager Activity</h3>
                  <button onClick={() => setActiveTab('managers')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#00AB4E', fontSize: '0.8125rem', fontWeight: 600 }}>View all <i className="fas fa-arrow-right"></i></button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1px', background: 'var(--border)' }}>
                  {managerSummary.slice(0, 4).map(mgr => (
                    <div key={mgr.name} style={{ background: 'var(--bg)', padding: '1rem 1.25rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.5rem' }}>
                        <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,#00AB4E,#007a37)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <i className="fas fa-user-tie" style={{ color: '#fff', fontSize: '0.75rem' }}></i>
                        </div>
                        <p style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.875rem' }}>{mgr.name}</p>
                      </div>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{mgr.actions} total actions</p>
                      <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.125rem' }}>Last: {new Date(mgr.lastSeen).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent activity */}
            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '1.125rem 1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem' }}>Recent Activity</h3>
                <button onClick={() => setActiveTab('audit')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#00AB4E', fontSize: '0.8125rem', fontWeight: 600 }}>View all <i className="fas fa-arrow-right"></i></button>
              </div>
              {auditLogs.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                  {loading ? <><i className="fas fa-spinner fa-spin"></i> Loading…</> : 'No audit logs yet. Actions from the Admin panel will appear here once the audit-log Lambda is deployed.'}
                </div>
              ) : (
                <div>
                  {auditLogs.slice(0, 10).map((log, i) => {
                    const conf = ACTION_CONFIG[log.action] || { label: log.action, icon: 'fa-circle', color: '#374151', bg: '#F3F4F6' };
                    return (
                      <div key={log.id} onClick={() => setSelectedLog(log)} style={{ padding: '0.875rem 1.5rem', borderBottom: i < 9 ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: '0.875rem', cursor: 'pointer', transition: 'background 0.1s' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
                        <div style={{ width: 34, height: 34, borderRadius: 8, background: conf.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <i className={`fas ${conf.icon}`} style={{ color: conf.color, fontSize: '0.875rem' }}></i>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontWeight: 600, color: 'var(--text-dark)', fontSize: '0.875rem', marginBottom: '0.125rem' }}>{conf.label} — <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{log.entityTitle || log.entityId}</span></p>
                          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{log.performedBy} · {new Date(log.timestamp).toLocaleString('en-IN')}</p>
                        </div>
                        <i className="fas fa-chevron-right" style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}></i>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── MANAGERS TAB ── */}
        {activeTab === 'managers' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <div>
                <h2 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-dark)', marginBottom: '0.25rem' }}>Manager Accounts</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Create, deactivate and manage admin manager accounts.</p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input value={managerSearch} onChange={e => setManagerSearch(e.target.value)} placeholder="Search managers…" style={{ padding: '0.5rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)', width: '100%', maxWidth: 260 }} />
                <button onClick={() => { setShowCreateManager(true); setManagerFormMsg(''); setShowManagerPassword(false); setManagerForm({ username: '', displayName: '', email: '', role: 'manager', password: '' }); }} style={{ padding: '0.5rem 1rem', background: '#00AB4E', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}>
                  <i className="fas fa-plus"></i> Create Manager
                </button>
              </div>
            </div>

            {/* Create Manager Modal */}
            {showCreateManager && (
              <div onClick={() => setShowCreateManager(false)} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)' }}>
                <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', borderRadius: 14, padding: '2rem', maxWidth: 440, width: '100%', boxShadow: '0 25px 50px rgba(0,0,0,0.15)' }}>
                  <h3 style={{ fontWeight: 800, color: 'var(--text-dark)', marginBottom: '1.25rem' }}>Create New Manager</h3>
                  {(['username', 'displayName', 'email'] as const).map(field => (
                    <div key={field} style={{ marginBottom: '0.875rem' }}>
                      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.3rem', textTransform: 'capitalize' }}>{field === 'displayName' ? 'Display Name' : field}</label>
                      <input
                        type={field === 'email' ? 'email' : 'text'}
                        value={managerForm[field]}
                        onChange={e => setManagerForm(f => ({ ...f, [field]: e.target.value }))}
                        style={{ width: '100%', padding: '0.625rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)', boxSizing: 'border-box' }}
                      />
                    </div>
                  ))}
                  <div style={{ marginBottom: '0.875rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.3rem' }}>Password</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type={showManagerPassword ? 'text' : 'password'}
                        value={managerForm.password}
                        onChange={e => setManagerForm(f => ({ ...f, password: e.target.value }))}
                        style={{ width: '100%', padding: '0.625rem 2.5rem 0.625rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)', boxSizing: 'border-box' }}
                      />
                      <button type="button" onClick={() => setShowManagerPassword(p => !p)} style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }}>
                        <i className={`fas ${showManagerPassword ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                      </button>
                    </div>
                    {managerForm.password && (() => {
                      const p = managerForm.password;
                      let score = 0;
                      if (p.length >= 8) score++;
                      if (/[A-Z]/.test(p)) score++;
                      if (/[0-9]/.test(p)) score++;
                      if (/[^A-Za-z0-9]/.test(p)) score++;
                      const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
                      const colors = ['', '#E53E3E', '#DD6B20', '#D97706', '#38A169'];
                      return (
                        <div style={{ marginTop: '0.375rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2 }}>
                            <div style={{ height: 4, background: colors[score], borderRadius: 2, width: `${score * 25}%`, transition: 'width 0.2s, background 0.2s' }} />
                          </div>
                          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: colors[score], minWidth: 40 }}>{labels[score]}</span>
                        </div>
                      );
                    })()}
                  </div>
                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.3rem' }}>Role</label>
                    <select value={managerForm.role} onChange={e => setManagerForm(f => ({ ...f, role: e.target.value }))} style={{ width: '100%', padding: '0.625rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)', boxSizing: 'border-box' }}>
                      <option value="manager">Manager</option>
                      <option value="senior_manager">Senior Manager</option>
                    </select>
                  </div>
                  {managerFormMsg && <p style={{ fontSize: '0.8125rem', color: managerFormMsg.startsWith('✓') ? '#065F46' : '#B91C1C', marginBottom: '0.75rem' }}>{managerFormMsg}</p>}
                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    <button onClick={() => setShowCreateManager(false)} style={{ flex: 1, padding: '0.75rem', background: 'none', border: '1.5px solid var(--border)', borderRadius: 8, fontWeight: 600, cursor: 'pointer', color: 'var(--text-dark)' }}>Cancel</button>
                    <button disabled={managerFormSaving} onClick={async () => {
                      const { username, displayName, email, role, password } = managerForm;
                      if (!username || !displayName || !email || !password) { setManagerFormMsg('All fields required.'); return; }
                      setManagerFormSaving(true); setManagerFormMsg('');
                      try {
                        const res = await fetch(masterUrl('/managers'), { method: 'POST', headers: getMasterHeaders(), body: JSON.stringify({ username, displayName, email, role, password }) });
                        if (res.status === 401) { handleSessionExpired(); return; }
                        const data = await res.json();
                        if (res.ok) { setManagerFormMsg('✓ Manager created!'); fetchManagers(); setTimeout(() => setShowCreateManager(false), 1200); }
                        else setManagerFormMsg(data.error || 'Failed to create manager.');
                      } catch { setManagerFormMsg('Network error.'); }
                      finally { setManagerFormSaving(false); }
                    }} style={{ flex: 1, padding: '0.75rem', background: '#00AB4E', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: managerFormSaving ? 'not-allowed' : 'pointer', opacity: managerFormSaving ? 0.6 : 1 }}>
                      {managerFormSaving ? 'Creating…' : 'Create Manager'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {managersError && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '0.875rem 1.25rem', marginBottom: '1rem', color: '#B91C1C', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <i className="fas fa-exclamation-circle"></i> {managersError}
              </div>
            )}

            {managersLoading ? (
              <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}><i className="fas fa-spinner fa-spin"></i> Loading…</div>
            ) : filteredManagers.length === 0 ? (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '4rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                {managerSearch ? `No managers match "${managerSearch}".` : 'No manager accounts yet. Click "Create Manager" to add the first one.'}
              </div>
            ) : (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                        {['Username', 'Display Name', 'Email', 'Role', 'Status', 'Last Login', 'Actions'].map(h => (
                          <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredManagers.map((mgr, i) => (
                        <tr key={mgr.managerId} style={{ borderBottom: i < filteredManagers.length - 1 ? '1px solid var(--border)' : 'none' }}>
                          <td style={{ padding: '0.875rem 1rem', fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{mgr.username}</td>
                          <td style={{ padding: '0.875rem 1rem', fontWeight: 600, color: 'var(--text-dark)' }}>{mgr.displayName}</td>
                          <td style={{ padding: '0.875rem 1rem', color: 'var(--text-muted)' }}>{mgr.email}</td>
                          <td style={{ padding: '0.875rem 1rem' }}><span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: 20, fontWeight: 600, background: mgr.role === 'senior_manager' ? '#DBEAFE' : '#F3F4F6', color: mgr.role === 'senior_manager' ? '#1E40AF' : '#374151' }}>{mgr.role === 'senior_manager' ? 'Senior Manager' : 'Manager'}</span></td>
                          <td style={{ padding: '0.875rem 1rem' }}><span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: 20, fontWeight: 600, background: mgr.status === 'active' ? '#D1FAE5' : '#FEE2E2', color: mgr.status === 'active' ? '#065F46' : '#991B1B' }}>{mgr.status}</span></td>
                          <td style={{ padding: '0.875rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{mgr.lastLoginAt ? new Date(mgr.lastLoginAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : 'Never'}</td>
                          <td style={{ padding: '0.875rem 1rem' }}>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              {mgr.status === 'active' ? (
                                <button onClick={() => setConfirmManagerAction({ managerId: mgr.managerId, newStatus: 'deactivated', displayName: mgr.displayName })} style={{ padding: '0.3rem 0.625rem', fontSize: '0.75rem', fontWeight: 600, background: '#FEE2E2', color: '#991B1B', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Deactivate</button>
                              ) : (
                                <button onClick={() => setConfirmManagerAction({ managerId: mgr.managerId, newStatus: 'active', displayName: mgr.displayName })} style={{ padding: '0.3rem 0.625rem', fontSize: '0.75rem', fontWeight: 600, background: '#D1FAE5', color: '#065F46', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Reactivate</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── AUDIT LOG TAB ── */}
        {activeTab === 'audit' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-dark)' }}>Audit Log</h2>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <input value={auditSearch} onChange={e => setAuditSearch(e.target.value)} placeholder="Search…" style={{ padding: '0.5rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)', width: '100%', maxWidth: 220 }} />
                <select value={auditFilter} onChange={e => setAuditFilter(e.target.value)} style={{ padding: '0.5rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)' }}>
                  <option value="all">All Actions</option>
                  <option value="faq">FAQ</option>
                  <option value="ticket">Tickets</option>
                  <option value="CREATE_FAQ">Created FAQ</option>
                  <option value="UPDATE_FAQ">Updated FAQ</option>
                  <option value="DELETE_FAQ">Deleted FAQ</option>
                  <option value="UPDATE_TICKET">Updated Ticket</option>
                  <option value="CREATE_TICKET">Created Ticket</option>
                  <option value="LOGIN">Admin Login</option>
                </select>
                <button onClick={() => exportCSV(auditLogs, 'audit-log.csv')} style={{ padding: '0.5rem 0.875rem', background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <i className="fas fa-download"></i> Export CSV
                </button>
              </div>
            </div>

            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              {filteredLogs.length === 0 ? (
                <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                  {loading
                    ? <><i className="fas fa-spinner fa-spin"></i> Loading…</>
                    : auditSearch || auditFilter !== 'all'
                      ? `No logs match your filter. Try clearing the search or selecting "All Actions".`
                      : <><p style={{ marginBottom: '0.5rem', fontWeight: 600, color: 'var(--text-dark)' }}>No audit logs yet.</p><p>Once the <code>ib-audit-log</code> DynamoDB table is created and the updated Lambda is deployed, every manager action will appear here automatically.</p></>
                  }
                </div>
              ) : (
                filteredLogs.map((log, i) => {
                  const conf = ACTION_CONFIG[log.action] || { label: log.action, icon: 'fa-circle', color: '#374151', bg: '#F3F4F6' };
                  return (
                    <div key={log.id} onClick={() => setSelectedLog(log)} style={{ padding: '0.875rem 1.5rem', borderBottom: i < filteredLogs.length - 1 ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: '0.875rem', cursor: 'pointer', transition: 'background 0.1s' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      <div style={{ width: 34, height: 34, borderRadius: 8, background: conf.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <i className={`fas ${conf.icon}`} style={{ color: conf.color, fontSize: '0.875rem' }}></i>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.125rem', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.5rem', borderRadius: 20, fontWeight: 600, background: conf.bg, color: conf.color }}>{conf.label}</span>
                          <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{log.entityId}</span>
                        </div>
                        <p style={{ fontWeight: 500, color: 'var(--text-dark)', fontSize: '0.875rem', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{log.entityTitle || '—'}</p>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{new Date(log.timestamp).toLocaleString('en-IN')}</p>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{log.performedBy}</p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* ── ANALYTICS TAB ── */}
        {activeTab === 'analytics' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-dark)' }}>Public Portal Analytics</h2>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <select value={analyticsDays} onChange={e => { const d = Number(e.target.value); setAnalyticsDays(d); fetchAnalytics(d); }} style={{ padding: '0.5rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)' }}>
                  <option value={7}>Last 7 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
                <button onClick={() => fetchAnalytics(analyticsDays)} disabled={analyticsLoading} style={{ padding: '0.5rem 0.875rem', background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <i className={`fas fa-sync-alt ${analyticsLoading ? 'fa-spin' : ''}`}></i> Refresh
                </button>
                {analytics && (
                  <button onClick={() => {
                    const totalFb = analytics.faq_feedback_helpful + analytics.faq_feedback_not_helpful;
                    const rows = [
                      { metric: 'Article Views', value: analytics.article_views },
                      { metric: 'Searches', value: analytics.searches },
                      { metric: 'Zero-Result Searches', value: analytics.zero_result_searches ?? 0 },
                      { metric: 'Chatbot Opens', value: analytics.chatbot_opens },
                      { metric: 'Chatbot Messages', value: analytics.chatbot_messages },
                      { metric: 'Avg Messages/Session', value: analytics.chatbot_opens > 0 ? (analytics.chatbot_messages / analytics.chatbot_opens).toFixed(1) : 0 },
                      { metric: 'Tickets Submitted', value: analytics.ticket_submits },
                      { metric: 'Helpful Feedback', value: analytics.faq_feedback_helpful },
                      { metric: 'Not Helpful Feedback', value: analytics.faq_feedback_not_helpful },
                      { metric: 'Overall Satisfaction %', value: totalFb > 0 ? `${Math.round((analytics.faq_feedback_helpful / totalFb) * 100)}%` : '—' },
                    ];
                    exportCSV(rows, `analytics-${analyticsDays}d.csv`);
                  }} style={{ padding: '0.5rem 0.875rem', background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    <i className="fas fa-download"></i> Export CSV
                  </button>
                )}
              </div>
            </div>
            {analyticsLoading ? (
              <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}><i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem' }}></i></div>
            ) : analyticsError ? (
              <div style={{ textAlign: 'center', padding: '4rem' }}>
                <i className="fas fa-exclamation-triangle" style={{ fontSize: '1.5rem', color: '#D97706', marginBottom: '0.75rem', display: 'block' }}></i>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>{analyticsError}</p>
                <button onClick={() => fetchAnalytics(analyticsDays)} style={{ padding: '0.5rem 1.25rem', background: '#00AB4E', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}>Retry</button>
              </div>
            ) : !analytics ? (
              <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>No analytics data yet. Events are tracked as users visit the portal.</div>
            ) : (
              <>
                {/* KPI row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                  {(() => {
                    const totalFeedback = analytics.faq_feedback_helpful + analytics.faq_feedback_not_helpful;
                    const satisfactionPct = totalFeedback > 0 ? Math.round((analytics.faq_feedback_helpful / totalFeedback) * 100) : null;
                    return [
                      { label: 'Article Views',    value: analytics.article_views,    icon: 'fa-eye',            color: '#00AB4E', bg: '#D1FAE5' },
                      { label: 'Searches',          value: analytics.searches,          icon: 'fa-search',         color: '#1E40AF', bg: '#DBEAFE' },
                      { label: 'Zero-Result Searches', value: analytics.zero_result_searches ?? 0, icon: 'fa-exclamation-circle', color: '#B45309', bg: '#FEF3C7' },
                      { label: 'Chatbot Opens',     value: analytics.chatbot_opens,     icon: 'fa-comment-dots',   color: '#5B21B6', bg: '#EDE9FE' },
                      { label: 'Chatbot Messages',  value: analytics.chatbot_messages,  icon: 'fa-paper-plane',    color: '#92400E', bg: '#FEF3C7' },
                      { label: 'Tickets Submitted', value: analytics.ticket_submits,    icon: 'fa-ticket-alt',     color: '#991B1B', bg: '#FEE2E2' },
                      { label: 'Helpful Feedback',  value: analytics.faq_feedback_helpful, icon: 'fa-thumbs-up',  color: '#065F46', bg: '#D1FAE5' },
                      { label: 'Not Helpful',       value: analytics.faq_feedback_not_helpful, icon: 'fa-thumbs-down', color: '#991B1B', bg: '#FEE2E2' },
                      { label: 'Satisfaction',      value: satisfactionPct !== null ? `${satisfactionPct}%` : '—', icon: 'fa-star', color: '#D97706', bg: '#FEF3C7' },
                    ];
                  })().map(kpi => (
                    <div key={kpi.label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem 1.125rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ width: 36, height: 36, borderRadius: 9, background: kpi.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <i className={`fas ${kpi.icon}`} style={{ color: kpi.color, fontSize: '0.9rem' }}></i>
                      </div>
                      <div>
                        <p style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.15rem' }}>{kpi.label}</p>
                        <p style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-dark)', lineHeight: 1 }}>{kpi.value}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Row 1: Top Articles + Top Searches */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.25rem', marginBottom: '1.25rem' }}>
                  {/* Top Articles by Views */}
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1.25rem' }}>
                    <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem', marginBottom: '1rem' }}>
                      <i className="fas fa-eye" style={{ color: '#00AB4E', marginRight: '0.5rem' }}></i>Top Articles by Views
                    </h3>
                    {analytics.top_articles.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No data yet.</p> : analytics.top_articles.map(([title, count]) => (
                      <div key={title} style={{ marginBottom: '0.625rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '0.2rem' }}>
                          <span style={{ color: 'var(--text-dark)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80%' }} title={title}>{title}</span>
                          <span style={{ color: 'var(--text-muted)', flexShrink: 0, marginLeft: '0.5rem', fontWeight: 600 }}>{count}</span>
                        </div>
                        <div style={{ height: 4, background: 'var(--bg-subtle)', borderRadius: 2 }}>
                          <div style={{ height: 4, background: '#00AB4E', borderRadius: 2, width: `${Math.round((count / (analytics.top_articles[0]?.[1] || 1)) * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Top Search Terms */}
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1.25rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                      <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem' }}>
                        <i className="fas fa-search" style={{ color: '#1E40AF', marginRight: '0.5rem' }}></i>Top Search Terms
                      </h3>
                      {(analytics.zero_result_searches ?? 0) > 0 && (
                        <span style={{ fontSize: '0.7rem', background: '#FEF3C7', color: '#B45309', padding: '0.2rem 0.5rem', borderRadius: 6, fontWeight: 600 }}>
                          {analytics.zero_result_searches} zero-result
                        </span>
                      )}
                    </div>
                    {analytics.top_searches.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No data yet.</p> : analytics.top_searches.slice(0, 10).map(([term, count]) => (
                      <div key={term} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.375rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.8125rem' }}>
                        <span style={{ color: 'var(--text-dark)' }}>{term}</span>
                        <span style={{ color: 'var(--text-muted)', fontWeight: 600, background: 'var(--bg-subtle)', padding: '0.1rem 0.4rem', borderRadius: 4 }}>{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Row 2: Tickets by Category + Chatbot Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.25rem', marginBottom: '1.25rem' }}>
                  {/* Tickets by Category */}
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1.25rem' }}>
                    <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem', marginBottom: '1rem' }}>
                      <i className="fas fa-ticket-alt" style={{ color: '#991B1B', marginRight: '0.5rem' }}></i>Tickets by Category
                    </h3>
                    {Object.keys(analytics.tickets_by_category).length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No data yet.</p> : (() => {
                      const entries = Object.entries(analytics.tickets_by_category).sort((a, b) => b[1] - a[1]);
                      const max = entries[0]?.[1] || 1;
                      return entries.map(([cat, count]) => (
                        <div key={cat} style={{ marginBottom: '0.5rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '0.2rem' }}>
                            <span style={{ color: 'var(--text-dark)' }}>{cat}</span>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{count} <span style={{ fontSize: '0.7rem' }}>({Math.round((count / analytics.ticket_submits) * 100)}%)</span></span>
                          </div>
                          <div style={{ height: 4, background: 'var(--bg-subtle)', borderRadius: 2 }}>
                            <div style={{ height: 4, background: '#5B21B6', borderRadius: 2, width: `${Math.round((count / max) * 100)}%` }} />
                          </div>
                        </div>
                      ));
                    })()}
                  </div>

                  {/* Chatbot Stats */}
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1.25rem' }}>
                    <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem', marginBottom: '1rem' }}>
                      <i className="fas fa-comment-dots" style={{ color: '#5B21B6', marginRight: '0.5rem' }}></i>Chatbot Usage
                    </h3>
                    <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.25rem' }}>
                      {[
                        { label: 'Sessions Opened', value: analytics.chatbot_opens, color: '#5B21B6', bg: '#EDE9FE' },
                        { label: 'Messages Sent', value: analytics.chatbot_messages, color: '#92400E', bg: '#FEF3C7' },
                        { label: 'Msgs / Session', value: analytics.chatbot_opens > 0 ? (analytics.chatbot_messages / analytics.chatbot_opens).toFixed(1) : '—', color: '#065F46', bg: '#D1FAE5' },
                      ].map(s => (
                        <div key={s.label} style={{ flex: 1, background: s.bg, borderRadius: 10, padding: '0.75rem', textAlign: 'center' }}>
                          <p style={{ fontSize: '1.375rem', fontWeight: 800, color: s.color, lineHeight: 1, marginBottom: '0.25rem' }}>{s.value}</p>
                          <p style={{ fontSize: '0.65rem', color: s.color, fontWeight: 600, textTransform: 'uppercase', opacity: 0.8 }}>{s.label}</p>
                        </div>
                      ))}
                    </div>
                    <h4 style={{ fontWeight: 600, color: 'var(--text-dark)', fontSize: '0.8125rem', marginBottom: '0.625rem' }}>Persona Breakdown</h4>
                    {Object.keys(analytics.persona_counts).length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>No persona data yet.</p> : (() => {
                      const total = Object.values(analytics.persona_counts).reduce((a, b) => a + b, 0);
                      return Object.entries(analytics.persona_counts).sort((a, b) => b[1] - a[1]).map(([persona, count]) => (
                        <div key={persona} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.375rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.8125rem' }}>
                          <span style={{ color: 'var(--text-dark)', textTransform: 'capitalize' }}>{persona}</span>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{count} <span style={{ fontSize: '0.7rem' }}>({Math.round((count / total) * 100)}%)</span></span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>

                {/* Row 3: Per-Article Feedback Breakdown */}
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1.25rem' }}>
                  <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem', marginBottom: '1rem' }}>
                    <i className="fas fa-thumbs-up" style={{ color: '#065F46', marginRight: '0.5rem' }}></i>Per-Article Feedback
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400, marginLeft: '0.5rem' }}>sorted by most feedback received</span>
                  </h3>
                  {!analytics.article_feedback || analytics.article_feedback.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No article feedback yet. Users rate articles on the FAQ page.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                        <thead>
                          <tr style={{ borderBottom: '2px solid var(--border)' }}>
                            {['Article', 'Category', '👍 Helpful', '👎 Not Helpful', 'Total', 'Satisfaction'].map(h => (
                              <th key={h} style={{ padding: '0.5rem 0.75rem', textAlign: h === 'Article' || h === 'Category' ? 'left' : 'center', color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.article_feedback.map((row) => (
                            <tr key={row.title} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ padding: '0.625rem 0.75rem', color: 'var(--text-dark)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.title}>{row.title}</td>
                              <td style={{ padding: '0.625rem 0.75rem', color: 'var(--text-muted)' }}>{row.category || '—'}</td>
                              <td style={{ padding: '0.625rem 0.75rem', textAlign: 'center', color: '#065F46', fontWeight: 600 }}>{row.helpful}</td>
                              <td style={{ padding: '0.625rem 0.75rem', textAlign: 'center', color: '#991B1B', fontWeight: 600 }}>{row.not_helpful}</td>
                              <td style={{ padding: '0.625rem 0.75rem', textAlign: 'center', color: 'var(--text-muted)' }}>{row.total}</td>
                              <td style={{ padding: '0.625rem 0.75rem', textAlign: 'center' }}>
                                <span style={{ display: 'inline-block', padding: '0.2rem 0.6rem', borderRadius: 6, fontWeight: 700, fontSize: '0.8125rem', background: row.pct >= 70 ? '#D1FAE5' : row.pct >= 40 ? '#FEF3C7' : '#FEE2E2', color: row.pct >= 70 ? '#065F46' : row.pct >= 40 ? '#92400E' : '#991B1B' }}>
                                  {row.pct}%
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* CTA Performance */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginTop: '1.25rem', marginBottom: '1.25rem' }}>
                  {[
                    { label: 'Open Account Clicks', value: analytics.cta_open_account ?? 0, icon: 'fa-rocket', color: '#065F46', bg: '#D1FAE5' },
                    { label: 'Login Clicks', value: analytics.cta_login ?? 0, icon: 'fa-sign-in-alt', color: '#1E40AF', bg: '#DBEAFE' },
                  ].map(kpi => (
                    <div key={kpi.label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: kpi.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <i className={`fas ${kpi.icon}`} style={{ color: kpi.color, fontSize: '1rem' }}></i>
                      </div>
                      <div>
                        <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>{kpi.label}</p>
                        <p style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-dark)', lineHeight: 1 }}>{kpi.value}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Device / Browser / OS Breakdown */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem', marginBottom: '1.25rem' }}>
                  {[
                    { title: 'Browser', icon: 'fa-globe', color: '#1E40AF', data: analytics.browser_counts ?? {} },
                    { title: 'Operating System', icon: 'fa-laptop', color: '#065F46', data: analytics.os_counts ?? {} },
                    { title: 'Device Type', icon: 'fa-mobile-alt', color: '#5B21B6', data: analytics.device_counts ?? {} },
                  ].map(({ title, icon, color, data }) => {
                    const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
                    const max = entries[0]?.[1] || 1;
                    return (
                      <div key={title} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1.25rem' }}>
                        <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem', marginBottom: '0.875rem' }}>
                          <i className={`fas ${icon}`} style={{ color, marginRight: '0.5rem' }}></i>{title}
                        </h3>
                        {entries.length === 0 ? (
                          <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>No data yet.</p>
                        ) : entries.map(([name, count]) => (
                          <div key={name} style={{ marginBottom: '0.5rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '0.2rem' }}>
                              <span style={{ color: 'var(--text-dark)' }}>{name}</span>
                              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{count}</span>
                            </div>
                            <div style={{ height: 4, background: 'var(--bg-subtle)', borderRadius: 2 }}>
                              <div style={{ height: 4, background: color, borderRadius: 2, width: `${Math.round((count / max) * 100)}%`, opacity: 0.75 }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>

                {/* By Category breakdown — articles + feedback + tickets per category */}
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
                  <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '0.9375rem', marginBottom: '0.875rem' }}>
                    <i className="fas fa-folder-tree" style={{ color: '#00AB4E', marginRight: '0.5rem' }}></i>By Category
                  </h3>
                  {(() => {
                    type Row = { name: string; articles: number; helpful: number; notHelpful: number; tickets: number };
                    const map: Record<string, Row> = {};
                    const ensure = (k: string): Row => (map[k] = map[k] || { name: k, articles: 0, helpful: 0, notHelpful: 0, tickets: 0 });
                    articles.forEach(a => { if (a.category) ensure(a.category).articles++; });
                    (analytics.article_feedback || []).forEach(f => { if (f.category) { const m = ensure(f.category); m.helpful += f.helpful; m.notHelpful += f.not_helpful; } });
                    Object.entries(analytics.tickets_by_category || {}).forEach(([k, v]) => { ensure(k).tickets += Number(v) || 0; });
                    const rows = Object.values(map).sort((a, b) => b.articles - a.articles || (b.helpful + b.notHelpful) - (a.helpful + a.notHelpful));
                    if (rows.length === 0) return <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>No category data yet.</p>;
                    const headers: { label: string; align: 'left' | 'right' }[] = [
                      { label: 'Category', align: 'left' }, { label: 'Articles', align: 'right' },
                      { label: 'Helpful', align: 'right' }, { label: 'Not helpful', align: 'right' },
                      { label: 'Helpful %', align: 'right' }, { label: 'Tickets', align: 'right' },
                    ];
                    return (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                          <thead>
                            <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                              {headers.map(h => (
                                <th key={h.label} style={{ padding: '0.6rem 0.75rem', textAlign: h.align, fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r, i) => {
                              const fb = r.helpful + r.notHelpful;
                              const pct = fb > 0 ? Math.round((r.helpful / fb) * 100) : null;
                              return (
                                <tr key={r.name} style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                  <td style={{ padding: '0.6rem 0.75rem', fontWeight: 600, color: 'var(--text-dark)' }}>{r.name}</td>
                                  <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right', color: 'var(--text-dark)' }}>{r.articles}</td>
                                  <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right', color: '#065F46' }}>{r.helpful}</td>
                                  <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right', color: '#B91C1C' }}>{r.notHelpful}</td>
                                  <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 600 }}>{pct === null ? '—' : `${pct}%`}</td>
                                  <td style={{ padding: '0.6rem 0.75rem', textAlign: 'right', color: 'var(--text-muted)' }}>{r.tickets}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              </>
            )}
          </>
        )}

        {/* ── TICKETS TAB ── */}
        {activeTab === 'tickets' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-dark)' }}>All Tickets <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '1rem' }}>({filteredTickets.length})</span></h2>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <input value={ticketSearch} onChange={e => setTicketSearch(e.target.value)} placeholder="Search tickets…" style={{ padding: '0.5rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)', width: '100%', maxWidth: 220 }} />
                <select value={ticketFilter} onChange={e => setTicketFilter(e.target.value)} style={{ padding: '0.5rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)' }}>
                  <option value="all">All Statuses</option>
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="solved">Solved / Resolved</option>
                </select>
                <button onClick={() => exportCSV(tickets, 'tickets.csv')} style={{ padding: '0.5rem 0.875rem', background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <i className="fas fa-download"></i> Export CSV
                </button>
              </div>
            </div>

            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              {loading ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}><i className="fas fa-spinner fa-spin"></i> Loading tickets…</div>
              ) : filteredTickets.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>No tickets found.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                        {['Ticket ID', 'Subject', 'Customer', 'Category', 'Status', 'Date'].map(h => (
                          <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTickets.map((t, i) => {
                        // Normalise legacy 'resolved' to 'solved' for display
                        const normStatus = (t.status === 'resolved' ? 'solved' : t.status) as keyof typeof STATUS_CONFIG;
                        const sc = STATUS_CONFIG[normStatus] || STATUS_CONFIG.open;
                        // Guard against invalid dates
                        const dateStr = t.createdAt && !isNaN(new Date(t.createdAt).getTime())
                          ? new Date(t.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                          : '—';
                        return (
                          <tr key={t.id} style={{ borderBottom: i < filteredTickets.length - 1 ? '1px solid var(--border)' : 'none' }}>
                            <td style={{ padding: '0.875rem 1rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{t.id}</td>
                            <td style={{ padding: '0.875rem 1rem', fontWeight: 500, color: 'var(--text-dark)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject || '—'}</td>
                            <td style={{ padding: '0.875rem 1rem', whiteSpace: 'nowrap' }}>
                              <p style={{ fontWeight: 500, color: 'var(--text-dark)' }}>{t.name || '—'}</p>
                              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.email || '—'}</p>
                            </td>
                            <td style={{ padding: '0.875rem 1rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{t.category || '—'}</td>
                            <td style={{ padding: '0.875rem 1rem' }}>
                              <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.6rem', borderRadius: 20, fontWeight: 600, background: sc.bg, color: sc.color, whiteSpace: 'nowrap' }}>{sc.label}</span>
                            </td>
                            <td style={{ padding: '0.875rem 1rem', color: 'var(--text-muted)', fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>{dateStr}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── FEEDBACK TAB ── */}
        {activeTab === 'feedback' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-dark)' }}>User Feedback <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '1rem' }}>({feedback.length})</span></h2>
              <button onClick={() => exportCSV(feedback, 'feedback.csv')} style={{ padding: '0.5rem 0.875rem', background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                <i className="fas fa-download"></i> Export CSV
              </button>
            </div>

            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              {loading ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}><i className="fas fa-spinner fa-spin"></i> Loading feedback…</div>
              ) : feedback.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>No feedback submitted yet.</div>
              ) : (
                <div style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {feedback.map((fb) => (
                    <div key={fb.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '1rem 1.125rem', background: 'var(--bg-subtle)', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-dark)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{fb.message}</p>
                        <div style={{ marginTop: '0.625rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          <span style={{ fontFamily: 'monospace' }}>{fb.id}</span>
                          {fb.page && <span><i className="fas fa-location-dot" style={{ marginRight: '0.3rem' }}></i>{fb.page}</span>}
                          {fb.createdAt && !isNaN(new Date(fb.createdAt).getTime()) && <span><i className="fas fa-clock" style={{ marginRight: '0.3rem' }}></i>{new Date(fb.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
                        </div>
                      </div>
                      {feedbackConfirmId === fb.id ? (
                        <div style={{ display: 'flex', gap: '0.35rem', flexShrink: 0 }}>
                          <button onClick={() => deleteFeedback(fb.id)} disabled={feedbackDeletingId === fb.id} style={{ padding: '0.3rem 0.6rem', background: '#DC2626', color: 'white', border: 'none', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700, cursor: feedbackDeletingId === fb.id ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
                            {feedbackDeletingId === fb.id ? <i className="fas fa-spinner fa-spin"></i> : 'Delete'}
                          </button>
                          <button onClick={() => setFeedbackConfirmId(null)} disabled={feedbackDeletingId === fb.id} style={{ padding: '0.3rem 0.6rem', background: 'var(--bg)', color: 'var(--text-muted)', border: '1.5px solid var(--border)', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setFeedbackConfirmId(fb.id)} aria-label="Delete feedback" title="Delete feedback" style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 6, border: '1.5px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', color: '#DC2626', fontSize: '0.8rem' }}>
                          <i className="fas fa-trash"></i>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── FAQ TAB ── */}
        {activeTab === 'faq' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <h2 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-dark)' }}>FAQ Articles <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '1rem' }}>({filteredArticles.length}{faqSearch ? ` of ${articles.length}` : ''})</span></h2>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <input value={faqSearch} onChange={e => setFaqSearch(e.target.value)} placeholder="Search articles…" style={{ padding: '0.5rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)', width: '100%', maxWidth: 200 }} />
                <button onClick={() => exportCSV(articles, 'faq-articles.csv')} style={{ padding: '0.5rem 0.875rem', background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <i className="fas fa-download"></i> Export CSV
                </button>
              </div>
            </div>
            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              {loading ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}><i className="fas fa-spinner fa-spin"></i> Loading articles…</div>
              ) : filteredArticles.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                  {faqSearch ? `No articles match "${faqSearch}". Try a different search.` : 'No FAQ articles found.'}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                        {['ID', 'Title', 'Category', 'Status', 'Last Updated'].map(h => (
                          <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredArticles.map((a, i) => {
                        const lastAudit = auditLogs
                          .filter(l => l.entityId === a.id && (l.action === 'UPDATE_FAQ' || l.action === 'CREATE_FAQ'))
                          .sort((x, y) => new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime())[0];
                        const updatedStr = a.updatedAt && !isNaN(new Date(a.updatedAt).getTime())
                          ? new Date(a.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + new Date(a.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
                          : '—';
                        return (
                          <tr key={a.id} style={{ borderBottom: i < filteredArticles.length - 1 ? '1px solid var(--border)' : 'none' }}>
                            <td style={{ padding: '0.875rem 1rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)' }}>{a.id}</td>
                            <td style={{ padding: '0.875rem 1rem', fontWeight: 500, color: 'var(--text-dark)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title || '—'}</td>
                            <td style={{ padding: '0.875rem 1rem', color: 'var(--text-muted)' }}>{a.category || '—'}</td>
                            <td style={{ padding: '0.875rem 1rem' }}>
                              <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.6rem', borderRadius: 20, fontWeight: 600, background: a.status === 'published' || !a.status ? '#D1FAE5' : '#F3F4F6', color: a.status === 'published' || !a.status ? '#065F46' : '#374151' }}>{a.status || 'published'}</span>
                            </td>
                            <td style={{ padding: '0.875rem 1rem', fontSize: '0.8125rem' }}>
                              <p style={{ color: 'var(--text-dark)', whiteSpace: 'nowrap' }}>{updatedStr}</p>
                              {lastAudit && <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>by {lastAudit.performedBy}</p>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── CATEGORIES TAB ── */}
        {activeTab === 'categories' && (
          <div style={{ maxWidth: 900 }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <div>
                <h2 style={{ fontSize: '1.375rem', fontWeight: 800, color: 'var(--text-dark)', marginBottom: '0.25rem' }}>Category Management</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Create and organise top-level categories and subcategories shown on the Knowledge Base sidebar.</p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                {seedingProgress && (
                  <span style={{ fontSize: '0.8125rem', color: seedingProgress.startsWith('Done') ? '#065F46' : '#1E40AF', fontWeight: 600 }}>{seedingProgress}</span>
                )}
                <button
                  onClick={async () => {
                    const SEED_CATS = [
                      { name: 'Getting Started', icon: 'fas fa-rocket', sortOrder: 1 },
                      { name: 'Account Opening', icon: 'fas fa-id-card', sortOrder: 2 },
                      { name: 'Trading', icon: 'fas fa-chart-line', sortOrder: 3 },
                      { name: 'Portfolio & Margin', icon: 'fas fa-briefcase', sortOrder: 4 },
                      { name: 'Funds', icon: 'fas fa-wallet', sortOrder: 5 },
                      { name: 'Charges & Brokerage', icon: 'fas fa-tags', sortOrder: 6 },
                      { name: 'Compliance & Safety', icon: 'fas fa-shield-halved', sortOrder: 7 },
                      { name: 'Mutual Funds', icon: 'fas fa-seedling', sortOrder: 8 },
                      { name: 'IPO', icon: 'fas fa-rocket', sortOrder: 9 },
                      { name: 'F&O', icon: 'fas fa-bolt', sortOrder: 10 },
                      { name: 'Pledging', icon: 'fas fa-link', sortOrder: 11 },
                      { name: 'MTF', icon: 'fas fa-layer-group', sortOrder: 12 },
                      { name: 'Tender Offers', icon: 'fas fa-hand-holding-dollar', sortOrder: 13 },
                      { name: 'Contact & Help', icon: 'fas fa-headset', sortOrder: 14 },
                      { name: 'Advanced', icon: 'fas fa-robot', sortOrder: 15 },
                      { name: 'Account', icon: 'fas fa-user-circle', sortOrder: 16 },
                      { name: 'Reports', icon: 'fas fa-file-invoice', sortOrder: 17 },
                      { name: 'NRI/HUF Accounts', icon: 'fas fa-globe', sortOrder: 18 },
                    ];
                    if (!confirm('This will add the 18 standard categories to the database. Existing categories with the same name will be skipped. Continue?')) return;
                    const existingNames = new Set(maCats.map(c => c.name.toLowerCase()));
                    let added = 0; let skipped = 0;
                    for (let i = 0; i < SEED_CATS.length; i++) {
                      const cat = SEED_CATS[i];
                      setSeedingProgress(`Seeding… ${i + 1}/${SEED_CATS.length}`);
                      if (existingNames.has(cat.name.toLowerCase())) { skipped++; continue; }
                      try {
                        const res = await fetch(masterUrl('/categories'), { method: 'POST', headers: getMasterHeaders(), body: JSON.stringify({ name: cat.name, icon: cat.icon, sortOrder: cat.sortOrder, parentId: null }) });
                        if (res.ok) { added++; existingNames.add(cat.name.toLowerCase()); }
                        else skipped++;
                      } catch { skipped++; }
                    }
                    setSeedingProgress(`Done! ${added} added, ${skipped} skipped.`);
                    fetchMaCats();
                    setTimeout(() => setSeedingProgress(''), 6000);
                  }}
                  style={{ padding: '0.5rem 1rem', background: 'var(--bg)', border: '1.5px solid #3B82F6', borderRadius: 8, cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600, color: '#3B82F6', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <i className="fas fa-database"></i> Seed Default Categories
                </button>
                <button onClick={fetchMaCats} disabled={maCatLoading} style={{ padding: '0.5rem 1rem', background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, cursor: maCatLoading ? 'not-allowed' : 'pointer', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-dark)', display: 'flex', alignItems: 'center', gap: '0.4rem', opacity: maCatLoading ? 0.6 : 1 }}>
                  <i className={`fas fa-rotate-right ${maCatLoading ? 'fa-spin' : ''}`}></i> Refresh
                </button>
              </div>
            </div>

            {/* Two-column layout: form left, tree right */}
            <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '1.25rem', alignItems: 'start' }}>

              {/* ── Form panel ── */}
              <div style={{ background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 14, padding: '1.375rem', position: 'sticky', top: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: editingMaCatId ? '#EFF6FF' : '#F0FDF4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <i className={editingMaCatId ? 'fas fa-pen' : 'fas fa-plus'} style={{ fontSize: '0.75rem', color: editingMaCatId ? '#1E40AF' : '#00AB4E' }}></i>
                  </div>
                  <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-dark)' }}>
                    {editingMaCatId ? 'Edit Category' : 'New Category'}
                  </h3>
                </div>

                <form onSubmit={async (e) => {
                  e.preventDefault();
                  if (!maCatForm.name.trim()) { setMaCatFormMsg('Name is required.'); return; }
                  setMaCatSubmitting(true); setMaCatFormMsg('');
                  try {
                    const method = editingMaCatId ? 'PUT' : 'POST';
                    const url = editingMaCatId ? masterUrl(`/categories/${editingMaCatId}`) : masterUrl('/categories');
                    const res = await fetch(url, { method, headers: getMasterHeaders(), body: JSON.stringify({ name: maCatForm.name.trim(), icon: maCatForm.icon, parentId: maCatForm.parentId || null, description: maCatForm.description.trim() }) });
                    if (res.status === 401) { handleSessionExpired(); return; }
                    if (!res.ok) throw new Error('Failed');
                    setMaCatFormMsg(editingMaCatId ? '✓ Category updated!' : '✓ Category created!');
                    setMaCatForm({ name: '', icon: 'fas fa-folder', parentId: '', description: '' });
                    setEditingMaCatId(null);
                    fetchMaCats();
                    setTimeout(() => setMaCatFormMsg(''), 3000);
                  } catch { setMaCatFormMsg('Something went wrong. Please try again.'); }
                  finally { setMaCatSubmitting(false); }
                }}>
                  <div style={{ marginBottom: '0.875rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Name *</label>
                    <input type="text" value={maCatForm.name} onChange={e => setMaCatForm({ ...maCatForm, name: e.target.value })} placeholder="e.g. Funds, Trading, IPO…" maxLength={100} style={{ width: '100%', padding: '0.625rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text-dark)' }} />
                  </div>

                  <div style={{ marginBottom: '0.875rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Description <span style={{ textTransform: 'none', fontWeight: 400 }}>— shown under the category on the site (optional)</span></label>
                    <input type="text" value={maCatForm.description} onChange={e => setMaCatForm({ ...maCatForm, description: e.target.value })} placeholder="e.g. Orders, GTT, Basket, AMO" maxLength={120} style={{ width: '100%', padding: '0.625rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text-dark)' }} />
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem', textAlign: 'right' }}>{maCatForm.description.length}/120</div>
                  </div>

                  <div style={{ marginBottom: '0.875rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Type</label>
                    <select value={maCatForm.parentId} onChange={e => setMaCatForm({ ...maCatForm, parentId: e.target.value })} style={{ width: '100%', padding: '0.625rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', outline: 'none', background: 'var(--bg)', color: 'var(--text-dark)', boxSizing: 'border-box' }}>
                      <option value="">📁 Top-level category</option>
                      {maTopLevelCats.map(c => <option key={c.id} value={c.id}>↳ Subcategory of: {c.name}</option>)}
                    </select>
                  </div>

                  <div style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>Icon</label>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: '#F0FDF4', border: '1.5px solid #BBF7D0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <i className={maCatForm.icon || 'fas fa-folder'} style={{ fontSize: '1rem', color: '#00AB4E' }}></i>
                      </div>
                      <input type="text" value={maCatForm.icon} onChange={e => setMaCatForm({ ...maCatForm, icon: e.target.value })} placeholder="fas fa-folder" style={{ flex: 1, padding: '0.625rem 0.875rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.8125rem', outline: 'none', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text-dark)', fontFamily: 'monospace' }} />
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                      {[
                        'fas fa-wallet','fas fa-chart-line','fas fa-rocket','fas fa-shield-halved',
                        'fas fa-headset','fas fa-file-invoice','fas fa-building-columns','fas fa-layer-group',
                        'fas fa-bolt','fas fa-link','fas fa-seedling','fas fa-globe',
                        'fas fa-id-card','fas fa-briefcase','fas fa-tags','fas fa-robot',
                      ].map(ic => (
                        <button key={ic} type="button" title={ic} onClick={() => setMaCatForm({ ...maCatForm, icon: ic })}
                          style={{ width: 30, height: 30, borderRadius: 6, border: `1.5px solid ${maCatForm.icon === ic ? '#00AB4E' : 'var(--border)'}`, background: maCatForm.icon === ic ? '#F0FDF4' : 'var(--bg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: maCatForm.icon === ic ? '#00AB4E' : 'var(--text-muted)', fontSize: '0.75rem' }}>
                          <i className={ic}></i>
                        </button>
                      ))}
                    </div>
                  </div>

                  {maCatFormMsg && (
                    <div style={{ padding: '0.625rem 0.875rem', borderRadius: 8, fontSize: '0.8125rem', marginBottom: '0.875rem', background: maCatFormMsg.startsWith('✓') ? '#F0FDF4' : '#FEF2F2', border: `1px solid ${maCatFormMsg.startsWith('✓') ? '#BBF7D0' : '#FECACA'}`, color: maCatFormMsg.startsWith('✓') ? '#065F46' : '#B91C1C', fontWeight: 500 }}>
                      {maCatFormMsg}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '0.625rem' }}>
                    <button type="submit" disabled={maCatSubmitting} style={{ flex: 1, padding: '0.625rem', background: '#00AB4E', color: 'white', border: 'none', borderRadius: 8, fontSize: '0.875rem', fontWeight: 700, cursor: maCatSubmitting ? 'not-allowed' : 'pointer', opacity: maCatSubmitting ? 0.7 : 1 }}>
                      {maCatSubmitting ? <><i className="fas fa-spinner fa-spin" style={{ marginRight: '0.375rem' }}></i>{editingMaCatId ? 'Saving…' : 'Creating…'}</> : (editingMaCatId ? 'Save Changes' : 'Create Category')}
                    </button>
                    {editingMaCatId && (
                      <button type="button" onClick={() => { setEditingMaCatId(null); setMaCatForm({ name: '', icon: 'fas fa-folder', parentId: '', description: '' }); setMaCatFormMsg(''); }} style={{ padding: '0.625rem 0.875rem', background: 'none', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', color: 'var(--text-muted)' }}>Cancel</button>
                    )}
                  </div>
                </form>
              </div>

              {/* ── Category tree panel ── */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {maTopLevelCats.length} {maTopLevelCats.length === 1 ? 'Category' : 'Categories'} · {maCats.filter(c => c.parentId).length} Subcategories
                  </span>
                </div>

                {maCatLoading ? (
                  <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg)', borderRadius: 14, border: '1.5px solid var(--border)' }}>
                    <i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem', marginBottom: '0.75rem', display: 'block' }}></i>
                    Loading categories…
                  </div>
                ) : maCatError ? (
                  <div style={{ padding: '3rem', textAlign: 'center', color: '#B91C1C', background: '#FEF2F2', borderRadius: 14, border: '1px solid #FECACA', fontSize: '0.875rem' }}>{maCatError}</div>
                ) : maCats.length === 0 ? (
                  <div style={{ padding: '4rem', textAlign: 'center', background: 'var(--bg)', borderRadius: 14, border: '1.5px dashed var(--border)' }}>
                    <i className="fas fa-folder-open" style={{ fontSize: '2rem', color: 'var(--text-muted)', marginBottom: '0.75rem', display: 'block' }}></i>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '0.25rem', fontWeight: 600 }}>No categories yet</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Create your first category using the form.</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {maTopLevelCats.map(cat => {
                      const subs = getMaSubcats(cat.id);
                      return (
                        <div key={cat.id} style={{ background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                          {/* Top-level row */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.875rem 1rem', background: editingMaCatId === cat.id ? '#EFF6FF' : 'var(--bg)' }}>
                            <div style={{ width: 36, height: 36, borderRadius: 9, background: '#F0FDF4', border: '1.5px solid #BBF7D0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <i className={cat.icon} style={{ color: '#00AB4E', fontSize: '0.875rem' }}></i>
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-dark)', marginBottom: '0.1rem' }}>{cat.name}</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                {subs.length > 0 ? `${subs.length} subcategor${subs.length === 1 ? 'y' : 'ies'}` : 'Top-level · no subcategories'}
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.375rem' }}>
                              <button title="Add subcategory" onClick={() => { setMaCatForm({ name: '', icon: 'fas fa-folder', parentId: cat.id, description: '' }); setEditingMaCatId(null); setMaCatFormMsg(''); }} style={{ height: 30, padding: '0 0.625rem', borderRadius: 6, border: '1.5px solid #BBF7D0', background: '#F0FDF4', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#00AB4E', fontSize: '0.75rem', fontWeight: 600 }}>
                                <i className="fas fa-plus" style={{ fontSize: '0.6rem' }}></i> Sub
                              </button>
                              <button title="Edit" onClick={() => { setEditingMaCatId(cat.id); setMaCatForm({ name: cat.name, icon: cat.icon, parentId: '', description: cat.description || '' }); setMaCatFormMsg(''); }} style={{ width: 30, height: 30, borderRadius: 6, border: '1.5px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1E40AF' }}>
                                <i className="fas fa-pen" style={{ fontSize: '0.65rem' }}></i>
                              </button>
                              <button title="Delete" disabled={!!deletingMaCatId} onClick={async () => {
                                if (!confirm(`Delete "${cat.name}"?${subs.length > 0 ? `\n\nThis will also delete its ${subs.length} subcategor${subs.length === 1 ? 'y' : 'ies'}.` : ''}`)) return;
                                setDeletingMaCatId(cat.id);
                                try {
                                  for (const sub of subs) {
                                    await fetch(masterUrl(`/categories/${sub.id}`), { method: 'DELETE', headers: getMasterHeaders() });
                                  }
                                  const r = await fetch(masterUrl(`/categories/${cat.id}`), { method: 'DELETE', headers: getMasterHeaders() });
                                  if (r.status === 401) { handleSessionExpired(); return; }
                                  if (!r.ok) throw new Error('Failed');
                                  fetchMaCats();
                                } catch { alert('Failed to delete category.'); }
                                finally { setDeletingMaCatId(null); }
                              }} style={{ width: 30, height: 30, borderRadius: 6, border: '1.5px solid #FECACA', background: '#FEF2F2', cursor: deletingMaCatId ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#B91C1C', opacity: deletingMaCatId === cat.id ? 0.5 : 1 }}>
                                {deletingMaCatId === cat.id ? <i className="fas fa-spinner fa-spin" style={{ fontSize: '0.65rem' }}></i> : <i className="fas fa-trash" style={{ fontSize: '0.65rem' }}></i>}
                              </button>
                            </div>
                          </div>

                          {/* Subcategories */}
                          {subs.length > 0 && (
                            <div style={{ borderTop: '1px solid var(--border)' }}>
                              {subs.map((sub, idx) => (
                                <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 1rem', background: editingMaCatId === sub.id ? '#EFF6FF' : idx % 2 === 0 ? 'var(--bg-subtle)' : 'var(--bg)', borderBottom: idx < subs.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                  <div style={{ width: 8, flexShrink: 0 }}></div>
                                  <i className="fas fa-corner-down-right" style={{ fontSize: '0.6rem', color: 'var(--text-muted)', flexShrink: 0 }}></i>
                                  <div style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                    <i className={sub.icon} style={{ color: '#6B7280', fontSize: '0.75rem' }}></i>
                                  </div>
                                  <span style={{ flex: 1, fontSize: '0.875rem', color: 'var(--text-dark)', fontWeight: 500 }}>{sub.name}</span>
                                  <div style={{ display: 'flex', gap: '0.375rem' }}>
                                    <button title="Edit" onClick={() => { setEditingMaCatId(sub.id); setMaCatForm({ name: sub.name, icon: sub.icon, parentId: sub.parentId || '', description: sub.description || '' }); setMaCatFormMsg(''); }} style={{ width: 26, height: 26, borderRadius: 6, border: '1.5px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1E40AF' }}>
                                      <i className="fas fa-pen" style={{ fontSize: '0.6rem' }}></i>
                                    </button>
                                    <button title="Delete" disabled={!!deletingMaCatId} onClick={async () => {
                                      if (!confirm(`Delete subcategory "${sub.name}"?`)) return;
                                      setDeletingMaCatId(sub.id);
                                      try {
                                        const r = await fetch(masterUrl(`/categories/${sub.id}`), { method: 'DELETE', headers: getMasterHeaders() });
                                        if (r.status === 401) { handleSessionExpired(); return; }
                                        if (!r.ok) throw new Error('Failed');
                                        fetchMaCats();
                                      } catch { alert('Failed to delete subcategory.'); }
                                      finally { setDeletingMaCatId(null); }
                                    }} style={{ width: 26, height: 26, borderRadius: 6, border: '1.5px solid #FECACA', background: '#FEF2F2', cursor: deletingMaCatId ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#B91C1C', opacity: deletingMaCatId === sub.id ? 0.5 : 1 }}>
                                      {deletingMaCatId === sub.id ? <i className="fas fa-spinner fa-spin" style={{ fontSize: '0.6rem' }}></i> : <i className="fas fa-trash" style={{ fontSize: '0.6rem' }}></i>}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Confirm manager status change modal ── */}
      {confirmManagerAction && (
        <div onClick={() => setConfirmManagerAction(null)} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', borderRadius: 14, padding: '2rem', maxWidth: 380, width: '100%', boxShadow: '0 25px 50px rgba(0,0,0,0.15)', textAlign: 'center' }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: confirmManagerAction.newStatus === 'deactivated' ? '#FEE2E2' : '#D1FAE5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem', fontSize: '1.25rem', color: confirmManagerAction.newStatus === 'deactivated' ? '#991B1B' : '#065F46' }}>
              <i className={`fas ${confirmManagerAction.newStatus === 'deactivated' ? 'fa-user-slash' : 'fa-user-check'}`}></i>
            </div>
            <h3 style={{ fontWeight: 800, color: 'var(--text-dark)', marginBottom: '0.5rem' }}>{confirmManagerAction.newStatus === 'deactivated' ? 'Deactivate Manager?' : 'Reactivate Manager?'}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
              {confirmManagerAction.newStatus === 'deactivated'
                ? `${confirmManagerAction.displayName} will lose access to the admin portal immediately.`
                : `${confirmManagerAction.displayName} will regain access to the admin portal.`}
            </p>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => setConfirmManagerAction(null)} style={{ flex: 1, padding: '0.75rem', background: 'none', border: '1.5px solid var(--border)', borderRadius: 8, fontWeight: 600, cursor: 'pointer', color: 'var(--text-dark)' }}>Cancel</button>
              <button onClick={async () => {
                const { managerId, newStatus, displayName } = confirmManagerAction;
                setConfirmManagerAction(null);
                try {
                  const r = await fetch(masterUrl(`/managers/${managerId}`), { method: 'PUT', headers: getMasterHeaders(), body: JSON.stringify({ status: newStatus }) });
                  if (r.status === 401) { handleSessionExpired(); return; }
                  if (!r.ok) { alert(`Failed to ${newStatus === 'deactivated' ? 'deactivate' : 'reactivate'} ${displayName}. Please try again.`); return; }
                } catch { alert('Network error. Please try again.'); return; }
                fetchManagers();
              }} style={{ flex: 1, padding: '0.75rem', background: confirmManagerAction.newStatus === 'deactivated' ? '#991B1B' : '#00AB4E', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
                {confirmManagerAction.newStatus === 'deactivated' ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Audit detail modal ── */}
      {selectedLog && (
        <div onClick={() => setSelectedLog(null)} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.5)' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', borderRadius: 14, boxShadow: '0 25px 50px rgba(0,0,0,0.15)', maxWidth: 500, width: '100%', overflow: 'hidden' }}>
            <div style={{ padding: '1.125rem 1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-subtle)' }}>
              <h3 style={{ fontWeight: 700, color: 'var(--text-dark)', fontSize: '1rem' }}>Audit Entry Detail</h3>
              <button onClick={() => setSelectedLog(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--text-muted)', lineHeight: 1 }}><i className="fas fa-times"></i></button>
            </div>
            <div style={{ padding: '1.5rem', display: 'grid', gap: '1rem' }}>
              {[
                ['Log ID', selectedLog.id],
                ['Action', ACTION_CONFIG[selectedLog.action]?.label || selectedLog.action],
                ['Entity Type', selectedLog.entity],
                ['Entity ID', selectedLog.entityId],
                ['Title / Subject', selectedLog.entityTitle || '—'],
                ['Performed By', selectedLog.performedBy],
                ['Timestamp', new Date(selectedLog.timestamp).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'medium' })],
              ].map(([label, value]) => (
                <div key={String(label)} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '0.5rem', fontSize: '0.875rem' }}>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', paddingTop: '0.1rem' }}>{label}</span>
                  <span style={{ color: 'var(--text-dark)', fontWeight: 500, wordBreak: 'break-all' }}>{String(value)}</span>
                </div>
              ))}
              {selectedLog.meta && Object.keys(selectedLog.meta).length > 0 && (
                <div>
                  <p style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' }}>Metadata</p>
                  <pre style={{ background: 'var(--bg-subtle)', borderRadius: 8, padding: '0.875rem', fontSize: '0.8rem', color: 'var(--text-dark)', overflowX: 'auto', margin: 0 }}>{JSON.stringify(selectedLog.meta, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
