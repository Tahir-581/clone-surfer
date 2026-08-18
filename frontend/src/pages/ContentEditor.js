import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Plus,
  Search,
  FileText,
  Calendar,
  Clock,
  CheckCircle,
  Circle,
  Tag,
  User,
  Filter,
  X,
  ArrowLeft,
  Loader,
  PenTool,
  Check,
  Square,
  CheckSquare,
  MoreVertical,
  Folder,
  Globe,
  Share2,
  Trash2
} from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { config } from '../config';
import { getStoredUser, normalizeRole, canAccessKeywordResearch, canWriteArticle, canMarkArticleStatus, canPublishReview } from '../utils/roles';
import KeywordResearchForm from '../components/KeywordResearchForm';
import '../styles/ContentEditor.css';

const SEARCH_PHASES = [
  { label: 'Extracting keywords from domains…', icon: 'extract' },
  { label: 'Exploring competitor content…', icon: 'explore' },
  { label: 'Finding relevant NLP terms…', icon: 'find' },
  { label: 'Managing entity clusters…', icon: 'manage' },
  { label: 'Merging & ranking results…', icon: 'merge' },
];



function formatRelativeTime(date) {
  if (!date) return '';
  const now = new Date();
  const diffInSeconds = Math.floor((now - new Date(date)) / 1000);

  if (diffInSeconds < 60) return 'just now';
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) return `${diffInDays}d ago`;

  return new Date(date).toLocaleDateString();
}

function normalizeKeywordGroups(keywordsJson, fallbackKeyword = '') {
  if (Array.isArray(keywordsJson)) {
    return {
      Green: [...new Set(keywordsJson.filter(Boolean))],
      Orange: [],
      White: [],
    };
  }

  if (keywordsJson && typeof keywordsJson === 'object') {
    return {
      Green: [...new Set(keywordsJson.Green || [])],
      Orange: [...new Set(keywordsJson.Orange || [])],
      White: [...new Set(keywordsJson.White || [])],
    };
  }

  return {
    Green: fallbackKeyword ? [fallbackKeyword] : [],
    Orange: [],
    White: [],
  };
}

function flattenKeywordGroups(groups) {
  return [...new Set([
    ...(groups.Green || []),
    ...(groups.Orange || []),
    ...(groups.White || []),
  ].filter(Boolean))];
}

function getArticleKey(item) {
  return item?.article_key || item?.session_id || item?.sessionId || item?.id || item?.keyword || '';
}

function renderSkeletonCards(count = 5) {
  return Array.from({ length: count }, (_, index) => (
    <div key={`content-skeleton-${index}`} className="ce-content-card ce-skeleton-card">
      <div className="ce-skeleton-score ce-skeleton-shimmer" />
      <div className="ce-skeleton-main">
        <div className="ce-skeleton-line ce-skeleton-title ce-skeleton-shimmer" />
        <div className="ce-skeleton-line ce-skeleton-subtitle ce-skeleton-shimmer" />
        <div className="ce-skeleton-actions">
          <div className="ce-skeleton-pill ce-skeleton-shimmer" />
          <div className="ce-skeleton-pill ce-skeleton-shimmer" />
          <div className="ce-skeleton-pill ce-skeleton-shimmer" />
        </div>
      </div>
      <div className="ce-skeleton-side">
        <div className="ce-skeleton-badge ce-skeleton-shimmer" />
        <div className="ce-skeleton-meta ce-skeleton-shimmer" />
      </div>
    </div>
  ));
}

function stripHtml(html = '') {
  if (!html) return '';
  if (typeof window !== 'undefined' && window.DOMParser) {
    return new window.DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  }
  return html.replace(/<[^>]*>/g, ' ');
}

