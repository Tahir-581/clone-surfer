import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getStoredUser, isTokenExpired, logout, normalizeRole } from '../utils/roles';

/**
 * ProtectedRoute – guards any route from unauthenticated or expired-session access.
 *
 * Props:
 *   allowedRoles  – optional array of roles that may enter.  Omit to allow any authenticated user.
 *   children      – the page component to render.
 */
const ProtectedRoute = ({ children, allowedRoles }) => {
  const location = useLocation();

  // 1. Check if user object exists
  const user = getStoredUser();
  if (!user || !user.token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // 2. Check JWT expiry (client-side guard – server will also reject expired tokens)
  if (isTokenExpired(30000)) { // 30-second buffer
    logout('/login');
    return null; // logout() redirects synchronously
  }

  // 3. Role-based gate
  if (allowedRoles && allowedRoles.length > 0) {
    const role = normalizeRole(user.role);
    if (!allowedRoles.includes(role) && role !== 'admin') {
      // Redirect to dashboard with an "unauthorized" flag
      return <Navigate to="/dashboard" state={{ unauthorized: true }} replace />;
    }
  }

  return children;
};

export default ProtectedRoute;
