import React, { useState } from 'react';
import { 
  ShoppingBag, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle, 
  RotateCw,
  Eye,
  EyeOff,
  Zap,
  ShieldCheck,
  MapPin
} from 'lucide-react';

interface BuyerAuthProps {
  onAuthSuccess: (user: any, token: string) => void;
}

export const BuyerAuth: React.FC<BuyerAuthProps> = ({ onAuthSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [step, setStep] = useState<'CREDENTIALS' | 'OTP'>('CREDENTIALS');
  
  // Fields
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [homeAddress, setHomeAddress] = useState('');
  const [otp, setOtp] = useState('');

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://unplowed-nutlike-antitoxic.ngrok-free.dev';

  const defaultHeaders = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true'
  };

  // Instant 1-Click Demo Login for testing and immediate evaluation
  const handleQuickDemoLogin = () => {
    const demoUser = {
      id: 'c1000000-0000-0000-0000-000000000001',
      fullName: 'Rahul Deshmukh',
      phone: '+91 98901 23456',
      email: 'rahul.d@example.com',
      address: 'Flat 402, Mayur Colony, Kothrud, Pune 411038',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
    };
    const demoToken = 'streetverse-jwt-demo-rahul-deshmukh-pune';
    localStorage.setItem('streetverse_buyer_token', demoToken);
    localStorage.setItem('streetverse_buyer_user', JSON.stringify(demoUser));
    onAuthSuccess(demoUser, demoToken);
  };

  const handleDemoFill = () => {
    setIsLogin(true);
    setIdentifier('rahul.d@example.com');
    setPassword('Password123!');
  };

  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      if (isLogin) {
        const res = await fetch(`${API_URL}/api/v1/auth/buyer/login`, {
          method: 'POST',
          headers: defaultHeaders,
          body: JSON.stringify({ identifier, password })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Login failed. Please check credentials.');
        }

        setEmail(data.email);
        setStep('OTP');
        setSuccessMsg(data.message || 'Verification code sent to your email.');
        startCooldown();
      } else {
        const res = await fetch(`${API_URL}/api/v1/auth/buyer/register`, {
          method: 'POST',
          headers: defaultHeaders,
          body: JSON.stringify({
            full_name: fullName,
            phone,
            email,
            password,
            home_address: homeAddress
          })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Registration failed.');
        }

        setStep('OTP');
        setSuccessMsg(data.message || 'Verification code sent to your email.');
        startCooldown();
      }
    } catch (err: any) {
      // If network fails (e.g. backend offline), provide graceful fallback guidance
      setError(err.message || 'Connection to server failed. Use 1-Click Demo Login to explore immediately.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/v1/auth/buyer/verify-otp`, {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({ email, otp })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Invalid verification code.');
      }

      localStorage.setItem('streetverse_buyer_token', data.token);
      localStorage.setItem('streetverse_buyer_user', JSON.stringify(data.user));
      onAuthSuccess(data.user, data.token);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (resendCooldown > 0) return;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/v1/auth/resend-otp`, {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({ scope: 'buyer', email })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resend OTP.');
      setSuccessMsg('A new 6-digit code has been sent.');
      startCooldown();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const startCooldown = () => {
    setResendCooldown(45);
    const interval = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-card">
        
        {/* Header */}
        <div className="auth-header">
          <div className="brand-badge">
            <ShoppingBag size={24} color="#FFF" />
          </div>
          <h1 className="brand-title">StreetVerse</h1>
          <p className="brand-subtitle">
            Hyperlocal Commerce & Instant Services • India
          </p>
          <div className="location-pill">
            <MapPin size={12} color="#059669" />
            <span>Pune · Bengaluru · Mumbai · Delhi</span>
          </div>
        </div>

        {/* 1-Click Quick Demo Button */}
        <div className="quick-demo-strip">
          <button
            type="button"
            onClick={handleQuickDemoLogin}
            className="quick-demo-btn"
          >
            <Zap size={16} />
            <span>1-Click Demo Login (Rahul Deshmukh · Pune)</span>
          </button>
        </div>

        <div className="divider">
          <span>OR CONTINUE WITH CREDENTIALS</span>
        </div>

        {/* Tab Switcher */}
        {step === 'CREDENTIALS' && (
          <div className="tab-container">
            <button
              type="button"
              onClick={() => { setIsLogin(true); setError(null); }}
              className={`tab-btn ${isLogin ? 'active' : ''}`}
            >
              Customer Sign In
            </button>
            <button
              type="button"
              onClick={() => { setIsLogin(false); setError(null); }}
              className={`tab-btn ${!isLogin ? 'active' : ''}`}
            >
              New Registration
            </button>
          </div>
        )}

        {/* Status Alerts */}
        {error && (
          <div className="alert-box error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="alert-box success">
            <CheckCircle2 size={16} />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Step 1: Form */}
        {step === 'CREDENTIALS' && (
          <form onSubmit={handleSubmitCredentials} className="auth-form">
            {isLogin ? (
              <>
                <div className="form-group">
                  <label className="form-label">Mobile Number or Email</label>
                  <input
                    type="text"
                    required
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="+91 98901 23456 or rahul.d@example.com"
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Password</label>
                  <div className="input-with-icon">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="form-input"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="eye-btn"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="form-group">
                  <label className="form-label">Full Name</label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Rahul Deshmukh"
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Indian Mobile Number (+91)</label>
                  <input
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+91 98901 23456"
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Email Address</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="rahul.d@example.com"
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Password (Min 8 characters)</label>
                  <div className="input-with-icon">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password123!"
                      className="form-input"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="eye-btn"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Delivery Address (Pune / Metro)</label>
                  <input
                    type="text"
                    value={homeAddress}
                    onChange={(e) => setHomeAddress(e.target.value)}
                    placeholder="Flat 402, Mayur Colony, Kothrud, Pune 411038"
                    className="form-input"
                  />
                </div>
              </>
            )}

            <button type="submit" disabled={loading} className="primary-btn">
              {loading ? (
                <RotateCw size={16} className="spin" />
              ) : (
                <>
                  <span>{isLogin ? 'Sign In' : 'Register Account'}</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>

            {/* Autofill Demo Credentials */}
            <div className="demo-footer">
              <button type="button" onClick={handleDemoFill} className="demo-link">
                Fill Seeded Test Credentials (rahul.d@example.com)
              </button>
            </div>
          </form>
        )}

        {/* Step 2: 6-Digit OTP */}
        {step === 'OTP' && (
          <form onSubmit={handleVerifyOtp} className="auth-form">
            <p className="otp-desc">
              We sent a 6-digit verification code to <strong>{email}</strong>
            </p>

            <div className="form-group">
              <input
                type="text"
                maxLength={6}
                required
                autoFocus
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="otp-input"
              />
            </div>

            <button type="submit" disabled={loading || otp.length < 6} className="primary-btn">
              {loading ? <RotateCw size={16} className="spin" /> : <span>Verify & Continue</span>}
            </button>

            <div className="otp-actions">
              <button
                type="button"
                onClick={() => setStep('CREDENTIALS')}
                className="back-btn"
              >
                &larr; Back
              </button>
              <button
                type="button"
                disabled={resendCooldown > 0 || loading}
                onClick={handleResendOtp}
                className="resend-btn"
              >
                {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}

        {/* Trust Badges */}
        <div className="trust-footer">
          <ShieldCheck size={14} color="#059669" />
          <span>NPCI UPI Protected • 256-bit Encrypted • Zero Data Sharing</span>
        </div>

      </div>

      <style jsx>{`
        .auth-wrapper {
          min-height: 100vh;
          background: linear-gradient(135deg, #090D16 0%, #131B2E 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1.5rem;
          font-family: 'Inter', -apple-system, sans-serif;
        }

        .auth-card {
          width: 100%;
          max-width: 440px;
          background: #FFFFFF;
          border: 1px solid #E2E8F0;
          border-radius: 24px;
          box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.25);
          padding: 2.25rem 2rem;
        }

        .auth-header {
          text-align: center;
          margin-bottom: 1.25rem;
        }

        .brand-badge {
          width: 52px;
          height: 52px;
          background: linear-gradient(135deg, #3525CD, #4F46E5);
          border-radius: 16px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 8px 18px rgba(53, 37, 205, 0.35);
          margin-bottom: 0.75rem;
        }

        .brand-title {
          font-size: 1.6rem;
          font-weight: 800;
          color: #0F172A;
          margin: 0;
          letter-spacing: -0.02em;
          font-family: 'Plus Jakarta Sans', sans-serif;
        }

        .brand-subtitle {
          font-size: 0.85rem;
          color: #64748B;
          margin-top: 0.25rem;
          font-weight: 500;
        }

        .location-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          background: #ECFDF5;
          color: #065F46;
          padding: 0.25rem 0.65rem;
          border-radius: 9999px;
          font-size: 0.72rem;
          font-weight: 600;
          margin-top: 0.5rem;
        }

        .quick-demo-strip {
          margin-bottom: 1rem;
        }

        .quick-demo-btn {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.75rem 1rem;
          background: #EEF2FF;
          color: #3525CD;
          border: 1.5px solid #C7D2FE;
          border-radius: 14px;
          font-size: 0.85rem;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .quick-demo-btn:hover {
          background: #E0E7FF;
          border-color: #818CF8;
          transform: translateY(-1px);
        }

        .divider {
          display: flex;
          align-items: center;
          text-align: center;
          margin: 1rem 0;
          color: #94A3B8;
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.05em;
        }

        .divider::before, .divider::after {
          content: '';
          flex: 1;
          border-bottom: 1px solid #E2E8F0;
        }

        .divider span {
          padding: 0 0.5rem;
        }

        .tab-container {
          display: flex;
          background: #F1F5F9;
          border-radius: 12px;
          padding: 3px;
          margin-bottom: 1.25rem;
        }

        .tab-btn {
          flex: 1;
          border: none;
          background: transparent;
          padding: 0.6rem;
          font-size: 0.82rem;
          font-weight: 600;
          color: #64748B;
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .tab-btn.active {
          background: #FFFFFF;
          color: #0F172A;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
        }

        .alert-box {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.65rem 0.85rem;
          border-radius: 10px;
          font-size: 0.8rem;
          margin-bottom: 1rem;
        }

        .alert-box.error {
          background: #FEF2F2;
          color: #991B1B;
          border: 1px solid #FEE2E2;
        }

        .alert-box.success {
          background: #F0FDF4;
          color: #166534;
          border: 1px solid #DCFCE7;
        }

        .auth-form {
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
        }

        .form-group {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }

        .form-label {
          font-size: 0.78rem;
          font-weight: 600;
          color: #334155;
        }

        .form-input {
          padding: 0.65rem 0.85rem;
          border: 1.5px solid #E2E8F0;
          border-radius: 12px;
          font-size: 0.875rem;
          color: #0F172A;
          outline: none;
          transition: border-color 0.2s;
        }

        .form-input:focus {
          border-color: #4F46E5;
          box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
        }

        .input-with-icon {
          position: relative;
          display: flex;
          align-items: center;
        }

        .input-with-icon .form-input {
          width: 100%;
          padding-right: 2.5rem;
        }

        .eye-btn {
          position: absolute;
          right: 0.75rem;
          background: none;
          border: none;
          color: #94A3B8;
          cursor: pointer;
        }

        .primary-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.75rem;
          background: #3525CD;
          color: #FFFFFF;
          border: none;
          border-radius: 12px;
          font-size: 0.875rem;
          font-weight: 700;
          cursor: pointer;
          transition: opacity 0.2s;
          margin-top: 0.35rem;
        }

        .primary-btn:hover {
          opacity: 0.92;
        }

        .primary-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .otp-desc {
          font-size: 0.85rem;
          color: #475569;
          text-align: center;
          margin-bottom: 0.5rem;
        }

        .otp-input {
          font-size: 1.75rem;
          font-weight: 800;
          letter-spacing: 0.5rem;
          text-align: center;
          padding: 0.75rem;
          border: 2px solid #CBD5E1;
          border-radius: 14px;
          color: #0F172A;
          outline: none;
        }

        .otp-input:focus {
          border-color: #4F46E5;
          box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.1);
        }

        .otp-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 0.5rem;
        }

        .back-btn, .resend-btn {
          background: none;
          border: none;
          font-size: 0.8rem;
          font-weight: 600;
          color: #4F46E5;
          cursor: pointer;
        }

        .resend-btn:disabled {
          color: #94A3B8;
          cursor: not-allowed;
        }

        .demo-footer {
          text-align: center;
          margin-top: 0.25rem;
        }

        .demo-link {
          background: none;
          border: none;
          color: #64748B;
          font-size: 0.75rem;
          text-decoration: underline;
          cursor: pointer;
        }

        .trust-footer {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.35rem;
          margin-top: 1.5rem;
          padding-top: 1rem;
          border-top: 1px solid #F1F5F9;
          font-size: 0.7rem;
          color: #64748B;
          font-weight: 500;
        }

        .spin {
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
