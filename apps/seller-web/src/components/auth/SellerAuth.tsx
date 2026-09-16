import React, { useState } from 'react';
import { 
  Store, 
  Lock, 
  Mail, 
  Phone, 
  MapPin, 
  KeyRound, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle, 
  RotateCw,
  Sparkles,
  ShieldCheck,
  CreditCard,
  Building2,
  Eye,
  EyeOff
} from 'lucide-react';

interface SellerAuthProps {
  onAuthSuccess: (merchant: any, token: string) => void;
}

export const SellerAuth: React.FC<SellerAuthProps> = ({ onAuthSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [step, setStep] = useState<'CREDENTIALS' | 'OTP'>('CREDENTIALS');

  // Login form
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Registration form
  const [businessName, setBusinessName] = useState('');
  const [category, setCategory] = useState('GROCERY');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [upiVpa, setUpiVpa] = useState('');
  const [address, setAddress] = useState('');
  const [pincode, setPincode] = useState('411038');
  const [latitude, setLatitude] = useState('18.5074');
  const [longitude, setLongitude] = useState('73.8077');

  // OTP form
  const [emailForOtp, setEmailForOtp] = useState('');
  const [otp, setOtp] = useState('');

  // UI status
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

  // Demo Quick-Fill options
  const handleQuickFill = (type: 'grocery' | 'salon' | 'pharmacy') => {
    if (type === 'grocery') {
      setIdentifier('greenvalley@streetverse.local');
      setPassword('Password123!');
    } else if (type === 'salon') {
      setIdentifier('aura.salon@streetverse.local');
      setPassword('Password123!');
    } else {
      setIdentifier('apollo.lifecare@streetverse.local');
      setPassword('Password123!');
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
        // Merchant Password Login
        const res = await fetch(`${API_URL}/api/v1/auth/seller/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Merchant login failed. Check phone/email and password.');
        }

        setEmailForOtp(data.email);
        setStep('OTP');
        setSuccessMsg(data.message || '6-digit OTP sent to merchant registered email.');
        startCooldown();
      } else {
        // Merchant Registration
        const res = await fetch(`${API_URL}/api/v1/auth/seller/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            business_name: businessName,
            category,
            owner_phone: ownerPhone,
            owner_email: ownerEmail,
            password,
            upi_vpa: upiVpa,
            address,
            pincode,
            latitude: parseFloat(latitude) || 18.5074,
            longitude: parseFloat(longitude) || 73.8077
          })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Merchant registration failed.');
        }

        setEmailForOtp(data.email);
        setStep('OTP');
        setSuccessMsg(data.message || 'Verification OTP sent to merchant email.');
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
      const res = await fetch(`${API_URL}/api/v1/auth/seller/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailForOtp, otp })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Invalid or expired OTP code.');
      }

      // Store in localStorage
      localStorage.setItem('streetverse_seller_token', data.token);
      localStorage.setItem('streetverse_seller_merchant', JSON.stringify(data.merchant));

      onAuthSuccess(data.merchant, data.token);
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
        body: JSON.stringify({ scope: 'seller', email: emailForOtp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resend OTP.');
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
    <div className="min-h-screen bg-[#FDFBF7] flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-[#EBE5DA] overflow-hidden">
        
        {/* Header Banner */}
        <div className="bg-[#2A4736] p-6 text-white text-center relative">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/10 mb-3 backdrop-blur-sm">
            <Store className="w-6 h-6 text-[#D7E8DC]" />
          </div>
          <h1 className="text-2xl font-serif font-bold tracking-tight">StreetVerse Merchant</h1>
          <p className="text-xs text-[#D7E8DC]/90 mt-1">
            Vendor Dashboard &bull; Live Inventory, Appointments & AI Restock Alerts
          </p>

          {/* Demo Quick Fills */}
          <div className="mt-3 flex items-center justify-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-white/70">Demo Logins:</span>
            <button
              type="button"
              onClick={() => handleQuickFill('grocery')}
              className="text-[10px] bg-white/15 hover:bg-white/25 text-white px-2 py-0.5 rounded-full transition-colors"
            >
              Grocery Mart
            </button>
            <button
              type="button"
              onClick={() => handleQuickFill('salon')}
              className="text-[10px] bg-white/15 hover:bg-white/25 text-white px-2 py-0.5 rounded-full transition-colors"
            >
              Salon & Spa
            </button>
            <button
              type="button"
              onClick={() => handleQuickFill('pharmacy')}
              className="text-[10px] bg-white/15 hover:bg-white/25 text-white px-2 py-0.5 rounded-full transition-colors"
            >
              Pharmacy
            </button>
          </div>
        </div>

        {/* Tab Toggle */}
        {step === 'CREDENTIALS' && (
          <div className="flex border-b border-[#EBE5DA] bg-[#F7F3EB]">
            <button
              type="button"
              onClick={() => { setIsLogin(true); setError(null); }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                isLogin ? 'bg-white text-[#2A4736] border-b-2 border-[#2A4736]' : 'text-[#7D6E5D] hover:text-[#2C241B]'
              }`}
            >
              Merchant Login
            </button>
            <button
              type="button"
              onClick={() => { setIsLogin(false); setError(null); }}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                !isLogin ? 'bg-white text-[#2A4736] border-b-2 border-[#2A4736]' : 'text-[#7D6E5D] hover:text-[#2C241B]'
              }`}
            >
              Register New Store
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
            <form onSubmit={handleSubmitCredentials} className="space-y-3.5">
              {isLogin ? (
                // Login View
                <>
                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Owner Email or Registered Phone</label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type="text"
                        required
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        placeholder="greenvalley@streetverse.local or +919876543210"
                        className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Account Password</label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full pl-9 pr-10 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
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
                // Merchant Registration View
                <>
                  <div>
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Business / Store Name</label>
                    <div className="relative">
                      <Building2 className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                      <input
                        type="text"
                        required
                        value={businessName}
                        onChange={(e) => setBusinessName(e.target.value)}
                        placeholder="e.g. Pune Organics Mart"
                        className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-[#5D5043] mb-1">Category</label>
                      <select
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                      >
                        <option value="GROCERY">Grocery & Supermarket</option>
                        <option value="SALON">Salon & Grooming</option>
                        <option value="PHARMACY">Pharmacy & Health</option>
                        <option value="RESTAURANT">Restaurant & Cafe</option>
                        <option value="FLORIST">Florist & Nursery</option>
                        <option value="HARDWARE">Hardware & Electrical</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-[#5D5043] mb-1">Vendor UPI ID (VPA)</label>
                      <div className="relative">
                        <CreditCard className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                        <input
                          type="text"
                          required
                          value={upiVpa}
                          onChange={(e) => setUpiVpa(e.target.value)}
                          placeholder="merchant@upi"
                          className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-[#5D5043] mb-1">Owner Phone</label>
                      <div className="relative">
                        <Phone className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                        <input
                          type="tel"
                          required
                          value={ownerPhone}
                          onChange={(e) => setOwnerPhone(e.target.value)}
                          placeholder="+919876543210"
                          className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-[#5D5043] mb-1">Owner Email</label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-[#A89885] absolute left-3 top-3" />
                        <input
                          type="email"
                          required
                          value={ownerEmail}
                          onChange={(e) => setOwnerEmail(e.target.value)}
                          placeholder="owner@store.com"
                          className="w-full pl-9 pr-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                        />
                      </div>
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
                        placeholder="Password123!"
                        className="w-full pl-9 pr-10 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
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
                    <label className="block text-xs font-semibold text-[#5D5043] mb-1">Shop Address & Pincode</label>
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        type="text"
                        required
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="Shop 1, Kothrud, Pune"
                        className="col-span-2 px-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                      />
                      <input
                        type="text"
                        required
                        value={pincode}
                        onChange={(e) => setPincode(e.target.value)}
                        placeholder="411038"
                        className="px-3 py-2 text-sm border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-[#7D6E5D] mb-0.5">Latitude</label>
                      <input
                        type="number"
                        step="0.0001"
                        value={latitude}
                        onChange={(e) => setLatitude(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs border border-[#D9CFC1] rounded-xl focus:outline-none bg-[#FFFDF9]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-[#7D6E5D] mb-0.5">Longitude</label>
                      <input
                        type="number"
                        step="0.0001"
                        value={longitude}
                        onChange={(e) => setLongitude(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs border border-[#D9CFC1] rounded-xl focus:outline-none bg-[#FFFDF9]"
                      />
                    </div>
                  </div>
                </>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 bg-[#2A4736] hover:bg-[#1E3326] text-white font-medium rounded-xl text-sm transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2 mt-4 disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" /> Verifying...
                  </>
                ) : (
                  <>
                    {isLogin ? 'Verify Merchant & Send OTP' : 'Register Store & Send OTP'} <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}

          {/* Step 2: OTP Verification */}
          {step === 'OTP' && (
            <form onSubmit={handleVerifyOtp} className="space-y-4 animate-fadeIn">
              <div className="text-center mb-4">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[#E5ECE7] text-[#2A4736] mb-2">
                  <KeyRound className="w-6 h-6" />
                </div>
                <h3 className="text-base font-semibold text-[#2C241B]">Enter Merchant Security Code</h3>
                <p className="text-xs text-[#7D6E5D] mt-1">
                  6-digit code sent to owner email: <br />
                  <strong className="text-[#2C241B]">{emailForOtp}</strong>
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
                  className="w-full text-center tracking-[10px] text-2xl font-mono py-3 border border-[#D9CFC1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2A4736] bg-[#FFFDF9]"
                />
              </div>

              <button
                type="submit"
                disabled={loading || otp.length < 6}
                className="w-full py-3 px-4 bg-[#2A4736] hover:bg-[#1E3326] text-white font-medium rounded-xl text-sm transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" /> Authenticating...
                  </>
                ) : (
                  <>
                    Verify & Enter Merchant Dashboard <CheckCircle2 className="w-4 h-4" />
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
                  className="text-[#2A4736] font-semibold hover:underline disabled:opacity-50"
                >
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend Code'}
                </button>
              </div>
            </form>
          )}

          {/* Security Notice */}
          <div className="mt-6 pt-4 border-t border-[#EBE5DA] text-center text-[11px] text-[#A89885] flex items-center justify-center gap-1.5">
            <ShieldCheck className="w-3 h-3 text-[#2A4736]" /> Zero Customer PII Exposed &bull; Encrypted Database Connection
          </div>
        </div>

      </div>
    </div>
  );
};
