import React, { useState, useCallback, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './App.css';
import axios from 'axios';

import SearchPage from './pages/SearchPage';
import ResultsPage from './pages/ResultsPage';
import MergePage from './pages/MergePage';
import Layout from './components/Layout';
import { ThemeProvider } from './context/ThemeContext';
import { SearchProvider } from './context/SearchContext';

// Pages
import Dashboard from './pages/Dashboard';
import ContentEditor from './pages/ContentEditor';


import TopicResearch from './pages/TopicResearch';

import RankTracker from './pages/RankTracker';

import ArticleWriter from './pages/ArticleWriter';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';
import ProtectedRoute from './components/ProtectedRoute';
import { normalizeRole, logout } from './utils/roles';

// ─── Axios 401 / Token-expired interceptor ────────────────────────────────────
// Set up once, globally – fires for any response with status 401.
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const detail = (error.response?.data?.detail || '').toLowerCase();
      if (detail.includes('expired') || detail.includes('invalid token')) {
        toast.error('Your session has expired. Please log in again.');
        logout('/login');
      }
    }
    return Promise.reject(error);
  }
);

function App() {
  const [sessionId, setSessionId] = useState(null);
  const [searchResults, setSearchResults] = useState([]);

  const handleSearchComplete = useCallback((data) => {
    setSessionId(data.session_id);
    setSearchResults(data.results);
  }, []);

  return (
    <ThemeProvider>
      <Router>
        <SearchProvider>
          <div className="app">
            <ToastContainer
            position="top-right"
            autoClose={3000}
            hideProgressBar={false}
            newestOnTop={true}
            theme="light"
          />
          <Layout>
            <Routes>
              {/* ── Public routes ── */}
              <Route path="/login" element={<Login onLoginSuccess={(data) => {
                const user = { ...data, role: normalizeRole(data.role) || data.role };
                localStorage.setItem('user', JSON.stringify(user));
              }} />} />
              <Route path="/register" element={<Register />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/verify-email" element={<VerifyEmail />} />

              {/* ── Dashboard – all authenticated roles ── */}
              <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />

              {/* ── Keyword Research – outliner + admin only ── */}
              <Route
                path="/"
                element={
                  <ProtectedRoute allowedRoles={['outliner', 'admin']}>
                    <SearchPage onSearchComplete={handleSearchComplete} />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/search"
                element={
                  <ProtectedRoute allowedRoles={['outliner', 'admin']}>
                    <SearchPage onSearchComplete={handleSearchComplete} />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/results"
                element={
                  <ProtectedRoute allowedRoles={['outliner', 'admin']}>
                    <ResultsPage sessionId={sessionId} results={searchResults} />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/merge"
                element={
                  <ProtectedRoute allowedRoles={['outliner', 'admin']}>
                    <MergePage sessionId={sessionId} results={searchResults} />
                  </ProtectedRoute>
                }
              />

              {/* ── Article Writer – content_writer, content_editor, compliance_manager, publisher, admin ── */}
              <Route
                path="/article-writer"
                element={
                  <ProtectedRoute allowedRoles={['content_writer', 'content_editor', 'compliance_manager', 'publisher', 'admin']}>
                    <ArticleWriter />
                  </ProtectedRoute>
                }
              />

              {/* ── Content Editor – all except outliner-only ── */}
              <Route
                path="/content-editor"
                element={
                  <ProtectedRoute allowedRoles={['content_writer', 'content_editor', 'compliance_manager', 'publisher', 'admin']}>
                    <ContentEditor />
                  </ProtectedRoute>
                }
              />

              {/* ── General pages – any authenticated user ── */}
       
          
           
              <Route path="/topic-research" element={<ProtectedRoute><TopicResearch /></ProtectedRoute>} />
             
              <Route path="/rank-tracker" element={<ProtectedRoute><RankTracker /></ProtectedRoute>} />
             
            </Routes>
          </Layout>
        </div>
        </SearchProvider>
      </Router>
    </ThemeProvider>
  );
}

export default App;
