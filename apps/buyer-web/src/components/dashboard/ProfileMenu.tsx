import React, { useRef, useEffect } from 'react';
import { 
  Heart, 
  Gift, 
  HelpCircle, 
  MapPin, 
  Award, 
  CreditCard, 
  Bell, 
  Info, 
  LogOut, 
  RefreshCcw,
  User,
  Settings
} from 'lucide-react';

interface ProfileMenuProps {
  user: any;
  onLogout: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

export const ProfileMenu: React.FC<ProfileMenuProps> = ({ user, onLogout, onOpenSettings, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const menuItemStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem 1rem',
    fontSize: '0.85rem',
    color: '#44403C',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    textDecoration: 'none',
    border: 'none',
    background: 'none',
    width: '100%',
    textAlign: 'left' as const,
  };

  const sectionHeaderStyle = {
    fontSize: '0.75rem',
    fontWeight: 700,
    color: '#A8A29E',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    padding: '1rem 1rem 0.5rem',
  };

  return (
    <div 
      ref={menuRef}
      style={{
        position: 'absolute',
        top: 'calc(100% + 0.5rem)',
        right: 0,
        width: '280px',
        backgroundColor: '#FFFDF9',
        border: '1px solid #E7E5E4',
        borderRadius: '16px',
        boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
        zIndex: 50,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Header Profile Section */}
      <div style={{ padding: '1.25rem 1rem', borderBottom: '1px solid #F3ECE2', backgroundColor: '#FAF7F2' }}>
        <p style={{ margin: 0, fontWeight: 700, fontSize: '1rem', color: '#292524' }}>{user.fullName || 'Valued Customer'}</p>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#78716C' }}>{user.email || 'No email set'}</p>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#78716C' }}>+91 {user.phone}</p>
        
        <button
          onClick={() => { onClose(); onOpenSettings(); }}
          style={{ ...menuItemStyle, padding: '0.5rem 0', marginTop: '0.5rem', color: '#D97706', fontWeight: 600 }}
        >
          <Settings size={16} /> Edit Profile & Email
        </button>
      </div>

      <div style={{ maxHeight: '350px', overflowY: 'auto' }}>
        <div style={sectionHeaderStyle}>Your Information</div>
        <button style={menuItemStyle} className="hover:bg-gray-50"><RefreshCcw size={16} /> Your Refunds</button>
        <button style={menuItemStyle} className="hover:bg-gray-50"><Heart size={16} /> Your Wishlist</button>
        <button style={menuItemStyle} className="hover:bg-gray-50"><Gift size={16} /> E-Gift Cards</button>
        <button style={menuItemStyle} className="hover:bg-gray-50"><HelpCircle size={16} /> Help & Support</button>
        <button style={menuItemStyle} className="hover:bg-gray-50"><MapPin size={16} /> Saved Addresses</button>
        <button style={menuItemStyle} className="hover:bg-gray-50"><Award size={16} /> Rewards</button>
        <button style={menuItemStyle} className="hover:bg-gray-50"><CreditCard size={16} /> Payment Management</button>

        <div style={sectionHeaderStyle}>Other Information</div>
        <button style={menuItemStyle} className="hover:bg-gray-50"><Bell size={16} /> Notifications</button>
        <button style={menuItemStyle} className="hover:bg-gray-50"><Info size={16} /> General Info / Legal</button>
      </div>

      <div style={{ borderTop: '1px solid #F3ECE2', padding: '0.5rem' }}>
        <button 
          onClick={onLogout}
          style={{ ...menuItemStyle, color: '#DC2626', fontWeight: 600, borderRadius: '8px' }}
          className="hover:bg-red-50"
        >
          <LogOut size={16} /> Log Out
        </button>
      </div>
    </div>
  );
};
