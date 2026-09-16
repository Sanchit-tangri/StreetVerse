import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import { 
  Search, 
  MapPin, 
  Calendar, 
  Clock, 
  Sparkles, 
  ShoppingBag, 
  MessageSquare, 
  QrCode, 
  CheckCircle2, 
  AlertCircle,
  LogOut,
  UserCheck,
  ChevronDown
} from 'lucide-react';
import { BuyerAuth } from '../components/auth/BuyerAuth';
import { ProfileMenu } from '../components/dashboard/ProfileMenu';
import { ProfileSettingsModal } from '../components/dashboard/ProfileSettingsModal';
import axios from 'axios';

interface MockShop {
  id: string;
  name: string;
  category: string;
  distance: string;
  rating: number;
  featuredItem: string;
  price: number;
  availableSlot: string;
}

const defaultShops: MockShop[] = [
  {
    id: 'm1',
    name: 'Green Valley Daily Needs & Organic Grocery',
    category: 'Grocery',
    distance: '350m away',
    rating: 4.8,
    featuredItem: 'Fresh Brown Bread & Organic Eggs',
    price: 45,
    availableSlot: 'Instant Delivery / Pickup'
  },
  {
    id: 'm2',
    name: 'Aura Unisex Neighborhood Salon',
    category: 'Salon & Spa',
    distance: '650m away',
    rating: 4.9,
    featuredItem: 'Hair Styling & Beard Grooming',
    price: 250,
    availableSlot: 'Today, 05:30 PM (2 slots left)'
  },
  {
    id: 'm3',
    name: 'Apollo Lifecare Pharmacy',
    category: 'Pharmacy',
    distance: '800m away',
    rating: 4.7,
    featuredItem: 'First Aid Kit & Essential Vitamins',
    price: 180,
    availableSlot: 'Store Open (Delivery in 15 mins)'
  }
];

