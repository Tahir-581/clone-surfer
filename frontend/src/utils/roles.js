// ─── Role Utilities ───────────────────────────────────────────────────────────
// Roles: admin | outliner | content_writer | content_editor | compliance_manager | publisher

export const ROLES = {
  ADMIN: 'admin',
  OUTLINER: 'outliner',
  CONTENT_WRITER: 'content_writer',
  CONTENT_EDITOR: 'content_editor',
  COMPLIANCE_MANAGER: 'compliance_manager',
  PUBLISHER: 'publisher',
};

export function normalizeRole(role) {
  if (!role || typeof role !== 'string') return '';
  return role.trim().toLowerCase().replace(/\s+/g, '_');
}

// ─── Stored User ───────────────────────────────────────────────────────────────

export function getStoredUser() {
  try {
    const userStr = localStorage.getItem('user');
    const user = userStr ? JSON.parse(userStr) : null;
    if (!user) return null;
    return { ...user, role: normalizeRole(user.role) || user.role || ROLES.CONTENT_WRITER };
  } catch {
    return null;
  }
}

export function getStoredUserRole() {
  return getStoredUser()?.role || ROLES.CONTENT_WRITER;
}

// ─── Role Checks ──────────────────────────────────────────────────────────────

export function isAdmin(role) {
  return normalizeRole(role) === ROLES.ADMIN;
}

export function isOutliner(role) {
  const r = normalizeRole(role);
  return r === ROLES.OUTLINER || r === ROLES.ADMIN;
}

export function isContentWriter(role) {
  const r = normalizeRole(role);
  return r === ROLES.CONTENT_WRITER || r === ROLES.ADMIN;
}

export function isContentEditor(role) {
  const r = normalizeRole(role);
  return r === ROLES.CONTENT_EDITOR || r === ROLES.ADMIN;
}

export function isComplianceManager(role) {
  const r = normalizeRole(role);
  return r === ROLES.COMPLIANCE_MANAGER || r === ROLES.ADMIN;
}

export function isPublisher(role) {
  const r = normalizeRole(role);
  return r === ROLES.PUBLISHER || r === ROLES.ADMIN;
}

// ─── Permission Checks ────────────────────────────────────────────────────────

/** Can access keyword research pages (SearchPage, ResultsPage) */
export function canAccessKeywordResearch(role) {
  const r = normalizeRole(role);
  return r === ROLES.ADMIN || r === ROLES.OUTLINER;
}

/** Can write/edit article content */
export function canWriteArticle(role) {
  const r = normalizeRole(role);
  return r === ROLES.ADMIN || r === ROLES.CONTENT_WRITER || r === ROLES.CONTENT_EDITOR || r === ROLES.COMPLIANCE_MANAGER;
}

/** Can view the article writer page (read-only or review mode) */
export function canViewArticle(role) {
  // All authenticated roles can view articles
  return !!normalizeRole(role);
}

/** Can mark articles complete/in-review */
export function canMarkArticleStatus(role) {
  const r = normalizeRole(role);
  return r === ROLES.ADMIN || r === ROLES.CONTENT_EDITOR || r === ROLES.COMPLIANCE_MANAGER;
}

/** Can see pre-publish review + publish/export tabs */
export function canPublishReview(role) {
  const r = normalizeRole(role);
  return r === ROLES.ADMIN || r === ROLES.COMPLIANCE_MANAGER || r === ROLES.PUBLISHER;
}

/** Can view article history (admin only) */
export function canViewHistory(role) {
  return normalizeRole(role) === ROLES.ADMIN;
}

/** Can access content-editor page (everyone except outliner-only users) */
export function canAccessContentEditor(role) {
  const r = normalizeRole(role);
  return r !== ROLES.OUTLINER || r === ROLES.ADMIN;
}

// ─── JWT Expiry Detection ─────────────────────────────────────────────────────

/**
 * Decodes a JWT payload (without verifying signature) and returns expiry timestamp (ms).
 * Returns null if the token is invalid or has no exp claim.
 */
export function getTokenExpiry(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return null;
    return payload.exp * 1000; // convert to ms
  } catch {
    return null;
  }
}

/**
 * Returns true if the stored token is expired or within `bufferMs` of expiry.
 */
export function isTokenExpired(bufferMs = 60000) {
  try {
    const user = getStoredUser();
    if (!user?.token) return true;
    const expiry = getTokenExpiry(user.token);
    if (expiry === null) return true;
    return Date.now() >= expiry - bufferMs;
  } catch {
    return true;
  }
}

// ─── Auth Logout ──────────────────────────────────────────────────────────────

export function logout(redirectPath = '/login') {
  try {
    localStorage.removeItem('user');
  } catch { /* ignore */ }
  window.location.href = redirectPath;
}
