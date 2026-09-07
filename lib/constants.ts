/**
 * Single source of truth for the canonical static category list used as a
 * fallback when the /categories API is unavailable, and to ensure all 18
 * static categories are always rendered on the homepage and FAQ sidebar
 * regardless of what's in the database.
 *
 * Category NAMES must exactly match the `category` field stored on articles
 * in Firestore (case-sensitive, including punctuation/whitespace). Drift
 * here breaks filtering on the frontend.
 *
 * Order in this array is the default sort order shown in the UI.
 */

export interface Category {
  id: string;
  name: string;
  icon: string;
  parentId: string | null;
  description?: string;
  sortOrder?: number;
  status?: string;
}

export const STATIC_CATEGORIES: Category[] = [
  { id: 'getting-started', name: 'Getting Started',     icon: 'fas fa-rocket',               parentId: null },
  { id: 'account-opening', name: 'Account Opening',     icon: 'fas fa-id-card',              parentId: null },
  { id: 'trading',         name: 'Trading',             icon: 'fas fa-chart-line',           parentId: null },
  { id: 'portfolio',       name: 'Portfolio & Margin',  icon: 'fas fa-briefcase',            parentId: null },
  { id: 'funds',           name: 'Funds',               icon: 'fas fa-wallet',               parentId: null },
  { id: 'charges',         name: 'Charges & Brokerage', icon: 'fas fa-tags',                 parentId: null },
  { id: 'compliance',      name: 'Compliance & Safety', icon: 'fas fa-shield-halved',        parentId: null },
  { id: 'mutual-funds',    name: 'Mutual Funds',        icon: 'fas fa-seedling',             parentId: null },
  { id: 'ipo',             name: 'IPO',                 icon: 'fas fa-rocket',               parentId: null },
  { id: 'fo',              name: 'F&O',                 icon: 'fas fa-bolt',                 parentId: null },
  { id: 'pledging',        name: 'Pledging',            icon: 'fas fa-link',                 parentId: null },
  { id: 'mtf',             name: 'MTF',                 icon: 'fas fa-layer-group',          parentId: null },
  { id: 'tender-offers',   name: 'Tender Offers',       icon: 'fas fa-hand-holding-dollar',  parentId: null },
  { id: 'contact-faq',     name: 'Contact & Help',      icon: 'fas fa-headset',              parentId: null },
  { id: 'advanced',        name: 'Advanced',            icon: 'fas fa-robot',                parentId: null },
  { id: 'account',         name: 'Account',             icon: 'fas fa-user-circle',          parentId: null },
  { id: 'reports',         name: 'Reports',             icon: 'fas fa-file-invoice',         parentId: null },
  { id: 'nri',             name: 'NRI/HUF Accounts',    icon: 'fas fa-globe',                parentId: null },
];

/**
 * Flat list of category names — used by admin forms (<select> options) and
 * by any code that just needs the canonical name strings.
 */
export const STATIC_CATEGORY_NAMES: string[] = STATIC_CATEGORIES.map(c => c.name).concat(['Other']);