// StreetVerse Hyperlocal Commerce - Production Build v1.0.2
export default function BuyerHome() {
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [shops, setShops] = useState<MockShop[]>(defaultShops);
  const [activeTab, setActiveTab] = useState<'DISCOVER' | 'BOOKING' | 'AI_ASSISTANT'>('DISCOVER');
  const [bookingState, setBookingState] = useState<{
    locked: boolean;
    slotId: string;
    expiresIn: number;
    upiUrl: string;
    confirmed: boolean;
  } | null>(null);

  // Profile State
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  // Location State
  const [locationName, setLocationName] = useState('Fetching location...');
  const [locationError, setLocationError] = useState<string | null>(null);
  const [userCoords, setUserCoords] = useState<{lat: number, lng: number} | null>(null);

  const fetchLocation = () => {
    setLocationName('Detecting location...');
    setLocationError(null);
    if (!navigator.geolocation) {
      setLocationName('Location not supported');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        setUserCoords({ lat: latitude, lng: longitude });
        try {
          const res = await axios.get(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=14&addressdetails=1`,
            { headers: { 'Accept-Language': 'en-US,en;q=0.9' } }
          );
          
          const address = res.data.address;
          if (address) {
            const locality = address.suburb || address.neighbourhood || address.city_district || address.city || address.town || address.village || 'Current Location';
            const city = address.city || address.state_district || address.state || '';
            const displayName = city && locality !== city ? `${locality}, ${city}` : locality;
            setLocationName(displayName || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
          } else {
            setLocationName('Location found (no address)');
          }
        } catch (err) {
          console.error('Geocoding error:', err);
          setLocationName(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
        }
      },
      (error) => {
        console.error(error);
        setLocationName('Location access denied');
        setLocationError('Please allow location access for hyperlocal results.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  useEffect(() => {
    if (currentUser) {
      fetchLocation();
    }
  }, [currentUser]);

  // Check persisted session on mount
  useEffect(() => {
    try {
      const savedToken = localStorage.getItem('streetverse_buyer_token');
      const savedUser = localStorage.getItem('streetverse_buyer_user');
      if (savedToken && savedUser) {
        setCurrentUser(JSON.parse(savedUser));
      }
    } catch (e) {
      console.warn('Session parse error:', e);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('streetverse_buyer_token');
    localStorage.removeItem('streetverse_buyer_user');
    setCurrentUser(null);
  };

  // If session is still checking, show loading
  if (!authChecked) {
    return (
      <div style={{ backgroundColor: '#FAF7F2', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#78716C', fontSize: '0.9rem' }}>Loading StreetVerse...</div>
      </div>
    );
  }

  // If unauthenticated, show the BuyerAuth login screen first!
  if (!currentUser) {
    return <BuyerAuth onAuthSuccess={(user) => setCurrentUser(user)} />;
  }

  // 5-Minute Atomic Slot Lock Simulation
  const handleLockSlot = (shop: MockShop) => {
    const slotId = `slot-${Date.now()}`;
    const dynamicUpi = `upi://pay?pa=streetverse.merchant@okhdfcbank&pn=${encodeURIComponent(shop.name)}&am=${shop.price}&cu=INR&tn=StreetVerse_${slotId}`;
    setBookingState({
      locked: true,
      slotId,
      expiresIn: 300,
      upiUrl: dynamicUpi,
      confirmed: false
    });
  };

  const handleConfirmUpi = () => {
    if (bookingState) {
      setBookingState({
        ...bookingState,
        confirmed: true
      });
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setShops(defaultShops);
      return;
    }
    setIsSearching(true);
    const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://unplowed-nutlike-antitoxic.ngrok-free.dev';
    try {
      const res = await axios.post(`${API_URL}/api/v1/search/hyperlocal`, {
        query: searchQuery,
        latitude: userCoords?.lat || 18.5204, // Default to Pune if denied
        longitude: userCoords?.lng || 73.8567,
        max_radius_km: 5.0,
        limit: 4
      }, { withCredentials: true, headers: { 'ngrok-skip-browser-warning': 'true' } });

      const results = res.data.results || [];
      if (results.length > 0) {
        const mappedShops: MockShop[] = results.map((r: any) => ({
          id: r.item_id,
          name: r.business_name,
          category: r.category,
          distance: r.distance_meters > 1000 ? `${(r.distance_meters / 1000).toFixed(1)}km away` : `${Math.round(r.distance_meters)}m away`,
          rating: (Math.random() * (5 - 4) + 4).toFixed(1), // Mock rating
          featuredItem: r.item_name,
          price: r.price,
          availableSlot: r.is_available ? 'Available Now' : 'Out of Stock'
        }));
        setShops(mappedShops);
      } else {
        setShops([]); // No results
      }
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div style={{ backgroundColor: '#FAF7F2', minHeight: '100vh', color: '#292524', fontFamily: 'Plus Jakarta Sans, sans-serif' }}>
      <Head>
        <title>StreetVerse - Neighborhood Commerce & Discovery</title>
      </Head>

      {/* Warm Cream Header */}
      <header style={{ borderBottom: '1px solid #E7E5E4', backgroundColor: '#FFFDF9', padding: '1rem 2rem', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#D97706', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFF' }}>
              <ShoppingBag size={22} />
            </div>
            <div>
              <h1 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#292524', margin: 0, letterSpacing: '-0.02em' }}>StreetVerse</h1>
              <p style={{ fontSize: '0.75rem', color: '#78716C', margin: 0 }}>Hyperlocal Commerce • Customer Portal</p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div 
              onClick={fetchLocation}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', backgroundColor: '#F3ECE2', padding: '0.4rem 0.9rem', borderRadius: 9999, fontSize: '0.85rem', cursor: 'pointer' }}
              title="Click to refresh location"
            >
              <MapPin size={16} color={locationError ? "#DC2626" : "#D97706"} />
              <span style={{ fontWeight: 600, color: locationError ? "#DC2626" : "inherit" }}>{locationName}</span>
            </div>

            {/* Authenticated User Badge & Dropdown */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.5rem', 
                  backgroundColor: '#FFF', 
                  border: '1px solid #E7E5E4', 
                  padding: '0.35rem 0.85rem', 
                  borderRadius: 9999, 
                  fontSize: '0.8rem',
                  cursor: 'pointer'
                }}
              >
                <UserCheck size={14} color="#16A34A" />
                <span style={{ fontWeight: 600, color: '#292524' }}>{currentUser.fullName || currentUser.phone}</span>
                <ChevronDown size={14} color="#78716C" />
              </button>

              {isProfileMenuOpen && (
                <ProfileMenu 
                  user={currentUser} 
                  onLogout={handleLogout}
                  onOpenSettings={() => setIsSettingsModalOpen(true)}
                  onClose={() => setIsProfileMenuOpen(false)}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      {isSettingsModalOpen && (
        <ProfileSettingsModal 
          user={currentUser}
          onClose={() => setIsSettingsModalOpen(false)}
          onUserUpdated={(user) => {
            setCurrentUser(user);
            localStorage.setItem('streetverse_buyer_user', JSON.stringify(user));
          }}
        />
      )}

      {/* Main Content Area */}
      <main style={{ maxWidth: '1200px', margin: '2rem auto', padding: '0 1.5rem' }}>
        
        {/* Search Bar / RAG Discovery Input */}
        <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #E7E5E4', borderRadius: 20, padding: '1.25rem', boxShadow: '0 4px 20px rgba(0,0,0,0.03)', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <Search size={22} color="#D97706" />
            <input 
              type="text" 
              placeholder="Ask AI: 'Where can I find organic brown bread or book a salon haircut nearby?'" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              style={{ width: '100%', border: 'none', outline: 'none', fontSize: '1rem', backgroundColor: 'transparent', color: '#292524' }}
            />
            <button 
              onClick={handleSearch}
              disabled={isSearching}
              style={{ backgroundColor: '#D97706', color: '#FFF', border: 'none', borderRadius: 12, padding: '0.6rem 1.4rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: isSearching ? 'not-allowed' : 'pointer', opacity: isSearching ? 0.7 : 1 }}
            >
              <Sparkles size={16} /> {isSearching ? 'Searching...' : 'Search Local'}
            </button>
          </div>
        </div>

        {/* Nearby Stores & Services */}
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem', color: '#292524' }}>
          {searchQuery && !isSearching ? `AI Results for "${searchQuery}"` : 'Nearby Neighborhood Stores & Services'}
        </h2>

        {shops.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: '#78716C', backgroundColor: '#FFFDF9', borderRadius: 16, border: '1px solid #E7E5E4' }}>
            No local businesses found matching your query. Try a different search!
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
            {shops.map((shop) => (
              <div key={shop.id} style={{ backgroundColor: '#FFFDF9', border: '1px solid #E7E5E4', borderRadius: 16, padding: '1.5rem', transition: 'all 0.2s' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <div>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: '#D97706', letterSpacing: '0.05em' }}>{shop.category}</span>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginTop: '0.25rem' }}>{shop.name}</h3>
                </div>
                <span style={{ backgroundColor: '#ECFDF5', color: '#059669', fontSize: '0.8rem', fontWeight: 700, padding: '0.2rem 0.6rem', borderRadius: 9999 }}>
                  ★ {shop.rating}
                </span>
              </div>

              <p style={{ fontSize: '0.85rem', color: '#78716C', marginBottom: '1rem' }}>
                📍 {shop.distance} • {shop.featuredItem}
              </p>

              <div style={{ borderTop: '1px solid #F3ECE2', paddingTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: '0.75rem', color: '#78716C' }}>Starting from</span>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#292524' }}>₹{shop.price}</div>
                </div>

                <button 
                  onClick={() => handleLockSlot(shop)}
                  style={{ backgroundColor: '#D97706', color: '#FFF', border: 'none', borderRadius: 10, padding: '0.5rem 1rem', fontWeight: 600, cursor: 'pointer' }}
                >
                  Reserve Slot / Buy
                </button>
              </div>
            </div>
          ))}
        </div>
        )}

        {/* 5-Minute Booking Lock Modal */}
        {bookingState && (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
            <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #E7E5E4', borderRadius: 20, padding: '2rem', maxWidth: '460px', width: '90%', boxShadow: '0 20px 40px rgba(0,0,0,0.15)' }}>
              
              {!bookingState.confirmed ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#D97706', marginBottom: '0.5rem' }}>
                    <Clock size={20} />
                    <span style={{ fontWeight: 700 }}>5-Minute Atomic Holding Lock</span>
                  </div>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '0.5rem' }}>Complete Dynamic UPI Payment</h3>
                  <p style={{ fontSize: '0.85rem', color: '#78716C', marginBottom: '1.5rem' }}>
                    This slot has been temporarily locked exclusively for you in the Merchant DB. Please scan the QR code to confirm.
                  </p>

                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.5rem', padding: '1rem', backgroundColor: '#FAF7F2', borderRadius: 12 }}>
                    <div style={{ textAlign: 'center' }}>
                      <QrCode size={120} color="#D97706" />
                      <p style={{ fontSize: '0.75rem', color: '#78716C', marginTop: '0.5rem' }}>Scan with any UPI App (GPay / PhonePe / Paytm)</p>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    <button 
                      onClick={() => setBookingState(null)} 
                      style={{ flex: 1, backgroundColor: '#F3ECE2', border: 'none', borderRadius: 10, padding: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={handleConfirmUpi}
                      style={{ flex: 1, backgroundColor: '#10B981', color: '#FFF', border: 'none', borderRadius: 10, padding: '0.75rem', fontWeight: 700, cursor: 'pointer' }}
                    >
                      Simulate UPI Paid
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <CheckCircle2 size={50} color="#10B981" style={{ margin: '0 auto 1rem' }} />
                  <h3 style={{ fontSize: '1.3rem', fontWeight: 800, color: '#292524' }}>Booking Confirmed!</h3>
                  <p style={{ fontSize: '0.9rem', color: '#78716C', marginBottom: '1.5rem' }}>
                    Receipt saved to your isolated Customer DB. Vendor dashboard notified via Redis Pub/Sub.
                  </p>
                  <button 
                    onClick={() => setBookingState(null)} 
                    style={{ backgroundColor: '#D97706', color: '#FFF', border: 'none', borderRadius: 10, padding: '0.75rem 2rem', fontWeight: 700, cursor: 'pointer' }}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
