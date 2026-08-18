import React from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';

const steps = [
  'Generating search request',
  'Getting Google search results',
  'Crawling pages',
  'Calculating content scores and NLP data'
];

function SearchStatusCard({ keyword, elapsed }) {
  return (
    <section className="status-card" aria-live="polite">
      <div className="status-card-header">
        <div>
          <h2>Deep analysis</h2>
          <p>{keyword}</p>
        </div>
        <span className="status-time">{elapsed}s</span>
      </div>

      <div className="status-group">
        <div className="status-group-title">
          <Loader2 className="spin-icon" size={18} />
          AI Search
          <span className="mini-engine">G</span>
          <span className="mini-engine">AI</span>
        </div>
        {steps.map((step, index) => (
          <div className="status-row" key={step}>
            {index === 0 ? <Check size={16} /> : <Circle size={14} />}
            <span>{step}</span>
          </div>
        ))}
      </div>

      <div className="status-group">
        <div className="status-group-title">
          <Loader2 className="spin-icon" size={18} />
          Google Search results
          <span className="mini-engine google-engine">G</span>
        </div>
        <div className="status-row">
          <Circle size={14} />
          <span>Fetching live SERP domains from the backend</span>
        </div>
      </div>
    </section>
  );
}

export default SearchStatusCard;
