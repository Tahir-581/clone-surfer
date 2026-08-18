import React from 'react';
import { ExternalLink, FileText, Hash, ShieldCheck } from 'lucide-react';

function getDomainInitial(domain) {
  const clean = (domain || '?').replace(/^www\./, '').trim();
  return clean.charAt(0).toUpperCase() || '?';
}

function SerpResultsPanel({ results, keyword, searchTime, onOpenResults }) {
  if (!results || results.length === 0) {
    return null;
  }

  return (
    <section className="serp-results-panel">
      <div className="serp-results-header">
        <div>
          <h2>Google Search results</h2>
          <p>{keyword}</p>
        </div>
        <button type="button" className="open-results-button" onClick={onOpenResults}>
          Open full results
        </button>
      </div>

      <div className="result-meta-row">
        <span><Hash size={14} /> {results.length} results</span>
        {searchTime > 0 && <span>{searchTime.toFixed(2)}s</span>}
      </div>

      <div className="serp-card-list">
        {results.map((result, index) => (
          <article className="serp-card" key={`${result.url}-${index}`}>
            <div className="serp-rank">{result.rank ?? index + 1}</div>
            <div className="domain-favicon large">{getDomainInitial(result.domain)}</div>
            <div className="serp-card-main">
              <a href={result.url} target="_blank" rel="noopener noreferrer" className="serp-title">
                {result.title || result.domain || 'Untitled result'}
                <ExternalLink size={14} aria-hidden="true" />
              </a>
              <div className="serp-domain">{result.domain}</div>
              <div className="serp-stats">
                <span><FileText size={14} /> {result.word_count || 0} words</span>
                <span><ShieldCheck size={14} /> Authority {result.authority ?? 0}/10</span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default SerpResultsPanel;
