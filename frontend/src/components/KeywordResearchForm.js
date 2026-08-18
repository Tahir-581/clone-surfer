import React from 'react';
import { Globe2, Monitor, Search, Smartphone } from 'lucide-react';

function KeywordResearchForm({ formData, loading, onChange, onSubmit }) {
  return (
    <form className="keyword-form" onSubmit={onSubmit}>
      <div className="form-group">
        <label htmlFor="keyword">Search keyword</label>
        <div className="keyword-input-wrap">
          <Search size={17} aria-hidden="true" />
          <input
            id="keyword"
            type="text"
            name="keyword"
            placeholder="e.g., dog breeds with short snouts"
            value={formData.keyword}
            onChange={onChange}
            disabled={loading}
          />
        </div>
      </div>

      <div className="keyword-form-grid">
        <div className="form-group">
          <label htmlFor="k">Number of results</label>
          <input
            id="k"
            type="number"
            name="k"
            min="5"
            max="50"
            value={formData.k}
            onChange={onChange}
            disabled={loading}
          />
        </div>

        <div className="form-group">
          <label htmlFor="device">Device type</label>
          <select
            id="device"
            name="device"
            value={formData.device}
            onChange={onChange}
            disabled={loading}
          >
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
          </select>
        </div>
      </div>

      <div className="keyword-options">
        <label className="option-pill" htmlFor="browser">
          <input
            id="browser"
            type="checkbox"
            name="use_browser"
            checked={formData.use_browser}
            onChange={onChange}
            disabled={loading}
          />
          {formData.device === 'mobile' ? <Smartphone size={16} /> : <Monitor size={16} />}
          <span>Use browser</span>
        </label>

        <label className="option-pill" htmlFor="usa_proxy">
          <input
            id="usa_proxy"
            type="checkbox"
            name="use_proxy"
            checked={formData.use_proxy}
            onChange={onChange}
            disabled={loading}
          />
          <Globe2 size={16} />
          <span>USA location</span>
        </label>
      </div>

      <button type="submit" className="keyword-submit" disabled={loading}>
        {loading ? (
          <>
            <span className="loading"></span>
            Searching
          </>
        ) : (
          <>
            <Search size={17} />
            Search
          </>
        )}
      </button>
    </form>
  );
}

export default KeywordResearchForm;