function countWords(text = '') {
  return (text.match(/\b[\w'-]+\b/g) || []).length;
}

function countKeywordUsage(text, keywords) {
  const lowerText = (text || '').toLowerCase();
  return keywords.filter((keyword) => lowerText.includes(String(keyword).toLowerCase())).length;
}

function calculateContentScore(item) {
  const storedScore = item?.score ?? item?.content_score ?? item?.contentScore ?? item?.total_score ?? item?.totalScore;
  if (Number.isFinite(Number(storedScore))) {
    return Math.max(0, Math.min(100, Math.round(Number(storedScore))));
  }

  const html = item?.html || '';
  const text = item?.text_content || item?.text || stripHtml(html);
  const keywords = flattenKeywordGroups(normalizeKeywordGroups(item?.keywords_json || item?.keywords, item?.keyword));
  const results = Array.isArray(item?.results) ? item.results : [];
  const words = countWords(text);
  const headings = (html.match(/<h[1-6][^>]*>/gi) || []).length;
  const paragraphs = (html.match(/<p\b[^>]*>/gi) || []).length;
  const images = (html.match(/<img\b[^>]*>/gi) || []).length;
  const avgWords = results.length
    ? Math.round(results.reduce((sum, result) => sum + Number(result.word_count || result.words || 0), 0) / results.length) || 1200
    : 1200;
  const avgHeadings = 12;
  const avgParagraphs = 35;
  const avgImages = 4;
  const structureScore = (
    Math.min(1, words / Math.max(avgWords, 1)) * 0.4 +
    Math.min(1, headings / avgHeadings) * 0.2 +
    Math.min(1, paragraphs / avgParagraphs) * 0.2 +
    Math.min(1, images / avgImages) * 0.2
  ) * 25;
  const termsScore = keywords.length > 0 ? (countKeywordUsage(text, keywords) / keywords.length) * 45 : 0;
  const headingsText = (html.match(/<h[1-6][^>]*>.*?<\/h[1-6]>/gis) || []).map(stripHtml).join(' ');
  const headingsWithKeywords = keywords.length > 0 ? countKeywordUsage(headingsText, keywords) : 0;
  const headingsScore = Math.min(1, headingsWithKeywords / Math.max(headings, 1)) * 15;
  const mediaScore = Math.min(1, images / avgImages) * 15;

  return Math.max(0, Math.min(100, Math.round(structureScore + termsScore + headingsScore + mediaScore)));
}

function ContentEditor() {
  const navigate = useNavigate();
  const location = useLocation();

  const userObj = getStoredUser();
  const userRole = userObj?.role || 'content_writer';
  const userId = userObj?.id;
  const authHeaders = userObj?.token ? { Authorization: `Bearer ${userObj.token}` } : {};

  // State
  const [contentItems, setContentItems] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterSort, setFilterSort] = useState('recent'); // 'recent' | 'lastEdit'
  const [filterStatus, setFilterStatus] = useState('all');  // 'all' | 'done' | 'not_done'
  const [filterTag, setFilterTag] = useState('');
  const [filterAuthor, setFilterAuthor] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState(null);
  const [users, setUsers] = useState([]);
  const [showTagModal, setShowTagModal] = useState(null);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await axios.get(`${config.API_URL}/users`, {
          headers: authHeaders
        });
        setUsers(response.data.items || []);
      } catch (e) {
        console.error("Failed to fetch users");
      }
    };
    fetchUsers();
  }, []);

  // Fetch articles from DB
  const fetchArticles = async (signal) => {
    try {
      setFetching(true);
      setFetchError('');
      const response = await axios.get(`${config.API_URL}/articles`, {
        signal,
        timeout: 15000,
        headers: authHeaders,
      });
      setContentItems(response.data.items || []);
    } catch (error) {
      if (axios.isCancel?.(error) || error.name === 'CanceledError') return;
      console.error('Error fetching articles:', error);
      const message = error.response?.data?.detail || error.message || 'Failed to load articles from database';
      setFetchError(message);
      if (error.response?.status !== 401) toast.error(message);
    } finally {
      if (!signal?.aborted) setFetching(false);
    }
  };

  const handleAssignWriter = async (article, writerId) => {
    try {
      const payload = {
        article_key: article.article_key,
        session_id: article.session_id || "",
        title: article.title || "Untitled",
        keyword: article.keyword || "",
        keywords: article.keywords_json || [],
        results: article.results || [],
        selected_urls: article.selected_urls || [],
        content_score: article.content_score || 0,
        html: article.html || "",
        text: article.text_content || "",
        status: article.status || "drafting",
        assigned_to: writerId ? parseInt(writerId, 10) : null,
      };
      await axios.post(`${config.API_URL}/articles`, payload, {
        headers: authHeaders
      });
      toast.success(writerId ? 'Writer tagged successfully!' : 'Tag removed successfully!');
      fetchArticles(); // refresh list
      setShowTagModal(null);
    } catch (err) {
      console.error('Failed to update writer tag:', err);
      toast.error('Failed to update writer tag');
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchArticles(controller.signal);
    return () => controller.abort();
  }, []);

  // Create new content – keyword research flow
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [searchTime, setSearchTime] = useState(0);
  const [activeResearch, setActiveResearch] = useState(null);
  const [animPhase, setAnimPhase] = useState(0);
  const [selectedDomains, setSelectedDomains] = useState([]);
  const [selectedKeywords, setSelectedKeywords] = useState([]);
  const [formData, setFormData] = useState({
    keyword: '',
    k: 10,
    device: 'desktop',
    use_proxy: true,
    use_browser: true,
  });



  // Elapsed timer + animation phase cycle
  useEffect(() => {
    let interval, phaseInterval;
    if (loading) {
      interval = setInterval(() => setElapsed((p) => p + 1), 1000);
      phaseInterval = setInterval(() => setAnimPhase((p) => (p + 1) % SEARCH_PHASES.length), 2800);
    } else {
      setAnimPhase(0);
    }
    return () => { clearInterval(interval); clearInterval(phaseInterval); };
  }, [loading]);

  // Derive unique tags & authors
  const allTags = useMemo(() => {
    const set = new Set();
    contentItems.forEach((c) => (c.tags || []).forEach((t) => set.add(t)));
    return [...set];
  }, [contentItems]);

  const allAuthors = useMemo(() => {
    const set = new Set();
    contentItems.forEach((c) => c.author && set.add(c.author));
    return [...set];
  }, [contentItems]);

  const filteredContent = useMemo(() => {
    let items = [...contentItems];

    // ── Role-based visibility ───────────────────────────────────────────────
    if (userRole === 'content_writer') {
      // Content writer: ONLY articles assigned to them or created by them
      items = items.filter(a =>
        String(a.assigned_to) === String(userId) ||
        String(a.user_id) === String(userId) ||
        String(a.created_by) === String(userId)
      );
    } else if (userRole === 'content_editor' || userRole === 'compliance_manager') {
      // Content editor & compliance manager: complete access - view all articles written by anyone
      // No status-based filtering!
    } else if (userRole === 'publisher') {
      // Publisher: approved or published only
      items = items.filter(a =>
        a.status === 'approved' || a.status === 'published'
      );
    } else if (userRole === 'outliner') {
      // Outliner: articles they outlined or created
      items = items.filter(a =>
        String(a.user_id) === String(userId) ||
        String(a.created_by) === String(userId) ||
        a.status === 'outline'
      );
    }
    // admin sees all

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (c) =>
          (c.title || '').toLowerCase().includes(q) ||
          (c.keyword || '').toLowerCase().includes(q) ||
          (c.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }

    // Status filter
    if (filterStatus === 'done') items = items.filter((c) => c.status === 'published' || c.status === 'approved');
    if (filterStatus === 'not_done') items = items.filter((c) => c.status !== 'published' && c.status !== 'approved');

    // Tag filter
    if (filterTag) items = items.filter((c) => (c.tags || []).includes(filterTag));

    // Author filter
    if (filterAuthor) items = items.filter((c) => c.author === filterAuthor);

    // Sort
    items.sort((a, b) => {
      if (filterSort === 'lastEdit') {
        return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return items;
  }, [contentItems, searchQuery, filterSort, filterStatus, filterTag, filterAuthor, userRole, userId]);

  const hasResults = activeResearch?.results?.length > 0;

  // Handlers
  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : type === 'number' ? Number(value) : value,
    }));
  };

  const handleCreateNew = () => {
    navigate('/search', { state: { from: 'content-editor' } });
  };

  const handleCancelCreate = () => {
    setShowCreatePanel(false);
    setActiveResearch(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const keyword = formData.keyword.trim();
    if (!keyword) {
      toast.error('Please enter a keyword');
      return;
    }

    setLoading(true);
    setElapsed(0);
    setSearchTime(0);
    setAnimPhase(0);
    setSelectedDomains([]);
    setSelectedKeywords([]);
    setActiveResearch({
      id: `pending-${Date.now()}`,
      keyword,
      results: [],
    });

    const startedAt = Date.now();

    try {
      const apiUrl = config.API_URL;
      if (!apiUrl || !apiUrl.startsWith('http')) {
        throw new Error(`Invalid API URL: ${apiUrl}`);
      }

      const response = await axios.post(`${apiUrl}${config.SEARCH_ENDPOINT}`, {
        keyword,
        k: formData.k,
        device: formData.device,
        use_proxy: formData.use_proxy,
        headless: !formData.use_browser,
        use_browser: formData.use_browser,
      });

      const nextSearchTime = (Date.now() - startedAt) / 1000;
      const researchData = {
        id: response.data.session_id || `content-${Date.now()}`,
        keyword,
        results: response.data.results || [],
        sessionId: response.data.session_id,
        timing: response.data.timing || {},
        searchTime: nextSearchTime,
      };

      setSearchTime(nextSearchTime);
      setActiveResearch(researchData);
      toast.success('Keyword research completed');
    } catch (error) {
      console.error('Content keyword research error:', error);
      const message =
        error.response?.data?.detail ||
        (error.request
          ? `Cannot reach backend at ${config.API_URL}. Make sure backend is running.`
          : error.message) ||
        'Keyword research failed';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveContent = () => {
    if (!activeResearch) return;
    const newItem = {
      id: activeResearch.id || `content-${Date.now()}`,
      title: activeResearch.keyword,
      keyword: activeResearch.keyword,
      status: 'not_done',
      tags: [],
      author: '',
      results: activeResearch.results,
      sessionId: activeResearch.sessionId,
      searchTime: activeResearch.searchTime || searchTime,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setContentItems((prev) => [newItem, ...prev]);
    setShowCreatePanel(false);
    setActiveResearch(null);
    toast.success('Content saved successfully');
  };

  const handleOpenResults = (item) => {
    // Navigate to results page with filters in URL
    const params = new URLSearchParams();
    params.set('keyword', item.keyword);
    params.set('sessionId', item.session_id || item.sessionId || '');
    params.set('articleKey', getArticleKey(item));
    params.set('from', 'content-editor');
    navigate(`/results?${params.toString()}`, {
      state: {
        results: item.results,
        sessionId: item.session_id || item.sessionId,
        keyword: item.keyword,
        articleKey: getArticleKey(item),
        keywordOutput: normalizeKeywordGroups(item.keywords_json, item.keyword),
        searchTime: Number(item.searchTime || 0),
      },
    });
  };

  const handleOpenArticle = useCallback((item) => {
    const articleKey = getArticleKey(item);
    const keyword = item.keyword || item.title || '';
    const keywordGroups = normalizeKeywordGroups(item.keywords_json, keyword);
    const keywords = flattenKeywordGroups(keywordGroups);
    const params = new URLSearchParams();

    if (keyword) params.set('keyword', keyword);
    if (articleKey) params.set('articleKey', articleKey);

    navigate(`/article-writer?${params.toString()}`, {
      state: {
        keyword,
        keywords,
        selectedKeywords: keywordGroups,
        jsonOutput: keywordGroups,
        results: item.results || [],
        selectedUrls: item.selected_urls || item.selectedUrls || [],
        sessionId: item.session_id || item.sessionId || '',
        articleKey,
      },
    });
  }, [navigate]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const sharedArticleKey = params.get('openArticleKey');
    if (!sharedArticleKey) return undefined;

    let cancelled = false;
    const existingItem = contentItems.find((item) => getArticleKey(item) === sharedArticleKey);
    if (existingItem) {
      handleOpenArticle(existingItem);
      return undefined;
    }

    const loadSharedArticle = async () => {
      try {
        const response = await axios.get(`${config.API_URL}/articles/${encodeURIComponent(sharedArticleKey)}`);
        if (!cancelled) handleOpenArticle(response.data || {});
      } catch (error) {
        console.error('Error opening shared article:', error);
        toast.error('Could not open shared article');
      }
    };

    loadSharedArticle();
    return () => {
      cancelled = true;
    };
  }, [contentItems, handleOpenArticle, location.search]);

  const handleToggleStatus = (id) => {
    setContentItems((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, status: c.status === 'done' ? 'not_done' : 'done', updatedAt: new Date().toISOString() }
          : c
      )
    );
  };

  const handleShareLink = (item) => {
    const key = getArticleKey(item);
    const baseUrl = window.location.origin;
    const shareUrl = `${baseUrl}/content-editor?openArticleKey=${encodeURIComponent(key)}`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl)
        .then(() => toast.success('Shareable link copied to clipboard'))
        .catch(() => toast.error('Failed to copy link'));
    } else {
      // Fallback
      const textArea = document.createElement("textarea");
      textArea.value = shareUrl;
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        toast.success('Shareable link copied to clipboard');
      } catch (err) {
        toast.error('Failed to copy link');
      }
      document.body.removeChild(textArea);
    }
    setActiveMenuId(null);
  };

  const handleDeleteContent = async (id) => {
    // Only admin can delete
    if (userRole !== 'admin') {
      toast.warn('Only admins can delete articles.');
      return;
    }
    const item = contentItems.find(c => c.id === id || c.article_key === id);
    const key = item?.article_key || item?.id;

    if (!window.confirm('Are you sure you want to delete this content?')) return;

    try {
      await axios.delete(`${config.API_URL}/articles/${key}`, { headers: authHeaders });
      setContentItems((prev) => prev.filter((c) => (c.id !== id && c.article_key !== id)));
      toast.info('Content removed successfully');
      setActiveMenuId(null);
    } catch (error) {
      console.error('Error deleting article:', error);
      toast.error('Failed to delete article');
    }
  };

  const clearFilters = () => {
    setSearchQuery('');
    setFilterSort('recent');
    setFilterStatus('all');
    setFilterTag('');
    setFilterAuthor('');
  };

  const hasActiveFilters = filterStatus !== 'all' || filterTag || filterAuthor;

  return (
    <main className="ce-page">
      <section className="ce-shell">
        {/* Top Bar */}
        <div className="ce-topbar">
          <h1>Content Editor</h1>
          <div className="ce-topbar-actions">
            {(userRole === 'outliner' || userRole === 'admin') && (
              <button type="button" className="ce-create-btn" onClick={handleCreateNew}>
                <Plus size={16} />
                Create New Content
              </button>
            )}
          </div>
        </div>

        {/* Main Layout */}
        <div className={`ce-layout ${showCreatePanel ? 'ce-layout-with-panel' : ''}`}>
          {/* Left: Content List */}
          <div className="ce-list-area">
            {/* Search Bar */}
            <div className="ce-search-bar">
              <div className="ce-search-input-wrap">
                <Search size={16} />
                <input
                  type="text"
                  placeholder="Search content by title, keyword or tag..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="ce-search-clear" onClick={() => setSearchQuery('')}>
                    <X size={14} />
                  </button>
                )}
              </div>
              <button
                className={`ce-filter-toggle ${showFilters ? 'active' : ''}`}
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter size={16} />
                Filters
                {hasActiveFilters && <span className="filter-badge" />}
              </button>
            </div>

            {/* Filters Panel */}
            {showFilters && (
              <div className="ce-filters-panel">
                <div className="ce-filter-group">
                  <label>Sort by</label>
                  <div className="ce-filter-pills">
                    <button
                      className={`ce-pill ${filterSort === 'recent' ? 'active' : ''}`}
                      onClick={() => setFilterSort('recent')}
                    >
                      <Calendar size={14} /> Recently Created
                    </button>
                    <button
                      className={`ce-pill ${filterSort === 'lastEdit' ? 'active' : ''}`}
                      onClick={() => setFilterSort('lastEdit')}
                    >
                      <Clock size={14} /> Last Edited
                    </button>
                  </div>
                </div>

                <div className="ce-filter-group">
                  <label>Status</label>
                  <div className="ce-filter-pills">
                    <button
                      className={`ce-pill ${filterStatus === 'all' ? 'active' : ''}`}
                      onClick={() => setFilterStatus('all')}
                    >
                      All
                    </button>
                    <button
                      className={`ce-pill ${filterStatus === 'done' ? 'active' : ''}`}
                      onClick={() => setFilterStatus('done')}
                    >
                      <CheckCircle size={14} /> Done
                    </button>
                    <button
                      className={`ce-pill ${filterStatus === 'not_done' ? 'active' : ''}`}
                      onClick={() => setFilterStatus('not_done')}
                    >
                      <Circle size={14} /> Not Done
                    </button>
                  </div>
                </div>

                {allTags.length > 0 && (
                  <div className="ce-filter-group">
                    <label><Tag size={14} /> Tags</label>
                    <div className="ce-filter-pills">
                      <button
                        className={`ce-pill ${filterTag === '' ? 'active' : ''}`}
                        onClick={() => setFilterTag('')}
                      >
                        All Tags
                      </button>
                      {allTags.map((tag) => (
                        <button
                          key={tag}
                          className={`ce-pill ${filterTag === tag ? 'active' : ''}`}
                          onClick={() => setFilterTag(tag)}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {allAuthors.length > 0 && (
                  <div className="ce-filter-group">
                    <label><User size={14} /> Author</label>
                    <div className="ce-filter-pills">
                      <button
                        className={`ce-pill ${filterAuthor === '' ? 'active' : ''}`}
                        onClick={() => setFilterAuthor('')}
                      >
                        All Authors
                      </button>
                      {allAuthors.map((author) => (
                        <button
                          key={author}
                          className={`ce-pill ${filterAuthor === author ? 'active' : ''}`}
                          onClick={() => setFilterAuthor(author)}
                        >
                          {author}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {hasActiveFilters && (
                  <button className="ce-clear-filters" onClick={clearFilters}>
                    <X size={14} /> Clear all filters
                  </button>
                )}
              </div>
            )}

            {/* Content List */}
            <div className="ce-content-list">
              {fetching ? (
                renderSkeletonCards()
              ) : fetchError ? (
                <div className="ce-empty-state ce-error-state">
                  <div className="ce-empty-icon">
                    <FileText size={48} />
                  </div>
                  <h3>Could not load content</h3>
                  <p>{fetchError}</p>
                  <button type="button" className="ce-create-btn" onClick={() => fetchArticles()}>
                    Try Again
                  </button>
                </div>
              ) : filteredContent.length === 0 ? (
                <div className="ce-empty-state">
                  <div className="ce-empty-icon">
                    <FileText size={48} />
                  </div>
                  <h3>No content yet</h3>
                  <p>Create your first content by clicking the button above or on the right panel.</p>
                  {(userRole === 'outliner' || userRole === 'admin') && (
                    <button type="button" className="ce-create-btn" onClick={handleCreateNew}>
                      <Plus size={16} />
                      Create New Content
                    </button>
                  )}
                </div>
              ) : (
                filteredContent.map((item) => {
                  const score = calculateContentScore(item);
                  const scoreColor = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444';
                  const itemKey = getArticleKey(item);
                  const isMenuOpen = activeMenuId === itemKey;

                  return (
                    <div
                      key={itemKey}
                      className="ce-content-card"
                      style={{ zIndex: isMenuOpen ? 1001 : (activeMenuId ? 1 : 'auto') }}
                    >
                      {/* Score Circle */}
                      <div className="ce-card-score-section">
                        <div className="ce-card-score-circle">
                          <svg viewBox="0 0 36 36" className="ce-score-svg">
                            <path
                              className="ce-score-bg"
                              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                            />
                            <path
                              className="ce-score-fill"
                              stroke={score > 0 ? scoreColor : '#e2e8f0'}
                              strokeDasharray={`${score}, 100`}
                              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                            />
                          </svg>
                          <span className="ce-score-text">{score}</span>
                        </div>
                      </div>

                      {/* Main Info */}
                      <div className="ce-card-main" onClick={() => handleOpenArticle(item)}>
                        <h3 className="ce-card-title">{item.title || 'Untitled'}</h3>
                        <p className="ce-card-tagline">
                          {item.keyword}
                          {item.status && <span style={{marginLeft: '10px', fontSize: '11px', textTransform: 'uppercase', background: '#e2e8f0', padding: '2px 6px', borderRadius: '4px'}}>{item.status}</span>}
                          {(item.assigned_to_name || item.created_by_name) && (
                            <span style={{marginLeft: '10px', fontSize: '11px', color: '#3b82f6'}}>
                              Assigned to: {item.assigned_to_name || item.created_by_name}
                            </span>
                          )}
                        </p>

                        <div className="ce-card-bottom-actions">
                          <button className="ce-action-btn" onClick={(e) => { e.stopPropagation(); setShowTagModal(item); }}>
                            <Plus size={14} /> Tag
                          </button>
                          <button className="ce-action-btn" onClick={(e) => { e.stopPropagation(); handleShareLink(item); }}>
                            <Share2 size={14} /> Share link
                          </button>
                        </div>
                      </div>

                      {/* Right Side Stats & Actions */}
                      <div className="ce-card-right">
                        <div className="ce-card-top-row">
                          <div className="ce-card-badges">
                            <div className="ce-badge-icon check">
                              <CheckCircle size={14} />
                            </div>
                            <div 
                              className="ce-author-avatar" 
                              title={`Name: ${item.assigned_to_name || item.created_by_name || 'Unassigned'}\nEmail: ${item.assigned_to_email || 'N/A'}\nRole: ${item.assigned_to_role || 'writer'}`}
                              style={{ cursor: 'help' }}
                            >
                              {(item.assigned_to_name || item.created_by_name || 'A').charAt(0).toUpperCase()}
                            </div>
                          </div>

                          <div className="ce-menu-wrap">
                            <button
                              className="ce-more-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveMenuId(isMenuOpen ? null : itemKey);
                              }}
                            >
                              <MoreVertical size={18} />
                            </button>

                            {isMenuOpen && (
                              <div className="ce-card-menu">
                                <button onClick={(e) => { e.stopPropagation(); handleShareLink(item); }}><Share2 size={14} /> Shareable link</button>
                                <button onClick={(e) => { e.stopPropagation(); setShowTagModal(item); }}><Tag size={14} /> Add tags</button>
                                <button className="delete" onClick={(e) => { e.stopPropagation(); handleDeleteContent(itemKey); }}><Trash2 size={14} /> Delete</button>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="ce-card-metadata">
                          <div className="ce-meta-item">
                            <Globe size={12} />
                            <span></span>
                          </div>
                          <div className="ce-meta-item time">
                            {formatRelativeTime(item.createdAt || Date.now())}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Create Panel */}
          {showCreatePanel && (
            <aside className="ce-create-panel">
              <div className="ce-panel-header">
                <button className="ce-back-btn" onClick={handleCancelCreate}>
                  <ArrowLeft size={18} />
                </button>
                <div>
                  <h2>Create New Content</h2>
                  <p>Search for a keyword to start building content.</p>
                </div>
              </div>

              <div className="ce-panel-body">
                {/* Keyword Form */}
                <section className="ce-form-card">
                  <KeywordResearchForm
                    formData={formData}
                    loading={loading}
                    onChange={handleInputChange}
                    onSubmit={handleSubmit}
                  />
                </section>

                {/* Search Animation with Phases */}
                {loading && (
                  <section className="ce-searching-card">
                    <div className="ce-searching-animation">
                      <div className="ce-pulse-ring" />
                      <div className="ce-pulse-ring ce-ring-2" />
                      <div className="ce-pulse-ring ce-ring-3" />
                      <Loader size={28} className="ce-spin-icon" />
                    </div>
                    <h3>Searching for "{activeResearch?.keyword || formData.keyword}"</h3>

                    {/* Animated Phase Steps */}
                    <div className="ce-phase-list">
                      {SEARCH_PHASES.map((phase, i) => (
                        <div
                          key={i}
                          className={`ce-phase-item ${i < animPhase ? 'done' : ''} ${i === animPhase ? 'active' : ''} ${i > animPhase ? 'pending' : ''}`}
                        >
                          <span className="ce-phase-dot">
                            {i < animPhase ? <Check size={12} /> : i === animPhase ? <Loader size={12} className="ce-spin-icon-sm" /> : <Circle size={12} />}
                          </span>
                          <span>{phase.label}</span>
                        </div>
                      ))}
                    </div>

                    {/* Scrolling domain names */}

                    <p className="ce-search-elapsed">{elapsed}s elapsed</p>
                    <div className="ce-progress-track">
                      <div className="ce-progress-bar" />
                    </div>
                  </section>
                )}

                {/* Results Preview with Domain & Keyword Selection */}
                {!loading && hasResults && (
                  <section className="ce-results-preview">
                    <div className="ce-results-header">
                      <h3>
                        <CheckCircle size={18} /> Found {activeResearch.results.length} Results
                      </h3>
                      {searchTime > 0 && (
                        <span className="ce-search-time">{searchTime.toFixed(2)}s</span>
                      )}
                    </div>

                    {/* Domain Selection */}
                    <div className="ce-section-label">Select Domains</div>
                    <div className="ce-results-list">
                      {activeResearch.results.map((r, idx) => {
                        const isSelected = selectedDomains.includes(r.domain);
                        return (
                          <div
                            key={idx}
                            className={`ce-result-item ce-selectable ${isSelected ? 'selected' : ''}`}
                            onClick={() => setSelectedDomains(prev => isSelected ? prev.filter(d => d !== r.domain) : [...prev, r.domain])}
                          >
                            <span className="ce-select-check">
                              {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                            </span>
                            <span className="ce-result-rank">{r.rank || idx + 1}</span>
                            <div className="ce-result-info">
                              <div className="ce-result-domain">{r.domain}</div>
                              <div className="ce-result-title">{r.title || 'N/A'}</div>
                            </div>
                            <span className="ce-result-words">{r.word_count} words</span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Keyword Selection (from domains) */}
                    {selectedDomains.length > 0 && (
                      <>
                        <div className="ce-section-label">Select Keywords <span className="ce-section-count">{selectedKeywords.length} selected</span></div>
                        <div className="ce-keyword-grid">
                          {/* Generate keyword suggestions from domain titles */}
                          {(() => {
                            const kws = new Set();
                            kws.add(activeResearch.keyword);
                            activeResearch.results
                              .filter(r => selectedDomains.includes(r.domain))
                              .forEach(r => {
                                if (r.title) {
                                  r.title.split(/[\s\-–|:,]+/).filter(w => w.length > 3).forEach(w => kws.add(w.toLowerCase()));
                                }
                              });
                            return [...kws].slice(0, 24).map((kw, i) => {
                              const isSel = selectedKeywords.includes(kw);
                              return (
                                <button
                                  key={i}
                                  className={`ce-kw-chip ${isSel ? 'selected' : ''}`}
                                  onClick={() => setSelectedKeywords(prev => isSel ? prev.filter(k => k !== kw) : [...prev, kw])}
                                >
                                  {isSel ? <Check size={12} /> : <Plus size={12} />}
                                  {kw}
                                </button>
                              );
                            });
                          })()}
                        </div>
                      </>
                    )}

                    {/* Actions */}
                    <div className="ce-results-actions">
                      <button className="ce-save-btn" onClick={handleSaveContent}>
                        <Plus size={16} /> Save Content
                      </button>
                      <button
                        className="ce-article-btn"
                        onClick={() => {
                          handleSaveContent();
                          navigate('/article-writer', {
                            state: {
                              keyword: activeResearch.keyword,
                              keywords: selectedKeywords.length > 0 ? selectedKeywords : [activeResearch.keyword],
                              results: activeResearch.results,
                              sessionId: activeResearch.sessionId,
                            },
                          });
                        }}
                      >
                        <PenTool size={16} /> Article Write
                      </button>
                    </div>
                  </section>
                )}

                {/* Empty state for panel */}
                {!loading && !hasResults && !showCreatePanel && (
                  <div className="ce-panel-empty">
                    <FileText size={40} />
                    <p>Enter a keyword above and search to begin.</p>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
      {showTagModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(15, 23, 42, 0.65)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          padding: '20px',
        }} onClick={() => setShowTagModal(null)}>
          <div style={{
            backgroundColor: 'var(--bg-card, #ffffff)',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '480px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 10px 10px -5px rgba(0, 0, 0, 0.08)',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            border: '1px solid var(--border-color, #e2e8f0)',
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '18px', fontWeight: '800', color: 'var(--text-primary, #0f172a)', margin: 0 }}>
                Tag Content Writer
              </h3>
              <button 
                onClick={() => setShowTagModal(null)}
                style={{
                  border: 'none',
                  background: 'none',
                  fontSize: '20px',
                  color: 'var(--text-secondary, #64748b)',
                  cursor: 'pointer',
                  padding: '4px',
                }}
              >
                &times;
              </button>
            </div>

            <div style={{ fontSize: '14px', color: 'var(--text-secondary, #64748b)', lineHeight: '1.5' }}>
              Assign a writer to draft and manage the article <strong>{showTagModal.title || 'Untitled'}</strong>.
            </div>

            {/* Current Active Assignment */}
            {showTagModal.assigned_to && (
              <div style={{
                backgroundColor: 'rgba(148, 163, 184, 0.05)',
                border: '1px dashed var(--border-color, #cbd5e1)',
                borderRadius: '12px',
                padding: '14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <div>
                  <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-secondary, #64748b)', fontWeight: 'bold', letterSpacing: '0.05em' }}>Active Assignment</div>
                  <div style={{ fontSize: '14px', fontWeight: '800', color: 'var(--text-primary, #0f172a)', marginTop: '4px' }}>
                    {showTagModal.assigned_to_name || `User ID: ${showTagModal.assigned_to}`}
                  </div>
                  {showTagModal.assigned_to_email && (
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary, #64748b)', marginTop: '2px' }}>{showTagModal.assigned_to_email}</div>
                  )}
                </div>
                <button 
                  onClick={() => handleAssignWriter(showTagModal, null)}
                  style={{
                    backgroundColor: '#fee2e2',
                    color: '#ef4444',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'all 0.2s',
                  }}
                >
                  <Trash2 size={14} /> Remove Tag
                </button>
              </div>
            )}

            {/* List of Writers */}
            <div>
              <div style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary, #475569)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Select a Content Writer
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto', paddingRight: '4px' }}>
                {users.filter(u => u.role === 'content_writer').length === 0 ? (
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary, #94a3b8)', textAlign: 'center', padding: '20px 0' }}>
                    No content writers registered in the system.
                  </div>
                ) : (
                  users.filter(u => u.role === 'content_writer').map(u => {
                    const isAssigned = String(showTagModal.assigned_to) === String(u.id);
                    return (
                      <div 
                        key={u.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 14px',
                          border: isAssigned ? '2px solid var(--color-brand, #ff5c00)' : '1px solid var(--border-color, #e2e8f0)',
                          backgroundColor: isAssigned ? 'rgba(255, 92, 0, 0.08)' : 'transparent',
                          borderRadius: '10px',
                        }}
                      >
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary, #0f172a)' }}>{u.name}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary, #64748b)' }}>{u.email}</div>
                        </div>
                        <button
                          disabled={isAssigned}
                          onClick={() => handleAssignWriter(showTagModal, u.id)}
                          style={{
                            backgroundColor: isAssigned ? 'rgba(255, 92, 0, 0.35)' : 'var(--color-brand, #ff5c00)',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '8px',
                            padding: '6px 12px',
                            fontSize: '12px',
                            fontWeight: '700',
                            cursor: isAssigned ? 'default' : 'pointer',
                            boxShadow: isAssigned ? 'none' : '0 2px 8px rgba(255, 92, 0, 0.2)',
                            transition: 'all 0.2s',
                          }}
                        >
                          {isAssigned ? 'Tagged' : 'Tag'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <button 
              onClick={() => setShowTagModal(null)}
              style={{
                backgroundColor: 'var(--border-color, #f1f5f9)',
                color: 'var(--text-primary, #475569)',
                border: 'none',
                borderRadius: '10px',
                padding: '10px',
                fontSize: '14px',
                fontWeight: '700',
                cursor: 'pointer',
                textAlign: 'center',
                marginTop: '10px',
                transition: 'all 0.2s',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

export default ContentEditor;
