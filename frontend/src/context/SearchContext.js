import React, { createContext, useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { useNavigate } from 'react-router-dom';
import { config } from '../config';
import { getStoredUser } from '../utils/roles';

export const SearchContext = createContext();

const SEARCH_STEPS = [
  'Searching Google results',
  'Reading competitor pages',
  'Extracting NLP keywords',
  'Ranking keyword groups',
  'Saving JSON output'
];

const SEARCH_PROGRESS_SVG = '/dog.svg';
<object type="image/svg+xml" data={SEARCH_PROGRESS_SVG} className="w-48 h-48" />
export const SearchProvider = ({ children }) => {
  const navigate = useNavigate();

  // Search progress and execution states
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [activeQuery, setActiveQuery] = useState('');
  const [currentProgress, setCurrentProgress] = useState({ step: 'Idle', domain: '', detail: '' });

  // Live domain progress log — shown during both single & batch searches
  const [progressLogs, setProgressLogs] = useState([]);
  const lastLogKeyRef = useRef('');

  const addProgressLog = (log) => {
    // Deduplicate: only add if domain+step combo has changed
    const key = `${log.domain}|${log.step}`;
    if (key === lastLogKeyRef.current) return;
    lastLogKeyRef.current = key;
    setProgressLogs((prev) => [...prev, { ...log, timestamp: Date.now() }]);
  };

  const clearProgressLogs = () => {
    setProgressLogs([]);
    lastLogKeyRef.current = '';
  };

  // Form input states (persisted when navigating away)
  const [keyword, setKeyword] = useState('');
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [device, setDevice] = useState('mobile');
  const [useProxy, setUseProxy] = useState(false);

  // Poll progress from backend while a search is running
  useEffect(() => {
    let timer;
    let progressTimer;

    if (loading && activeQuery) {
      timer = setInterval(() => setElapsed((v) => v + 1), 1000);

      const pollProgress = async () => {
        try {
          const userObj = getStoredUser();
          const authHeaders = userObj?.token ? { Authorization: `Bearer ${userObj.token}` } : {};
          const res = await axios.get(
            `${config.API_URL}/search/progress?keyword=${encodeURIComponent(activeQuery.trim())}`,
            { headers: authHeaders }
          );
          if (res.data) {
            setCurrentProgress(res.data);
            if (res.data.domain || res.data.step) {
              addProgressLog({
                domain: res.data.domain || '',
                step: res.data.step || '',
                detail: res.data.detail || ''
              });
            }
            const idx = SEARCH_STEPS.indexOf(res.data.step);
            if (idx !== -1) setStepIndex(idx);
          }
        } catch (e) {
          // Silent — polling errors are non-critical
          console.warn('Progress poll error:', e?.message);
        }
      };

      pollProgress();
      progressTimer = setInterval(pollProgress, 800);
    } else {
      setCurrentProgress({ step: 'Idle', domain: '', detail: '' });
    }

    return () => {
      clearInterval(timer);
      clearInterval(progressTimer);
    };
  }, [loading, activeQuery]);

  // Global search execution — persists across page navigation
  const executeSearch = async ({
    query,
    isBatch,
    currentDevice,
    currentUseProxy,
    onSearchComplete,
    reloadHistory
  }) => {
    const userObj = getStoredUser();
    const authHeaders = userObj?.token ? { Authorization: `Bearer ${userObj.token}` } : {};

    clearProgressLogs();
    setActiveQuery(query);
    setLoading(true);
    setElapsed(0);
    setStepIndex(0);
    const startedAt = Date.now();

    try {
      if (isBatch) {
        // ── Batch Search ──────────────────────────────────────────────
        const keywordsList = query
          .split('\n')
          .map((k) => k.trim())
          .filter((k) => k);

        const response = await axios.post(
          `${config.API_URL}${config.BATCH_SEARCH_ENDPOINT}`,
          {
            keywords: keywordsList,
            k: 20,
            device: currentDevice,
            use_proxy: currentUseProxy,
            headless: false,
            use_browser: true
          },
          { headers: authHeaders }
        );

        const { completed = 0, failed = 0 } = response.data || {};
        toast.success(`Batch complete: ${completed} succeeded, ${failed} failed.`);
        if (reloadHistory) await reloadHistory(1, false);
        setKeyword('');
      } else {
        // ── Single Search ─────────────────────────────────────────────
        const response = await axios.post(
          `${config.API_URL}${config.SEARCH_ENDPOINT}`,
          {
            keyword: query,
            k: 20,
            device: currentDevice,
            use_proxy: currentUseProxy,
            headless: false,
            use_browser: true
          },
          { headers: authHeaders }
        );

        const searchTime = (Date.now() - startedAt) / 1000;
        if (onSearchComplete) onSearchComplete(response.data);
        if (reloadHistory) await reloadHistory(1, false);

        navigate('/results', {
          state: {
            results: response.data.results || [],
            sessionId: response.data.session_id,
            keyword: query,
            searchTime,
            timing: response.data.timing || {}
          }
        });
      }
    } catch (error) {
      console.error('Search error:', error);
      const message =
        error.response?.data?.detail ||
        (error.request
          ? `Cannot reach backend at ${config.API_URL}. Make sure backend is running.`
          : error.message) ||
        'Search failed';
      toast.error(message);
    } finally {
      setLoading(false);
      setElapsed(0);
      setStepIndex(0);
      setActiveQuery('');
      clearProgressLogs();
    }
  };

  return (
    <SearchContext.Provider
      value={{
        // Status
        loading,
        elapsed,
        stepIndex,
        activeQuery,
        currentProgress,
        SEARCH_STEPS,
        SEARCH_PROGRESS_SVG,
        // Live domain logs (for progress UI)
        progressLogs,
        addProgressLog,
        clearProgressLogs,
        // Form state
        keyword,
        setKeyword,
        isBatchMode,
        setIsBatchMode,
        device,
        setDevice,
        useProxy,
        setUseProxy,
        // Action
        executeSearch
      }}
    >
      {children}
    </SearchContext.Provider>
  );
};
