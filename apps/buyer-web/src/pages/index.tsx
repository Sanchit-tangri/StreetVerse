import React, { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
import axios from 'axios';
import { BuyerAuth } from '../components/auth/BuyerAuth';
import { ProfileSettingsModal } from '../components/dashboard/ProfileSettingsModal';
import { getTranslation } from '../utils/translations';
import {
  createInitialBookingFlowState,
  resolveConfirmBookingOutcome,
  resolveLockSlotOutcome
} from '../utils/bookingFlow';
import {
  AuthenticatedBuyerUser,
  buildBuyerAuthHeaders,
  clearBuyerSession,
  hydrateBuyerSession,
  resolveBuyerApiUrl
} from '../utils/buyerSession';

interface MarketplaceItem {
  id: string;
  category: 'dining' | 'grocery' | 'wellness' | 'turf';
  title: string;
  vendorName: string;
  distance: string;
  price: number;
  originalPrice?: number;
  rating: number;
  ratingCount: string;
  image: string;
  imageAlt: string;
  badge: string;
  badgeColor: string;
  deliveryEtaOrSlot: string;
  description: string;
  isService?: boolean;
  serviceType?: string;
  priceLabel?: string;
}

// 100% Indian Hyperlocal Catalog with authentic pricing (₹ INR), vendors & images
const INDIAN_CATALOG: MarketplaceItem[] = [
  {
    id: 'd-1',
    category: 'dining',
    title: 'Special Handi Mutton Dum Biryani (Peshawari Saffron)',
    vendorName: 'Bawarchi Nawabi Kitchen',
    distance: '0.8 km (Kothrud)',
    price: 349,
    originalPrice: 450,
    rating: 4.92,
    ratingCount: '3.4k',
    image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?auto=format&fit=crop&w=800&q=80',
    imageAlt: 'Authentic Hyderabadi Dum Biryani served with fragrant saffron and spices in traditional clay handi',
    badge: '30% OFF COMBO',
    badgeColor: 'bg-error text-on-error',
    deliveryEtaOrSlot: '18-22m',
    description: 'Slow-cooked aged Basmati rice, marinated tender mutton chunks, saffron milk, served with spicy mirchi ka salan & burani raita.'
  },
  {
    id: 'd-2',
    category: 'dining',
    title: 'Woodfired Paneer Tikka & Burrata Makhani Naan-Za',
    vendorName: 'The Artisan Tandoor & Oven',
    distance: '1.2 km (FC Road)',
    price: 269,
    originalPrice: 340,
    rating: 4.88,
    ratingCount: '1.9k',
    image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=800&q=80',
    imageAlt: 'Woodfired tandoori pizza bubbling with mozzarella, paneer tikka, and rich makhani sauce',
    badge: 'CHEF SPECIAL',
    badgeColor: 'bg-primary-container text-on-primary',
    deliveryEtaOrSlot: '20-25m',
    description: '48-hour fermented sourdough crust, charred clay oven paneer tikka, rich butter makhani reduction, buffalo mozzarella, and fresh coriander.'
  },
  {
    id: 'g-1',
    category: 'grocery',
    title: 'Fresh Mandi Morning Harvest + A2 Desi Cow Milk Basket',
    vendorName: 'Gokul Kisan Mandi Direct & Dairy',
    distance: '0.6 km (Pune Mandi)',
    price: 185,
    originalPrice: 240,
    rating: 4.96,
    ratingCount: '4.8k',
    image: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=800&q=80',
    imageAlt: 'Fresh morning farm harvest vegetables and glass milk bottle',
    badge: 'FLASH MANDI HARVEST',
    badgeColor: 'bg-secondary text-on-secondary',
    deliveryEtaOrSlot: '10 min drop',
    description: '1L A2 Gir Cow Milk, 6 Free-range brown eggs, 1kg Desi Hybrid Tomatoes, 500g Tender Bhindi, and Fresh Dhaniya-Mirchi bundle.'
  },
  {
    id: 'g-2',
    category: 'grocery',
    title: 'MP Sharbati Chakki Atta (5kg) + Fortune Kachi Ghani Mustard Oil (1L)',
    vendorName: 'Sharma Kirana & General Store',
    distance: '0.3 km (Mayur Colony)',
    price: 395,
    originalPrice: 460,
    rating: 4.82,
    ratingCount: '2.1k',
    image: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=800&q=80',
    imageAlt: 'Indian kitchen staples, grain bags, chakki flour, mustard oil',
    badge: 'KIRANA SAVER',
    badgeColor: 'bg-secondary text-on-secondary',
    deliveryEtaOrSlot: '12 min drop',
    description: '100% whole wheat grain chakki fresh ground flour with unrefined cold-pressed virgin mustard oil for healthy Indian cooking.'
  },
  {
    id: 'w-1',
    category: 'wellness',
    title: 'Royal Grooming: Precision Fade Cut, Beard Sculpt & Charcoal D-Tan',
    vendorName: 'TrueCut Barber & Salon Studio',
    distance: '1.1 km (Indiranagar / Kothrud)',
    price: 299,
    originalPrice: 450,
    rating: 4.95,
    ratingCount: '1.6k',
    image: 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=800&q=80',
    imageAlt: 'Modern men salon haircut and beard styling session',
    badge: 'ZERO WAIT TOKEN',
    badgeColor: 'bg-primary-container text-on-primary',
    deliveryEtaOrSlot: 'Open: 05:30 PM Today',
    description: 'Stylist consultation, precision fade haircut, beard sculpting with hot towel steam, and herbal charcoal de-tan skin glow therapy.',
    isService: true,
    serviceType: 'Men Grooming',
    priceLabel: '40 mins'
  },
  {
    id: 'w-2',
    category: 'wellness',
    title: 'Ayurvedic Herbal Hair Spa & Shirodhara Head Massage (45 Mins)',
    vendorName: 'Aura Ayurvedic Wellness Lounge',
    distance: '1.8 km (Deccan Gymkhana)',
    price: 599,
    originalPrice: 850,
    rating: 4.98,
    ratingCount: '920',
    image: 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=800&q=80',
    imageAlt: 'Ayurvedic massage and relaxation spa therapy',
    badge: '5-MIN ATOMIC LOCK',
    badgeColor: 'bg-surface-tint text-on-primary',
    deliveryEtaOrSlot: 'Open: 06:30 PM Today',
    description: 'Warm Brahmi & Bhringraj oil massage, scalp steam, herbal nourishing mask, and soothing neck & shoulder stress release.',
    isService: true,
    serviceType: 'Ayurvedic Spa',
    priceLabel: '45 mins'
  },
  {
    id: 't-1',
    category: 'turf',
    title: 'Prime Floodlit Box Cricket Arena (60 Mins Slot - Bats & Ball Included)',
    vendorName: 'Spartan Box Cricket Arena',
    distance: '2.2 km (Campus East / Baner)',
    price: 800,
    originalPrice: 1000,
    rating: 4.92,
    ratingCount: '840',
    image: 'https://images.unsplash.com/photo-1529900748604-07564a03e7a6?auto=format&fit=crop&w=800&q=80',
    imageAlt: 'Green floodlit turf arena under night sports stadium lights',
    badge: 'NIGHT LEAGUE OPEN',
    badgeColor: 'bg-tertiary-container text-on-tertiary',
    deliveryEtaOrSlot: 'Tonight 8-9 PM Open',
    description: 'High-density synthetic box cricket turf, boundary netting, glare-free LED floodlights, digital scoreboard, and gear rentals.',
    isService: true,
    serviceType: 'Box Cricket',
    priceLabel: '/ 1 hr slot'
  },
  {
    id: 't-2',
    category: 'turf',
    title: 'FIFA Pro Synthetic 7v7 Football Turf (60 Mins Slot)',
    vendorName: 'KickOff Sports Arena',
    distance: '2.5 km (West Metro Hub)',
    price: 1200,
    originalPrice: 1500,
    rating: 4.94,
    ratingCount: '610',
    image: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=800&q=80',
    imageAlt: 'Synthetic football turf with night stadium lights',
    badge: 'INSTANT LOCK',
    badgeColor: 'bg-tertiary-container text-on-tertiary',
    deliveryEtaOrSlot: 'Tonight 9-10 PM Open',
    description: 'Full 7-a-side synthetic shock-pad turf pitch, night floodlit access, dugout benches, and changing rooms with showers.',
    isService: true,
    serviceType: 'Sports Turf',
    priceLabel: '/ 1 hr slot'
  }
];

interface TrayItem {
  item: MarketplaceItem;
  quantity: number;
}

export default function BuyerHome() {
  // Theme & Accent
  const [theme, setTheme] = useState<'light' | 'warm-beige' | 'sky-blue' | 'dark'>('dark');
  const [accent, setAccent] = useState<'indigo' | 'emerald' | 'amber' | 'rose'>('indigo');
  const [currentLang, setCurrentLang] = useState('EN · India');

  // Load saved language preference
  useEffect(() => {
    try {
      const savedLang = localStorage.getItem('streetverse_lang');
      if (savedLang) setCurrentLang(savedLang);
    } catch { }
  }, []);

  const t = (key: string, fallback?: string) => getTranslation(currentLang, key, fallback);

  const handleSelectCategory = (cat: 'all' | 'dining' | 'grocery' | 'wellness' | 'turf') => {
    setActiveFilterTab(cat);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 320, behavior: 'smooth' });
    }
  };

  // User & Auth State (Strictly server-hydrated via GET /api/v1/auth/me)
  const [currentUser, setCurrentUser] = useState<AuthenticatedBuyerUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false);
  const [isLocationDropdownOpen, setIsLocationDropdownOpen] = useState(false);

  // Omnisearch & Hot Filter
  const [searchQuery, setSearchQuery] = useState('');
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [activeFilterTab, setActiveFilterTab] = useState<'all' | 'dining' | 'grocery' | 'wellness' | 'turf'>('all');
  const [catalog, setCatalog] = useState<MarketplaceItem[]>(INDIAN_CATALOG);
  const [isSearching, setIsSearching] = useState(false);

  // Indian Delivery Location Hubs
  const [deliverTo, setDeliverTo] = useState('Kothrud, Pune 411038');
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);

  // Cart / Tray slide-over
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [isTrayOpen, setIsTrayOpen] = useState(false);
  const [addedItemFeedback, setAddedItemFeedback] = useState<string | null>(null);

  // 5-Minute Atomic Slot Booking Modal
  const [isSlotModalOpen, setIsSlotModalOpen] = useState(false);
  const [selectedServiceItem, setSelectedServiceItem] = useState<MarketplaceItem | null>(null);
  const [selectedSlotTime, setSelectedSlotTime] = useState('06:30 PM (Fav)');
  const [slotCountdown, setSlotCountdown] = useState<number>(300);
  const [isSlotLocked, setIsSlotLocked] = useState(false);
  const [lockToken, setLockToken] = useState<string | null>(null);
  const [bookingConfirmedReceipt, setBookingConfirmedReceipt] = useState<any>(null);
  const [isLocking, setIsLocking] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://clatter-mousiness-smugness.ngrok-free.dev';
  const [serverNode, setServerNode] = useState<any>(null);

  // Fetch live home server telemetry & node status
  useEffect(() => {
    axios
      .get(`${API_URL}/api/v1/server/node-status`, {
        headers: { 'ngrok-skip-browser-warning': 'true' },
        timeout: 4000
      })
      .then((res) => {
        if (res.data && res.data.node) {
          setServerNode(res.data.node);
        }
      })
      .catch(() => { });
  }, [API_URL]);

  // Apply visual theme to DOM
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    body.classList.remove('theme-warm-beige', 'theme-sky-blue', 'dark');

    if (theme === 'dark') {
      root.classList.add('dark');
      body.classList.add('dark');
      body.style.backgroundColor = '#090D16';
    } else if (theme === 'warm-beige') {
      root.classList.remove('dark');
      body.classList.add('theme-warm-beige');
      body.style.backgroundColor = '#F7F4EA';
    } else if (theme === 'sky-blue') {
      root.classList.remove('dark');
      body.classList.add('theme-sky-blue');
      body.style.backgroundColor = '#EBF4FF';
    } else {
      root.classList.remove('dark');
      body.style.backgroundColor = '#faf8ff';
    }
  }, [theme]);

  const refreshBuyerSession = useCallback(async () => {
    const result = await hydrateBuyerSession({ apiUrl: API_URL });
    if (result.status === 'authenticated' && result.user && result.token) {
      setCurrentUser(result.user);
      setAuthToken(result.token);
      setSessionError(null);
      setSessionNotice(null);
    } else if (result.status === 'service_unavailable') {
      setCurrentUser(null);
      setAuthToken(result.token);
      setSessionError(
        result.errorMessage || 'Authentication service is temporarily unavailable. Please retry.'
      );
    } else {
      setCurrentUser(null);
      setAuthToken(null);
      setSessionError(null);
      if (result.errorMessage) {
        setSessionNotice(result.errorMessage);
      }
    }
    setAuthChecked(true);
  }, [API_URL]);

  // Hydrate authenticated buyer session from /api/v1/auth/me (never trust local profile cache)
  useEffect(() => {
    void refreshBuyerSession();
  }, [refreshBuyerSession]);

  // Keyboard shortcut: Cmd+K / Ctrl+K focuses search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Geolocation detection
  useEffect(() => {
    if (typeof window !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          setUserCoords({ lat: latitude, lng: longitude });
        },
        () => { },
        { timeout: 8000 }
      );
    }
  }, []);

  // Slot countdown timer for 5-minute atomic lock
  useEffect(() => {
    let timer: any;
    if (isSlotLocked && slotCountdown > 0) {
      timer = setInterval(() => {
        setSlotCountdown((prev) => {
          if (prev <= 1) {
            setIsSlotLocked(false);
            setLockToken(null);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isSlotLocked, slotCountdown]);

  // Sign out handler (clears persisted token cleanly and returns to sign-in screen)
  const handleLogout = (notice?: string) => {
    clearBuyerSession();
    setCurrentUser(null);
    setAuthToken(null);
    setSessionError(null);
    setSessionNotice(typeof notice === 'string' && notice.trim().length > 0 ? notice : null);
    setIsProfileDropdownOpen(false);
  };

  // Voice Search Handler
  const triggerVoiceSearch = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setIsVoiceActive(true);
      setTimeout(() => {
        setSearchQuery('Dum handi biryani near me');
        setIsVoiceActive(false);
        handleSearchSubmit('Dum handi biryani near me');
      }, 1500);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'en-IN';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      setIsVoiceActive(true);
      recognition.start();

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setSearchQuery(transcript);
        setIsVoiceActive(false);
        handleSearchSubmit(transcript);
      };

      recognition.onerror = () => setIsVoiceActive(false);
      recognition.onend = () => setIsVoiceActive(false);
    } catch {
      setIsVoiceActive(false);
    }
  };

  // Perform Hyperlocal Search
  const handleSearchSubmit = async (queryText: string) => {
    const q = queryText.trim();
    if (!q) {
      setCatalog(INDIAN_CATALOG);
      return;
    }

    setIsSearching(true);
    try {
      const lat = userCoords?.lat || 18.5074;
      const lon = userCoords?.lng || 73.8077;
      const res = await axios.get(
        `${API_URL}/api/v1/search/hyperlocal?q=${encodeURIComponent(q)}&lat=${lat}&lon=${lon}&radius=10`,
        { headers: { 'ngrok-skip-browser-warning': 'true' }, timeout: 4000 }
      );

      if (res.data && Array.isArray(res.data.results) && res.data.results.length > 0) {
        const mappedResults: MarketplaceItem[] = res.data.results.map((r: any, idx: number) => {
          const isSlot = r.item_type === 'slot' || r.type === 'service';
          const isDining = r.category === 'DINING' || r.category === 'RESTAURANT';
          const cat: any = isSlot ? (r.category === 'SPORTS' ? 'turf' : 'wellness') : (isDining ? 'dining' : 'grocery');
          const distLabel = r.distance_meters !== undefined
            ? `${(Number(r.distance_meters) / 1000).toFixed(1)} km (PostGIS)`
            : (r.distance_km ? `${r.distance_km.toFixed(1)} km away` : '0.8 km (Kothrud)');

          return {
            id: r.item_id || r.id || `search-${idx}`,
            category: cat,
            title: r.item_name || r.business_name || q,
            vendorName: r.business_name || 'Neighborhood Merchant',
            distance: distLabel,
            price: Number(r.price) || 249,
            originalPrice: Number(r.price) ? Math.round(Number(r.price) * 1.3) : undefined,
            rating: Number(r.rating) || 4.9,
            ratingCount: 'Live DB Record',
            image: isSlot
              ? (cat === 'turf' ? INDIAN_CATALOG[6].image : INDIAN_CATALOG[4].image)
              : (isDining ? INDIAN_CATALOG[0].image : INDIAN_CATALOG[2].image),
            imageAlt: r.item_name || 'Search result',
            badge: '⚡ LIVE SERVER DB',
            badgeColor: 'bg-emerald-600 text-white font-bold',
            deliveryEtaOrSlot: isSlot ? 'Today · Instant Lock' : '15-20m Express',
            description: r.description || `Fresh real-time inventory from ${r.business_name}. Powered by Docker PostgreSQL 16 on Pratham's Server.`,
            isService: isSlot,
            serviceType: isSlot ? (cat === 'turf' ? 'Sports Turf' : 'Salon & Grooming') : undefined,
            priceLabel: isSlot ? '/ slot' : undefined
          };
        });
        setCatalog(mappedResults);
      } else {
        const filtered = INDIAN_CATALOG.filter(
          (item) =>
            item.title.toLowerCase().includes(q.toLowerCase()) ||
            item.vendorName.toLowerCase().includes(q.toLowerCase()) ||
            item.description.toLowerCase().includes(q.toLowerCase())
        );
        setCatalog(filtered.length > 0 ? filtered : INDIAN_CATALOG);
      }
    } catch {
      const filtered = INDIAN_CATALOG.filter(
        (item) =>
          item.title.toLowerCase().includes(q.toLowerCase()) ||
          item.vendorName.toLowerCase().includes(q.toLowerCase()) ||
          item.description.toLowerCase().includes(q.toLowerCase())
      );
      setCatalog(filtered.length > 0 ? filtered : INDIAN_CATALOG);
    } finally {
      setIsSearching(false);
    }
  };

  // Add Item to Tray
  const addToTray = (item: MarketplaceItem) => {
    setTray((prev) => {
      const existing = prev.find((t) => t.item.id === item.id);
      if (existing) {
        return prev.map((t) => (t.item.id === item.id ? { ...t, quantity: t.quantity + 1 } : t));
      }
      return [...prev, { item, quantity: 1 }];
    });
    setAddedItemFeedback(item.id);
    setTimeout(() => setAddedItemFeedback(null), 1500);
  };

  const updateTrayQty = (itemId: string, delta: number) => {
    setTray((prev) =>
      prev
        .map((t) => {
          if (t.item.id === itemId) {
            const nextQty = t.quantity + delta;
            return nextQty > 0 ? { ...t, quantity: nextQty } : null;
          }
          return t;
        })
        .filter(Boolean) as TrayItem[]
    );
  };

  // Cart Calculations in ₹ INR
  const traySubtotal = tray.reduce((acc, t) => acc + t.item.price * t.quantity, 0);
  const trayDeliveryFee = traySubtotal > 199 || traySubtotal === 0 ? 0 : 29;
  const trayTaxes = Math.round(traySubtotal * 0.05);
  const trayTotal = traySubtotal + trayDeliveryFee + trayTaxes;

  // 5-Minute Atomic Slot Booking Handlers
  const closeSlotBookingModal = () => {
    const initial = createInitialBookingFlowState();
    setIsSlotModalOpen(false);
    setBookingConfirmedReceipt(initial.bookingConfirmedReceipt);
    setIsSlotLocked(initial.isSlotLocked);
    setLockToken(initial.lockToken);
    setSlotCountdown(initial.slotCountdown);
    setBookingError(initial.bookingError);
  };

  const openSlotBooking = (item: MarketplaceItem) => {
    const initial = createInitialBookingFlowState();
    setSelectedServiceItem(item);
    setBookingConfirmedReceipt(initial.bookingConfirmedReceipt);
    setIsSlotLocked(initial.isSlotLocked);
    setLockToken(initial.lockToken);
    setSlotCountdown(initial.slotCountdown);
    setBookingError(initial.bookingError);
    setIsLocking(false);
    setIsConfirming(false);
    setIsSlotModalOpen(true);
  };

  const handleLockSlot = async () => {
    if (!selectedServiceItem || isLocking || isConfirming) return;
    if (!currentUser?.id || !authToken) {
      setBookingError('Please sign in to lock a booking slot.');
      return;
    }
    setIsLocking(true);
    setBookingError(null);

    try {
      const slotId = `slot-${selectedServiceItem.id}-${Date.now().toString().slice(-4)}`;
      const merchantId = 'm2';
      const userId = currentUser.id;

      const res = await axios.post(
        `${API_URL}/api/v1/bookings/lock-slot`,
        {
          slotId,
          merchantId,
          userId,
          serviceName: selectedServiceItem.title,
          price: selectedServiceItem.price
        },
        {
          headers: buildBuyerAuthHeaders(authToken),
          timeout: 5000,
          validateStatus: () => true
        }
      );

      if (res.status === 401) {
        setIsSlotModalOpen(false);
        handleLogout('Your session has expired. Please sign in again.');
        return;
      }

      const outcome = resolveLockSlotOutcome(res.status, res.data);
      setIsSlotLocked(outcome.isSlotLocked);
      setLockToken(outcome.lockToken);
      setSlotCountdown(outcome.slotCountdown);
      setBookingError(outcome.bookingError);
    } catch (err: any) {
      const status = typeof err?.response?.status === 'number' ? err.response.status : 503;
      const outcome = resolveLockSlotOutcome(status, err?.response?.data);
      setIsSlotLocked(outcome.isSlotLocked);
      setLockToken(outcome.lockToken);
      setSlotCountdown(outcome.slotCountdown);
      setBookingError(outcome.bookingError);
    } finally {
      setIsLocking(false);
    }
  };

  const handleConfirmBooking = async () => {
    if (!selectedServiceItem || isConfirming || isLocking) return;
    if (!currentUser?.id || !authToken) {
      setBookingError('Please sign in to confirm your booking.');
      return;
    }
    setIsConfirming(true);
    setBookingError(null);

    try {
      const res = await axios.post(
        `${API_URL}/api/v1/bookings/confirm-payment`,
        {
          slotId: `slot-${selectedServiceItem.id}`,
          userId: currentUser.id,
          merchantId: 'm2',
          serviceName: selectedServiceItem.title,
          upiRef: `UPI-IND-${Date.now()}`,
          lockToken
        },
        {
          headers: buildBuyerAuthHeaders(authToken),
          timeout: 5000,
          validateStatus: () => true
        }
      );

      if (res.status === 401) {
        setIsSlotModalOpen(false);
        handleLogout('Your session has expired. Please sign in again.');
        return;
      }

      const outcome = resolveConfirmBookingOutcome(res.status, res.data);
      setBookingConfirmedReceipt(outcome.bookingConfirmedReceipt);
      setBookingError(outcome.bookingError);
    } catch (err: any) {
      const status = typeof err?.response?.status === 'number' ? err.response.status : 503;
      const outcome = resolveConfirmBookingOutcome(status, err?.response?.data);
      setBookingConfirmedReceipt(outcome.bookingConfirmedReceipt);
      setBookingError(outcome.bookingError);
    } finally {
      setIsConfirming(false);
    }
  };

  // Filtered Cards
  const displayedCards = catalog.filter((item) => {
    if (activeFilterTab === 'all') return true;
    return item.category === activeFilterTab;
  });

  // 1. Initial Loading Splash
  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#090D16] flex items-center justify-center font-body-md text-white">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-primary flex items-center justify-center shadow-lg animate-pulse">
            <span className="material-symbols-outlined text-2xl text-white">shopping_bag</span>
          </div>
          <span className="text-sm font-semibold tracking-wider text-slate-400">Loading StreetVerse India...</span>
        </div>
      </div>
    );
  }

  // 2. SERVICE UNAVAILABLE / NETWORK OUTAGE RECOVERY (Preserves valid signed token cleanly)
  if (sessionError && !currentUser) {
    return (
      <div className="min-h-screen bg-[#090D16] flex items-center justify-center p-6 font-body-md text-white">
        <div className="max-w-md w-full bg-[#111827] border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col gap-4 text-center">
          <span className="material-symbols-outlined text-3xl text-amber-400 mx-auto">cloud_off</span>
          <h2 className="text-lg font-bold text-white">Authentication Service Unavailable</h2>
          <p className="text-sm text-slate-300">{sessionError}</p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center mt-2">
            <button
              className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-bold hover:opacity-90"
              onClick={() => {
                setAuthChecked(false);
                void refreshBuyerSession();
              }}
              type="button"
            >
              Retry Session Check
            </button>
            <button
              className="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-sm font-semibold hover:bg-slate-700"
              onClick={() => handleLogout()}
              type="button"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 3. REQUIRE LOGIN FIRST IF NOT AUTHENTICATED
  if (!currentUser) {
    return (
      <BuyerAuth
        sessionNotice={sessionNotice}
        onAuthSuccess={(user, token) => {
          setCurrentUser(user);
          setAuthToken(token);
          setSessionError(null);
          setSessionNotice(null);
        }}
      />
    );
  }

  // 3. AUTHENTICATED BUYER MARKETPLACE EXPERIENCE
  return (
    <div className="bg-surface font-body-md text-body-md text-on-surface min-h-screen flex flex-col selection:bg-primary-container selection:text-on-primary">
      <Head>
        <title>StreetVerse India — Four Vital Lifelines. One Seamless Marketplace.</title>
        <meta
          name="description"
          content="Hyperlocal instant marketplace for Dining, Daily Mandi Groceries, Salons & Box Cricket Turfs in India."
        />
      </Head>

      {/* =========================================================================
          TOP COMMAND CENTER & NAVIGATION HEADER
         ========================================================================= */}
      <header className="fixed top-0 left-0 w-full z-50 bg-surface/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] transition-all">
        <div className="h-20 w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin flex items-center justify-between gap-space-md">
          {/* Logo & Deliver-To */}
          <div className="flex items-center gap-space-lg shrink-0">
            <div className="flex items-center gap-space-sm cursor-pointer" onClick={() => setActiveFilterTab('all')}>
              <img
                alt="StreetVerse Logo"
                className="h-8 w-auto object-contain"
                src="https://lh3.googleusercontent.com/aida/ALJJyrB4hMSJNjb-iiz-k1hmNy6UyV3rp1ihcP854ZQ1YpJRterKZjfmV_VqiWBsTsIVnC4rG4u52P5QUh-zlIMLR5-h3hr3oAEQWYFeI7wH-2CEFo_94OOmsEKc9PRAHDtDy73GbdCS0Qg40MkV_NL6V4dPjliGF-QkbSDeJ78FNn3vGgK4YrzQFEGqO8ioht67upXkJ3hW7xm8SozGYAIZqtoI9gAZatGEcsT4sTwAeWqR"
              />
              <span className="font-headline-sm text-headline-sm font-bold tracking-tight text-on-surface">
                StreetVerse
              </span>
            </div>

            {/* Indian City & Location Quick Dropdown */}
            <div className="relative">
              <button
                className="hidden xl:flex items-center gap-space-xs px-space-sm py-space-xs rounded-xl bg-surface-container-low hover:bg-surface-container hover:text-on-surface text-on-surface-variant transition-colors text-left"
                type="button"
                onClick={() => setIsLocationDropdownOpen(!isLocationDropdownOpen)}
              >
                <span className="material-symbols-outlined text-primary text-base">location_on</span>
                <div className="flex flex-col">
                  <span className="font-label-sm text-label-sm text-outline">Deliver to</span>
                  <span className="font-label-md text-label-md text-on-surface font-semibold truncate max-w-[140px]">
                    {deliverTo}
                  </span>
                </div>
                <span className="material-symbols-outlined text-outline text-sm">expand_more</span>
              </button>

              {isLocationDropdownOpen && (
                <div className="absolute left-0 top-full pt-space-xs z-50 w-64">
                  <div className="bg-surface-container-lowest rounded-xl shadow-[0_12px_32px_-4px_rgba(15,23,42,0.15)] p-space-xs flex flex-col gap-space-2xs border border-surface-container">
                    {[
                      { city: 'Kothrud, Pune 411038', state: 'Maharashtra' },
                      { city: 'FC Road, Pune 411004', state: 'Maharashtra' },
                      { city: 'Indiranagar, Bengaluru 560038', state: 'Karnataka' },
                      { city: 'HSR Layout, Bengaluru 560102', state: 'Karnataka' },
                      { city: 'Bandra West, Mumbai 400050', state: 'Maharashtra' },
                      { city: 'Connaught Place, New Delhi 110001', state: 'Delhi NCR' }
                    ].map((loc) => (
                      <button
                        key={loc.city}
                        className="px-space-sm py-space-xs font-label-md text-label-md rounded-lg text-on-surface hover:bg-surface-container flex items-center justify-between text-left"
                        onClick={() => {
                          setDeliverTo(loc.city);
                          setIsLocationDropdownOpen(false);
                        }}
                      >
                        <span className="truncate">{loc.city}</span>
                        <span className="text-[10px] text-outline ml-1">{loc.state}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Quick Search in header */}
          <div className="hidden md:flex flex-1 max-w-lg mx-space-sm">
            <div className="relative w-full flex items-center bg-surface-container-low rounded-xl px-space-md py-space-xs group focus-within:bg-surface-container-lowest focus-within:ring-2 focus-within:ring-primary/40 transition-all">
              <span className="material-symbols-outlined text-outline text-lg mr-space-sm group-focus-within:text-primary transition-colors">
                search
              </span>
              <input
                className="w-full bg-transparent border-0 outline-none text-on-surface placeholder:text-outline font-body-sm text-body-sm"
                placeholder="Search biryani, kirana, salon stylists, box cricket..."
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  handleSearchSubmit(e.target.value);
                }}
              />
              <span className="font-label-sm text-label-sm text-outline bg-surface px-space-xs py-space-2xs rounded border border-outline-variant/30 hidden lg:inline-block">
                ⌘K
              </span>
            </div>
          </div>

          {/* Controls: Palette Dots, Language, Tray, Profile */}
          <div className="flex items-center gap-space-sm shrink-0">
            {/* 4 Theme Dots */}
            <div className="hidden 2xl:flex items-center bg-surface-container-low p-space-2xs rounded-full gap-space-2xs">
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${theme === 'light' ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.1)] scale-110' : 'hover:bg-surface-container'
                  }`}
                title="Light Default"
                type="button"
                onClick={() => setTheme('light')}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${theme === 'dark' ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.1)] scale-110' : 'hover:bg-surface-container'
                  }`}
                title="Noir Canvas"
                type="button"
                onClick={() => setTheme('dark')}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-slate-900" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${theme === 'warm-beige' ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.1)] scale-110' : 'hover:bg-surface-container'
                  }`}
                title="Warm Beige"
                type="button"
                onClick={() => setTheme('warm-beige')}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-amber-700" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${theme === 'sky-blue' ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.1)] scale-110' : 'hover:bg-surface-container'
                  }`}
                title="Sky Blue"
                type="button"
                onClick={() => setTheme('sky-blue')}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-sky-400" />
              </button>
            </div>

            {/* Language Selector Dropdown */}
            <div className="relative">
              <button
                className="hidden lg:flex items-center gap-space-xs px-space-sm py-space-xs rounded-xl bg-surface-container-low hover:bg-surface-container text-on-surface-variant font-label-md text-label-md transition-colors"
                type="button"
                onClick={() => setIsLangDropdownOpen(!isLangDropdownOpen)}
              >
                <span className="material-symbols-outlined text-base">translate</span>
                <span>{currentLang.split(' ')[0]}</span>
                <span className="material-symbols-outlined text-xs">expand_more</span>
              </button>
              {isLangDropdownOpen && (
                <div className="absolute right-0 top-full pt-space-xs z-50 w-44">
                  <div className="bg-surface-container-lowest rounded-xl shadow-[0_12px_32px_-4px_rgba(15,23,42,0.15)] p-space-xs flex flex-col gap-space-2xs border border-surface-container">
                    {[
                      { code: 'HI · भारत', label: 'हिन्दी', flag: '🇮🇳' },
                      { code: 'EN · India', label: 'English (India)', flag: '🇮🇳' },
                      { code: 'MR · महाराष्ट्र', label: 'मराठी', flag: '🇮🇳' },
                      { code: 'TA · தமிழ்', label: 'தமிழ்', flag: '🇮🇳' },
                      { code: 'TE · తెలుగు', label: 'తెలుగు', flag: '🇮🇳' }
                    ].map((l) => (
                      <button
                        key={l.code}
                        className="px-space-sm py-space-xs font-label-md text-label-md rounded-lg text-on-surface hover:bg-surface-container flex items-center justify-between"
                        onClick={() => {
                          setCurrentLang(l.code);
                          setIsLangDropdownOpen(false);
                        }}
                      >
                        <span>{l.label}</span>
                        <span className="text-xs">{l.flag}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Tray / Cart Badge Trigger */}
            <button
              aria-label="View Shopping Tray"
              className="relative p-space-xs text-on-surface-variant hover:text-on-surface rounded-full hover:bg-surface-container-low transition-colors"
              type="button"
              onClick={() => setIsTrayOpen(true)}
            >
              <span className="material-symbols-outlined">shopping_bag</span>
              {tray.length > 0 && (
                <span className="absolute top-1 right-1 w-5 h-5 bg-primary text-on-primary text-[10px] font-bold rounded-full flex items-center justify-center ring-2 ring-surface animate-bounce">
                  {tray.reduce((acc, t) => acc + t.quantity, 0)}
                </span>
              )}
            </button>

            {/* Authenticated User Profile Avatar & Menu */}
            <div className="relative">
              <button
                className="flex items-center gap-space-xs p-space-2xs rounded-full hover:bg-surface-container-low transition-colors"
                type="button"
                onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)}
              >
                <div className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-sm ring-2 ring-primary/30">
                  {currentUser.fullName ? currentUser.fullName.charAt(0) : 'U'}
                </div>
                <span className="material-symbols-outlined text-outline text-sm hidden sm:inline">
                  expand_more
                </span>
              </button>

              {isProfileDropdownOpen && (
                <div className="absolute right-0 top-full pt-space-xs z-50 w-60">
                  <div className="bg-surface-container-lowest rounded-xl shadow-[0_12px_32px_-4px_rgba(15,23,42,0.15)] p-space-sm flex flex-col gap-space-2xs border border-surface-container">
                    <div className="px-space-sm py-space-xs">
                      <p className="font-label-md text-label-md font-semibold text-on-surface">
                        {currentUser.fullName || 'Verified Buyer'}
                      </p>
                      <p className="font-label-sm text-label-sm text-outline truncate">{currentUser.email}</p>
                      <p className="font-mono text-[11px] text-secondary mt-0.5">{currentUser.phone || ''}</p>
                    </div>
                    <div className="h-px bg-surface-container-high my-space-2xs" />
                    <button
                      className="flex items-center gap-space-sm px-space-sm py-space-xs font-label-md text-label-md rounded-lg text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors text-left"
                      onClick={() => {
                        setIsSettingsOpen(true);
                        setIsProfileDropdownOpen(false);
                      }}
                    >
                      <span className="material-symbols-outlined text-base">person</span>
                      Profile & Email OTP
                    </button>
                    <a
                      className="flex items-center gap-space-sm px-space-sm py-space-xs font-label-md text-label-md rounded-lg text-secondary font-semibold hover:bg-surface-container transition-colors"
                      href="http://localhost:3001"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="material-symbols-outlined text-base">storefront</span>
                      Switch to Seller Portal
                    </a>
                    <button
                      className="flex items-center gap-space-sm px-space-sm py-space-xs font-label-md text-label-md rounded-lg text-error hover:bg-error-container/20 transition-colors text-left font-semibold"
                      onClick={() => handleLogout()}
                    >
                      <span className="material-symbols-outlined text-base">logout</span>
                      Sign Out (Exit to Login)
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Secondary Sub-navigation */}
        <nav className="hidden lg:flex items-center gap-space-sm max-w-7xl mx-auto px-margin-mobile lg:px-margin pb-space-xs">
          <button
            className={`px-space-sm py-space-2xs transition-colors rounded-lg font-label-md text-label-md ${activeFilterTab === 'all'
              ? 'bg-primary-container text-on-primary font-bold'
              : 'text-on-surface-variant hover:text-on-surface'
              }`}
            onClick={() => setActiveFilterTab('all')}
          >
            Explore All India Hubs
          </button>
          <button
            className="px-space-sm py-space-2xs text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors"
            onClick={() => setActiveFilterTab('dining')}
          >
            Dining & Street Food
          </button>
          <button
            className="px-space-sm py-space-2xs text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors"
            onClick={() => setActiveFilterTab('grocery')}
          >
            Daily Kirana & Mandi
          </button>
          <button
            className="px-space-sm py-space-2xs text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors"
            onClick={() => setActiveFilterTab('wellness')}
          >
            Salons & Parlours
          </button>
          <button
            className="px-space-sm py-space-2xs text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors"
            onClick={() => setActiveFilterTab('turf')}
          >
            Box Cricket & Turfs
          </button>
        </nav>
      </header>

      {/* =========================================================================
          MAIN INTERACTIVE EXPERIENCE
         ========================================================================= */}
      <main className="w-full pt-28 bg-surface flex-1">
        <div className="flex flex-col w-full">
          {/* Top Command Center & Context Header */}
          <section className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin pt-space-md pb-space-lg">
            <div className="flex flex-col gap-space-md">
              {/* Live Dedicated Server Mesh Telemetry Banner */}
              <div className="flex flex-wrap items-center justify-between gap-space-sm bg-gradient-to-r from-emerald-950/40 via-surface-container-low to-primary/10 border border-emerald-500/30 rounded-xl px-space-md py-space-xs text-xs shadow-sm">
                <div className="flex items-center gap-space-sm flex-wrap">
                  <span className="flex h-2.5 w-2.5 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                  </span>
                  <span className="font-bold text-emerald-400">
                    {serverNode?.serverName || "Pratham's Dedicated Laptop Server Node (Pune)"}
                  </span>
                  <span className="text-outline">•</span>
                  <span className="text-on-surface-variant font-mono">
                    {serverNode?.latency || "29ms Direct Tunnel"}
                  </span>
                  <span className="text-outline">•</span>
                  <span className="bg-emerald-500/10 text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-500/20 font-medium">
                    PostgreSQL 16 & Redis Active
                  </span>
                  <span className="hidden md:inline text-outline">•</span>
                  <span className="hidden md:inline text-on-surface-variant">
                    {serverNode?.stats?.merchants || 4} Verified Pune Merchants
                  </span>
                </div>
                <div className="flex items-center gap-space-xs">
                  <button
                    onClick={() => { setSearchQuery('biryani'); handleSearchSubmit('biryani'); }}
                    className="text-primary hover:text-primary-container font-semibold underline text-[11px] cursor-pointer flex items-center gap-1"
                    type="button"
                  >
                    <span>⚡ Live DB Test: "biryani"</span>
                  </button>
                </div>
              </div>

              {/* Utility Control Strip */}
              <div className="flex flex-wrap items-center justify-between gap-space-sm bg-surface-container-low rounded-xl px-space-md py-space-xs shadow-sm">
                <div className="flex items-center gap-space-md flex-wrap">
                  <div className="flex items-center gap-space-xs">
                    <span className="material-symbols-outlined text-outline text-sm">palette</span>
                    <span className="font-label-sm text-label-sm text-on-surface-variant font-semibold uppercase tracking-wider">
                      Canvas Theme:
                    </span>
                    <div className="flex items-center gap-space-2xs bg-surface-container-highest p-space-2xs rounded-full">
                      <button
                        className={`theme-pill px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm transition-all duration-200 flex items-center gap-1 stitch-pill ${theme === 'light'
                          ? 'bg-surface-container-lowest text-on-surface shadow-xs ring-2 ring-primary/40 font-bold'
                          : 'text-on-surface-variant hover:text-on-surface'
                          }`}
                        onClick={() => setTheme('light')}
                        title="Light Mode"
                        type="button"
                      >
                        <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                        <span>Default</span>
                      </button>
                      <button
                        className={`theme-pill px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm transition-all duration-200 flex items-center gap-1 stitch-pill ${theme === 'warm-beige'
                          ? 'bg-surface-container-lowest text-on-surface shadow-xs ring-2 ring-primary/40 font-bold'
                          : 'text-on-surface-variant hover:text-on-surface'
                          }`}
                        onClick={() => setTheme('warm-beige')}
                        title="Warm Beige"
                        type="button"
                      >
                        <span className="w-2.5 h-2.5 rounded-full bg-amber-700" />
                        <span>Beige</span>
                      </button>
                      <button
                        className={`theme-pill px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm transition-all duration-200 flex items-center gap-1 stitch-pill ${theme === 'sky-blue'
                          ? 'bg-surface-container-lowest text-on-surface shadow-xs ring-2 ring-primary/40 font-bold'
                          : 'text-on-surface-variant hover:text-on-surface'
                          }`}
                        onClick={() => setTheme('sky-blue')}
                        title="Soft Blue"
                        type="button"
                      >
                        <span className="w-2.5 h-2.5 rounded-full bg-sky-400" />
                        <span>Sky</span>
                      </button>
                      <button
                        className={`theme-pill px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm transition-all duration-200 flex items-center gap-1 stitch-pill ${theme === 'dark'
                          ? 'bg-surface-container-lowest text-on-surface shadow-xs ring-2 ring-primary/40 font-bold'
                          : 'text-on-surface-variant hover:text-on-surface'
                          }`}
                        onClick={() => setTheme('dark')}
                        title="Dark Canvas"
                        type="button"
                      >
                        <span className="w-2.5 h-2.5 rounded-full bg-slate-900" />
                        <span>Noir</span>
                      </button>
                    </div>
                  </div>

                  {/* Color Accent Swatches */}
                  <div className="hidden sm:flex items-center gap-space-xs pl-space-sm border-l border-surface-container-highest">
                    <span className="font-label-sm text-label-sm text-outline">Accent:</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        className={`accent-swatch w-4 h-4 rounded-full bg-primary-container transition-all duration-200 ${accent === 'indigo' ? 'ring-2 ring-primary ring-offset-2 scale-125' : 'hover:scale-125'
                          }`}
                        onClick={() => {
                          setAccent('indigo');
                          searchInputRef.current?.focus();
                        }}
                        title="Indigo Accent"
                        type="button"
                      />
                      <button
                        className={`accent-swatch w-4 h-4 rounded-full bg-secondary transition-all duration-200 ${accent === 'emerald' ? 'ring-2 ring-secondary ring-offset-2 scale-125' : 'hover:scale-125'
                          }`}
                        onClick={() => {
                          setAccent('emerald');
                          searchInputRef.current?.focus();
                        }}
                        title="Emerald Accent"
                        type="button"
                      />
                      <button
                        className={`accent-swatch w-4 h-4 rounded-full bg-tertiary-container transition-all duration-200 ${accent === 'amber' ? 'ring-2 ring-tertiary-container ring-offset-2 scale-125' : 'hover:scale-125'
                          }`}
                        onClick={() => {
                          setAccent('amber');
                          searchInputRef.current?.focus();
                        }}
                        title="Amber Accent"
                        type="button"
                      />
                      <button
                        className={`accent-swatch w-4 h-4 rounded-full bg-error transition-all duration-200 ${accent === 'rose' ? 'ring-2 ring-error ring-offset-2 scale-125' : 'hover:scale-125'
                          }`}
                        onClick={() => {
                          setAccent('rose');
                          searchInputRef.current?.focus();
                        }}
                        title="Rose Accent"
                        type="button"
                      />
                    </div>
                  </div>
                </div>

                {/* Language Pill & Live Grid Badge */}
                <div className="flex items-center gap-space-sm ml-auto">
                  <div className="relative">
                    <button
                      className="flex items-center gap-space-xs px-space-sm py-space-2xs rounded-full bg-surface-container-lowest text-on-surface font-label-sm text-label-sm shadow-xs transition-colors"
                      type="button"
                      onClick={() => setIsLangDropdownOpen(!isLangDropdownOpen)}
                    >
                      <span className="material-symbols-outlined text-sm text-primary">translate</span>
                      <span className="font-semibold">{currentLang}</span>
                      <span className="material-symbols-outlined text-xs text-outline">arrow_drop_down</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-1 text-on-secondary-container bg-secondary-container/20 px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm font-semibold">
                    <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
                    <span>Live StreetVerse Grid</span>
                  </div>
                </div>
              </div>

              {/* Main Omnisearch Shell with Voice & Indian Trending Hot Chips */}
              <div className="relative bg-surface-container-lowest rounded-2xl p-space-md shadow-md flex flex-col gap-space-sm border border-surface-container">
                <div className="flex items-center gap-space-sm bg-surface-container-low rounded-xl px-space-md py-space-sm transition-all focus-within:bg-surface-container focus-within:shadow-xs">
                  <span className="material-symbols-outlined text-primary text-xl">search</span>
                  <input
                    ref={searchInputRef}
                    className="w-full bg-transparent border-0 outline-none font-body-md text-body-md text-on-surface placeholder:text-outline"
                    placeholder={
                      isVoiceActive
                        ? 'Listening... Speak your order or venue now'
                        : 'Search biryani, kirana, salon stylists, box cricket...'
                    }
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      handleSearchSubmit(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleSearchSubmit(searchQuery);
                      }
                    }}
                  />
                  <button
                    className={`p-space-xs rounded-full transition-colors ${isVoiceActive ? 'text-error animate-pulse bg-error-container/30' : 'text-outline hover:text-primary hover:bg-surface'
                      }`}
                    onClick={triggerVoiceSearch}
                    title="Voice Search"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-xl">mic</span>
                  </button>
                  <button
                    className="hidden md:flex items-center gap-1 px-space-md py-space-xs rounded-xl bg-primary text-on-primary font-label-md text-label-md font-semibold hover:opacity-95 active:scale-95 transition-all stitch-btn"
                    onClick={() => handleSearchSubmit(searchQuery)}
                    type="button"
                  >
                    <span>{isSearching ? 'Searching...' : 'Explore Hub'}</span>
                    <span className="material-symbols-outlined text-sm">arrow_forward</span>
                  </button>
                </div>

                {/* Hot Trending Quick Chips (Indian Market) */}
                <div className="flex items-center gap-space-xs overflow-x-auto pb-space-2xs scrollbar-none">
                  <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider shrink-0 flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs text-amber-500 animate-pulse">trending_up</span>{' '}
                    Hot:
                  </span>
                  {[
                    { label: 'Dum Handi Biryani · 20m', query: 'Hyderabadi Dum Biryani', color: 'hover:bg-primary-container hover:text-on-primary' },
                    { label: 'A2 Desi Cow Milk & Eggs (10m)', query: 'A2 Milk', color: 'hover:bg-secondary hover:text-on-secondary' },
                    { label: 'Box Cricket Turf (Tonight 8 PM)', query: 'Box Cricket Arena', color: 'hover:bg-tertiary hover:text-on-tertiary' },
                    { label: 'Beard Trim & D-Tan (₹299)', query: 'Precision Cut', color: 'hover:bg-surface-tint hover:text-on-primary' },
                    { label: 'Fresh Mandi Veggie Box', query: 'Fresh Mandi', color: 'hover:bg-secondary hover:text-on-secondary' },
                    { label: 'Chai & Bun Maska', query: 'Chai & Bun Maska', color: 'hover:bg-primary-container hover:text-on-primary' }
                  ].map((chip) => (
                    <button
                      key={chip.query}
                      className={`shrink-0 px-space-sm py-space-2xs rounded-full bg-surface-container ${chip.color} font-label-sm text-label-sm text-on-surface transition-all duration-200 stitch-pill shadow-xs`}
                      onClick={() => {
                        setSearchQuery(chip.query);
                        handleSearchSubmit(chip.query);
                      }}
                      type="button"
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* =========================================================================
              THE 4 PILLAR EXPERIENCE: 4 CORE INDIAN LIFELINES QUADRANT
             ========================================================================= */}
          <section className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin py-space-md">
            <div className="flex flex-col gap-space-lg">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-sm">
                <div>
                  <span className="font-label-sm text-label-sm text-primary uppercase font-bold tracking-widest">
                    Multi-Vendor Hyperlocal Network • Bharat
                  </span>
                  <h2 className="font-headline-lg text-headline-lg font-bold text-on-surface tracking-tight mt-1">
                    Four Vital Lifelines. One Seamless Marketplace.
                  </h2>
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">
                  Instant booking, 10-minute kirana dispatch, verified Indian vendor guarantees, and real-time inventory across urban zones.
                </p>
              </div>

              {/* 4 Core Hub Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-space-md">
                {/* 1. Dining & Street Gourmet */}
                <div className="group relative rounded-2xl bg-surface-container-lowest overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between hover:-translate-y-1 stitch-card-hover border border-surface-container">
                  <div className="relative h-48 w-full overflow-hidden bg-surface-container">
                    <img
                      alt="Authentic Dum Biryani and Indian Gourmet Culinary Plating"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      src="https://images.unsplash.com/photo-1589302168068-964664d93dc0?auto=format&fit=crop&w=1200&q=80"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/80 via-transparent to-transparent" />
                    <div className="absolute top-3 left-3 bg-surface/90 backdrop-blur-md px-space-xs py-space-2xs rounded-full flex items-center gap-1 shadow-sm">
                      <span className="material-symbols-outlined text-xs text-amber-500">star</span>
                      <span className="font-label-sm text-label-sm font-bold text-on-surface">4.94 (24k+)</span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-inverse-on-surface">
                      <span className="font-label-md text-label-md font-semibold flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm text-secondary-fixed">bolt</span> Avg ETA 20 mins
                      </span>
                      <span className="font-label-sm text-label-sm bg-primary/80 backdrop-blur-md px-2 py-0.5 rounded-full text-on-primary">
                        Table & Takeaway
                      </span>
                    </div>
                  </div>
                  <div className="p-space-md flex flex-col gap-space-sm flex-1 justify-between">
                    <div>
                      <div className="flex items-center gap-space-xs mb-1">
                        <span className="w-6 h-6 rounded-md bg-amber-100 flex items-center justify-center text-amber-800">
                          <span className="material-symbols-outlined text-sm">restaurant</span>
                        </span>
                        <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Dining & Street Gourmet</h3>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                        Authentic Hyderabadi dum biryani, woodfired paneer pizzas, street chaat, and live table reservation locks.
                      </p>
                    </div>
                    <div className="pt-space-xs flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="font-label-sm text-label-sm text-outline">Available Now</span>
                        <span className="font-headline-sm text-headline-sm font-bold text-on-surface">148 Eateries</span>
                      </div>
                      <button
                        className="px-space-sm py-space-xs rounded-xl bg-surface-container hover:bg-primary hover:text-on-primary font-label-md text-label-md font-semibold text-on-surface transition-colors flex items-center gap-1 stitch-btn"
                        onClick={() => setActiveFilterTab('dining')}
                        type="button"
                      >
                        <span>Browse</span>
                        <span className="material-symbols-outlined text-sm">chevron_right</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* 2. Kirana, Mandi & Daily Dairy */}
                <div className="group relative rounded-2xl bg-surface-container-lowest overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between hover:-translate-y-1 stitch-card-hover border border-surface-container">
                  <div className="relative h-48 w-full overflow-hidden bg-surface-container">
                    <img
                      alt="Fresh Mandi farm produce and vegetables"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      src="https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1200&q=80"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/80 via-transparent to-transparent" />
                    <div className="absolute top-3 left-3 bg-secondary text-on-secondary px-space-xs py-space-2xs rounded-full flex items-center gap-1 shadow-sm font-label-sm text-label-sm font-bold">
                      <span className="material-symbols-outlined text-xs">timer</span>
                      <span>10-Min Kirana</span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-inverse-on-surface">
                      <span className="font-label-md text-label-md font-semibold">Cold-Chain Desi Dairy</span>
                      <span className="font-label-sm text-label-sm bg-secondary-container text-on-secondary-container px-2 py-0.5 rounded-full font-bold">
                        Free Delivery ₹199+
                      </span>
                    </div>
                  </div>
                  <div className="p-space-md flex flex-col gap-space-sm flex-1 justify-between">
                    <div>
                      <div className="flex items-center gap-space-xs mb-1">
                        <span className="w-6 h-6 rounded-md bg-emerald-100 flex items-center justify-center text-emerald-800">
                          <span className="material-symbols-outlined text-sm">local_mall</span>
                        </span>
                        <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Kirana, Mandi & Dairy</h3>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                        Fresh mandi vegetables, A2 Gir cow milk, chakki fresh atta, pulses, and same-hour kirana replenishment.
                      </p>
                    </div>
                    <div className="pt-space-xs flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="font-label-sm text-label-sm text-outline">In Stock Near You</span>
                        <span className="font-headline-sm text-headline-sm font-bold text-secondary">3,420 Items</span>
                      </div>
                      <button
                        className="px-space-sm py-space-xs rounded-xl bg-surface-container hover:bg-secondary hover:text-on-secondary font-label-md text-label-md font-semibold text-on-surface transition-colors flex items-center gap-1 stitch-btn"
                        onClick={() => setActiveFilterTab('grocery')}
                        type="button"
                      >
                        <span>Shop Fast</span>
                        <span className="material-symbols-outlined text-sm">chevron_right</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* 3. Salons & Personal Grooming */}
                <div className="group relative rounded-2xl bg-surface-container-lowest overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between hover:-translate-y-1 stitch-card-hover border border-surface-container">
                  <div className="relative h-48 w-full overflow-hidden bg-surface-container">
                    <img
                      alt="Modern luxury unisex salon and spa studio"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      src="https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1200&q=80"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/80 via-transparent to-transparent" />
                    <div className="absolute top-3 left-3 bg-surface/90 backdrop-blur-md px-space-xs py-space-2xs rounded-full flex items-center gap-1 shadow-sm">
                      <span className="material-symbols-outlined text-xs text-primary">verified</span>
                      <span className="font-label-sm text-label-sm font-bold text-on-surface">Master Stylists</span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-inverse-on-surface">
                      <span className="font-label-md text-label-md font-semibold">Today: 14 Open Slots</span>
                      <span className="font-label-sm text-label-sm bg-surface-tint text-on-primary px-2 py-0.5 rounded-full font-bold">
                        Zero Wait Token
                      </span>
                    </div>
                  </div>
                  <div className="p-space-md flex flex-col gap-space-sm flex-1 justify-between">
                    <div>
                      <div className="flex items-center gap-space-xs mb-1">
                        <span className="w-6 h-6 rounded-md bg-purple-100 flex items-center justify-center text-purple-800">
                          <span className="material-symbols-outlined text-sm">spa</span>
                        </span>
                        <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Salons & Grooming</h3>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                        Precision fade cuts, royal beard sculpting, bridal facials, Ayurvedic head massages, and home therapists.
                      </p>
                    </div>
                    <div className="pt-space-xs flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="font-label-sm text-label-sm text-outline">Verified Studios</span>
                        <span className="font-headline-sm text-headline-sm font-bold text-on-surface">62 Studios</span>
                      </div>
                      <button
                        className="px-space-sm py-space-xs rounded-xl bg-surface-container hover:bg-primary-container hover:text-on-primary font-label-md text-label-md font-semibold text-on-surface transition-colors flex items-center gap-1 stitch-btn"
                        onClick={() => setActiveFilterTab('wellness')}
                        type="button"
                      >
                        <span>Book Slot</span>
                        <span className="material-symbols-outlined text-sm">chevron_right</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* 4. Box Cricket & Sports Turfs */}
                <div className="group relative rounded-2xl bg-surface-container-lowest overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between hover:-translate-y-1 stitch-card-hover border border-surface-container">
                  <div className="relative h-48 w-full overflow-hidden bg-surface-container">
                    <img
                      alt="Floodlit synthetic turf in India under night lights"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      src="https://images.unsplash.com/photo-1529900748604-07564a03e7a6?auto=format&fit=crop&w=1200&q=80"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/80 via-transparent to-transparent" />
                    <div className="absolute top-3 left-3 bg-tertiary text-on-tertiary px-space-xs py-space-2xs rounded-full flex items-center gap-1 shadow-sm font-label-sm text-label-sm font-bold">
                      <span className="material-symbols-outlined text-xs">sports_cricket</span>
                      <span>Box Cricket & 7v7</span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-inverse-on-surface">
                      <span className="font-label-md text-label-md font-semibold">Live Slot Sync</span>
                      <span className="font-label-sm text-label-sm bg-tertiary-fixed text-on-tertiary-container px-2 py-0.5 rounded-full font-bold">
                        UPI Split Bills
                      </span>
                    </div>
                  </div>
                  <div className="p-space-md flex flex-col gap-space-sm flex-1 justify-between">
                    <div>
                      <div className="flex items-center gap-space-xs mb-1">
                        <span className="w-6 h-6 rounded-md bg-amber-100 flex items-center justify-center text-amber-900">
                          <span className="material-symbols-outlined text-sm">sports_soccer</span>
                        </span>
                        <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Turfs & Box Cricket</h3>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                        Floodlit artificial turf pitches, box cricket arenas, wooden badminton courts, and night cricket net practice.
                      </p>
                    </div>
                    <div className="pt-space-xs flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="font-label-sm text-label-sm text-outline">Open Tonight</span>
                        <span className="font-headline-sm text-headline-sm font-bold text-on-surface">28 Arenas</span>
                      </div>
                      <button
                        className="px-space-sm py-space-xs rounded-xl bg-surface-container hover:bg-tertiary hover:text-on-tertiary font-label-md text-label-md font-semibold text-on-surface transition-colors flex items-center gap-1 stitch-btn"
                        onClick={() => setActiveFilterTab('turf')}
                        type="button"
                      >
                        <span>Reserve</span>
                        <span className="material-symbols-outlined text-sm">chevron_right</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* =========================================================================
              LIVE PULSE STATS STRIP (India Telemetry)
             ========================================================================= */}
          <section className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin py-space-sm">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm bg-surface-container-low p-space-md rounded-2xl shadow-xs border border-surface-container">
              <div className="flex items-center gap-space-sm">
                <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-primary shrink-0">
                  <span className="material-symbols-outlined text-xl">speed</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm font-bold text-on-surface">14.2m</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">Median Dispatch Drop</p>
                </div>
              </div>
              <div className="flex items-center gap-space-sm">
                <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-secondary shrink-0">
                  <span className="material-symbols-outlined text-xl">verified_user</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm font-bold text-on-surface">100%</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">FSSAI & GST Vetted</p>
                </div>
              </div>
              <div className="flex items-center gap-space-sm">
                <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-tertiary shrink-0">
                  <span className="material-symbols-outlined text-xl">calendar_month</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm font-bold text-on-surface">418</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">Slots Booked Today</p>
                </div>
              </div>
              <div className="flex items-center gap-space-sm">
                <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-primary shrink-0">
                  <span className="material-symbols-outlined text-xl">currency_rupee</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm font-bold text-on-surface">UPI Escrow</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">Buyer Protection Assured</p>
                </div>
              </div>
            </div>
          </section>

          {/* =========================================================================
              INTERACTIVE FEED: DYNAMIC TABS & LIVE INDIAN DEALS GRID
             ========================================================================= */}
          <section id="marketplace-feed" className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin pt-space-lg pb-space-2xl">
            <div className="flex flex-col gap-space-lg">
              {/* Filter Segmented Controller */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-md border-b-0">
                <div>
                  <h3 className="font-headline-md text-headline-md font-bold text-on-surface">
                    Trending Deals & Ready-To-Book Nearby
                  </h3>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    Fresh mandi vegetables, chef specials, salon stylists & box cricket slots
                  </p>
                </div>
                {/* Category Tab Buttons */}
                <div className="flex items-center gap-space-2xs bg-surface-container-low p-space-2xs rounded-xl overflow-x-auto">
                  {[
                    { id: 'all', label: 'All Offers' },
                    { id: 'dining', label: 'Street & Gourmet' },
                    { id: 'grocery', label: 'Kirana & Mandi' },
                    { id: 'wellness', label: 'Salon Deals' },
                    { id: 'turf', label: 'Box Cricket & Turfs' }
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      className={`deal-tab-btn px-space-md py-space-xs rounded-lg font-label-md text-label-md transition-all ${activeFilterTab === tab.id
                        ? 'bg-surface-container-lowest text-primary shadow-xs font-bold'
                        : 'text-on-surface-variant hover:text-on-surface font-semibold'
                        }`}
                      onClick={() => setActiveFilterTab(tab.id as any)}
                      type="button"
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Main Live Items Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-space-md" id="marketplace-cards-grid">
                {displayedCards.map((card) => (
                  <article
                    key={card.id}
                    className="deal-card bg-surface-container-lowest rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-all flex flex-col justify-between group stitch-card-hover border border-surface-container"
                  >
                    <div>
                      <div className="relative h-44 w-full bg-surface-container">
                        <img
                          alt={card.imageAlt}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          src={card.image}
                        />
                        <span
                          className={`absolute top-3 left-3 px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm font-bold shadow-xs ${card.badgeColor}`}
                        >
                          {card.badge}
                        </span>
                        <button
                          className="absolute top-3 right-3 bg-surface/90 backdrop-blur-md text-on-surface p-1.5 rounded-full flex items-center justify-center hover:text-error transition-colors"
                          type="button"
                        >
                          <span className="material-symbols-outlined text-sm">favorite</span>
                        </button>
                        <div className="absolute bottom-2 left-2 bg-inverse-surface/80 backdrop-blur-sm text-inverse-on-surface px-2 py-0.5 rounded text-xs font-semibold flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs text-amber-400">star</span>{' '}
                          {card.rating} ({card.ratingCount})
                        </div>
                      </div>

                      <div className="p-space-md flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span className="font-label-sm text-label-sm text-secondary font-semibold uppercase truncate max-w-[150px]">
                            {card.vendorName}
                          </span>
                          <span className="font-label-sm text-label-sm text-outline">{card.distance}</span>
                        </div>
                        <h4 className="font-headline-sm text-headline-sm font-bold text-on-surface truncate">
                          {card.title}
                        </h4>
                        <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-1">
                          {card.description}
                        </p>
                        <div className="mt-2 flex items-baseline gap-space-xs">
                          <span className="font-headline-sm text-headline-sm font-bold text-on-surface">
                            ₹{card.price.toFixed(2)}
                          </span>
                          {card.originalPrice && (
                            <span className="font-label-md text-label-md text-outline line-through">
                              ₹{card.originalPrice.toFixed(2)}
                            </span>
                          )}
                          <span className="font-label-sm text-label-sm text-secondary font-bold ml-auto flex items-center gap-0.5">
                            {card.isService ? (
                              <span>{card.priceLabel || 'Slot'}</span>
                            ) : (
                              <>
                                <span className="material-symbols-outlined text-xs">moped</span> {card.deliveryEtaOrSlot}
                              </>
                            )}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="p-space-md pt-0">
                      {card.isService ? (
                        <button
                          className="w-full py-space-xs px-space-md rounded-xl bg-surface-container-high hover:bg-primary-container hover:text-on-primary text-on-surface font-label-md text-label-md font-semibold transition-all flex items-center justify-center gap-1 shadow-xs stitch-btn"
                          onClick={() => openSlotBooking(card)}
                          type="button"
                        >
                          <span className="material-symbols-outlined text-sm">event_available</span>
                          <span>{card.category === 'turf' ? 'Reserve Box Cricket / Turf' : 'Select Stylist & Slot'}</span>
                        </button>
                      ) : (
                        <button
                          className={`w-full py-space-xs px-space-md rounded-xl font-label-md text-label-md font-semibold active:scale-95 transition-all flex items-center justify-center gap-1 shadow-xs stitch-btn ${card.category === 'grocery'
                            ? 'bg-secondary text-on-secondary hover:opacity-90'
                            : 'bg-primary text-on-primary hover:opacity-90'
                            }`}
                          onClick={() => addToTray(card)}
                          type="button"
                        >
                          <span className="material-symbols-outlined text-sm">
                            {addedItemFeedback === card.id ? 'check' : 'add_shopping_cart'}
                          </span>
                          <span>{addedItemFeedback === card.id ? 'Added to Tray!' : 'Add to Tray'}</span>
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* =========================================================================
          5-MINUTE ATOMIC SLOT RESERVATION MODAL (INDIAN RUPEES & NPCI UPI)
         ========================================================================= */}
      {isSlotModalOpen && selectedServiceItem && (
        <div className="fixed inset-0 z-50 bg-inverse-surface/60 backdrop-blur-sm flex items-center justify-center p-space-md animate-in fade-in duration-200">
          <div className="bg-surface-container-lowest max-w-lg w-full rounded-2xl shadow-2xl p-space-lg flex flex-col gap-space-md border border-surface-container">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-xs">
                <span className="material-symbols-outlined text-primary text-2xl">calendar_month</span>
                <h4 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                  {bookingConfirmedReceipt ? 'Slot Confirmed!' : selectedServiceItem.title}
                </h4>
              </div>
              <button
                className="p-1 rounded-full hover:bg-surface-container text-outline hover:text-on-surface"
                onClick={closeSlotBookingModal}
                type="button"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {bookingConfirmedReceipt ? (
              <div className="flex flex-col gap-space-md text-center py-space-md">
                <div className="w-16 h-16 rounded-full bg-secondary-container text-on-secondary-container mx-auto flex items-center justify-center">
                  <span className="material-symbols-outlined text-3xl">verified</span>
                </div>
                <div>
                  <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                    Booking Confirmed & Escrow Locked!
                  </h3>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                    Receipt #{bookingConfirmedReceipt.receiptId} • Token #{bookingConfirmedReceipt.tokenNumber}
                  </p>
                </div>
                <div className="bg-surface-container p-space-sm rounded-xl font-mono text-sm text-primary font-bold">
                  {bookingConfirmedReceipt.qrVerificationCode}
                </div>
                <div className="text-xs text-outline">
                  Show this pass or token at the venue for instant entry with zero wait time.
                </div>
                <button
                  className="w-full py-space-xs px-space-md rounded-xl bg-primary text-on-primary font-label-md text-label-md font-semibold"
                  onClick={closeSlotBookingModal}
                  type="button"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-space-xs">
                  <p className="font-body-sm text-body-sm text-on-surface-variant font-medium">
                    {selectedServiceItem.vendorName} • ₹{selectedServiceItem.price.toFixed(2)}
                  </p>
                  <span className="font-label-sm text-label-sm text-outline">
                    Choose an available slot window for today:
                  </span>
                </div>

                {/* Time Slots Grid */}
                <div className="grid grid-cols-3 gap-space-xs">
                  {['05:00 PM', '06:30 PM (Fav)', '08:00 PM', '09:15 PM', '10:30 PM'].map((time) => (
                    <button
                      key={time}
                      className={`slot-pill px-space-sm py-space-xs rounded-xl font-label-md text-label-md font-semibold transition-all ${selectedSlotTime === time
                        ? 'bg-primary-container text-on-primary shadow-xs'
                        : 'bg-surface-container hover:bg-primary-container hover:text-on-primary text-on-surface'
                        }`}
                      onClick={() => setSelectedSlotTime(time)}
                      type="button"
                    >
                      {time}
                    </button>
                  ))}
                  <button
                    className="px-space-sm py-space-xs rounded-xl bg-surface-container-high/50 font-label-md text-label-md text-outline cursor-not-allowed"
                    disabled
                    type="button"
                  >
                    Sold Out
                  </button>
                </div>

                {bookingError && (
                  <div
                    role="alert"
                    className="bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 rounded-xl p-space-sm flex flex-col gap-2"
                  >
                    <div className="flex items-start gap-2">
                      <span className="material-symbols-outlined text-base shrink-0 mt-0.5">error</span>
                      <p className="font-label-md text-label-md font-semibold">{bookingError}</p>
                    </div>
                    <div className="flex justify-end">
                      <button
                        className="px-space-sm py-1 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-sm text-label-sm font-semibold"
                        onClick={closeSlotBookingModal}
                        type="button"
                      >
                        Close & Continue Browsing
                      </button>
                    </div>
                  </div>
                )}

                {/* Lock Status & Countdown Timer */}
                {isSlotLocked ? (
                  <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-space-sm flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-amber-600 animate-spin">timelapse</span>
                      <div>
                        <p className="font-label-md text-label-md font-bold text-amber-900 dark:text-amber-200">
                          Slot Locked Exclusively for You
                        </p>
                        <p className="font-label-sm text-label-sm text-amber-700 dark:text-amber-400">
                          Expires in {Math.floor(slotCountdown / 60)}:{(slotCountdown % 60).toString().padStart(2, '0')} mins
                        </p>
                      </div>
                    </div>
                    <span className="font-mono font-bold text-lg text-amber-800 dark:text-amber-300">
                      ₹{selectedServiceItem.price.toFixed(0)}
                    </span>
                  </div>
                ) : (
                  <div className="bg-surface-container-low rounded-xl p-space-sm flex items-center gap-2 text-on-surface-variant font-label-sm text-label-sm">
                    <span className="material-symbols-outlined text-base text-primary">lock_clock</span>
                    <span>5-Minute atomic holding lock guarantees no double bookings across the venue.</span>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="pt-space-sm flex items-center justify-between border-t border-surface-container">
                  <div className="flex items-center gap-1 text-secondary font-label-sm text-label-sm font-semibold">
                    <span className="material-symbols-outlined text-base">verified</span> Instant SMS & Escrow Pass
                  </div>
                  {!isSlotLocked ? (
                    <button
                      className="px-space-md py-space-xs rounded-xl bg-primary text-on-primary font-label-md text-label-md font-semibold shadow-sm hover:opacity-95 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={isLocking || isConfirming}
                      onClick={handleLockSlot}
                      type="button"
                    >
                      {isLocking ? 'Checking Availability...' : 'Lock Slot (5 Mins)'}
                    </button>
                  ) : (
                    <button
                      className="px-space-md py-space-xs rounded-xl bg-secondary text-on-secondary font-label-md text-label-md font-semibold shadow-sm hover:opacity-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                      disabled={isConfirming || isLocking}
                      onClick={handleConfirmBooking}
                      type="button"
                    >
                      <span>{isConfirming ? 'Confirming...' : `Pay ₹${selectedServiceItem.price} with UPI`}</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          SLIDE-OVER TRAY / CART DRAWER (INDIAN RUPEES & NPCI UPI)
         ========================================================================= */}
      {isTrayOpen && (
        <div className="fixed inset-0 z-50 bg-inverse-surface/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-md bg-surface-container-lowest h-full shadow-2xl p-space-lg flex flex-col justify-between animate-in slide-in-from-right duration-300 border-l border-surface-container">
            <div>
              <div className="flex items-center justify-between pb-space-md border-b border-surface-container">
                <div className="flex items-center gap-space-xs">
                  <span className="material-symbols-outlined text-primary text-2xl">shopping_bag</span>
                  <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Your Food & Kirana Tray</h3>
                </div>
                <button
                  className="p-1 rounded-full hover:bg-surface-container text-outline hover:text-on-surface"
                  onClick={() => setIsTrayOpen(false)}
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              {tray.length === 0 ? (
                <div className="py-space-2xl text-center flex flex-col items-center gap-space-sm text-outline">
                  <span className="material-symbols-outlined text-5xl">shopping_cart</span>
                  <p className="font-body-md text-body-md">Your tray is currently empty.</p>
                  <button
                    className="mt-2 px-space-md py-space-xs rounded-xl bg-primary text-on-primary font-label-md text-label-md font-semibold"
                    onClick={() => setIsTrayOpen(false)}
                  >
                    Browse Items
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-space-sm py-space-md max-h-[55vh] overflow-y-auto">
                  {tray.map((t) => (
                    <div
                      key={t.item.id}
                      className="flex items-center justify-between gap-space-sm p-space-sm bg-surface-container-low rounded-xl"
                    >
                      <img alt={t.item.title} className="w-12 h-12 rounded-lg object-cover" src={t.item.image} />
                      <div className="flex-1 truncate">
                        <p className="font-label-md text-label-md font-bold text-on-surface truncate">{t.item.title}</p>
                        <p className="font-label-sm text-label-sm text-outline">₹{t.item.price.toFixed(2)} each</p>
                      </div>
                      <div className="flex items-center gap-1 bg-surface-container rounded-lg p-1">
                        <button
                          className="w-6 h-6 rounded flex items-center justify-center font-bold text-on-surface hover:bg-surface"
                          onClick={() => updateTrayQty(t.item.id, -1)}
                        >
                          -
                        </button>
                        <span className="w-6 text-center font-bold font-label-md text-label-md">{t.quantity}</span>
                        <button
                          className="w-6 h-6 rounded flex items-center justify-center font-bold text-on-surface hover:bg-surface"
                          onClick={() => updateTrayQty(t.item.id, 1)}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {tray.length > 0 && (
              <div className="pt-space-md border-t border-surface-container flex flex-col gap-space-sm">
                <div className="flex justify-between font-label-md text-label-md text-outline">
                  <span>Subtotal</span>
                  <span>₹{traySubtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-label-md text-label-md text-outline">
                  <span>Hyperlocal Dispatch Fee</span>
                  <span>{trayDeliveryFee === 0 ? 'FREE (Orders ₹199+)' : `₹${trayDeliveryFee.toFixed(2)}`}</span>
                </div>
                <div className="flex justify-between font-label-md text-label-md text-outline">
                  <span>Taxes & GST (5%)</span>
                  <span>₹{trayTaxes.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-headline-sm text-headline-sm font-bold text-on-surface pt-1 border-t border-surface-container">
                  <span>Total Amount</span>
                  <span>₹{trayTotal.toFixed(2)}</span>
                </div>
                <button
                  className="w-full mt-2 py-space-sm px-space-md rounded-xl bg-primary text-on-primary font-label-md text-label-md font-bold hover:opacity-95 shadow-md flex items-center justify-center gap-2"
                  onClick={() => {
                    alert(`Order placed successfully with Escrow Lock for ₹${trayTotal.toFixed(2)}! Dispatched in 14 mins.`);
                    setTray([]);
                    setIsTrayOpen(false);
                  }}
                >
                  <span className="material-symbols-outlined text-lg">currency_rupee</span>
                  <span>Checkout with Direct UPI (₹{trayTotal.toFixed(2)})</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          PROFILE SETTINGS MODAL
         ========================================================================= */}
      {isSettingsOpen && (
        <ProfileSettingsModal
          user={currentUser}
          onClose={() => setIsSettingsOpen(false)}
          onSessionExpired={(msg) => {
            setIsSettingsOpen(false);
            handleLogout(msg);
          }}
          onUserUpdated={(updatedUser) => {
            setCurrentUser(updatedUser);
            void refreshBuyerSession();
          }}
        />
      )}

      {/* =========================================================================
          FOOTER MATCHING STITCH DESIGN
         ========================================================================= */}
      <footer className="w-full bg-surface-container-low py-space-2xl mt-space-3xl border-t border-surface-container">
        <div className="max-w-7xl mx-auto px-margin-mobile lg:px-margin flex flex-col md:flex-row items-center justify-between gap-space-md">
          <div className="flex items-center gap-space-sm">
            <img
              alt="StreetVerse Logo"
              className="h-6 w-auto object-contain"
              src="https://lh3.googleusercontent.com/aida/ALJJyrB4hMSJNjb-iiz-k1hmNy6UyV3rp1ihcP854ZQ1YpJRterKZjfmV_VqiWBsTsIVnC4rG4u52P5QUh-zlIMLR5-h3hr3oAEQWYFeI7wH-2CEFo_94OOmsEKc9PRAHDtDy73GbdCS0Qg40MkV_NL6V4dPjliGF-QkbSDeJ78FNn3vGgK4YrzQFEGqO8ioht67upXkJ3hW7xm8SozGYAIZqtoI9gAZatGEcsT4sTwAeWqR"
            />
            <span className="font-label-lg text-label-lg text-on-surface font-semibold">
              StreetVerse India Marketplace
            </span>
          </div>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            © 2026 StreetVerse Platform India Inc. Dual-Platform Architecture. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
