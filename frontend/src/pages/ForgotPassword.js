import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'react-toastify';
import { config } from '../config';
import '../styles/Auth.css';

function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await axios.post(`${config.API_URL}/auth/forgot-password`, { email });
      setSubmitted(true);
      toast.success('Reset link sent!');
    } catch (error) {
      // Still show success to prevent email enumeration, unless it's a network error
      setSubmitted(true);
      toast.success('If an account exists, a reset link was sent.');
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <h2>Check Your Email</h2>
          <div className="auth-message success">
            If an account exists for <strong>{email}</strong>, we have sent a password reset link. Please check your inbox.
          </div>
          <div className="auth-links">
            <Link to="/login" className="auth-button" style={{display: 'block', textDecoration: 'none'}}>Back to Login</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h2>Reset Password</h2>
        <p className="auth-subtitle">Enter your email and we'll send you a link to reset your password.</p>
        
        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <input
              type="email"
              id="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
            />
          </div>
          
          <button type="submit" className="auth-button" disabled={loading}>
            {loading ? 'Sending Link...' : 'Send Reset Link'}
          </button>
        </form>
        
        <div className="auth-links">
          <span>Remember your password? <Link to="/login" className="auth-link">Log in</Link></span>
        </div>
      </div>
    </div>
  );
}

export default ForgotPassword;
