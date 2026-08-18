import React, { useEffect, useMemo, useState, useContext } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { ArrowRight, Calendar, CheckCircle, Clock, Database, Loader, RefreshCw, Search, Trash2 } from 'lucide-react';
import { config } from '../config';
import { getStoredUser, getStoredUserRole, isOutliner } from '../utils/roles';
import { SearchContext } from '../context/SearchContext';

function getKeywordCount(payload = {}) {
  return ['Green', 'Orange', 'White'].reduce((sum, group) => sum + (payload[group] || []).length, 0);
}

function SearchPage({ onSearchComplete }) {
  const navigate = useNavigate();
  const userObj = getStoredUser();
  const userRole = getStoredUserRole();
  const canSearch = isOutliner(userRole);
  const authHeaders = userObj?.token ? { Authorization: `Bearer ${userObj.token}` } : {};
  const {
    loading, elapsed, stepIndex, activeQuery, currentProgress, SEARCH_STEPS, SEARCH_PROGRESS_SVG, progressLogs,
    keyword, setKeyword, isBatchMode, setIsBatchMode,
    device, setDevice, useProxy, setUseProxy,
    executeSearch
  } = useContext(SearchContext);

  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeHistory, setActiveHistory] = useState(null);
  const [deletingHistoryId, setDeletingHistoryId] = useState(null);
  const [sparkles, setSparkles] = useState({});

  // Pagination & Filtering States
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [filterType, setFilterType] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [pastKeyword, setPastKeyword] = useState('');
  const [debouncedPastKeyword, setDebouncedPastKeyword] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedPastKeyword(pastKeyword.trim().toLowerCase());
    }, 300);

    return () => window.clearTimeout(timer);
  }, [pastKeyword]);

  // Trigger sparkle animation on new logs
  useEffect(() => {
    if (progressLogs.length > 0) {
      const lastLogIdx = progressLogs.length - 1;
      if (!sparkles[lastLogIdx]) {
        setSparkles((prev) => ({ ...prev, [lastLogIdx]: true }));
        setTimeout(() => {
          setSparkles((prev) => {
            const next = { ...prev };
            delete next[lastLogIdx];
            return next;
          });
        }, 800);
      }
    }
  }, [progressLogs.length, sparkles]);

  const loadHistory = async (pageToFetch = 1, append = false) => {
    setHistoryLoading(true);
    try {
      const shouldSearchPastKeyword = debouncedPastKeyword.length > 0;
      const params = {
        page: pageToFetch,
        limit: shouldSearchPastKeyword ? 1000 : 10,
      };
      if (filterType !== 'all') {
        params.filter_type = filterType;
        if (filterType === 'range') {
          if (startDate) params.start_date = startDate;
          if (endDate) params.end_date = endDate;
        }
      }

      const response = await axios.get(`${config.API_URL}${config.NLP_KEYWORDS_ENDPOINT}`, {
        headers: authHeaders,
        params,
      });

      const rawItems = response.data?.items || [];
      const items = shouldSearchPastKeyword
        ? rawItems.filter((item) =>
          (item.source_keyword || '').toLowerCase().includes(debouncedPastKeyword)
        )
        : rawItems;
      const hasMoreItems = shouldSearchPastKeyword ? false : (response.data?.has_more || false);

      setHistory((prev) => {
        const next = append ? [...prev, ...items] : items;
        setActiveHistory((current) => {
          if (!current) return next[0] || null;
          return next.find((item) => item.id === current.id) || next[0] || null;
        });
        return next;
      });

      setHasMore(hasMoreItems);
      setPage(pageToFetch);
    } catch (error) {
      const message = error.response?.data?.detail || 'Could not load saved keyword history';
      if (error.response?.status !== 401) toast.error(message);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadHistory(1, false);
  }, [filterType, startDate, endDate, debouncedPastKeyword]);

  const handleScroll = (event) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 20) {
      if (hasMore && !historyLoading) {
        loadHistory(page + 1, true);
      }
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const activeOutput = useMemo(() => activeHistory?.keywords_json || {}, [activeHistory]);
  const activeCounts = useMemo(() => ({
    Green: (activeOutput.Green || []).length,
    Orange: (activeOutput.Orange || []).length,
    White: (activeOutput.White || []).length,
  }), [activeOutput]);

  const openSavedKeywordResult = (item = activeHistory) => {
    if (!item) return;
    navigate('/results', {
      state: {
        keyword: item.source_keyword,
        keywordOutput: item.keywords_json || {},
        savedKeywordId: item.id,
        fileName: item.file_name,
        results: item.results || [],
        selectedUrls: item.selected_urls || [],
      }
    });
  };

  const handleDeleteHistory = async (event, item) => {
    event.stopPropagation();
    if (!item?.id || deletingHistoryId) return;
    const confirmed = window.confirm(`Delete "${item.source_keyword}" from saved keyword history?`);
    if (!confirmed) return;

    setDeletingHistoryId(item.id);
    try {
      await axios.delete(
        `${config.API_URL}${config.NLP_KEYWORDS_ENDPOINT}/${encodeURIComponent(item.id)}`,
        { headers: authHeaders },
      );
      setHistory((current) => {
        const next = current.filter((historyItem) => historyItem.id !== item.id);
        setActiveHistory((active) => {
          if (active?.id !== item.id) return active;
          return next[0] || null;
        });
        return next;
      });
      toast.success('Keyword history deleted');
    } catch (error) {
      const message = error.response?.data?.detail || error.message || 'Could not delete keyword history';
      toast.error(message);
    } finally {
      setDeletingHistoryId(null);
    }
  };

  const handleSearch = async (event) => {
    event.preventDefault();
    if (!canSearch) {
      toast.error('You do not have permission to search new keywords. Please use existing keywords from history.');
      return;
    }
    const query = keyword.trim();
    if (!query) {
      toast.error('Please enter a keyword');
      return;
    }

    executeSearch({
      query,
      isBatch: isBatchMode,
      currentDevice: device,
      currentUseProxy: useProxy,
      onSearchComplete,
      reloadHistory: loadHistory
    });
  };

  return (
    <main className="search-workspace">
      <section className="search-main-panel">
        <div className={`search-focus-card ${loading ? 'search-focus-card-active' : ''}`}>
          <div className="search-focus-icon">
            {loading ? <Loader size={24} className="spin-icon" /> : <Search size={24} />}
          </div>
          <div className="search-focus-copy">
            <h1>Keyword Search</h1>
            <p>Generate NLP keyword groups,then select terms for the article.</p>
          </div>

          <div className="search-focus-header-actions" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
            <label className="search-focus-select" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', cursor: 'pointer', padding: '0.5rem 1.2rem', borderRadius: '20px', background: 'var(--bg-light)', border: '1px solid var(--border-color)', boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
              <input
                type="checkbox"
                checked={isBatchMode}
                onChange={(e) => setIsBatchMode(e.target.checked)}
                disabled={loading || !canSearch}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>Batch Mode</span>
            </label>
          </div>
          <form onSubmit={handleSearch} className="search-focus-form">
            <div className="search-focus-input" style={isBatchMode ? { alignItems: 'flex-start' } : {}}>
              <Search size={18} style={isBatchMode ? { marginTop: '12px' } : {}} />
              {isBatchMode ? (
                <textarea
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder={canSearch ? "Enter multiple keywords (one per line)" : "Search is restricted to Outliners"}
                  disabled={loading || !canSearch}
                  style={{ width: '100%', minHeight: '100px', border: 'none', background: 'transparent', resize: 'vertical', outline: 'none', padding: '10px 0' }}
                />
              ) : (
                <input
                  type="text"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder={canSearch ? "Enter keyword or article topic" : "Search is restricted to Outliners"}
                  disabled={loading || !canSearch}
                />
              )}
            </div>
            <div className="search-focus-controls">
              <label className="search-focus-select">
                <span>Device</span>
                <select
                  value={device}
                  onChange={(event) => setDevice(event.target.value)}
                  disabled={loading || !canSearch}
                >
                  <option value="mobile">Mobile</option>
                  <option value="desktop">Desktop</option>
                </select>
              </label>
            </div>
            <button type="submit" className="search-focus-submit" disabled={loading || !canSearch}>
              {loading ? 'Processing' : 'Search'}
              <ArrowRight size={17} />
            </button>
          </form>



          {loading && (
            <div className="sp-shell">

              {/* ── ZONE 1: Live logs ───────────────────── */}
              <div className="sp-logs-zone">
                <div className="sp-logs-label">
                  <Loader size={11} className="spin-icon" />
                  Real-Time Results
                </div>
                <div className="sp-logs-scroll">
                  {progressLogs.length > 0 ? (
                    progressLogs.map((log, idx) => {
                      const isLatest = idx === progressLogs.length - 1;
                      return (
                        <div key={idx} className={`sp-log-row${isLatest ? ' sp-log-row--active' : ''}`}>
                          <span className="sp-log-time">{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                          <span className="sp-log-divider" />
                          <span className="sp-log-domain">
                            {isLatest && <Loader size={10} className="spin-icon sp-log-spin" />}
                            {log.domain || '—'}
                          </span>
                          {log.detail && <span className="sp-log-detail">{log.detail}</span>}
                          {log.step && <span className="sp-log-badge">{log.step}</span>}
                          {sparkles[idx] && (
                            <>
                              <span className="sparkle" style={{ top: '50%', left: '18%', animation: 'sparkle 0.8s ease-out' }}><span className="sparkle-dot" /></span>
                              <span className="sparkle" style={{ top: '20%', left: '55%', animation: 'sparkle 0.8s ease-out 0.1s' }}><span className="sparkle-dot" /></span>
                            </>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="sp-logs-empty">Awaiting search progress…</div>
                  )}
                </div>
              </div>

              {/* ── ZONE 2: steps + SVG ─────────────────── */}
              <div className="sp-body">

                {/* LEFT: animated workflow steps */}
                <div className="sp-steps-zone">
                  <p className="sp-steps-label">Workflow</p>
                  <div className="sp-steps-list">
                    {SEARCH_STEPS.map((step, index) => {
                      const isActive = index === stepIndex;
                      const isDone = index < stepIndex;
                      return (
                        <div key={step} className={`sp-step${isDone ? ' sp-step--done' : ''}${isActive ? ' sp-step--active' : ''}`}>
                          {/* track line */}
                          {index < SEARCH_STEPS.length - 1 && <span className={`sp-step-track${isDone ? ' sp-step-track--done' : ''}${isActive ? ' sp-step-track--active' : ''}`} />}
                          {/* node */}
                          <span className="sp-step-node">
                            {isDone
                              ? <CheckCircle size={13} />
                              : isActive
                                ? <Loader size={11} className="spin-icon" />
                                : null}
                          </span>
                          <span className="sp-step-name">{step}</span>
                          {isActive && currentProgress.detail && (
                            <span className="sp-step-detail">{currentProgress.detail}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* RIGHT: large SVG illustration */}
                <div className="sp-svg-zone">
                  {SEARCH_PROGRESS_SVG ? (
                    <object
                      type="image/svg+xml"
                      data={SEARCH_PROGRESS_SVG}
                      aria-label="Search in progress animation"
                      className="sp-svg-obj"
                    >
                      <img src={SEARCH_PROGRESS_SVG} alt="Search in progress" className="sp-svg-obj" loading="lazy" />
                    </object>
                  ) : (
                    <div className="sp-svg-empty">
                      <Loader size={28} className="spin-icon" style={{ color: 'var(--color-brand)' }} />
                    </div>
                  )}
                </div>

              </div>
            </div>
          )}
        </div>

        {activeHistory && (
          <section className="keyword-history-detail">
            <div className="keyword-history-detail-header">
              <div>
                <span className="eyebrow">Recent saved </span>
                <h2>{activeHistory.source_keyword}</h2>
                <p>{activeHistory.file_name}</p>
              </div>
              <div className="keyword-history-total">
                <strong>{getKeywordCount(activeOutput)}</strong>
                <span>keywords</span>
              </div>
            </div>
            <button type="button" className="history-open-result" onClick={() => openSavedKeywordResult(activeHistory)}>
              Open editable result
              <ArrowRight size={15} />
            </button>

            <div className="keyword-group-summary">
              {['Green', 'Orange', 'White'].map((group) => (
                <div className={`keyword-group-card keyword-group-${group.toLowerCase()}`} key={group}>
                  <span>{group}</span>
                  <strong>{activeCounts[group]}</strong>
                </div>
              ))}
            </div>

            <div className="keyword-preview-grid">
              {['Green', 'Orange', 'White'].map((group) => (
                <div className="keyword-preview-column" key={group}>
                  <h3>{group}</h3>
                  <div className="keyword-preview-list">
                    {(activeOutput[group] || []).slice(0, 18).map((item) => {
                      return (
                        <span className="keyword-preview-chip" key={`${group}-${item}`}>
                          {item}
                        </span>
                      );
                    })}
                    {(activeOutput[group] || []).length === 0 && <p>No keywords</p>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>

      <aside className="search-history-panel">
        <div className="search-history-header">
          <div>
            <h2>Past Keywords</h2>
            <p>saved keywords</p>
          </div>
          <button type="button" className="history-refresh" onClick={() => loadHistory(1, false)} disabled={historyLoading}>
            <RefreshCw size={16} className={historyLoading ? 'spin-icon' : ''} />
          </button>
        </div>

        {/* Filters Section */}
        <div className="history-filters-container">
          <div className="history-filter-tabs">
            <button
              type="button"
              className={`filter-tab-btn ${filterType === 'all' ? 'active' : ''}`}
              onClick={() => setFilterType('all')}
            >
              All
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterType === 'today' ? 'active' : ''}`}
              onClick={() => setFilterType('today')}
            >
              Today
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterType === 'yesterday' ? 'active' : ''}`}
              onClick={() => setFilterType('yesterday')}
            >
              Yesterday
            </button>
            <button
              type="button"
              className={`filter-tab-btn ${filterType === 'range' ? 'active' : ''}`}
              onClick={() => setFilterType('range')}
            >
              <Calendar size={12} style={{ marginRight: '4px', verticalAlign: 'middle', display: 'inline-block' }} />
              Range
            </button>
          </div>

          {filterType === 'range' && (
            <div className="history-date-picker-range">
              <div className="range-picker-header">
                <span className="range-picker-title">Date Range</span>
                {(startDate || endDate) && (
                  <button
                    type="button"
                    className="clear-range-btn"
                    onClick={() => {
                      setStartDate('');
                      setEndDate('');
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="date-picker-field">
                <span className="date-field-label">Start Date</span>
                <div className="date-input-wrapper">
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    onFocus={(e) => {
                      try { e.target.showPicker(); } catch (err) { }
                    }}
                    onClick={(e) => {
                      try { e.target.showPicker(); } catch (err) { }
                    }}
                    className="history-date-input"
                  />
                  <Calendar size={13} className="date-input-icon" />
                </div>
              </div>
              <div className="date-picker-field">
                <span className="date-field-label">End Date</span>
                <div className="date-input-wrapper">
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    onFocus={(e) => {
                      try { e.target.showPicker(); } catch (err) { }
                    }}
                    onClick={(e) => {
                      try { e.target.showPicker(); } catch (err) { }
                    }}
                    className="history-date-input"
                  />
                  <Calendar size={13} className="date-input-icon" />
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: '0.85rem' }}>
            <span
              style={{
                display: 'block',
                marginBottom: '0.4rem',
                fontSize: '0.78rem',
                fontWeight: 600,
                color: 'var(--text-secondary)'
              }}
            >
              Search Past Keyword
            </span>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.55rem',
                width: '100%',
                padding: '0.8rem 0.9rem',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                background: 'var(--surface-color, #fff)'
              }}
            >
              <Search size={16} style={{ color: 'var(--text-secondary)' }} />
              <input
                type="text"
                value={pastKeyword}
                onChange={(e) => setPastKeyword(e.target.value)}
                placeholder="Search saved keywords"
                aria-label="Search past keywords"
                style={{
                  width: '100%',
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: '0.92rem',
                  color: 'var(--text-primary)'
                }}
              />
            </div>
          </div>
        </div>

        <div className="search-history-list" onScroll={handleScroll}>
          {history.map((item) => {
            const total = getKeywordCount(item.keywords_json || {});
            const active = activeHistory?.id === item.id;
            return (
              <div
                role="button"
                tabIndex={0}
                key={item.id}
                className={`search-history-card ${active ? 'active' : ''}`}
                onClick={() => openSavedKeywordResult(item)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openSavedKeywordResult(item);
                  }
                }}
              >
                <span className="history-card-top">
                  <span className="history-card-title">{item.source_keyword}</span>
                  <button
                    type="button"
                    className="history-card-delete"
                    onClick={(event) => handleDeleteHistory(event, item)}
                    disabled={deletingHistoryId === item.id}
                    title="Delete keyword history"
                    aria-label={`Delete ${item.source_keyword}`}
                  >
                    {deletingHistoryId === item.id ? <Loader size={14} className="spin-icon" /> : <Trash2 size={14} />}
                  </button>
                </span>
                <span className="history-card-meta">
                  <Database size={13} />
                  {total} terms
                </span>
                <span className="history-card-footer">
                  <span>{item.file_name}</span>
                  <span><Clock size={12} /> {new Date(item.updated_at).toLocaleDateString()}</span>
                </span>
              </div>
            );
          })}

          {historyLoading && page > 1 && (
            <div className="history-page-loader">
              <Loader size={16} className="spin-icon" />
              <span>Loading more...</span>
            </div>
          )}

          {!historyLoading && history.length === 0 && (
            <div className="search-history-empty">
              <Database size={22} />
              <p>No saved keyword JSON outputs yet.</p>
            </div>
          )}
        </div>
      </aside>
    </main>
  );
}

export default SearchPage;
