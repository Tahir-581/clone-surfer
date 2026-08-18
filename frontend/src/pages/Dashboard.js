import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'react-toastify';
import {
  FileText, Clock, CheckCircle, Circle, AlertCircle,
  RefreshCw, Eye, PenTool, ShieldCheck, User, Filter,
  Search, BookOpen, Layers, Edit3, ArrowUpRight, BarChart2
} from 'lucide-react';
import { getStoredUser, normalizeRole, canAccessKeywordResearch } from '../utils/roles';
import { config } from '../config';
import '../styles/Dashboard.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr) {
  if (!dateStr) return '—';
  const now = new Date();
  const diff = Math.floor((now - new Date(dateStr)) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

const STATUS_META = {
  outline: { label: 'Outline', color: 'var(--color-brand)', bg: 'var(--color-brand-tint)', icon: <FileText size={14} /> },
  drafting: { label: 'Drafting', color: 'var(--color-warning)', bg: 'var(--color-warning-tint)', icon: <PenTool size={14} /> },
  revision: { label: 'Revision', color: '#9333ea', bg: '#f3e8ff', icon: <PenTool size={14} /> },
  in_review: { label: 'In Review', color: 'var(--color-brand-hover)', bg: 'rgba(255, 128, 64, 0.12)', icon: <Eye size={14} /> },
  approved: { label: 'Approved', color: 'var(--color-success)', bg: 'var(--color-success-tint)', icon: <CheckCircle size={14} /> },
  published: { label: 'Published', color: '#ff5c00', bg: 'rgba(255, 92, 0, 0.12)', icon: <ShieldCheck size={14} /> },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || 'Unknown', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', icon: <Circle size={14} /> };
  return (
    <span className="status-badge" style={{ color: meta.color, background: meta.bg }}>
      {meta.icon} {meta.label}
    </span>
  );
}

const ROLE_LABELS = {
  admin: 'Administrator',
  outliner: 'Outliner',
  content_writer: 'Content Writer',
  content_editor: 'Content Editor',
  compliance_manager: 'Compliance Manager',
  publisher: 'Publisher',
};

// ── Skeleton Loader ──────────────────────────────────────────────────────────

const SkeletonCard = () => (
  <div className="skeleton-card-premium">
    <div className="skeleton-circle shimmer" />
    <div className="skeleton-content-wrap">
      <div className="skeleton-line shimmer title" />
      <div className="skeleton-line shimmer sub" />
    </div>
    <div className="skeleton-badge shimmer" />
  </div>
);

const SkeletonList = ({ count = 5 }) => (
  <div className="list-container">
    {Array.from({ length: count }).map((_, i) => (
      <SkeletonCard key={i} />
    ))}
  </div>
);

// ── Dashboard Component ───────────────────────────────────────────────────────

function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();

  const user = getStoredUser();
  const role = normalizeRole(user?.role);

  const [articles, setArticles] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dateFilter, setDateFilter] = useState('today'); // 'today' | 'week' | 'all'

  // Lazy loading state
  const [displayCountArticles, setDisplayCountArticles] = useState(10);
  const [displayCountKeywords, setDisplayCountKeywords] = useState(10);
  const observerRefArticles = useRef(null);
  const observerRefKeywords = useRef(null);

  useEffect(() => {
    if (location.state?.unauthorized) {
      toast.warn("You don't have permission to access that page.");
    }
  }, [location.state]);

  // ── Fetch Data ─────────────────────────────────────────────────────────────
  const fetchData = useCallback(async (signal) => {
    try {
      setLoading(true);
      setError('');
      const headers = user?.token ? { Authorization: `Bearer ${user.token}` } : {};

      const requests = [
        axios.get(`${config.API_URL}/articles`, { headers, signal, timeout: 15000 })
      ];

      // If outliner or admin, also fetch keywords
      if (role === 'outliner' || role === 'admin') {
        requests.push(axios.get(`${config.API_URL}/nlp-keywords?limit=1000`, { headers, signal, timeout: 15000 }));
      }

      const responses = await Promise.all(requests);

      setArticles(responses[0]?.data?.items || []);

      if (responses[1]) {
        setKeywords(responses[1]?.data?.items || []);
      }

    } catch (err) {
      if (axios.isCancel?.(err) || err.name === 'CanceledError') return;
      const msg = err.response?.data?.detail || err.message || 'Failed to load dashboard data';
      setError(msg);
      if (err.response?.status !== 401) toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [user?.token, role]);

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  // ── Filter logic ───────────────────────────────────────────────────────────

  // Date filtering helper
  const isWithinDateFilter = useCallback((dateStr) => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    const now = new Date();
    if (dateFilter === 'today') {
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    } else if (dateFilter === 'week') {
      const weekAgo = Date.now() - 7 * 86400000;
      return d.getTime() >= weekAgo;
    }
    return true; // 'all'
  }, [dateFilter]);

  const filteredArticles = useMemo(() => {
    let items = [...articles];

    // Role-based visibility
    if (role === 'content_writer') {
      items = items.filter(a => String(a.assigned_to) === String(user?.id) || String(a.user_id) === String(user?.id) || String(a.created_by) === String(user?.id));
    } else if (role === 'content_editor' || role === 'compliance_manager') {
      // Content editor & Compliance manager: complete access - view all articles written by anyone
    } else if (role === 'publisher') {
      items = items.filter(a => a.status === 'in_review' || a.status === 'approved' || a.status === 'published');
    } else if (role === 'outliner') {
      items = items.filter(a => String(a.user_id) === String(user?.id) || String(a.created_by) === String(user?.id) || a.status === 'outline');
    }

    // Date filter
    items = items.filter(a => isWithinDateFilter(a.updated_at || a.created_at || a.updatedAt || a.createdAt));

    return items.sort((a, b) => new Date(b.updated_at || b.updatedAt || 0) - new Date(a.updated_at || a.updatedAt || 0));
  }, [articles, role, user?.id, isWithinDateFilter]);

  const filteredKeywords = useMemo(() => {
    let items = [...keywords];
    items = items.filter(k => isWithinDateFilter(k.updated_at || k.created_at));
    return items.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  }, [keywords, isWithinDateFilter]);


  // ── Intersection Observer for Lazy Loading ─────────────────────────────────
  useEffect(() => {
    const rootEl = document.querySelector('.articles-list-container');
    const observerArt = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        setDisplayCountArticles(prev => prev + 10);
      }
    }, { root: rootEl || null, threshold: 0.1 });

    if (observerRefArticles.current) observerArt.observe(observerRefArticles.current);

    return () => observerArt.disconnect();
  }, [filteredArticles]);

  useEffect(() => {
    const rootEl = document.querySelector('.keywords-list-container');
    const observerKw = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        setDisplayCountKeywords(prev => prev + 10);
      }
    }, { root: rootEl || null, threshold: 0.1 });

    if (observerRefKeywords.current) observerKw.observe(observerRefKeywords.current);

    return () => observerKw.disconnect();
  }, [filteredKeywords]);


  // ── Stats Calculation ──────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (role === 'outliner') {
      return [
        { label: 'Total Keywords Researched', value: filteredKeywords.length, color: 'var(--color-brand)', bg: 'var(--color-brand-tint)', icon: <Search size={24} /> },
      ];
    } else if (role === 'content_writer') {
      return [
        { label: 'Total Articles', value: filteredArticles.length, color: 'var(--color-brand)', bg: 'var(--color-brand-tint)', icon: <BookOpen size={24} /> },
        { label: 'Drafting', value: filteredArticles.filter(a => a.status === 'drafting').length, color: 'var(--color-warning)', bg: 'var(--color-warning-tint)', icon: <PenTool size={24} /> },
        { label: 'In Review', value: filteredArticles.filter(a => a.status === 'in_review').length, color: 'var(--color-brand-hover)', bg: 'rgba(255, 128, 64, 0.12)', icon: <Eye size={24} /> },
        { label: 'Approved', value: filteredArticles.filter(a => a.status === 'approved' || a.status === 'published').length, color: 'var(--color-success)', bg: 'var(--color-success-tint)', icon: <CheckCircle size={24} /> },
      ];
    } else if (role === 'content_editor') {
      return [
        { label: 'Total Articles to Edit', value: filteredArticles.length, color: 'var(--color-brand)', bg: 'var(--color-brand-tint)', icon: <Layers size={24} /> },
        { label: 'Pending Review', value: filteredArticles.filter(a => a.status === 'in_review').length, color: 'var(--color-warning)', bg: 'var(--color-warning-tint)', icon: <Eye size={24} /> },
        { label: 'Edited / Reviewed', value: filteredArticles.filter(a => a.status === 'approved' || a.status === 'published').length, color: 'var(--color-success)', bg: 'var(--color-success-tint)', icon: <Edit3 size={24} /> },
        { label: 'Drafts', value: filteredArticles.filter(a => a.status === 'drafting').length, color: 'var(--color-text-muted)', bg: 'var(--color-bg-surface)', icon: <FileText size={24} /> },
      ];
    } else if (role === 'compliance_manager') {
      return [
        { label: 'Total for Compliance', value: filteredArticles.length, color: 'var(--color-brand)', bg: 'var(--color-brand-tint)', icon: <ShieldCheck size={24} /> },
        { label: 'Needs Review', value: filteredArticles.filter(a => a.status === 'in_review').length, color: 'var(--color-warning)', bg: 'var(--color-warning-tint)', icon: <Clock size={24} /> },
        { label: 'Compliance Approved', value: filteredArticles.filter(a => a.status === 'approved' || a.status === 'published').length, color: 'var(--color-success)', bg: 'var(--color-success-tint)', icon: <CheckCircle size={24} /> },
      ];
    } else if (role === 'publisher') {
      return [
        { label: 'Total Ready', value: filteredArticles.length, color: 'var(--color-brand)', bg: 'var(--color-brand-tint)', icon: <ArrowUpRight size={24} /> },
        { label: 'Approved (Pending Publish)', value: filteredArticles.filter(a => a.status === 'approved').length, color: 'var(--color-warning)', bg: 'var(--color-warning-tint)', icon: <Clock size={24} /> },
        { label: 'Published', value: filteredArticles.filter(a => a.status === 'published').length, color: 'var(--color-success)', bg: 'var(--color-success-tint)', icon: <ShieldCheck size={24} /> },
      ];
    }
    // Admin default
    return [
      { label: 'Total Articles', value: filteredArticles.length, color: 'var(--color-brand)', bg: 'var(--color-brand-tint)', icon: <BarChart2 size={24} /> },
      { label: 'Total NLPs', value: filteredKeywords.length, color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)', icon: <Search size={24} /> },
      { label: 'Total Review', value: filteredArticles.filter(a => a.status === 'in_review').length, color: 'var(--color-brand-hover)', bg: 'rgba(255, 128, 64, 0.12)', icon: <Eye size={24} /> },
      { label: 'Total Approved', value: filteredArticles.filter(a => a.status === 'approved').length, color: 'var(--color-success)', bg: 'var(--color-success-tint)', icon: <CheckCircle size={24} /> },
      { label: 'Draft', value: filteredArticles.filter(a => a.status === 'drafting' || a.status === 'outline').length, color: 'var(--color-warning)', bg: 'var(--color-warning-tint)', icon: <PenTool size={24} /> },
      { label: 'Total Published', value: filteredArticles.filter(a => a.status === 'published').length, color: '#ff5c00', bg: 'rgba(255, 92, 0, 0.12)', icon: <ShieldCheck size={24} /> },
    ];
  }, [filteredArticles, filteredKeywords, role]);


  // ── Navigation ─────────────────────────────────────────────────────────────
  const openArticle = (item) => {
    const articleKey = item.article_key || item.id || item.keyword || '';
    const keyword = item.keyword || item.title || '';
    const articleKeywords = Array.isArray(item.keywords_json?.Green) ? [
      ...(item.keywords_json.Green || []),
      ...(item.keywords_json.Orange || []),
      ...(item.keywords_json.White || []),
    ] : [];
    navigate(`/article-writer?keyword=${encodeURIComponent(keyword)}&articleKey=${encodeURIComponent(articleKey)}`, {
      state: { keyword, keywords: articleKeywords, articleKey, results: item.results || [], selectedUrls: item.selected_urls || [] },
    });
  };

  const publishArticle = async (item) => {
    try {
      const headers = user?.token ? { Authorization: `Bearer ${user.token}` } : {};
      
      const payload = {
        article_key: item.article_key || item.id,
        session_id: item.session_id || item.sessionId,
        title: item.title || 'Untitled',
        keyword: item.keyword,
        keywords: item.keywords_json || item.keywords || {},
        results: item.results || [],
        selected_urls: item.selected_urls || item.selectedUrls || [],
        content_score: item.content_score || item.score || 0,
        html: item.html || '',
        text: item.text_content || item.text || '',
        status: 'published',
        assigned_to: item.assigned_to,
        user_id: user?.id,
      };

      await axios.post(`${config.API_URL}/articles`, payload, { headers });
      toast.success('Article published successfully!');
      
      // Refresh local list immediately
      setArticles(prev => prev.map(a => 
        (a.article_key === item.article_key || a.id === item.id) ? { ...a, status: 'published' } : a
      ));
    } catch (err) {
      const msg = err.response?.data?.detail || err.message || 'Failed to publish article';
      toast.error(msg);
    }
  };

  const openKeyword = (item) => {
    navigate('/search'); // Or if there is a specific keyword viewer, navigate there.
  };

  return (
    <main className="dashboard-main">
      {/* ── Header ── */}
      <header className="dashboard-header">
        <h1 className="dashboard-title">Dashboard</h1>
        <div className="dashboard-subtitle">
          Welcome back, <strong>{user?.name || 'User'}</strong>
          {user?.id && <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>#{user.id}</span>}
          <span className="role-badge">{ROLE_LABELS[role] || role}</span>
        </div>
      </header>

      {/* ── Filter Bar ── */}
      <div className="filter-bar">
        <Filter size={16} color="#64748b" />
        <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#64748b', marginRight: '0.5rem' }}>Show:</span>
        {[
          { key: 'today', label: 'Today' },
          { key: 'week', label: 'This Week' },
          { key: 'all', label: 'All Time' },
        ].map(f => (
          <button
            key={f.key}
            className={`filter-btn ${dateFilter === f.key ? 'active' : ''}`}
            onClick={() => { setDateFilter(f.key); setDisplayCountArticles(10); setDisplayCountKeywords(10); }}
          >
            {f.label}
          </button>
        ))}

        <button
          onClick={() => fetchData()}
          className="filter-btn"
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* ── Stat Cards ── */}
      {loading ? (
        <div className="stats-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton-stat-card shimmer" />
          ))}
        </div>
      ) : !error && (
        <div className="stats-grid">
          {stats.map((s, i) => (
            <div key={i} className="stat-card" style={{ '--card-color': s.color, '--card-bg': s.bg }}>
              <div className="stat-icon-wrapper">
                {s.icon}
              </div>
              <div className="stat-value">{s.value}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Main Content ── */}
      {loading ? (
        <div className={`content-section ${role === 'admin' ? 'two-cols' : ''}`}>
          {(role === 'outliner' || role === 'admin') && (
            <div className="list-section">
              <h2 className="section-title"><Search size={20} color="var(--color-brand)" /> NLP's searched</h2>
              <SkeletonList count={5} />
            </div>
          )}
          {role !== 'outliner' && (
            <div className="list-section">
              <h2 className="section-title"><FileText size={20} color="var(--color-warning)" /> Total Articles</h2>
              <SkeletonList count={5} />
            </div>
          )}
        </div>
      ) : error ? (
        <div className="empty-state" style={{ borderColor: '#ef4444', color: '#ef4444' }}>
          <AlertCircle size={48} style={{ marginBottom: '1rem' }} />
          <h3>Failed to load data</h3>
          <p>{error}</p>
          <button onClick={() => fetchData()} className="filter-btn active" style={{ marginTop: '1rem' }}>Try Again</button>
        </div>
      ) : (
        <div className={`content-section ${role === 'admin' ? 'two-cols' : ''}`}>

          {/* Keywords Section (Outliner / Admin) */}
          {(role === 'outliner' || role === 'admin') && (
            <div className="list-section">
              <h2 className="section-title"><Search size={20} color="var(--color-brand)" /> NLP's searched</h2>
              {filteredKeywords.length === 0 ? (
                <div className="empty-state">
                  <Search size={40} opacity={0.5} style={{ marginBottom: '1rem' }} />
                  <p>No keywords found for this filter.</p>
                  {canAccessKeywordResearch(role) && (
                    <button onClick={() => navigate('/search')} className="filter-btn active" style={{ marginTop: '1rem' }}>
                      Start Keyword Research
                    </button>
                  )}
                </div>
              ) : (
                <div className="list-container keywords-list-container">
                  {filteredKeywords.slice(0, displayCountKeywords).map((item, idx) => (
                    <div key={item.id || idx} className="list-card" onClick={() => openKeyword(item)}>
                      <div className="card-icon" style={{ background: 'var(--color-brand)' }}>
                        <Search size={20} />
                      </div>
                      <div className="card-content">
                        <div className="card-title">{item.source_keyword || item.file_name}</div>
                        <div className="card-meta">
                          {item.user_id && <span><User size={12} /> ID: #{item.user_id}</span>}
                          <span><Clock size={12} /> {formatRelativeTime(item.updated_at || item.created_at)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {displayCountKeywords < filteredKeywords.length && (
                    <div ref={observerRefKeywords} className="lazy-load-sentinel">
                      <RefreshCw size={18} className="animate-spin" color="var(--color-text-muted)" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Articles Section */}
          {role !== 'outliner' && (
            <div className="list-section">
              <h2 className="section-title"><FileText size={20} color="var(--color-warning)" /> Total Articles</h2>
              {filteredArticles.length === 0 ? (
                <div className="empty-state">
                  <FileText size={40} opacity={0.5} style={{ marginBottom: '1rem' }} />
                  <p>No articles found for this filter.</p>
                </div>
              ) : (
                <div className="list-container articles-list-container">
                  {filteredArticles.slice(0, displayCountArticles).map((item, idx) => {
                    const assignedName = item.assigned_to_name || (item.assigned_to ? `User #${item.assigned_to}` : null);
                    return (
                      <div key={item.article_key || idx} className="list-card" onClick={() => openArticle(item)}>
                        <div className="card-icon" style={{ background: 'var(--color-warning)' }}>
                          <FileText size={20} />
                        </div>
                        <div className="card-content">
                          <div className="card-title">{item.title || item.keyword || 'Untitled'}</div>
                          <div className="card-meta">
                            {item.keyword && <span>🔑 {item.keyword}</span>}
                            {assignedName && <span><User size={12} /> {assignedName}</span>}
                            <span><Clock size={12} /> {formatRelativeTime(item.updated_at || item.created_at)}</span>
                          </div>
                        </div>
                        <div className="card-status">
                          <StatusBadge status={item.status} />
                        </div>
                      </div>
                    );
                  })}
                  {displayCountArticles < filteredArticles.length && (
                    <div ref={observerRefArticles} className="lazy-load-sentinel">
                      <RefreshCw size={18} className="animate-spin" color="var(--color-text-muted)" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {role === 'publisher' && (
            <div className="list-section" style={{ gridColumn: 'span 2', marginTop: '2rem' }}>
              <h2 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldCheck size={20} color="#ff5c00" />
                <span>Ready to Publish (Approved Content)</span>
              </h2>
              {filteredArticles.filter(a => a.status === 'approved').length === 0 ? (
                <div className="empty-state" style={{ padding: '30px 20px', borderRadius: '12px', border: '1px dashed var(--border-color)' }}>
                  <CheckCircle size={32} opacity={0.5} style={{ marginBottom: '0.75rem', color: 'var(--color-success)' }} />
                  <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>All approved articles have been successfully published!</p>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px', marginTop: '12px' }}>
                  {filteredArticles.filter(a => a.status === 'approved').map((item, idx) => {
                    return (
                      <div 
                        key={item.article_key || idx} 
                        style={{
                          backgroundColor: 'var(--bg-card, #ffffff)',
                          border: '1px solid var(--border-color, #e2e8f0)',
                          borderRadius: '12px',
                          padding: '16px',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          gap: '14px',
                          boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
                          transition: 'all 0.2s',
                          cursor: 'pointer',
                        }}
                        onClick={() => openArticle(item)}
                        className="ready-to-publish-card"
                      >
                        <div>
                          <div style={{ fontSize: '15px', fontWeight: '800', color: 'var(--text-primary, #1e293b)' }}>
                            {item.title || item.keyword || 'Untitled'}
                          </div>
                          {item.keyword && (
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary, #64748b)', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <span>🔑</span> {item.keyword}
                            </div>
                          )}
                          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                            Last updated: {formatRelativeTime(item.updated_at || item.created_at)}
                          </div>
                        </div>
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            publishArticle(item);
                          }}
                          style={{
                            backgroundColor: '#ff5c00',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '8px',
                            padding: '8px 16px',
                            fontSize: '13px',
                            fontWeight: '700',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                            boxShadow: '0 2px 10px rgba(255, 92, 0, 0.2)',
                            transition: 'all 0.2s',
                          }}
                        >
                          <ShieldCheck size={15} />
                          Publish Article
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>
      )}
    </main>
  );
}

export default Dashboard;
