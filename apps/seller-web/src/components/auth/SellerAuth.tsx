import React, { useState } from 'react';
import { 
  Store, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle, 
  RotateCw,
  Eye,
  EyeOff
} from 'lucide-react';

interface SellerAuthProps {
  onAuthSuccess: (merchant: any, token: string) => void;
}

export const SellerAuth: React.FC<SellerAuthProps> = ({ onAuthSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [step, setStep] = useState<'CREDENTIALS' | 'OTP'>('CREDENTIALS');

  // Form fields
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [category, setCategory] = useState('GROCERY');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [upiVpa, setUpiVpa] = useState('');
  const [address, setAddress] = useState('');
  const [pincode, setPincode] = useState('411038');

  // OTP
  const [emailForOtp, setEmailForOtp] = useState('');
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

  const handleDemoFill = () => {
    setIsLogin(true);
    setIdentifier('greenvalley@streetverse.local');
    setPassword('Password123!');
  };

  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      if (isLogin) {
        const res = await fetch(`${API_URL}/api/v1/auth/seller/login`, {
          method: 'POST',
          headers: defaultHeaders,
          body: JSON.stringify({ identifier, password })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Merchant login failed. Check credentials.');
        }

        setEmailForOtp(data.email);
        setStep('OTP');
        setSuccessMsg(data.message || 'Verification code sent to merchant email.');
        startCooldown();
      } else {
        const res = await fetch(`${API_URL}/api/v1/auth/seller/register`, {
          method: 'POST',
          headers: defaultHeaders,
          body: JSON.stringify({
            business_name: businessName,
            category,
            owner_phone: ownerPhone,
            owner_email: ownerEmail,
            password,
            upi_vpa: upiVpa,
            address,
            pincode,
            latitude: 18.5074,
            longitude: 73.8077
          })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Merchant registration failed.');
        }

        setEmailForOtp(data.email);
        setStep('OTP');
        setSuccessMsg(data.message || 'Verification code sent to email.');
        startCooldown();
      }
    } catch (err: any) {
      setError(err.message);
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
      const res = await fetch(`${API_URL}/api/v1/auth/seller/verify-otp`, {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({ email: emailForOtp, otp })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Invalid verification code.');
      }

      localStorage.setItem('streetverse_seller_token', data.token);
      localStorage.setItem('streetverse_seller_merchant', JSON.stringify(data.merchant));
      onAuthSuccess(data.merchant, data.token);
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
        body: JSON.stringify({ scope: 'seller', email: emailForOtp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resend code.');
      setSuccessMsg('A new verification code has been dispatched.');
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
        
        {/* Clean Header */}
        <div className="auth-header">
          <div className="brand-badge">
            <Store size={24} color="#FFF" />
          </div>
          <h1 className="brand-title">Merchant Portal</h1>
          <p className="brand-subtitle">
            {step === 'OTP' ? 'Enter security verification code' : isLogin ? 'Sign in to manage your store' : 'Register your local business'}
          </p>
        </div>

        {/* Tab Switcher */}
        {step === 'CREDENTIALS' && (
          <div className="tab-container">
            <button
              type="button"
              onClick={() => { setIsLogin(true); setError(null); }}
              className={`tab-btn ${isLogin ? 'active' : ''}`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => { setIsLogin(false); setError(null); }}
              className={`tab-btn ${!isLogin ? 'active' : ''}`}
            >
              Register Store
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

        {/* Form View */}
        {step === 'CREDENTIALS' && (
          <form onSubmit={handleSubmitCredentials} className="auth-form">
            {isLogin ? (
              <>
                <div className="form-group">
                  <label className="form-label">Owner Email or Phone</label>
                  <input
                    type="text"
                    required
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="greenvalley@streetverse.local"
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
                  <label className="form-label">Store / Business Name</label>
                  <input
                    type="text"
                    required
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    placeholder="e.g. Pune Organics Mart"
                    className="form-input"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group flex-1">
                    <label className="form-label">Category</label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="form-input"
                    >
                      <option value="GROCERY">Grocery</option>
                      <option value="SALON">Salon</option>
                      <option value="PHARMACY">Pharmacy</option>
                      <option value="RESTAURANT">Restaurant</option>
                      <option value="HARDWARE">Hardware</option>
                    </select>
                  </div>

                  <div className="form-group flex-1">
                    <label className="form-label">UPI ID (VPA)</label>
                    <input
                      type="text"
                      required
                      value={upiVpa}
                      onChange={(e) => setUpiVpa(e.target.value)}
                      placeholder="store@okhdfcbank"
                      className="form-input"
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group flex-1">
                    <label className="form-label">Owner Phone</label>
                    <input
                      type="tel"
                      required
                      value={ownerPhone}
                      onChange={(e) => setOwnerPhone(e.target.value)}
                      placeholder="+919876543210"
                      className="form-input"
                    />
                  </div>

                  <div className="form-group flex-1">
                    <label className="form-label">Owner Email</label>
                    <input
                      type="email"
                      required
                      value={ownerEmail}
                      onChange={(e) => setOwnerEmail(e.target.value)}
                      placeholder="owner@store.com"
                      className="form-input"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Password</label>
                  <div className="input-with-icon">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Min 8 characters"
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

                <div className="form-row">
                  <div className="form-group flex-2">
                    <label className="form-label">Store Address</label>
                    <input
                      type="text"
                      required
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="Shop 4, Mayur Colony, Kothrud"
                      className="form-input"
                    />
                  </div>
                  <div className="form-group flex-1">
                    <label className="form-label">Pincode</label>
                    <input
                      type="text"
                      required
                      value={pincode}
                      onChange={(e) => setPincode(e.target.value)}
                      placeholder="411038"
                      className="form-input"
                    />
                  </div>
                </div>
              </>
            )}

            <button type="submit" disabled={loading} className="primary-btn">
              {loading ? (
                <RotateCw size={16} className="spin" />
              ) : (
                <>
                  <span>{isLogin ? 'Continue' : 'Register Store'}</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>

            {/* Discreet Demo Fill */}
            <div className="demo-footer">
              <button type="button" onClick={handleDemoFill} className="demo-link">
                Use Demo Merchant Account
              </button>
            </div>
          </form>
        )}

        {/* Step 2: 6-Digit OTP */}
        {step === 'OTP' && (
          <form onSubmit={handleVerifyOtp} className="auth-form">
            <p className="otp-desc">
              Security verification code sent to <strong>{emailForOtp}</strong>
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
              {loading ? <RotateCw size={16} className="spin" /> : <span>Verify & Access Dashboard</span>}
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

      </div>

      <style jsx>{`
        .auth-wrapper {
          min-height: 100vh;
          background-color: #FAF7F2;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1.5rem;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        }

        .auth-card {
          width: 100%;
          max-width: 440px;
          background: #FFFFFF;
          border: 1px solid #E7E3DC;
          border-radius: 20px;
          box-shadow: 0 16px 36px -12px rgba(41, 37, 36, 0.08);
          padding: 2.25rem 2rem;
        }

        .auth-header {
          text-align: center;
          margin-bottom: 1.75rem;
        }

        .brand-badge {
          width: 48px;
          height: 48px;
          background: linear-gradient(135deg, #059669, #047857);
          border-radius: 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 6px 14px rgba(5, 150, 105, 0.25);
          margin-bottom: 0.85rem;
        }

        .brand-title {
          font-size: 1.5rem;
          font-weight: 800;
          color: #292524;
          margin: 0;
          letter-spacing: -0.02em;
        }

        .brand-subtitle {
          font-size: 0.85rem;
          color: #78716C;
          margin-top: 0.35rem;
        }

        .tab-container {
          display: flex;
          background: #F4EFEB;
          border-radius: 12px;
          padding: 3px;
          margin-bottom: 1.5rem;
        }

        .tab-btn {
          flex: 1;
          padding: 0.55rem;
          font-size: 0.82rem;
          font-weight: 600;
          color: #78716C;
          background: transparent;
          border: none;
          border-radius: 9px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .tab-btn.active {
          background: #FFFFFF;
          color: #292524;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
        }

        .auth-form {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .form-row {
          display: flex;
          gap: 0.75rem;
        }

        .flex-1 { flex: 1; }
        .flex-2 { flex: 2; }

        .form-group {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }

        .form-label {
          font-size: 0.78rem;
          font-weight: 600;
          color: #57534E;
        }

        .form-input {
          width: 100%;
          padding: 0.7rem 0.9rem;
          font-size: 0.88rem;
          color: #292524;
          background: #FAF8F5;
          border: 1px solid #E7E3DC;
          border-radius: 11px;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }

        .form-input:focus {
          border-color: #059669;
          box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.12);
          background: #FFFFFF;
        }

        .input-with-icon {
          position: relative;
          display: flex;
          align-items: center;
        }

        .eye-btn {
          position: absolute;
          right: 0.85rem;
          background: transparent;
          border: none;
          color: #A8A29E;
          cursor: pointer;
          display: flex;
          align-items: center;
          padding: 0;
        }

        .eye-btn:hover {
          color: #57534E;
        }

        .primary-btn {
          margin-top: 0.5rem;
          width: 100%;
          padding: 0.75rem;
          background: #059669;
          color: #FFFFFF;
          border: none;
          border-radius: 12px;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          transition: all 0.2s ease;
          box-shadow: 0 4px 12px rgba(5, 150, 105, 0.2);
        }

        .primary-btn:hover:not(:disabled) {
          background: #047857;
          transform: translateY(-1px);
          box-shadow: 0 6px 16px rgba(5, 150, 105, 0.3);
        }

        .primary-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .demo-footer {
          text-align: center;
          margin-top: 0.25rem;
        }

        .demo-link {
          background: transparent;
          border: none;
          color: #A8A29E;
          font-size: 0.75rem;
          cursor: pointer;
          text-decoration: underline;
        }

        .demo-link:hover {
          color: #059669;
        }

        .otp-desc {
          text-align: center;
          font-size: 0.82rem;
          color: #78716C;
          margin: 0;
        }

        .otp-input {
          width: 100%;
          text-align: center;
          letter-spacing: 12px;
          font-family: monospace;
          font-size: 1.6rem;
          font-weight: 700;
          color: #292524;
          padding: 0.65rem 0.5rem;
          background: #FAF8F5;
          border: 1px solid #E7E3DC;
          border-radius: 12px;
          outline: none;
        }

        .otp-input:focus {
          border-color: #059669;
          box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.12);
          background: #FFFFFF;
        }

        .otp-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 0.8rem;
          margin-top: 0.25rem;
        }

        .back-btn {
          background: transparent;
          border: none;
          color: #78716C;
          cursor: pointer;
          padding: 0;
        }

        .back-btn:hover {
          color: #292524;
        }

        .resend-btn {
          background: transparent;
          border: none;
          color: #059669;
          font-weight: 600;
          cursor: pointer;
          padding: 0;
        }

        .resend-btn:disabled {
          color: #A8A29E;
          cursor: not-allowed;
        }

        .alert-box {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.65rem 0.85rem;
          border-radius: 10px;
          font-size: 0.78rem;
          margin-bottom: 1rem;
        }

        .alert-box.error {
          background: #FEF2F2;
          color: #B91C1C;
          border: 1px solid #FEE2E2;
        }

        .alert-box.success {
          background: #ECFDF5;
          color: #047857;
          border: 1px solid #D1FAE5;
        }

        :global(.spin) {
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
