import React, { useEffect, useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import axios from 'axios';
import { config } from '../config';
import '../styles/Auth.css';

function VerifyEmail() {
  const location = useLocation();
  const [status, setStatus] = useState('verifying'); // verifying, success, error
  const [message, setMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');

    if (!token) {
      setStatus('error');
      setMessage('No verification token found in the URL.');
      return;
    }

    const verifyToken = async () => {
      try {
        const response = await axios.get(`${config.API_URL}/auth/verify-email?token=${token}`);
        setStatus('success');
        setMessage(response.data.message || 'Email verified successfully!');
      } catch (error) {
        setStatus('error');
        setMessage(error.response?.data?.detail || 'Failed to verify email. The link might be invalid or expired.');
      }
    };

    verifyToken();
  }, [location]);

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h2>Email Verification</h2>
        
        {status === 'verifying' && (
          <div className="auth-message" style={{ textAlign: 'center', margin: '2rem 0' }}>
            <p>Verifying your email address...</p>
          </div>
        )}

        {status === 'success' && (
          <>
            <div className="auth-message success">{message}</div>
            <div className="auth-links">
              <Link to="/login" className="auth-button" style={{display: 'block', textDecoration: 'none'}}>Continue to Login</Link>
            </div>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="auth-message error">{message}</div>
            <div className="auth-links">
              <Link to="/login" className="auth-button" style={{display: 'block', textDecoration: 'none'}}>Go to Login</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default VerifyEmail;
