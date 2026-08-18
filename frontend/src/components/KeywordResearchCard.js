import React from 'react';
import { ExternalLink, MoreHorizontal, Plus } from 'lucide-react';

function getDomainInitial(domain) {
  const clean = (domain || '?').replace(/^www\./, '').trim();
  return clean.charAt(0).toUpperCase() || '?';
}

function KeywordResearchCard({ research, active, onOpen }) {
  const results = Array.isArray(research.results) ? research.results : [];
  const shownResults = results.slice(0, 4);

  return (
    <article className={`research-card ${active ? 'research-card-active' : ''}`}>
      <div className="research-card-header">
        <button type="button" className="research-title-button" onClick={() => onOpen(research)}>
          <span className="research-title">{research.keyword}</span>
          <span className="research-location">{research.location || 'United States'}</span>
        </button>
        <button type="button" className="icon-button" aria-label="More actions">
          <MoreHorizontal size={18} />
        </button>
      </div>

      {shownResults.length > 0 && (
        <div className="research-serp-preview">
          {shownResults.map((result, index) => (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="serp-preview-item"
              key={`${result.url}-${index}`}
              title={result.title || result.domain}
            >
              <span className="domain-favicon">{getDomainInitial(result.domain)}</span>
              <span className="serp-preview-domain">{result.domain || 'Unknown domain'}</span>
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          ))}
        </div>
      )}

      <div className="research-card-footer">
        <button type="button" className="tag-button">
          <Plus size={15} />
          Tag
        </button>
        <span>{results.length ? `${results.length} results` : 'Ready'}</span>
      </div>
    </article>
  );
}

export default KeywordResearchCard;
