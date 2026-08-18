import React from 'react';
import { Search } from 'lucide-react';

function Header() {
  return (
    <header className="header">
      <div className="header-content">
        <h1>Surfox</h1>
        <div className="global-search">
          <Search size={16} />
          <span>Search</span>
          <kbd>Ctrl+K</kbd>
        </div>

      </div>
    </header>
  );
}

export default Header;
