import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Check, ChevronDown, Plus, RefreshCw, Tags } from 'lucide-react';
import { config } from '../config';
import { getStoredUser } from '../utils/roles';
import KeywordResearchCard from '../components/KeywordResearchCard';
import KeywordResearchForm from '../components/KeywordResearchForm';
import SearchStatusCard from '../components/SearchStatusCard';
import SerpResultsPanel from '../components/SerpResultsPanel';
import '../styles/KeywordResearchPage.css';

const STORAGE_KEY = 'surfox.keywordResearch.history';



function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch (error) {
    return [];
  }
  return [];
}

function KeywordResearchPage({ onSearchComplete }) {
  const navigate = useNavigate();
  const userObj = getStoredUser();
  const authHeaders = useMemo(() => (
    userObj?.token ? { Authorization: `Bearer ${userObj.token}` } : {}
  ), [userObj?.token]);
  const [history, setHistory] = useState(readHistory);
  const [activeResearch, setActiveResearch] = useState(null);
  const [showNewResearch, setShowNewResearch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [searchTime, setSearchTime] = useState(0);
  const [nlpKeywords, setNlpKeywords] = useState([]);
  const [selectedKeywordIds, setSelectedKeywordIds] = useState([]);
  const [keywordsLoading, setKeywordsLoading] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);
  const [formData, setFormData] = useState({
    keyword: '',
    k: 10,
    device: 'desktop',
    use_proxy: true,
    use_browser: true
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, 30)));
  }, [history]);

  useEffect(() => {
    let interval;
    if (loading) {
      interval = setInterval(() => setElapsed((prev) => prev + 1), 1000);
    }
    return () => clearInterval(interval);
  }, [loading]);

  const loadNlpKeywords = useCallback(async () => {
    setKeywordsLoading(true);
    try {
      const response = await axios.get(`${config.API_URL}${config.NLP_KEYWORDS_ENDPOINT}`, {
        headers: authHeaders,
      });
      const outputs = response.data?.items || [];
      const nextKeywords = outputs.flatMap((item) =>
        ['Green', 'Orange', 'White'].flatMap((category) =>
          (item.keywords_json?.[category] || []).map((keyword, index) => ({
            id: `${item.id}-${category}-${index}`,
            keyword,
            category,
            source_keyword: item.source_keyword,
            is_selected: true,
          }))
        )
      );
      setNlpKeywords(nextKeywords);
      setSelectedKeywordIds(nextKeywords.filter((item) => item.is_selected).map((item) => item.id));
    } catch (error) {
      const message = error.response?.data?.detail || 'Could not load NLP keywords from database';
      toast.error(message);
    } finally {
      setKeywordsLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    loadNlpKeywords();
  }, [loadNlpKeywords]);

  const hasResults = activeResearch?.results?.length > 0;

  const sortedHistory = useMemo(() => {
    return [...history].sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });
  }, [history]);

  const handleInputChange = (event) => {
    const { name, value, type, checked } = event.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : type === 'number' ? Number(value) : value
    }));
  };

  const handleStartNewResearch = () => {
    setShowNewResearch(true);
    setSearchTime(0);
    setActiveResearch(null);
  };

  const handleOpenResearch = (research) => {
    setActiveResearch(research);
    setShowNewResearch(false);
    setSearchTime(Number(research.searchTime || 0));
  };

  const openResultsPage = (research = activeResearch) => {
    if (!research?.results?.length) return;
    onSearchComplete({
      session_id: research.sessionId,
      results: research.results
    });
    navigate('/results', {
      state: {
        results: research.results,
        sessionId: research.sessionId,
        keyword: research.keyword,
        searchTime: Number(research.searchTime || searchTime || 0),
        timing: research.timing || {}
      }
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const keyword = formData.keyword.trim();
    if (!keyword) {
      toast.error('Please enter a keyword');
      return;
    }

    setLoading(true);
    setElapsed(0);
    setSearchTime(0);
    setActiveResearch({
      id: `pending-${Date.now()}`,
      keyword,
      location: formData.use_proxy ? 'United States' : 'Default location',
      results: []
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
        use_browser: formData.use_browser
      });

      const nextSearchTime = (Date.now() - startedAt) / 1000;
      const nextResearch = {
        id: response.data.session_id || `research-${Date.now()}`,
        keyword,
        location: formData.use_proxy ? 'United States' : 'Default location',
        resultCount: response.data.total_results || response.data.results?.length || 0,
        results: response.data.results || [],
        sessionId: response.data.session_id,
        timing: response.data.timing || {},
        searchTime: nextSearchTime,
        device: formData.device,
        createdAt: new Date().toISOString()
      };

      setSearchTime(nextSearchTime);
      setActiveResearch(nextResearch);
      setHistory((prev) => [nextResearch, ...prev.filter((item) => item.id !== nextResearch.id)].slice(0, 30));
      onSearchComplete(response.data);
      loadNlpKeywords();
      toast.success('Keyword research completed');
    } catch (error) {
      console.error('Keyword research error:', error);
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

  const toggleKeywordSelection = (keywordId) => {
    setSelectedKeywordIds((prev) =>
      prev.includes(keywordId) ? prev.filter((id) => id !== keywordId) : [...prev, keywordId]
    );
  };

  const saveSelectedKeywords = async () => {
    if (selectedKeywordIds.length === 0) {
      toast.error('Select at least one keyword');
      return;
    }

    setSavingSelection(true);
    try {
      const selected = nlpKeywords.filter((item) => selectedKeywordIds.includes(item.id));
      const grouped = selected.reduce((acc, item) => {
        acc[item.category] = [...(acc[item.category] || []), item.keyword];
        return acc;
      }, { Green: [], Orange: [], White: [] });
      const sourceKeyword = activeResearch?.keyword || selected[0]?.source_keyword || 'selected_keywords';
      await axios.post(`${config.API_URL}${config.SELECT_NLP_KEYWORDS_ENDPOINT}`, {
        source_keyword: sourceKeyword,
        file_name: `${sourceKeyword.replace(/[^\w\s-]/g, '').replace(/[-\s]+/g, '_') || 'selected_keywords'}.json`,
        json_output: grouped
      }, {
        headers: authHeaders,
      });
      toast.success(`${selectedKeywordIds.length} keywords saved`);
      loadNlpKeywords();
    } catch (error) {
      const message = error.response?.data?.detail || 'Could not save selected keywords';
      toast.error(message);
    } finally {
      setSavingSelection(false);
    }
  };

  const visibleNlpKeywords = nlpKeywords.slice(0, 250);

  return (
    <main className="keyword-research-page">
      <section className="keyword-research-shell">
        <div className="keyword-research-topbar">
          <h1>Keyword Research</h1>
          <div className="topbar-actions">
            <button type="button" className="ghost-icon-button" aria-label="Keyword tools">
              <Tags size={18} />
            </button>
            <button type="button" className="new-keyword-button" onClick={handleStartNewResearch}>
              <Plus size={16} />
              New Keyword Research
            </button>
          </div>
        </div>

        <div className="keyword-research-layout">
          <div className="research-list-panel">
            <div className="research-filter-row">
              <button type="button" className="filter-button">
                Tags
                <ChevronDown size={15} />
              </button>
            </div>

            <div className="research-list">
              {sortedHistory.map((research) => (
                <KeywordResearchCard
                  key={research.id}
                  research={research}
                  active={activeResearch?.id === research.id}
                  onOpen={handleOpenResearch}
                />
              ))}
            </div>
          </div>

          <aside className="research-detail-panel">
            {showNewResearch && (
              <section className="detail-card">
                <div className="detail-card-header">
                  <h2>New keyword research</h2>
                  <p>Search live Google results and collect competitor domains.</p>
                </div>
                <KeywordResearchForm
                  formData={formData}
                  loading={loading}
                  onChange={handleInputChange}
                  onSubmit={handleSubmit}
                />
              </section>
            )}

            {loading && <SearchStatusCard keyword={activeResearch?.keyword || formData.keyword} elapsed={elapsed} />}

            {!loading && hasResults && (
              <SerpResultsPanel
                results={activeResearch.results}
                keyword={activeResearch.keyword}
                searchTime={searchTime || activeResearch.searchTime}
                onOpenResults={() => openResultsPage(activeResearch)}
              />
            )}

            <section className="nlp-keyword-selector">
              <div className="nlp-selector-header">
                <div>
                  <h2>NLP keywords</h2>
                  <p>Select keywords to save in the selected_keyword column.</p>
                </div>
                <button
                  type="button"
                  className="ghost-icon-button"
                  aria-label="Refresh NLP keywords"
                  onClick={loadNlpKeywords}
                  disabled={keywordsLoading}
                >
                  <RefreshCw size={17} className={keywordsLoading ? 'spin-icon' : ''} />
                </button>
              </div>

              <div className="nlp-keyword-list">
                {visibleNlpKeywords.map((item) => {
                  const checked = selectedKeywordIds.includes(item.id);
                  return (
                    <label className="nlp-keyword-row" key={item.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleKeywordSelection(item.id)}
                      />
                      <span className="nlp-keyword-main">
                        <span className="nlp-keyword-text">{item.keyword}</span>
                        <span className="nlp-keyword-meta">
                          {item.category} | {item.source_keyword}
                        </span>
                      </span>
                      {item.is_selected && <Check size={16} className="nlp-selected-icon" />}
                    </label>
                  );
                })}

                {!keywordsLoading && visibleNlpKeywords.length === 0 && (
                  <p className="nlp-keyword-empty">No NLP keywords in PostgreSQL yet.</p>
                )}
              </div>

              <button
                type="button"
                className="keyword-submit"
                onClick={saveSelectedKeywords}
                disabled={savingSelection || selectedKeywordIds.length === 0}
              >
                <Check size={16} />
                Save selected keywords
              </button>
            </section>

            {!showNewResearch && !loading && !hasResults && (
              <section className="empty-detail-card">
                <h2>Select or create research</h2>
                <p>Open a previous keyword or start a new search to show live SERP domains here.</p>
                <button type="button" className="new-keyword-button" onClick={handleStartNewResearch}>
                  <Plus size={16} />
                  New Keyword Research
                </button>
              </section>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

export default KeywordResearchPage;
