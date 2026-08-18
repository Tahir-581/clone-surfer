/* Runtime configuration - loaded by index.html */
(function attachRuntimeConfig() {
  const backendPort = '8010';
  const { protocol, hostname, origin, port } = window.location;
  const apiUrl = !port || port === backendPort
    ? origin
    : `${protocol}//${hostname}:${backendPort}`;

  window.__APP_CONFIG__ = {
    API_URL: apiUrl,
    BACKEND_PORT: backendPort,
    SEARCH_ENDPOINT: '/search',
    BATCH_SEARCH_ENDPOINT: '/batch_search',
    MERGE_ENDPOINT: '/merge',
    NLP_KEYWORDS_ENDPOINT: '/nlp-keywords',
    SELECT_NLP_KEYWORDS_ENDPOINT: '/nlp-keywords/select',
  };
})();
