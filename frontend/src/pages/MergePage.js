import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

function MergePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { mergeData } = location.state || {};

  if (!mergeData) {
    return (
      <div className="page-container merge-page">
        <div className="page-header">
          <h2>Analysis Results</h2>
          <p>No data available</p>
        </div>
        <button 
          className="btn-action btn-secondary" 
          onClick={() => navigate('/')}
        >
          Back to Search
        </button>
      </div>
    );
  }

  const stats = mergeData.average_statistics || {};
  const entities = mergeData.entities || [];

  const getTier = (score) => {
    const s = score != null ? Number(score) : 0;
    if (s > 0.5) return 'tier-high'; // similarity > 0.5 -> green
    return 'tier-medium'; // rest are orange by default
  };

  // Compute score helpers once
  const scoredEntities = entities.map((entity) => ({
    entity,
    score: entity.average_weightage != null ? Number(entity.average_weightage) : 0,
  }));

  // New coloring logic:
  // - Green: top 40% of merged NLPs (by score)
  // - Orange: remaining 60% of merged NLPs
  // - White: from the "other clusters" approximation -> top 10% of remaining items
  let highEntities = [];
  let whiteEntities = [];
  let mediumEntities = [];

  if (scoredEntities.length > 0) {
    const sorted = [...scoredEntities].sort((a, b) => b.score - a.score);
    const total = sorted.length;

    const greenCount = Math.max(1, Math.floor(total * 0.4));
    const highSlice = sorted.slice(0, greenCount);
    const remaining = sorted.slice(greenCount);

    const whiteCount = remaining.length > 0 ? Math.max(1, Math.floor(remaining.length * 0.1)) : 0;
    const whiteSlice = remaining.slice(0, whiteCount);
    const mediumSlice = remaining.slice(whiteCount);

    highEntities = highSlice.map(({ entity }) => entity);
    whiteEntities = whiteSlice.map(({ entity }) => entity);
    mediumEntities = mediumSlice.map(({ entity }) => entity);
  }

  return (
    <div className="page-container merge-page">
      <div className="page-header">
        <h2>Entity Analysis</h2>
        <p>Aggregated insights from {mergeData.total_files_processed} domains</p>
      </div>

      {/* Statistics Cards */}
      <div className="merge-stats">
        <div className="stat-card">
          <h3>Unique Entities</h3>
          <div className="value">{mergeData.total_unique_entities}</div>
        </div>
        <div className="stat-card">
          <h3>Total Occurrences</h3>
          <div className="value">{mergeData.total_entity_occurrences}</div>
        </div>
        <div className="stat-card">
          <h3>Avg Word Count</h3>
          <div className="value">{stats.avg_word_count || 0}</div>
        </div>
        <div className="stat-card">
          <h3>Avg Headings</h3>
          <div className="value">{stats.avg_heading_count || 0}</div>
        </div>
      </div>

      {/* Entities List */}
      <div className="entities-container">
        <h3>Extracted Entities (Hover for details)</h3>
        {entities.length > 0 && (
          <div style={{ marginBottom: '0.75rem', fontSize: '0.85rem', color: '#4b5563' }}>
            <span style={{ marginRight: '1rem' }}>
              Total: <strong>{entities.length}</strong>
            </span>
            <span style={{ marginRight: '1rem', color: '#059669', fontWeight: 600 }}>
              Green: {highEntities.length}
            </span>
            <span style={{ marginRight: '1rem', color: '#ea580c', fontWeight: 600 }}>
              Orange: {mediumEntities.length}
            </span>
            <span style={{ color: '#4b5563', fontWeight: 600 }}>
              White: {whiteEntities.length}
            </span>
          </div>
        )}
        {entities.length > 0 ? (
          <div className="merge-entities-grid">
            {/* Cluster 1: green (score > 0.5) */}
            {highEntities.map((entity, idx) => {
              const score = entity.average_weightage != null ? Number(entity.average_weightage) : 0;
              const tier = getTier(score); // will be 'tier-high'
              return (
              <React.Fragment key={`high-${idx}`}>
                <div className={`merge-entity-card ${tier}`}>
                <div className="merge-entity-main">
                  <div className="merge-entity-text">{entity.text}</div>
                </div>
                <div className="merge-entity-bottom">
                  <span className="merge-entity-meta">Score: {entity.average_weightage != null ? Number(entity.average_weightage).toFixed(3) : '—'}</span>
                  <span className="merge-entity-meta">Count: {entity.combined_count}</span>
                  <span className="merge-entity-meta">{entity.competitor_count} domain(s)</span>
                </div>
                <div className="entity-tooltip">
                  <div className="tooltip-title">Term Details</div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Method:</span>
                    <span className="tooltip-value">{mergeData.ranking_method === 'crossencoder' ? 'CrossEncoder' : 'BiEncoder'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Score:</span>
                    <span className="tooltip-value">{entity.average_weightage != null ? Number(entity.average_weightage).toFixed(3) : '—'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Count:</span>
                    <span className="tooltip-value">{entity.combined_count}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Found in:</span>
                    <span className="tooltip-value">{entity.competitor_count} domain(s)</span>
                  </div>
                  {entity.found_in_files && entity.found_in_files.length > 0 && (
                    <div style={{ marginTop: '0.8rem', paddingTop: '0.8rem', borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                      <div style={{ marginBottom: '0.3rem' }}>Domains:</div>
                      <div style={{ fontSize: '0.8rem', opacity: 0.9 }}>
                        {entity.found_in_files.join(', ')}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              </React.Fragment>
            );})}

            {/* Orange: all remaining non‑cluster‑1 terms */}
            {mediumEntities.length > 0 && <div className="nlp-tier-break" />}
            {mediumEntities.map((entity, idx) => {
              const tier = 'tier-medium';
              return (
              <React.Fragment key={`med-${idx}`}>
                <div className={`merge-entity-card ${tier}`}>
                <div className="merge-entity-main">
                  <div className="merge-entity-text">{entity.text}</div>
                </div>
                <div className="merge-entity-bottom">
                  <span className="merge-entity-meta">Score: {entity.average_weightage != null ? Number(entity.average_weightage).toFixed(3) : '—'}</span>
                  <span className="merge-entity-meta">Count: {entity.combined_count}</span>
                  <span className="merge-entity-meta">{entity.competitor_count} domain(s)</span>
                </div>
                <div className="entity-tooltip">
                  <div className="tooltip-title">Term Details</div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Method:</span>
                    <span className="tooltip-value">{mergeData.ranking_method === 'crossencoder' ? 'CrossEncoder' : 'BiEncoder'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Score:</span>
                    <span className="tooltip-value">{entity.average_weightage != null ? Number(entity.average_weightage).toFixed(3) : '—'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Count:</span>
                    <span className="tooltip-value">{entity.combined_count}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Found in:</span>
                    <span className="tooltip-value">{entity.competitor_count} domain(s)</span>
                  </div>
                  {entity.found_in_files && entity.found_in_files.length > 0 && (
                    <div style={{ marginTop: '0.8rem', paddingTop: '0.8rem', borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                      <div style={{ marginBottom: '0.3rem' }}>Domains:</div>
                      <div style={{ fontSize: '0.8rem', opacity: 0.9 }}>
                        {entity.found_in_files.join(', ')}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              </React.Fragment>
            );})}

            {/* White: all NLPs from the top 5 remaining clusters (by similarity) */}
            {whiteEntities.length > 0 && <div className="nlp-tier-break" />}
            {whiteEntities.map((entity, idx) => {
              const tier = 'tier-low'; // white section
              return (
              <React.Fragment key={`white-${idx}`}>
                <div className={`merge-entity-card ${tier}`}>
                <div className="merge-entity-main">
                  <div className="merge-entity-text">{entity.text}</div>
                </div>
                <div className="merge-entity-bottom">
                  <span className="merge-entity-meta">Score: {entity.average_weightage != null ? Number(entity.average_weightage).toFixed(3) : '—'}</span>
                  <span className="merge-entity-meta">Count: {entity.combined_count}</span>
                  <span className="merge-entity-meta">{entity.competitor_count} domain(s)</span>
                </div>
                <div className="entity-tooltip">
                  <div className="tooltip-title">Term Details</div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Method:</span>
                    <span className="tooltip-value">{mergeData.ranking_method === 'crossencoder' ? 'CrossEncoder' : 'BiEncoder'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Score:</span>
                    <span className="tooltip-value">{entity.average_weightage != null ? Number(entity.average_weightage).toFixed(3) : '—'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Count:</span>
                    <span className="tooltip-value">{entity.combined_count}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Found in:</span>
                    <span className="tooltip-value">{entity.competitor_count} domain(s)</span>
                  </div>
                  {entity.found_in_files && entity.found_in_files.length > 0 && (
                    <div style={{ marginTop: '0.8rem', paddingTop: '0.8rem', borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                      <div style={{ marginBottom: '0.3rem' }}>Domains:</div>
                      <div style={{ fontSize: '0.8rem', opacity: 0.9 }}>
                        {entity.found_in_files.join(', ')}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              </React.Fragment>
            );})}
          </div>
        ) : (
          <p style={{ color: '#666', textAlign: 'center', padding: '2rem' }}>No entities found</p>
        )}
      </div>

      {/* Action Buttons */}
      <div className="action-bar" style={{ marginTop: '2rem' }}>
        <button 
          className="btn-action btn-secondary" 
          onClick={() => navigate('/')}
        >
          New Search
        </button>
        <button 
          className="btn-action btn-secondary" 
          onClick={() => navigate(-1)}
        >
          Back to Results
        </button>
      </div>
    </div>
  );
}

export default MergePage;
