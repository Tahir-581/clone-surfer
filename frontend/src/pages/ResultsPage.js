import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Share2, Save, PenTool } from 'lucide-react';
import { config } from '../config';
import { getStoredUser, getStoredUserRole, isOutliner as checkOutliner } from '../utils/roles';

const GROUP_NAMES = ['Green', 'Orange', 'White'];

const CONTENT_STRUCTURE_DEFAULTS = { words: 1200, headings: 18, paragraphs: 16, images: 20 };

function getUniqueTerms(terms = []) {
  return [...new Set((Array.isArray(terms) ? terms : []).filter((term) => typeof term === 'string' && term.trim()))];
}

function normalizeSelectedTerms(groups = {}) {
  return {
    Green: getUniqueTerms(groups.Green),
    Orange: getUniqueTerms(groups.Orange),
    White: getUniqueTerms(groups.White),
  };
}

function ResultsPage({ sessionId: propSessionId, results: propResults }) {
  const navigate = useNavigate();
  const location = useLocation();

  const userObj = getStoredUser();
  const userRole = userObj?.role || getStoredUserRole();
  const isOutliner = checkOutliner(userRole);
  const authHeaders = useMemo(() => (
    userObj?.token ? { Authorization: `Bearer ${userObj.token}` } : {}
  ), [userObj?.token]);

  const keyword = location.state?.keyword || '';
  const normalizedKeyword = useMemo(() => keyword.trim(), [keyword]);
  const savedKeywordId = location.state?.savedKeywordId || null;
  const savedKeywordOutput = location.state?.keywordOutput || null;
  const fileName = location.state?.fileName || `${normalizedKeyword.replace(/[^\w\s-]/g, '').replace(/[-\s]+/g, '_') || 'search'}.json`;

  const [activeResults, setActiveResults] = useState([]);
  const [selectedUrls, setSelectedUrls] = useState([]);
  const [mergeData, setMergeData] = useState(null);
  const [loadingMerge, setLoadingMerge] = useState(false);
  const [savingTerms, setSavingTerms] = useState(false);
  const [contentStructure, setContentStructure] = useState(CONTENT_STRUCTURE_DEFAULTS);
  const [isSavingSilently, setIsSavingSilently] = useState(false);

  const [selectedTerms, setSelectedTerms] = useState({ Green: [], Orange: [], White: [] });
  const [hasInitializedSelection, setHasInitializedSelection] = useState(false);

  const [sessionId, setSessionId] = useState(location.state?.sessionId || propSessionId || '');

  const getNormalizedUrl = (url) => {
    if (!url || typeof url !== 'string') return '';
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  };

  const getDisplayDomain = (result) => {
    const fallbackDomain = result?.domain || '';
    const normalizedUrl = getNormalizedUrl(result?.url);
    if (!normalizedUrl) return fallbackDomain;

    try {
      return new URL(normalizedUrl).hostname.replace(/^www\./i, '') || fallbackDomain;
    } catch (error) {
      return fallbackDomain;
    }
  };

  // 1. Initialize Active Results & Load local selections
  useEffect(() => {
    let initialResults = propResults && propResults.length > 0 ? propResults : null;
    if (!initialResults) {
      initialResults = location.state?.results || null;
    }
    if (initialResults) {
      setActiveResults(initialResults);
    }

    if (normalizedKeyword) {
      let initialSelected = [];
      if (location.state?.selectedUrls && location.state.selectedUrls.length > 0) {
        initialSelected = location.state.selectedUrls;
      } else {
        const saved = localStorage.getItem(`selected_domains_${normalizedKeyword}`);
        if (saved) {
          try {
            initialSelected = JSON.parse(saved);
          } catch (e) {
            console.error('Error parsing local domain selections:', e);
          }
        }
      }
      setSelectedUrls(initialSelected);
    }
  }, [propResults, location.state, normalizedKeyword]);

  // 2. Fetch saved selections / results from PostgreSQL database
  useEffect(() => {
    if (!normalizedKeyword) return;
    const loadSavedArticleData = async () => {
      try {
        const response = await fetch(`${config.API_URL}/articles/${encodeURIComponent(normalizedKeyword)}`, {
          headers: authHeaders,
        });
        if (response.ok) {
          const article = await response.json();
          if (article.results && article.results.length > 0) {
            setActiveResults(article.results);
          }
          if (Array.isArray(article.selected_urls)) {
            setSelectedUrls(article.selected_urls);
            localStorage.setItem(`selected_domains_${normalizedKeyword}`, JSON.stringify(article.selected_urls));
          }
          if (article.keywords_json && typeof article.keywords_json === 'object' && !Array.isArray(article.keywords_json)) {
            setSelectedTerms(normalizeSelectedTerms(article.keywords_json));
            setHasInitializedSelection(true);
          }
          if (article.session_id) {
            setSessionId(article.session_id);
          }
          if (article.content_structure && typeof article.content_structure === 'object' && article.content_structure.words) {
            setContentStructure(article.content_structure);
          }
        }
      } catch (error) {
        console.error("Error loading saved article details:", error);
      }
    };
    loadSavedArticleData();
  }, [normalizedKeyword, authHeaders]);

  // 3. Save selections to LocalStorage instantly on change
  useEffect(() => {
    if (normalizedKeyword) {
      localStorage.setItem(`selected_domains_${normalizedKeyword}`, JSON.stringify(selectedUrls));
    }
  }, [selectedUrls, normalizedKeyword]);

  // 3b. Debounced auto-save effect to database when selections or structure change
  useEffect(() => {
    if (!hasInitializedSelection || !normalizedKeyword || !isOutliner) return undefined;

    const timer = setTimeout(async () => {
      setIsSavingSilently(true);
      try {
        await fetch(`${config.API_URL}${config.SELECT_NLP_KEYWORDS_ENDPOINT}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            source_keyword: keyword,
            keyword_output_id: savedKeywordId,
            file_name: fileName,
            json_output: selectedTerms,
            results: activeResults,
            selected_urls: selectedUrls
          })
        });

        // Update article record too
        let article = {};
        try {
          const articleRes = await fetch(`${config.API_URL}/articles/${encodeURIComponent(normalizedKeyword)}`, { headers: authHeaders });
          if (articleRes.ok) {
            article = await articleRes.json();
          }
        } catch (e) {
          console.error("Error loading existing article details:", e);
        }

        await fetch(`${config.API_URL}/articles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            ...article,
            article_key: normalizedKeyword,
            title: article.title || normalizedKeyword,
            content: article.content || '',
            keywords: selectedTerms,
            results: activeResults,
            selected_urls: selectedUrls,
            session_id: sessionId || undefined,
            content_structure: contentStructure
          })
        });
      } catch (error) {
        console.error('Auto-save error:', error);
      } finally {
        setIsSavingSilently(false);
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [contentStructure, selectedTerms, selectedUrls, normalizedKeyword, fileName, activeResults, sessionId, authHeaders, hasInitializedSelection, isOutliner, savedKeywordId]);

  // 4. Real-time NLP merge
  const performRealTimeMerge = useCallback(async () => {
    if (selectedUrls.length === 0) {
      setMergeData(null);
      return;
    }
    setLoadingMerge(true);
    try {
      const response = await fetch(`${config.API_URL}${config.MERGE_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          selected_urls: selectedUrls,
          session_id: sessionId,
          keyword: keyword || undefined
        })
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      setMergeData(data);
    } catch (error) {
      console.error('Real-time merge error:', error);
    } finally {
      setLoadingMerge(false);
    }
  }, [selectedUrls, sessionId, keyword, authHeaders]);

  useEffect(() => {
    performRealTimeMerge();
  }, [selectedUrls, performRealTimeMerge]);

  // Compute entities into groups
  const { highEntities, whiteEntities, mediumEntities } = useMemo(() => {
    let high = [], white = [], medium = [];
    if (mergeData?.entities) {
      const scoredEntities = mergeData.entities.map((entity) => ({
        entity,
        score: entity.average_weightage != null ? Number(entity.average_weightage) : 0,
      }));
      const sorted = [...scoredEntities].sort((a, b) => b.score - a.score);
      const total = sorted.length;
      const greenCount = Math.max(1, Math.floor(total * 0.4));
      const highSlice = sorted.slice(0, greenCount);
      const remaining = sorted.slice(greenCount);
      const whiteCount = remaining.length > 0 ? Math.max(1, Math.floor(remaining.length * 0.1)) : 0;
      const whiteSlice = remaining.slice(0, whiteCount);
      const mediumSlice = remaining.slice(whiteCount);

      high = highSlice.map(({ entity }) => entity);
      white = whiteSlice.map(({ entity }) => entity);
      medium = mediumSlice.map(({ entity }) => entity);
    } else if (savedKeywordOutput) {
      high = (savedKeywordOutput.Green || []).map(text => ({ text, combined_count: '-' }));
      medium = (savedKeywordOutput.Orange || []).map(text => ({ text, combined_count: '-' }));
      white = (savedKeywordOutput.White || []).map(text => ({ text, combined_count: '-' }));
    }
    return { highEntities: high, whiteEntities: white, mediumEntities: medium };
  }, [mergeData, savedKeywordOutput]);

  const availableTermsByGroup = useMemo(() => ({
    Green: getUniqueTerms(highEntities.map((entity) => entity.text)),
    Orange: getUniqueTerms(mediumEntities.map((entity) => entity.text)),
    White: getUniqueTerms(whiteEntities.map((entity) => entity.text)),
  }), [highEntities, mediumEntities, whiteEntities]);

  // Initialize selection once
  useEffect(() => {
    if (savedKeywordOutput) {
      if (!hasInitializedSelection) {
        setSelectedTerms(normalizeSelectedTerms(savedKeywordOutput));
        setHasInitializedSelection(true);
      }
      return;
    }

    // Auto-select Green keywords by default when live analysis finishes
    if (highEntities.length > 0 && !hasInitializedSelection) {
      setSelectedTerms({
        Green: highEntities.map((e) => e.text).filter(Boolean),
        Orange: [],
        White: [],
      });
      setHasInitializedSelection(true);
    }
  }, [hasInitializedSelection, savedKeywordOutput, highEntities]);

  useEffect(() => {
    const hasAvailableTerms = GROUP_NAMES.some((group) => availableTermsByGroup[group].length > 0);
    if (!hasAvailableTerms) return;

    setSelectedTerms((prev) => {
      const next = GROUP_NAMES.reduce((acc, group) => {
        const allowed = new Set(availableTermsByGroup[group]);
        acc[group] = getUniqueTerms(prev[group]).filter((term) => allowed.has(term));
        return acc;
      }, {});

      const changed = GROUP_NAMES.some((group) => {
        const current = getUniqueTerms(prev[group]);
        const filtered = next[group];
        return current.length !== filtered.length || current.some((term, index) => term !== filtered[index]);
      });

      return changed ? next : prev;
    });
  }, [availableTermsByGroup]);

  // Toggle single term
  const toggleTerm = (group, text) => {
    if (!isOutliner) return;
    setSelectedTerms((prev) => {
      const current = prev[group] || [];
      return {
        ...prev,
        [group]: current.includes(text) ? current.filter((t) => t !== text) : [...current, text]
      };
    });
  };

  // Toggle group
  const toggleGroup = (group, entities) => {
    if (!isOutliner) return;
    const allTerms = entities.map((e) => e.text).filter(Boolean);
    setSelectedTerms((prev) => {
      const current = prev[group] || [];
      const allSelected = allTerms.length > 0 && allTerms.every((t) => current.includes(t));
      return {
        ...prev,
        [group]: allSelected ? [] : allTerms
      };
    });
  };

  const handleSelectAllDomains = (e) => {
    if (!isOutliner) return;
    if (e.target.checked) setSelectedUrls(activeResults.map(r => r.url));
    else setSelectedUrls([]);
  };

  const handleSelectDomain = (url) => {
    if (!isOutliner) return;
    setSelectedUrls(prev => prev.includes(url) ? prev.filter(u => u !== url) : [...prev, url]);
  };

  const saveSelectedTerms = async () => {
    if (!normalizedKeyword) {
      toast.error('Missing source keyword');
      return false;
    }
    setSavingTerms(true);
    try {
      const response = await fetch(`${config.API_URL}${config.SELECT_NLP_KEYWORDS_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          source_keyword: keyword,
          keyword_output_id: savedKeywordId,
          file_name: fileName,
          json_output: selectedTerms,
          results: activeResults,
          selected_urls: selectedUrls
        })
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      // Update article record too
      let article = {};
      try {
        const articleRes = await fetch(`${config.API_URL}/articles/${encodeURIComponent(normalizedKeyword)}`, { headers: authHeaders });
        if (articleRes.ok) {
          article = await articleRes.json();
        }
      } catch (e) {
        console.error("Error loading existing article details:", e);
      }

      await fetch(`${config.API_URL}/articles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          ...article,
          article_key: normalizedKeyword,
          title: article.title || normalizedKeyword,
          content: article.content || '',
          keywords: selectedTerms,
          results: activeResults,
          selected_urls: selectedUrls,
          session_id: sessionId || undefined,
          content_structure: contentStructure
        })
      });

      toast.success('Selected keywords saved successfully');
      return true;
    } catch (error) {
      console.error('Save error:', error);
      toast.error('Could not save keywords');
      return false;
    } finally {
      setSavingTerms(false);
    }
  };

  const handleShare = async () => {
    const success = await saveSelectedTerms();
    if (success) {
      const shareUrl = `${window.location.origin}/article-writer?keyword=${encodeURIComponent(keyword)}`;

      const copyToClipboard = (text) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text);
        }
        return new Promise((resolve, reject) => {
          try {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.top = "0";
            textArea.style.left = "0";
            textArea.style.position = "fixed";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const successful = document.execCommand("copy");
            document.body.removeChild(textArea);
            if (successful) resolve();
            else reject(new Error("Copy command failed"));
          } catch (err) {
            reject(err);
          }
        });
      };

      copyToClipboard(shareUrl)
        .then(() => {
          toast.success('Share link copied to clipboard! Content Writers can use this link.');
        })
        .catch(() => {
          toast.info(`Share link: ${shareUrl}`);
        });
    }
  };

  const openArticleWriter = async () => {
    await saveSelectedTerms();
    navigate('/article-writer', {
      state: {
        keyword,
        selectedKeywords: selectedTerms,
        jsonOutput: selectedTerms,
        sessionId,
        results: activeResults,
        selectedUrls,
        contentStructure,
      }
    });
  };

  if ((!activeResults || activeResults.length === 0) && !savedKeywordOutput) {
    return (
      <div className="page-container results-page" style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto', background: '#f9fafb', minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ background: 'white', padding: '3rem', borderRadius: '12px', border: '1px solid #e5e7eb', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <h2 style={{ fontSize: '1.5rem', color: '#111827', marginBottom: '0.5rem', fontWeight: 700 }}>Search Results</h2>
          <p style={{ color: '#6b7280', marginBottom: '1.5rem' }}>No competitor results or keywords loaded. Please perform a search first.</p>
          <button className="btn-action btn-secondary" onClick={() => navigate('/')} style={{ background: 'white', border: '1px solid #d1d5db', padding: '0.6rem 1.25rem', borderRadius: '6px', fontWeight: 600, cursor: 'pointer' }}>
            Back to Search
          </button>
        </div>
      </div>
    );
  }

  const renderNlpRow = (groupName, entities) => {
    const currentSelected = getUniqueTerms(selectedTerms[groupName]);
    const allTerms = getUniqueTerms(entities.map((entity) => entity.text));
    const selectedCount = allTerms.filter((term) => currentSelected.includes(term)).length;
    const allSelected = allTerms.length > 0 && selectedCount === allTerms.length;

    return (
      <div className="nlp-category-row" style={{ width: '100%', marginBottom: '2.5rem' }}>
        {/* Row Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', paddingBottom: '0.5rem', borderBottom: '1px solid #f3f4f6' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              width: '10px', height: '10px', borderRadius: '50%',
              background: groupName === 'Green' ? '#10b981' : groupName === 'Orange' ? '#f97316' : '#6b7280'
            }} />
            <h4 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: groupName === 'Green' ? '#065f46' : groupName === 'Orange' ? '#9a3412' : '#374151' }}>
              {groupName === 'Green' ? 'High Relevant (Green)' : groupName === 'Orange' ? 'Medium Relevant (Orange)' : 'Low Relevant (White)'}
            </h4>
            <span style={{ fontSize: '0.8rem', color: '#6b7280', background: '#f3f4f6', padding: '0.15rem 0.5rem', borderRadius: '12px', fontWeight: 500 }}>
              {selectedCount} of {allTerms.length} selected
            </span>
          </div>
          {isOutliner && entities.length > 0 && (
            <button
              style={{ background: 'white', border: '1px solid #d1d5db', borderRadius: '6px', padding: '0.3rem 0.65rem', fontSize: '0.75rem', cursor: 'pointer', color: '#374151', fontWeight: 600, transition: 'all 0.2s' }}
              onClick={() => toggleGroup(groupName, entities)}
            >
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
          )}
        </div>

        {/* Horizontal Wrapping Chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
          {entities.map((entity, idx) => {
            const isSelected = currentSelected.includes(entity.text);
            return (
              <div
                key={idx}
                onClick={() => toggleTerm(groupName, entity.text)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.8rem',
                  borderRadius: '30px', border: `1px solid ${isSelected ? (groupName === 'Green' ? '#10b981' : groupName === 'Orange' ? '#f97316' : '#9ca3af') : '#e5e7eb'}`,
                  background: isSelected ? (groupName === 'Green' ? '#ecfdf5' : groupName === 'Orange' ? '#fff7ed' : '#f9fafb') : 'white',
                  cursor: isOutliner ? 'pointer' : 'default', transition: 'all 0.2s',
                  boxShadow: isSelected ? '0 1px 2px rgba(0,0,0,0.05)' : 'none'
                }}
              >
                {isOutliner && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    style={{ cursor: 'pointer', accentColor: groupName === 'Green' ? '#10b981' : groupName === 'Orange' ? '#f97316' : '#4b5563', width: '14px', height: '14px' }}
                  />
                )}
                <span style={{ fontSize: '0.88rem', color: '#111827', fontWeight: isSelected ? 600 : 400 }}>{entity.text}</span>
                <span style={{ fontSize: '0.7rem', color: '#6b7280', background: '#f3f4f6', padding: '0.1rem 0.35rem', borderRadius: '10px', fontWeight: 500 }}>{entity.combined_count}x</span>
              </div>
            );
          })}
          {entities.length === 0 && <p style={{ color: '#9ca3af', fontSize: '0.9rem', fontStyle: 'italic', margin: 0 }}>No {groupName.toLowerCase()} terms found.</p>}
        </div>
      </div>
    );
  };

  const isAllSelected = activeResults.length > 0 && selectedUrls.length === activeResults.length;

  return (
    <div className="page-container results-page" style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto', background: '#f9fafb', minHeight: '100vh' }}>
      {/* Header */}
      <div className="page-header" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.8rem', color: '#111827', marginBottom: '0.5rem', fontWeight: 800 }}>Organic Competitors</h2>
        <p style={{ color: '#4b5563', fontSize: '1.05rem' }}>
          {isOutliner ? 'Your content guidelines will be based on competitors you choose. Pick at least five URLs for the most relevant results' : 'Review competitor domains and the NLP keywords curated for this topic.'}
        </p>
        {keyword && (
          <div style={{ marginTop: '1rem', display: 'inline-block', padding: '0.5rem 1rem', background: '#eff6ff', borderRadius: '6px', fontWeight: 600, border: '1px solid #bfdbfe' }}>
            Target Keyword: <span style={{ color: '#1d4ed8' }}>{keyword}</span>
          </div>
        )}
      </div>

      {/* Domain Selection */}
      {activeResults && activeResults.length > 0 && (
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', overflow: 'hidden', marginBottom: '2rem', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #e5e7eb', background: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.15rem', color: '#111827', fontWeight: 700 }}>Competitor Domains</h3>
              <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.85rem', color: '#6b7280' }}>Selected: {selectedUrls.length} of {activeResults.length}</p>
            </div>
          </div>
          <div style={{ maxHeight: '350px', overflowY: 'auto' }}>
            <table className="results-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1, borderBottom: '1px solid #e5e7eb' }}>
                <tr>
                  {isOutliner && (
                    <th style={{ padding: '0.85rem 1.5rem', width: '40px', textAlign: 'center' }}>
                      <input type="checkbox" checked={isAllSelected} onChange={handleSelectAllDomains} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                    </th>
                  )}
                  <th style={{ padding: '0.85rem 1.5rem', textAlign: 'left', fontSize: '0.85rem', textTransform: 'uppercase', color: '#6b7280', fontWeight: 600 }}>Rank</th>
                  <th style={{ padding: '0.85rem 1.5rem', textAlign: 'left', fontSize: '0.85rem', textTransform: 'uppercase', color: '#6b7280', fontWeight: 600 }}>Domain</th>
                  <th style={{ padding: '0.85rem 1.5rem', textAlign: 'left', fontSize: '0.85rem', textTransform: 'uppercase', color: '#6b7280', fontWeight: 600 }}>Title</th>
                  <th style={{ padding: '0.85rem 1.5rem', textAlign: 'center', fontSize: '0.85rem', textTransform: 'uppercase', color: '#6b7280', fontWeight: 600 }}>Words</th>
                  <th style={{ padding: '0.85rem 1.5rem', textAlign: 'center', fontSize: '0.85rem', textTransform: 'uppercase', color: '#6b7280', fontWeight: 600 }}>Authority</th>
                </tr>
              </thead>
              <tbody>
                {activeResults.map((result, idx) => {
                  const normalizedUrl = getNormalizedUrl(result.url);
                  const displayDomain = getDisplayDomain(result);
                  
                  const authScore = result.authority || 0;
                  let authColor = '#10b981'; // Green
                  if (authScore < 4) authColor = '#ef4444'; // Red
                  else if (authScore < 7) authColor = '#f59e0b'; // Yellow

                  return (
                    <tr key={idx} style={{ borderBottom: '1px solid #f3f4f6', background: selectedUrls.includes(result.url) ? '#eff6ff' : 'white', transition: 'background 0.2s' }}>
                      {isOutliner && (
                        <td style={{ padding: '0.85rem 1.5rem', textAlign: 'center' }}>
                          <input type="checkbox" checked={selectedUrls.includes(result.url)} onChange={() => handleSelectDomain(result.url)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                        </td>
                      )}
                      <td style={{ padding: '0.85rem 1.5rem', fontWeight: 700, color: '#374151' }}>#{result.rank ?? (idx + 1)}</td>
                      <td style={{ padding: '0.85rem 1.5rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <a href={normalizedUrl || '#'} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 600 }}>
                            {displayDomain || 'N/A'}
                          </a>
                          <a
                            href={normalizedUrl || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#6b7280', textDecoration: 'none', fontSize: '0.8rem', wordBreak: 'break-all' }}
                          >
                            {result.url || 'N/A'}
                          </a>
                        </div>
                      </td>
                      <td style={{ padding: '0.85rem 1.5rem', color: '#4b5563', fontSize: '0.9rem' }}>{result.title || 'N/A'}</td>
                      <td style={{ padding: '0.85rem 1.5rem', textAlign: 'center' }}>
                        <span style={{ background: '#f3f4f6', padding: '0.25rem 0.6rem', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 500, color: '#4b5563' }}>
                          {result.word_count}
                        </span>
                      </td>
                      <td style={{ padding: '0.85rem 1.5rem', textAlign: 'center' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '32px' }}>
                            <svg viewBox="0 0 24 24" fill={authColor} style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0.9 }}>
                              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                            </svg>
                            <span style={{ position: 'relative', color: 'white', fontWeight: 700, fontSize: '0.85rem' }}>{authScore}</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Content Structure Section - only for outliners */}
      {isOutliner && (
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '2rem', marginBottom: '2rem', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <div style={{ marginBottom: '1.75rem' }}>
            <h3 style={{ margin: '0 0 0.35rem', fontSize: '1.2rem', color: '#111827', fontWeight: 700 }}>Content Structure</h3>
            <p style={{ margin: 0, fontSize: '0.85rem', color: '#6b7280' }}>
              Your content structure elements are calculated based on the competitors you picked for the analysis.{' '}
              <a href="#" onClick={e => e.preventDefault()} style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 500 }}>Learn more.</a>
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0', alignItems: 'stretch', overflowX: 'auto' }}>
            {[
              { key: 'words', label: 'WORDS', hasDropdown: true },
              { key: 'headings', label: 'HEADINGS', hasDropdown: false },
              { key: 'paragraphs', label: 'PARAGRAPHS', hasDropdown: false },
              { key: 'images', label: 'IMAGES', hasDropdown: false },
            ].map(({ key, label, hasDropdown }, idx, arr) => {
              const value = contentStructure[key];
              const rangeMin = value;
              const rangeMax = key === 'words' ? Math.round(value * 1.15) : Math.round(value * 1.2);
              const formatNum = (n) => n >= 1000 ? n.toLocaleString() : String(n);
              const step = key === 'words' ? 100 : 1;
              const minVal = key === 'words' ? 100 : 0;
              return (
                <React.Fragment key={key}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem', padding: '0 1.5rem', minWidth: '110px' }}>
                    {/* Reset Icon */}
                    <button
                      onClick={() => setContentStructure(prev => ({ ...prev, [key]: CONTENT_STRUCTURE_DEFAULTS[key] }))}
                      title={`Reset ${label} to default (${CONTENT_STRUCTURE_DEFAULTS[key]})`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '1.1rem', lineHeight: 1, padding: '2px', display: 'flex', alignItems: 'center', transition: 'color 0.2s' }}
                      onMouseOver={e => e.currentTarget.style.color = '#374151'}
                      onMouseOut={e => e.currentTarget.style.color = '#9ca3af'}
                    >
                      ↺
                    </button>

                    {/* Label / Dropdown */}
                    {hasDropdown ? (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.78rem', fontWeight: 600, color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', padding: '3px 10px', cursor: 'default', background: 'white', userSelect: 'none' }}>
                        WORDS <span style={{ fontSize: '0.65rem', color: '#6b7280' }}>▾</span>
                      </div>
                    ) : (
                      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
                    )}

                    {/* +/- Counter */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      <button
                        onClick={() => setContentStructure(prev => ({ ...prev, [key]: Math.max(minVal, prev[key] - step) }))}
                        style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', flexShrink: 0, transition: 'border-color 0.2s' }}
                        onMouseOver={e => e.currentTarget.style.borderColor = '#9ca3af'}
                        onMouseOut={e => e.currentTarget.style.borderColor = '#e5e7eb'}
                      >−</button>
                      <span style={{ fontSize: '1.3rem', fontWeight: 700, color: '#111827', minWidth: '55px', textAlign: 'center' }}>
                        {formatNum(value)}
                      </span>
                      <button
                        onClick={() => setContentStructure(prev => ({ ...prev, [key]: prev[key] + step }))}
                        style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: '1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', flexShrink: 0, transition: 'border-color 0.2s' }}
                        onMouseOver={e => e.currentTarget.style.borderColor = '#9ca3af'}
                        onMouseOut={e => e.currentTarget.style.borderColor = '#e5e7eb'}
                      >+</button>
                    </div>

                    {/* Range hint */}
                    <span style={{ fontSize: '0.8rem', color: '#6b7280', fontWeight: 500 }}>
                      {formatNum(rangeMin)}–{formatNum(rangeMax)}
                    </span>
                  </div>
                  {idx < arr.length - 1 && (
                    <div style={{ width: '1px', background: '#e5e7eb', alignSelf: 'stretch', flexShrink: 0 }} />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* NLP Selection (Row-Wise Analysis) */}
      {(selectedUrls.length > 0 || savedKeywordOutput) && (mergeData || savedKeywordOutput) && (
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '2rem', marginBottom: '2rem', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem', paddingBottom: '1.25rem', borderBottom: '1px solid #e5e7eb' }}>
            <h3 style={{ margin: 0, fontSize: '1.25rem', color: '#111827', fontWeight: 700 }}>Terms to Use</h3>
            {loadingMerge && <span className="loading-small" style={{ borderColor: '#e5e7eb', borderTopColor: '#2563eb' }}></span>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {renderNlpRow('Green', highEntities)}
            {renderNlpRow('Orange', mediumEntities)}
            {renderNlpRow('White', whiteEntities)}
          </div>
        </div>
      )}

      {/* Action Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '2rem', padding: '1rem 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button className="btn-action btn-secondary" onClick={() => navigate('/')} style={{ background: 'white', border: '1px solid #d1d5db', padding: '0.75rem 1.5rem', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}>
            Back to Search
          </button>
          {isSavingSilently && (
            <span style={{ color: '#059669', fontSize: '0.88rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <span className="loading-small" style={{ width: '12px', height: '12px', borderColor: '#e5e7eb', borderTopColor: '#059669' }}></span>
              Saving changes...
            </span>
          )}
        </div>

        {isOutliner && (
          <div style={{ display: 'flex', gap: '1rem' }}>
            <button
              onClick={handleShare}
              disabled={savingTerms}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'white', color: '#374151', border: '1px solid #d1d5db', padding: '0.75rem 1.5rem', borderRadius: '8px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}
              onMouseOver={e => e.currentTarget.style.background = '#f9fafb'}
              onMouseOut={e => e.currentTarget.style.background = 'white'}
            >
              <Share2 size={18} /> Share Link
            </button>
            <button
              onClick={saveSelectedTerms}
              disabled={savingTerms}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'white', color: '#059669', border: '1px solid #059669', padding: '0.75rem 1.5rem', borderRadius: '8px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}
              onMouseOver={e => e.currentTarget.style.background = '#ecfdf5'}
              onMouseOut={e => e.currentTarget.style.background = 'white'}
            >
              <Save size={18} /> {savingTerms ? 'Saving...' : 'Save Selection'}
            </button>
            <button
              onClick={openArticleWriter}
              disabled={savingTerms}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#2563eb', color: 'white', border: 'none', padding: '0.75rem 1.5rem', borderRadius: '8px', fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', boxShadow: '0 4px 6px -1px rgba(37, 99, 235, 0.2)' }}
              onMouseOver={e => e.currentTarget.style.transform = 'translateY(-1px)'}
              onMouseOut={e => e.currentTarget.style.transform = 'none'}
            >
              <PenTool size={18} /> Write Article
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ResultsPage;
