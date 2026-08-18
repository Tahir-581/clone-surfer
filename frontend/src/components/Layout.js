import React from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import './Layout.css';

const Layout = ({ children }) => {
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const location = useLocation();

  // Define paths where the sidebar should NOT be shown
  const noSidebarPaths = ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/article-writer'];
  const showSidebar = !noSidebarPaths.some(path => location.pathname.startsWith(path));

  if (!showSidebar) {
    const isAuthPath = ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email'].some(path => location.pathname.startsWith(path));
    return (
      <div className={`layout-container ${isAuthPath ? 'auth-layout' : 'full-width-layout'}`}>
        <main className={`main-content full-width ${isAuthPath ? '' : 'no-padding'}`}>
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className={`layout-container ${isCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} />
      <main className="main-content">
        {children}
      </main>
    </div>
  );
};

export default Layout;
