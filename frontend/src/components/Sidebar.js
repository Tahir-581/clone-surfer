import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  FileEdit,
  Globe,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Search,
  Lightbulb,
  Key,
  Activity,
  UserCircle,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  LogOut,
  PenTool,
  Shield,
  Eye,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { getStoredUser, canAccessKeywordResearch, normalizeRole, logout } from '../utils/roles';
import './Sidebar.css';

const Sidebar = ({ isCollapsed, setIsCollapsed }) => {
  const [isToolsOpen, setIsToolsOpen] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { theme } = useTheme();

  const user = getStoredUser();
  const role = normalizeRole(user?.role);

  // ── Role label map ─────────────────────────────────────────────────────────
  const ROLE_LABELS = {
    admin: 'Administrator',
    outliner: 'Outliner',
    content_writer: 'Content Writer',
    content_editor: 'Content Editor',
    compliance_manager: 'Compliance Manager',
    publisher: 'Publisher',
  };

  // ── Primary nav items (role-filtered) ──────────────────────────────────────
  const allNavItems = [
    { name: 'Dashboard', icon: <LayoutDashboard size={20} />, path: '/dashboard', roles: null }, // all roles
    { name: 'Content Editor', icon: <FileEdit size={20} />, path: '/content-editor', roles: ['content_writer', 'content_editor', 'compliance_manager', 'publisher', 'admin'] },


  ];

  const navItems = allNavItems.filter(item => {
    if (!item.roles) return true; // visible to all
    return item.roles.includes(role) || role === 'admin';
  });

  // ── Tools sub-menu (keyword research – outliner + admin only) ──────────────
  const allToolItems = [
    { name: 'Keyword Research', icon: <Key size={18} />, path: '/', roles: ['outliner', 'admin'] },
  ];

  const toolItems = allToolItems.filter(item =>
    item.roles.includes(role) || role === 'admin'
  );

  const showToolsSection = toolItems.length > 0;

  const toggleMobileMenu = () => setIsMobileMenuOpen(!isMobileMenuOpen);

  const handleLogout = () => {
    logout('/login');
  };

  return (
    <>
      <button className="mobile-toggle" onClick={toggleMobileMenu}>
        {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
      </button>

      <aside className={`sidebar ${isMobileMenuOpen ? 'mobile-open' : ''} ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo-container">
            <img src="/surfoxlogo.png" alt="Surfox Logo" className="sidebar-logo" />
          </div>
          <button
            className="collapse-toggle"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            {isCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>

        <nav className="sidebar-nav">
          {/* Primary nav */}
          <div className="nav-section">
            {navItems.map((item) => (
              <NavLink
                key={item.name}
                to={item.path}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                onClick={() => setIsMobileMenuOpen(false)}
                title={isCollapsed ? item.name : ""}
              >
                <span className="nav-icon">{item.icon}</span>
                {!isCollapsed && <span className="nav-label">{item.name}</span>}
              </NavLink>
            ))}
          </div>

          {/* Tools section (only if this role has tools) */}
          {showToolsSection && (
            <div className="nav-section">
              {!isCollapsed ? (
                <button
                  className="dropdown-trigger"
                  onClick={() => setIsToolsOpen(!isToolsOpen)}
                >
                  <div className="trigger-content">
                    <span className="nav-label">Tools</span>
                  </div>
                  {isToolsOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
              ) : (
                <div className="section-divider"></div>
              )}

              <div className={`dropdown-content ${(isToolsOpen || isCollapsed) ? 'open' : ''}`}>
                {toolItems.map((item) => (
                  <NavLink
                    key={item.name}
                    to={item.path}
                    className={({ isActive }) => `dropdown-item ${isActive ? 'active' : ''}`}
                    onClick={() => setIsMobileMenuOpen(false)}
                    title={isCollapsed ? item.name : ""}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    {!isCollapsed && <span className="nav-label">{item.name}</span>}
                  </NavLink>
                ))}
              </div>
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile">
            <div className="user-avatar">
              {user?.name?.[0]?.toUpperCase() || <UserCircle size={24} />}
            </div>
            {!isCollapsed && (
              <div className="user-info">
                <span className="user-name">{user?.name || 'Guest'}</span>
                <span className="user-role">{ROLE_LABELS[role] || role?.replace(/_/g, ' ') || 'Visitor'}</span>
              </div>
            )}
          </div>
          {!isCollapsed && (
            <button
              className="logout-btn"
              onClick={handleLogout}
              title="Logout"
            >
              <LogOut size={18} />
            </button>
          )}
        </div>
      </aside>

      {isMobileMenuOpen && <div className="sidebar-overlay" onClick={() => setIsMobileMenuOpen(false)}></div>}
    </>
  );
};

export default Sidebar;
