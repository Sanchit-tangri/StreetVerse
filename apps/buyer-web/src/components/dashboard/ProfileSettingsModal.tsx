import React, { useState } from 'react';
import { X, CheckCircle2, ShieldAlert } from 'lucide-react';
import axios from 'axios';

interface ProfileSettingsModalProps {
  user: any;
  onClose: () => void;
  onUserUpdated: (updatedUser: any) => void;
}

export const ProfileSettingsModal: React.FC<ProfileSettingsModalProps> = ({ user, onClose, onUserUpdated }) => {
  const [fullName, setFullName] = useState(user.fullName || '');
  const [email, setEmail] = useState(user.email || '');
  
  const [isVerifyingEmail, setIsVerifyingEmail] = useState(false);
  const [otp, setOtp] = useState('');
  
  const [status, setStatus] = useState<{ type: 'error' | 'success' | 'info'; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://unplowed-nutlike-antitoxic.ngrok-free.dev';

  const handleRequestEmailChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (email === user.email && fullName === user.fullName) {
      setStatus({ type: 'info', message: 'No changes made.' });
      return;
    }

    // If only name changed, we could just update it. 
    // For simplicity, let's assume we trigger OTP if email changes.
    if (email !== user.email) {
      setLoading(true);
      try {
        await axios.post(`${API_URL}/api/user/request-email-change`, {
          newEmail: email,
          userId: user.id
        }, { withCredentials: true, headers: { 'ngrok-skip-browser-warning': 'true' } });
        
        setIsVerifyingEmail(true);
        setStatus({ type: 'success', message: 'OTP sent to your new email!' });
      } catch (err: any) {
        setStatus({ type: 'error', message: err.response?.data?.error || 'Failed to send OTP.' });
      } finally {
        setLoading(false);
      }
    } else {
      // Just update name
      // TODO: Implement name only update in gateway if needed
      setStatus({ type: 'info', message: 'Name update API pending implementation.' });
    }
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await axios.post(`${API_URL}/api/user/verify-email-change`, {
        newEmail: email,
        userId: user.id,
        otp
      }, { withCredentials: true, headers: { 'ngrok-skip-browser-warning': 'true' } });
      
      setStatus({ type: 'success', message: 'Email updated successfully!' });
      onUserUpdated(res.data.user);
      setTimeout(() => onClose(), 1500);
    } catch (err: any) {
      setStatus({ type: 'error', message: err.response?.data?.error || 'Invalid OTP.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ backgroundColor: '#FFFDF9', borderRadius: '24px', width: '100%', maxWidth: '400px', padding: '2rem', position: 'relative', boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
        
        <button 
          onClick={onClose}
          style={{ position: 'absolute', top: '1.25rem', right: '1.25rem', background: 'none', border: 'none', cursor: 'pointer', color: '#A8A29E' }}
        >
          <X size={24} />
        </button>

        <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#292524', marginBottom: '1.5rem', marginTop: 0 }}>
          Profile Settings
        </h2>

        {status && (
          <div style={{ 
            padding: '0.75rem', 
            borderRadius: '12px', 
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            backgroundColor: status.type === 'error' ? '#FEF2F2' : status.type === 'success' ? '#ECFDF5' : '#EFF6FF',
            color: status.type === 'error' ? '#B91C1C' : status.type === 'success' ? '#059669' : '#1D4ED8',
            fontSize: '0.85rem',
            fontWeight: 600
          }}>
            {status.type === 'error' ? <ShieldAlert size={16} /> : <CheckCircle2 size={16} />}
            {status.message}
          </div>
        )}

        {!isVerifyingEmail ? (
          <form onSubmit={handleRequestEmailChange} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#44403C', marginBottom: '0.4rem' }}>Full Name</label>
              <input 
                type="text" 
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                style={{ width: '100%', padding: '0.75rem 1rem', borderRadius: '12px', border: '1px solid #E7E5E4', backgroundColor: '#FFF', fontSize: '0.9rem', color: '#292524', outline: 'none' }}
              />
            </div>
            
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#44403C', marginBottom: '0.4rem' }}>Email Address</label>
              <input 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ width: '100%', padding: '0.75rem 1rem', borderRadius: '12px', border: '1px solid #E7E5E4', backgroundColor: '#FFF', fontSize: '0.9rem', color: '#292524', outline: 'none' }}
              />
            </div>

            <div style={{ fontSize: '0.75rem', color: '#78716C', marginTop: '-0.5rem' }}>
              Note: Changing your email will require verification.
            </div>

            <button 
              type="submit" 
              disabled={loading}
              style={{ marginTop: '0.5rem', backgroundColor: '#D97706', color: '#FFF', border: 'none', padding: '0.85rem', borderRadius: '12px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
            >
              {loading ? 'Processing...' : 'Save Changes'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyEmail} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#44403C', marginBottom: '0.4rem' }}>Enter Verification OTP</label>
              <input 
                type="text" 
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="6-digit code"
                style={{ width: '100%', padding: '0.75rem 1rem', borderRadius: '12px', border: '1px solid #E7E5E4', backgroundColor: '#FFF', fontSize: '0.9rem', color: '#292524', outline: 'none', textAlign: 'center', letterSpacing: '0.1em', fontWeight: 700 }}
              />
            </div>
            <button 
              type="submit" 
              disabled={loading}
              style={{ marginTop: '0.5rem', backgroundColor: '#16A34A', color: '#FFF', border: 'none', padding: '0.85rem', borderRadius: '12px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
            >
              {loading ? 'Verifying...' : 'Verify & Update Email'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
