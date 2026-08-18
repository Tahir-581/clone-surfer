// Configuration loader that supports both development and production.
// This is a lazy getter to ensure window.__APP_CONFIG__ is available when accessed.
function deriveDefaultApiUrl() {
  if (typeof window !== 'undefined' && window.location) {
    const runtimePort = window.__APP_CONFIG__ && window.__APP_CONFIG__.BACKEND_PORT;
    const envPort = process.env.REACT_APP_BACKEND_PORT;
    const backendPort = runtimePort || envPort || '8010';
    const { protocol, hostname, port } = window.location;

    if (!port || port === backendPort) {
      return window.location.origin;
    }

    return `${protocol}//${hostname}:${backendPort}`;
  }

  return process.env.REACT_APP_API_URL || 'http://localhost:8010';
}

export const config = {
  get API_URL() {
    // Priority 1: Runtime config (supports same artifact across multiple hosts)
    if (typeof window !== 'undefined' && window.__APP_CONFIG__ && window.__APP_CONFIG__.API_URL) {
      return window.__APP_CONFIG__.API_URL;
    }

    // Priority 2: Build-time environment variable
    if (process.env.REACT_APP_API_URL) {
      return process.env.REACT_APP_API_URL;
    }

    // Priority 3: Derive backend URL for either same-origin hosting or split frontend/backend ports.
    return deriveDefaultApiUrl();
  },

  get SEARCH_ENDPOINT() {
    if (typeof window !== 'undefined' && window.__APP_CONFIG__ && window.__APP_CONFIG__.SEARCH_ENDPOINT) {
      return window.__APP_CONFIG__.SEARCH_ENDPOINT;
    }
    return process.env.REACT_APP_SEARCH_ENDPOINT || '/search';
  },

  get BATCH_SEARCH_ENDPOINT() {
    if (typeof window !== 'undefined' && window.__APP_CONFIG__ && window.__APP_CONFIG__.BATCH_SEARCH_ENDPOINT) {
      return window.__APP_CONFIG__.BATCH_SEARCH_ENDPOINT;
    }
    return process.env.REACT_APP_BATCH_SEARCH_ENDPOINT || '/batch_search';
  },

  get MERGE_ENDPOINT() {
    if (typeof window !== 'undefined' && window.__APP_CONFIG__ && window.__APP_CONFIG__.MERGE_ENDPOINT) {
      return window.__APP_CONFIG__.MERGE_ENDPOINT;
    }
    return process.env.REACT_APP_MERGE_ENDPOINT || '/merge';
  },

  get NLP_KEYWORDS_ENDPOINT() {
    if (typeof window !== 'undefined' && window.__APP_CONFIG__ && window.__APP_CONFIG__.NLP_KEYWORDS_ENDPOINT) {
      return window.__APP_CONFIG__.NLP_KEYWORDS_ENDPOINT;
    }
    return process.env.REACT_APP_NLP_KEYWORDS_ENDPOINT || '/nlp-keywords';
  },

  get SELECT_NLP_KEYWORDS_ENDPOINT() {
    if (
      typeof window !== 'undefined' &&
      window.__APP_CONFIG__ &&
      window.__APP_CONFIG__.SELECT_NLP_KEYWORDS_ENDPOINT
    ) {
      return window.__APP_CONFIG__.SELECT_NLP_KEYWORDS_ENDPOINT;
    }
    return process.env.REACT_APP_SELECT_NLP_KEYWORDS_ENDPOINT || '/nlp-keywords/select';
  }
};
