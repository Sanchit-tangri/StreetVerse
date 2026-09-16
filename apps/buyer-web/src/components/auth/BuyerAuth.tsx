import React, { useState } from 'react';
import { 
  Lock, 
  Mail, 
  Phone, 
  User, 
  MapPin, 
  KeyRound, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle, 
  RotateCw,
  Sparkles,
  ShieldCheck,
  Eye,
  EyeOff
} from 'lucide-react';

interface BuyerAuthProps {
  onAuthSuccess: (user: any, token: string) => void;
}

export const BuyerAuth: React.FC<BuyerAuthProps> = ({ onAuthSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [step, setStep] = useState<'CREDENTIALS' | 'OTP'>('CREDENTIALS');
  
  // Form fields
  const [identifier, setIdentifier] = useState(''); // phone or email for login
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

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

  // Demo Quick-Fill
  const handleQuickFill = () => {
    if (isLogin) {
      setIdentifier('rahul.d@example.com');
      setPassword('Password123!');
    } else {
      setFullName('Rahul Deshmukh');
      setPhone('+919890123456');
      setEmail('rahul.d@example.com');
      setPassword('Password123!');
      setHomeAddress('Shop 4, Mayur Colony, Kothrud, Pune');
    }
  };

  // Submit Credentials (Login or Register)
  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      if (isLogin) {
        // Buyer Password Login
        const res = await fetch(`${API_URL}/api/v1/auth/buyer/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Login failed. Please check credentials.');
        }

        setEmail(data.email);
        setStep('OTP');
        setSuccessMsg(data.message || '6-digit verification code sent to your email.');
        startCooldown();
      } else {
        // Buyer Registration
        const res = await fetch(`${API_URL}/api/v1/auth/buyer/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Verify 6-digit OTP
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/v1/auth/buyer/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Invalid verification code.');
      }

      // Store in localStorage
      localStorage.setItem('streetverse_buyer_token', data.token);
      localStorage.setItem('streetverse_buyer_user', JSON.stringify(data.user));

      onAuthSuccess(data.user, data.token);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Resend OTP
  const handleResendOtp = async () => {
    if (resendCooldown > 0) return;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/v1/auth/resend-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'buyer', email })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resend OTP.');
      setSuccessMsg('A new 6-digit code has been dispatched to your email.');
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
    <div className="min-h-screen bg-[#FDFBF7] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-[#EBE5DA] overflow-hidden">
        
        {/* Header Banner */}
        <div className="bg-[#7A3E1D] p-6 text-white text-center relative">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/10 mb-3 backdrop-blur-sm">
            <ShieldCheck className="w-6 h-6 text-[#F9E9D2]" />
          </div>
          <h1 className="text-2xl font-serif font-bold tracking-tight">StreetVerse</h1>
          <p className="text-xs text-[#F9E9D2]/90 mt-1">
            Customer Portal &bull; Hyperlocal Discoveries & Instant Booking
          </p>

          {/* Quick Demo Fill Badge */}
          <button
            type="button"
            onClick={handleQuickFill}
            className="absolute top-4 right-4 text-[10px] bg-white/20 hover:bg-white/30 text-white font-medium px-2.5 py-1 rounded-full transition-colors flex items-center gap-1"
            title="Auto-fill with demo credentials"
          >
            <Sparkles className="w-3 h-3 text-amber-300" /> Demo Fill
          </button>
        </div>

        {/* Tab Toggle (Login vs Sign Up) */}
        {step === 'CREDENTIALS' && (
          <div className="flex border-b border-[#EBE5DA] bg-[#F7F3EB]">
            <button
              type="button"
              onClick={() => { setIsLogin(true); setError(null); }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                isLogin ? 'bg-white text-[#7A3E1D] border-b-2 border-[#7A3E1D]' : 'text-[#7D6E5D] hover:text-[#2C241B]'
              }`}
            >
              Customer Login
            </button>
            <button
              type="button"
              onClick={() => { setIsLogin(false); setError(null); }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                !isLogin ? 'bg-white text-[#7A3E1D] border-b-2 border-[#7A3E1D]' : 'text-[#7D6E5D] hover:text-[#2C241B]'
              }`}
            >
              New Registration
            </button>
          </div>
        )}

        <div className="p-6">
          {/* Alerts */}
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2 animate-fadeIn">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex items-start gap-2 animate-fadeIn">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Step 1: Credentials Form */}
          {step === 'CREDENTIALS' && (
            <form onSubmit={handleSubmitCredentials} className="space-y-4">
              {isLogin ? (
                // Login View
                <>
                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Phone Number or Email</label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type="text"
                        required
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        placeholder="e.g. rahul.d@example.com or +919890123456"
                        className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#7A3E1D] bg-[#FFFDF9]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Password</label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full pl-9 pr-10 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#7A3E1D] bg-[#FFFDF9]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-3 text-[#A89885] hover:text-[#5D5043]"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                // Sign Up View
                <>
                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Full Name</label>
                    <div className="relative">
                      <User className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type="text"
                        required
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="Rahul Deshmukh"
                        className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#7A3E1D] bg-[#FFFDF9]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Mobile Phone (10-15 digits)</label>
                    <div className="relative">
                      <Phone className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type="tel"
                        required
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="+919890123456"
                        className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#7A3E1D] bg-[#FFFDF9]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Email Address</label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="rahul.d@example.com"
                        className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#7A3E1D] bg-[#FFFDF9]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Password (min 8 chars, letters & numbers)</label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password123!"
                        className="w-full pl-9 pr-10 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#7A3E1D] bg-[#FFFDF9]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-3 text-[#A89885] hover:text-[#5D5043]"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Home Delivery Address (Optional)</label>
                    <div className="relative">
                      <MapPin className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type="text"
                        value={homeAddress}
                        onChange={(e) => setHomeAddress(e.target.value)}
                        placeholder="Flat 302, Kothrud, Pune"
                        className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#7A3E1D] bg-[#FFFDF9]"
                      />
                    </div>
                  </div>
                </>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 bg-[#7A3E1D] hover:bg-[#603116] text-white font-medium rounded-xl text-sm transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2 mt-4 disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" /> Verifying...
                  </>
                ) : (
                  <>
                    {isLogin ? 'Verify & Send Email OTP' : 'Create Account & Send OTP'} <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}

          {/* Step 2: 6-Digit Email OTP Verification */}
          {step === 'OTP' && (
            <form onSubmit={handleVerifyOtp} className="space-y-4 animate-fadeIn">
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[#F3ECE1] text-[#7A3E1D] mb-2">
                  <KeyRound className="w-6 h-6" />
                </div>
                <h3 className="text-base font-semibold text-[#2C241B]">Enter Verification Code</h3>
                <p className="text-xs text-[#7D6E5D] mt-1">
                  A 6-digit code has been sent to <br />
                  <strong className="text-[#2C241B]">{email}</strong>
                </p>
              </div>

              <div>
                <input
                  type="text"
                  maxLength={6}
                  required
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full text-center tracking-[10px] text-2xl font-mono py-3 border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#7A3E1D] bg-[#FFFDF9]"
                />
              </div>

              <button
                type="submit"
                disabled={loading || otp.length < 6}
                className="w-full py-3 px-4 bg-[#7A3E1D] hover:bg-[#603116] text-white font-medium rounded-xl text-sm transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" /> Confirming...
                  </>
                ) : (
                  <>
                    Verify & Enter Marketplace <CheckCircle2 className="w-4 h-4" />
                  </>
                )}
              </button>

              <div className="flex items-center justify-between pt-3 text-xs text-[#7D6E5D]">
                <button
                  type="button"
                  onClick={() => setStep('CREDENTIALS')}
                  className="hover:text-[#2C241B] transition-colors"
                >
                  &larr; Back to login
                </button>

                <button
                  type="button"
                  disabled={resendCooldown > 0 || loading}
                  onClick={handleResendOtp}
                  className="text-[#7A3E1D] font-semibold hover:underline disabled:opacity-50"
                >
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend Code'}
                </button>
              </div>
            </form>
          )}

          {/* Security Notice */}
          <div className="mt-6 pt-4 border-t border-[#EBE5DA] text-center text-[11px] text-[#A89885] flex items-center justify-center gap-1.5">
            <Lock className="w-3 h-3" /> Protected by SQL Injection Defense & 256-bit Hash
          </div>
        </div>

      </div>
    </div>
  );
};
