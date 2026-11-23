import React, { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import axios from 'axios';
import { BuyerAuth } from '../components/auth/BuyerAuth';
import { ProfileSettingsModal } from '../components/dashboard/ProfileSettingsModal';

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

const INITIAL_CATALOG: MarketplaceItem[] = [
  {
    id: 'd-1',
    category: 'dining',
    title: 'Woodfired Margherita & Burrata Box',
    vendorName: 'Bella Forno Pizzeria',
    distance: '1.2 miles',
    price: 19.5,
    originalPrice: 26.0,
    rating: 4.9,
    ratingCount: '1.2k',
    image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAn1iHUUI2KnATuH94VGQIGh6vegy0xedfgxXCtlvjmGesR4G_OBsidnQthHZ6BFqcovfLnpew-_EFEkMHYdAb0jKdhKhsMrRYhOGENb76WhHX0fEowu-0vtLJrIvqo96qSe2VmkHu73w1quR_9eQ7-bdh17MnkSJFgMwFtLBYzJd-i_whCd7I8kIRfJemZkyTgjTxgp5TdAx9HzSUisfCAzDYfwRFXVtm3QhYSTl4',
    imageAlt: 'Artisanal sourdough crust Neapolitan pizza bubbling with mozzarella and basil',
    badge: '25% OFF BUNDLE',
    badgeColor: 'bg-error text-on-error',
    deliveryEtaOrSlot: '18-25m',
    description: 'Slow fermented dough, DOP certified buffalo mozzarella, fresh basil, and pesto drizzle.'
  },
  {
    id: 'g-1',
    category: 'grocery',
    title: 'Artisan Farmstead Morning Basket',
    vendorName: 'GreenAcres Organic Farm',
    distance: '0.8 miles',
    price: 16.8,
    originalPrice: 22.0,
    rating: 4.95,
    ratingCount: '2.4k',
    image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCCwiN2tC4w5ucDwV70bZHCGzasAUQki3RUBYUvPGTraqzgxOSn4iX2VdczMZ2hYym_w3Q4o9539koBOcSnAxtlbKMfn0HajqXn-4Bc4Gj_j9SioYBH6uWFh1zwUXGFdG5vu8dp9DwzvcVZRFDTynKvk5ufQsIXlAsXrYo91v-ROAfmFETZ9OkUJBL4xINr5_RhpjvqMAfZ3eNB5L67NSw0z9r607ZU_o04Y1ua-D8',
    imageAlt: 'Curated organic farm breakfast grocery kit with milk, brown eggs, honey',
    badge: 'FLASH HARVEST',
    badgeColor: 'bg-secondary text-on-secondary',
    deliveryEtaOrSlot: '12 min drop',
    description: 'Pasture-raised eggs (12ct), A2 Whole Milk, sourdough loaf, and organic blueberries.'
  },
  {
    id: 'w-1',
    category: 'wellness',
    title: 'Precision Cut & Botanical Spa Blowdry',
    vendorName: 'LuxeAura Studio',
    distance: '1.5 miles',
    price: 45.0,
    originalPrice: 60.0,
    rating: 4.96,
    ratingCount: '840',
    image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuA__atbqOk8tdF2F-tEh4eOUUBdJ6nW1_02eDCBQDnzIZYSmg4DiU1hrI2aCM17PmoPfjNaRYy5RZCYxbxhxSoy4Qh44RbYL0qpkX8upTKgXeKX3I9pc5lJ50mSTBEX6ZBdXM8Nvp2YRFLrYFl6iYqYhb3i_Eu2uoiFjD21uZY3AQIJusrmfKn4r5gMn1WYhX_6lbha1K5JvafOyiiddePSEw33k56VauYL5dcVO4I',
    imageAlt: 'Professional chic salon styling session with luxury aesthetic',
    badge: 'SLOT DISCOUNT',
    badgeColor: 'bg-primary-container text-on-primary',
    deliveryEtaOrSlot: 'Open: 3:30 PM Today',
    description: 'Includes consultation, scalp massage, organic rosemary rinse, and custom blowdry.',
    isService: true,
    serviceType: 'Hair & Spa',
    priceLabel: '45 mins'
  },
  {
    id: 't-1',
    category: 'turf',
    title: 'Prime 7v7 Turf (60 Mins Slot)',
    vendorName: 'StreetVerse Arena Downtown',
    distance: 'Campus East (2.4 mi)',
    price: 32.0,
    rating: 4.92,
    ratingCount: '520',
    image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAwna39CjJrEPKHxEIF6OZTGBn1OsQCbe4q52rk7zlRS15GR5CuUorkPGfSkC5Q2hBmyKc3Hzwh93AA9nVR9My-OOpPXG9ZJDOLpnwJRogc7kDVMJ_yBF7Ycn9HySmv68nxQiCDp3Tcg6tzzFYoj25yNBbOM9_i9v_jyIMfUm9nHnq-4_mbi2eKXTwDOiIREQvg3pfc4kUjf5nSUOgvEYpp2AixoPfEak_wimoDCnw',
    imageAlt: 'High quality indoor wooden badminton and squash courts with LED glare-free lights',
    badge: 'NIGHT LEAGUE OPEN',
    badgeColor: 'bg-tertiary-container text-on-tertiary',
    deliveryEtaOrSlot: 'Tonight 7-8 PM Open',
    description: 'Full FIFA-grade shock-absorption turf, changing showers, and floodlit night access.',
    isService: true,
    serviceType: 'Sports Turf',
    priceLabel: '/ court slot'
  }
];

interface TrayItem {
  item: MarketplaceItem;
  quantity: number;
}

export default function BuyerHome() {
  // Theme & Accent
  const [theme, setTheme] = useState<'light' | 'warm-beige' | 'sky-blue' | 'dark'>('light');
  const [accent, setAccent] = useState<'indigo' | 'emerald' | 'amber' | 'rose'>('indigo');
  const [currentLang, setCurrentLang] = useState('EN · United States');

  // User & Auth
  const [currentUser, setCurrentUser] = useState<any>({
    fullName: 'Elena Vance',
    email: 'elena.vance@nexus.io',
    phone: '+1 415-555-0198',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuC_LdfTnEBhA_KDn34EdkfcJtY8hipfCfYpYr71MlyRMxkD04tjUMwrLCt_fsugz17nMsrpcHHNepT30eUp4_t01Goia3fFKpYjIiaXC2e49KgsgISLOaeLydvuR_-56k6N-uJzt3B9GFZhV2VS-zaECHCU_amHO23ImP0kiGbE9hyYubQAOJnQ4mXk0RgEuvttpMYWr3bkHOUtc_4iicVDnO5B50qAlyLVaw8X6Fo'
  });
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
  const [isLangDropdownOpen, setIsLangDropdownOpen] = useState(false);

  // Omnisearch & Hot Filter
  const [searchQuery, setSearchQuery] = useState('');
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [activeFilterTab, setActiveFilterTab] = useState<'all' | 'dining' | 'grocery' | 'wellness' | 'turf'>('all');
  const [catalog, setCatalog] = useState<MarketplaceItem[]>(INITIAL_CATALOG);
  const [isSearching, setIsSearching] = useState(false);

  // Location
  const [deliverTo, setDeliverTo] = useState('San Francisco 94103');
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

  const searchInputRef = useRef<HTMLInputElement>(null);
  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

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

  // Load saved buyer session from localStorage
  useEffect(() => {
    try {
      const savedUser = localStorage.getItem('streetverse_buyer_user');
      if (savedUser) {
        setCurrentUser(JSON.parse(savedUser));
      }
    } catch {}
  }, []);

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
          setDeliverTo(`Live Zone (${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°)`);
        },
        () => {
          setDeliverTo('Downtown Hub · Zone 1');
        },
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

  // Voice Search Handler
  const triggerVoiceSearch = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      // Mock voice search simulation
      setIsVoiceActive(true);
      setTimeout(() => {
        setSearchQuery('Woodfire pizza near me under 25 mins');
        setIsVoiceActive(false);
        handleSearchSubmit('Woodfire pizza near me under 25 mins');
      }, 1500);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
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

      recognition.onerror = () => {
        setIsVoiceActive(false);
      };

      recognition.onend = () => {
        setIsVoiceActive(false);
      };
    } catch {
      setIsVoiceActive(false);
    }
  };

  // Perform Hyperlocal Search
  const handleSearchSubmit = async (queryText: string) => {
    const q = queryText.trim();
    if (!q) {
      setCatalog(INITIAL_CATALOG);
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
        // Map backend results to Stitch card schema
        const mappedResults: MarketplaceItem[] = res.data.results.map((r: any, idx: number) => {
          const isSlot = r.item_type === 'slot' || r.type === 'service';
          const cat: any = isSlot ? (r.category === 'SPORTS' ? 'turf' : 'wellness') : (r.category === 'RESTAURANT' ? 'dining' : 'grocery');
          return {
            id: r.id || `search-${idx}`,
            category: cat,
            title: r.item_name || r.business_name || q,
            vendorName: r.business_name || 'Neighborhood Merchant',
            distance: r.distance_km ? `${r.distance_km.toFixed(1)} km away` : '0.9 miles',
            price: Number(r.price) || 25.0,
            originalPrice: Number(r.price) ? Number(r.price) * 1.25 : undefined,
            rating: 4.85,
            ratingCount: '1.1k',
            image: isSlot
              ? (cat === 'turf' ? INITIAL_CATALOG[3].image : INITIAL_CATALOG[2].image)
              : (cat === 'dining' ? INITIAL_CATALOG[0].image : INITIAL_CATALOG[1].image),
            imageAlt: r.item_name || 'Search result',
            badge: isSlot ? 'LIVE SLOT' : 'INSTANT DISPATCH',
            badgeColor: isSlot ? 'bg-primary-container text-on-primary' : 'bg-secondary text-on-secondary',
            deliveryEtaOrSlot: isSlot ? 'Today · Instant Lock' : '20-25m',
            description: r.description || `Freshly updated availability from ${r.business_name}.`,
            isService: isSlot,
            serviceType: isSlot ? (cat === 'turf' ? 'Sports Turf' : 'Salon & Wellness') : undefined,
            priceLabel: isSlot ? '/ slot' : undefined
          };
        });
        setCatalog(mappedResults);
      } else {
        // Fallback filter on local catalogue
        const filtered = INITIAL_CATALOG.filter(
          (item) =>
            item.title.toLowerCase().includes(q.toLowerCase()) ||
            item.vendorName.toLowerCase().includes(q.toLowerCase()) ||
            item.description.toLowerCase().includes(q.toLowerCase())
        );
        setCatalog(filtered.length > 0 ? filtered : INITIAL_CATALOG);
      }
    } catch {
      // Fallback filter
      const filtered = INITIAL_CATALOG.filter(
        (item) =>
          item.title.toLowerCase().includes(q.toLowerCase()) ||
          item.vendorName.toLowerCase().includes(q.toLowerCase()) ||
          item.description.toLowerCase().includes(q.toLowerCase())
      );
      setCatalog(filtered.length > 0 ? filtered : INITIAL_CATALOG);
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

  // Cart Calculations
  const traySubtotal = tray.reduce((acc, t) => acc + t.item.price * t.quantity, 0);
  const trayDeliveryFee = traySubtotal > 25 || traySubtotal === 0 ? 0 : 2.5;
  const trayTaxes = traySubtotal * 0.05;
  const trayTotal = traySubtotal + trayDeliveryFee + trayTaxes;

  // 5-Minute Atomic Slot Booking Handlers
  const openSlotBooking = (item: MarketplaceItem) => {
    setSelectedServiceItem(item);
    setBookingConfirmedReceipt(null);
    setIsSlotLocked(false);
    setSlotCountdown(300);
    setIsSlotModalOpen(true);
  };

  const handleLockSlot = async () => {
    if (!selectedServiceItem) return;
    setIsLocking(true);

    try {
      const slotId = `slot-${selectedServiceItem.id}-${Date.now().toString().slice(-4)}`;
      const merchantId = 'm2'; // Linked merchant ID
      const userId = currentUser?.id || 'guest-user-1';

      const res = await axios.post(
        `${API_URL}/api/v1/bookings/lock-slot`,
        {
          slotId,
          merchantId,
          userId,
          serviceName: selectedServiceItem.title,
          price: selectedServiceItem.price
        },
        { headers: { 'ngrok-skip-browser-warning': 'true' }, timeout: 5000 }
      );

      if (res.data && res.data.success) {
        setIsSlotLocked(true);
        setLockToken(res.data.lockToken);
        setSlotCountdown(res.data.expiresInSeconds || 300);
      }
    } catch {
      // Mock resilience lock
      setIsSlotLocked(true);
      setLockToken(`RESILIENT-${Date.now()}`);
      setSlotCountdown(300);
    } finally {
      setIsLocking(false);
    }
  };

  const handleConfirmBooking = async () => {
    if (!selectedServiceItem) return;
    try {
      const res = await axios.post(
        `${API_URL}/api/v1/bookings/confirm-payment`,
        {
          slotId: `slot-${selectedServiceItem.id}`,
          userId: currentUser?.id || 'guest-user-1',
          merchantId: 'm2',
          serviceName: selectedServiceItem.title,
          upiRef: `UPI-${Date.now()}`,
          lockToken
        },
        { headers: { 'ngrok-skip-browser-warning': 'true' }, timeout: 5000 }
      );

      if (res.data && res.data.receipt) {
        setBookingConfirmedReceipt(res.data.receipt);
      } else {
        setBookingConfirmedReceipt({
          receiptId: `REC-${Date.now().toString().slice(-6)}`,
          tokenNumber: 314,
          serviceName: selectedServiceItem.title,
          status: 'CONFIRMED',
          qrVerificationCode: 'STREETVERSE-PASS-PASS99'
        });
      }
    } catch {
      setBookingConfirmedReceipt({
        receiptId: `REC-${Date.now().toString().slice(-6)}`,
        tokenNumber: 314,
        serviceName: selectedServiceItem.title,
        status: 'CONFIRMED',
        qrVerificationCode: 'STREETVERSE-PASS-PASS99'
      });
    }
  };

  // Filtered Cards
  const displayedCards = catalog.filter((item) => {
    if (activeFilterTab === 'all') return true;
    return item.category === activeFilterTab;
  });

  return (
    <div className="bg-surface font-body-md text-body-md text-on-surface min-h-screen flex flex-col selection:bg-primary-container selection:text-on-primary">
      <Head>
        <title>StreetVerse — Four Vital Lifelines. One Seamless Marketplace.</title>
        <meta
          name="description"
          content="Hyperlocal instant marketplace for Dining, Daily Groceries, Salons, and Sports Turfs."
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

            <button
              className="hidden xl:flex items-center gap-space-xs px-space-sm py-space-xs rounded-xl bg-surface-container-low hover:bg-surface-container hover:text-on-surface text-on-surface-variant transition-colors text-left"
              type="button"
              title="Change Delivery Location"
            >
              <span className="material-symbols-outlined text-primary text-base">location_on</span>
              <div className="flex flex-col">
                <span className="font-label-sm text-label-sm text-outline">Deliver to</span>
                <span className="font-label-md text-label-md text-on-surface font-semibold truncate max-w-[130px]">
                  {deliverTo}
                </span>
              </div>
              <span className="material-symbols-outlined text-outline text-sm">expand_more</span>
            </button>
          </div>

          {/* Quick Search in header */}
          <div className="hidden md:flex flex-1 max-w-lg mx-space-sm">
            <div className="relative w-full flex items-center bg-surface-container-low rounded-xl px-space-md py-space-xs group focus-within:bg-surface-container-lowest focus-within:ring-2 focus-within:ring-primary/40 transition-all">
              <span className="material-symbols-outlined text-outline text-lg mr-space-sm group-focus-within:text-primary transition-colors">
                search
              </span>
              <input
                className="w-full bg-transparent border-0 outline-none text-on-surface placeholder:text-outline font-body-sm text-body-sm"
                placeholder="Search products, certified vendors, brands..."
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

          {/* Controls: Palette Dots, Language, Notifications, Profile */}
          <div className="flex items-center gap-space-sm shrink-0">
            {/* 4 Theme Dots */}
            <div className="hidden 2xl:flex items-center bg-surface-container-low p-space-2xs rounded-full gap-space-2xs">
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  theme === 'light' ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.1)] scale-110' : 'hover:bg-surface-container'
                }`}
                title="Light Default"
                type="button"
                onClick={() => setTheme('light')}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  theme === 'dark' ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.1)] scale-110' : 'hover:bg-surface-container'
                }`}
                title="Noir Canvas"
                type="button"
                onClick={() => setTheme('dark')}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-slate-900" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  theme === 'warm-beige' ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.1)] scale-110' : 'hover:bg-surface-container'
                }`}
                title="Warm Beige"
                type="button"
                onClick={() => setTheme('warm-beige')}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-amber-700" />
              </button>
              <button
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                  theme === 'sky-blue' ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.1)] scale-110' : 'hover:bg-surface-container'
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
                      { code: 'EN · United States', label: 'English (US)', flag: '🇺🇸' },
                      { code: 'ES · España', label: 'Español', flag: '🇪🇸' },
                      { code: 'FR · France', label: 'Français', flag: '🇫🇷' },
                      { code: 'DE · Deutschland', label: 'Deutsch', flag: '🇩🇪' },
                      { code: 'HI · भारत', label: 'हिन्दी', flag: '🇮🇳' }
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

            {/* User Profile Avatar & Menu */}
            <div className="relative">
              <button
                className="flex items-center gap-space-xs p-space-2xs rounded-full hover:bg-surface-container-low transition-colors"
                type="button"
                onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)}
              >
                <img
                  alt="Profile"
                  className="w-8 h-8 rounded-full object-cover ring-2 ring-primary/20"
                  src={currentUser.avatar}
                />
                <span className="material-symbols-outlined text-outline text-sm hidden sm:inline">
                  expand_more
                </span>
              </button>

              {isProfileDropdownOpen && (
                <div className="absolute right-0 top-full pt-space-xs z-50 w-56">
                  <div className="bg-surface-container-lowest rounded-xl shadow-[0_12px_32px_-4px_rgba(15,23,42,0.15)] p-space-sm flex flex-col gap-space-2xs border border-surface-container">
                    <div className="px-space-sm py-space-xs">
                      <p className="font-label-md text-label-md font-semibold text-on-surface">
                        {currentUser.fullName}
                      </p>
                      <p className="font-label-sm text-label-sm text-outline truncate">{currentUser.email}</p>
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
                      Profile & Security
                    </button>
                    <a
                      className="flex items-center gap-space-sm px-space-sm py-space-xs font-label-md text-label-md rounded-lg text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors"
                      href="#marketplace-feed"
                      onClick={() => setIsProfileDropdownOpen(false)}
                    >
                      <span className="material-symbols-outlined text-base">inventory_2</span>
                      Past Orders/Bookings
                    </a>
                    <a
                      className="flex items-center gap-space-sm px-space-sm py-space-xs font-label-md text-label-md rounded-lg text-secondary font-semibold hover:bg-surface-container transition-colors"
                      href="http://localhost:3001"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="material-symbols-outlined text-base">storefront</span>
                      Seller Dashboard
                    </a>
                    <button
                      className="flex items-center gap-space-sm px-space-sm py-space-xs font-label-md text-label-md rounded-lg text-error hover:bg-error-container/20 transition-colors text-left"
                      onClick={() => {
                        setIsAuthOpen(true);
                        setIsProfileDropdownOpen(false);
                      }}
                    >
                      <span className="material-symbols-outlined text-base">logout</span>
                      Switch Account
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
            className={`px-space-sm py-space-2xs transition-colors rounded-lg font-label-md text-label-md ${
              activeFilterTab === 'all'
                ? 'bg-primary-container text-on-primary font-bold'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
            onClick={() => setActiveFilterTab('all')}
          >
            Explore Products
          </button>
          <button
            className="px-space-sm py-space-2xs text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors"
            onClick={() => setActiveFilterTab('dining')}
          >
            Verified Vendors
          </button>
          <button
            className="px-space-sm py-space-2xs text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors"
            onClick={() => setIsTrayOpen(true)}
          >
            My Tray
          </button>
          <button
            className="px-space-sm py-space-2xs text-on-surface-variant hover:text-on-surface font-label-md text-label-md transition-colors"
            onClick={() => setActiveFilterTab('grocery')}
          >
            Flash Deals
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
              {/* Utility Control Strip: Personalization, Palettes & Locales */}
              <div className="flex flex-wrap items-center justify-between gap-space-sm bg-surface-container-low rounded-xl px-space-md py-space-xs shadow-sm">
                <div className="flex items-center gap-space-md flex-wrap">
                  <div className="flex items-center gap-space-xs">
                    <span className="material-symbols-outlined text-outline text-sm">palette</span>
                    <span className="font-label-sm text-label-sm text-on-surface-variant font-semibold uppercase tracking-wider">
                      Canvas Theme:
                    </span>
                    <div className="flex items-center gap-space-2xs bg-surface-container-highest p-space-2xs rounded-full">
                      <button
                        className={`theme-pill px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm transition-all duration-200 flex items-center gap-1 stitch-pill ${
                          theme === 'light'
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
                        className={`theme-pill px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm transition-all duration-200 flex items-center gap-1 stitch-pill ${
                          theme === 'warm-beige'
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
                        className={`theme-pill px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm transition-all duration-200 flex items-center gap-1 stitch-pill ${
                          theme === 'sky-blue'
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
                        className={`theme-pill px-space-xs py-space-2xs rounded-full font-label-sm text-label-sm transition-all duration-200 flex items-center gap-1 stitch-pill ${
                          theme === 'dark'
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
                        className={`accent-swatch w-4 h-4 rounded-full bg-primary-container transition-all duration-200 ${
                          accent === 'indigo' ? 'ring-2 ring-primary ring-offset-2 scale-125' : 'hover:scale-125'
                        }`}
                        onClick={() => {
                          setAccent('indigo');
                          searchInputRef.current?.focus();
                        }}
                        title="Indigo Accent"
                        type="button"
                      />
                      <button
                        className={`accent-swatch w-4 h-4 rounded-full bg-secondary transition-all duration-200 ${
                          accent === 'emerald' ? 'ring-2 ring-secondary ring-offset-2 scale-125' : 'hover:scale-125'
                        }`}
                        onClick={() => {
                          setAccent('emerald');
                          searchInputRef.current?.focus();
                        }}
                        title="Emerald Accent"
                        type="button"
                      />
                      <button
                        className={`accent-swatch w-4 h-4 rounded-full bg-tertiary-container transition-all duration-200 ${
                          accent === 'amber' ? 'ring-2 ring-tertiary-container ring-offset-2 scale-125' : 'hover:scale-125'
                        }`}
                        onClick={() => {
                          setAccent('amber');
                          searchInputRef.current?.focus();
                        }}
                        title="Amber Accent"
                        type="button"
                      />
                      <button
                        className={`accent-swatch w-4 h-4 rounded-full bg-error transition-all duration-200 ${
                          accent === 'rose' ? 'ring-2 ring-error ring-offset-2 scale-125' : 'hover:scale-125'
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

              {/* Main Omnisearch Shell with Voice & Trending Hot Chips */}
              <div className="relative bg-surface-container-lowest rounded-2xl p-space-md shadow-md flex flex-col gap-space-sm border border-surface-container">
                <div className="flex items-center gap-space-sm bg-surface-container-low rounded-xl px-space-md py-space-sm transition-all focus-within:bg-surface-container focus-within:shadow-xs">
                  <span className="material-symbols-outlined text-primary text-xl">search</span>
                  <input
                    ref={searchInputRef}
                    className="w-full bg-transparent border-0 outline-none font-body-md text-body-md text-on-surface placeholder:text-outline"
                    placeholder={
                      isVoiceActive
                        ? 'Listening... Speak your order or venue now'
                        : 'Search dishes, groceries, salon stylists, turf & court slots...'
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
                    className={`p-space-xs rounded-full transition-colors ${
                      isVoiceActive ? 'text-error animate-pulse bg-error-container/30' : 'text-outline hover:text-primary hover:bg-surface'
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

                {/* Hot Trending Quick Chips */}
                <div className="flex items-center gap-space-xs overflow-x-auto pb-space-2xs scrollbar-none">
                  <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider shrink-0 flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs text-amber-500 animate-pulse">trending_up</span>{' '}
                    Hot:
                  </span>
                  {[
                    { label: 'Woodfire Pizza · 22m', query: 'Woodfire Sourdough Pizza', color: 'hover:bg-primary-container hover:text-on-primary' },
                    { label: 'Avocado 4-pack (12m delivery)', query: 'Organic Hass Avocados', color: 'hover:bg-secondary hover:text-on-secondary' },
                    { label: 'Swedish Massage · 4.9★', query: 'Deep Tissue Spa Therapist', color: 'hover:bg-surface-tint hover:text-on-primary' },
                    { label: 'Football Turf (Tonight 8 PM)', query: 'Floodlit Football Turf 7v7', color: 'hover:bg-tertiary hover:text-on-tertiary' },
                    { label: 'Fresh Brioche', query: 'Artisan Bakery Croissants', color: 'hover:bg-primary-container hover:text-on-primary' }
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
              THE 4 PILLAR EXPERIENCE: 4 CORE LIFELINES QUADRANT
             ========================================================================= */}
          <section className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin py-space-md">
            <div className="flex flex-col gap-space-lg">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-sm">
                <div>
                  <span className="font-label-sm text-label-sm text-primary uppercase font-bold tracking-widest">
                    Multi-Vendor Hyperlocal Network
                  </span>
                  <h2 className="font-headline-lg text-headline-lg font-bold text-on-surface tracking-tight mt-1">
                    Four Vital Lifelines. One Seamless Marketplace.
                  </h2>
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">
                  Instant booking, on-demand dispatch, verified vendor guarantees, and synchronized inventory across urban
                  zones.
                </p>
              </div>

              {/* 4 Core Hub Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-space-md">
                {/* 1. Dining & Gourmet */}
                <div className="group relative rounded-2xl bg-surface-container-lowest overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between hover:-translate-y-1 stitch-card-hover border border-surface-container">
                  <div className="relative h-48 w-full overflow-hidden bg-surface-container">
                    <img
                      alt="Artisan culinary plating"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      src="https://lh3.googleusercontent.com/aida-public/AB6AXuBSxxlytwD565CGNhF3hlfrpFN_eMbjnrgiItZA8Bh9lTf1WyR7zTWdZiHx8ocRyYhneAakjB3VvIWCPIpUXIYedU568kjmOvIRKRJ0iwfGQHNDSWDdYN1ZYD_3IaT3N2y3oU1A90FdEOw_Kd-e7X2bSz8InDYYEB76INn1nieepJ43XgVOW12BjEatJM0MHkPfTkyuNZK8F8QwR0KZcRSWeOhy5FXq6moygUsI6LI"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/80 via-transparent to-transparent" />
                    <div className="absolute top-3 left-3 bg-surface/90 backdrop-blur-md px-space-xs py-space-2xs rounded-full flex items-center gap-1 shadow-sm">
                      <span className="material-symbols-outlined text-xs text-amber-500">star</span>
                      <span className="font-label-sm text-label-sm font-bold text-on-surface">4.92 (18k+)</span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-inverse-on-surface">
                      <span className="font-label-md text-label-md font-semibold flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm text-secondary-fixed">bolt</span> Avg ETA 24 mins
                      </span>
                      <span className="font-label-sm text-label-sm bg-primary/80 backdrop-blur-md px-2 py-0.5 rounded-full text-on-primary">
                        Table Bookings
                      </span>
                    </div>
                  </div>
                  <div className="p-space-md flex flex-col gap-space-sm flex-1 justify-between">
                    <div>
                      <div className="flex items-center gap-space-xs mb-1">
                        <span className="w-6 h-6 rounded-md bg-amber-100 flex items-center justify-center text-amber-800">
                          <span className="material-symbols-outlined text-sm">restaurant</span>
                        </span>
                        <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Dining & Gourmet</h3>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                        Chef specials, woodfired pizzerias, patisseries, and live table reservation locks.
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

                {/* 2. Grocery & Pantry */}
                <div className="group relative rounded-2xl bg-surface-container-lowest overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between hover:-translate-y-1 stitch-card-hover border border-surface-container">
                  <div className="relative h-48 w-full overflow-hidden bg-surface-container">
                    <img
                      alt="Fresh produce and groceries"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      src="https://lh3.googleusercontent.com/aida-public/AB6AXuDTC_0HeUP7WZifiTlUyIVkho_Prj2nKiwCJA_wjkoark1fQejOZ_tPALgGOTCnrRejLhGsc3IaktlW7UxAMkjCByfQkt7YYx6NOxz8mHgjOGs_p9lhKQiIVgBU7nAQWiIs9dAvBW1DTIwxiyxKuyYrncB2Kwn7NeU1yx9uphK8nzPTdOmUECwFR_qmNSfrTldYW3va1SdOh1gp14AhydkQgj4MlAzusL9FPx8X_Qc"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/80 via-transparent to-transparent" />
                    <div className="absolute top-3 left-3 bg-secondary text-on-secondary px-space-xs py-space-2xs rounded-full flex items-center gap-1 shadow-sm font-label-sm text-label-sm font-bold">
                      <span className="material-symbols-outlined text-xs">timer</span>
                      <span>15-Min Instant</span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-inverse-on-surface">
                      <span className="font-label-md text-label-md font-semibold">Cold-Chain Certified</span>
                      <span className="font-label-sm text-label-sm bg-secondary-container text-on-secondary-container px-2 py-0.5 rounded-full font-bold">
                        Free Delivery $25+
                      </span>
                    </div>
                  </div>
                  <div className="p-space-md flex flex-col gap-space-sm flex-1 justify-between">
                    <div>
                      <div className="flex items-center gap-space-xs mb-1">
                        <span className="w-6 h-6 rounded-md bg-emerald-100 flex items-center justify-center text-emerald-800">
                          <span className="material-symbols-outlined text-sm">local_mall</span>
                        </span>
                        <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Grocery & Pantry</h3>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                        Direct farm produce, A2 organic dairy, pantry staples, and same-hour pantry replenishment.
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

                {/* 3. Salons & Wellness Spas */}
                <div className="group relative rounded-2xl bg-surface-container-lowest overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between hover:-translate-y-1 stitch-card-hover border border-surface-container">
                  <div className="relative h-48 w-full overflow-hidden bg-surface-container">
                    <img
                      alt="Modern serene luxury salon interior"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      src="https://lh3.googleusercontent.com/aida-public/AB6AXuCvVN_wO84FJTIz90YmRccXo57h47LxFzxgy1rzRQdRLC9uhwIymSODVx60rNdZyx1FsslhDJBjfqvPhQzms_O3VebQBEhsFYkjh7UIhQ4v08sEwPNO4UYJeLn86YkDQ67IcpCdh9vX3T5iltPQFlFqObX-O0EsEX_VGyOdJw7JrBxF4VSnr1EIBIyA1jU68kjmMrCY4X6Ephb2Ybm_pIUKRiHKuvbpz_0zmlkicQA"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/80 via-transparent to-transparent" />
                    <div className="absolute top-3 left-3 bg-surface/90 backdrop-blur-md px-space-xs py-space-2xs rounded-full flex items-center gap-1 shadow-sm">
                      <span className="material-symbols-outlined text-xs text-primary">verified</span>
                      <span className="font-label-sm text-label-sm font-bold text-on-surface">Master Stylists</span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-inverse-on-surface">
                      <span className="font-label-md text-label-md font-semibold">Today: 14 Open Slots</span>
                      <span className="font-label-sm text-label-sm bg-surface-tint text-on-primary px-2 py-0.5 rounded-full font-bold">
                        Zero Wait
                      </span>
                    </div>
                  </div>
                  <div className="p-space-md flex flex-col gap-space-sm flex-1 justify-between">
                    <div>
                      <div className="flex items-center gap-space-xs mb-1">
                        <span className="w-6 h-6 rounded-md bg-purple-100 flex items-center justify-center text-purple-800">
                          <span className="material-symbols-outlined text-sm">spa</span>
                        </span>
                        <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Salons & Wellness</h3>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                        Precision hair sculpting, bespoke facials, deep tissue massage, and personal therapists.
                      </p>
                    </div>
                    <div className="pt-space-xs flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="font-label-sm text-label-sm text-outline">Verified Venues</span>
                        <span className="font-headline-sm text-headline-sm font-bold text-on-surface">62 Salons</span>
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

                {/* 4. Sports & Turf Booking */}
                <div className="group relative rounded-2xl bg-surface-container-lowest overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 flex flex-col justify-between hover:-translate-y-1 stitch-card-hover border border-surface-container">
                  <div className="relative h-48 w-full overflow-hidden bg-surface-container">
                    <img
                      alt="Lush green floodlit FIFA synthetic football turf arena"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      src="https://lh3.googleusercontent.com/aida-public/AB6AXuD4Z2ydl-Ue2KcZwxwg8xcu29fGMBUDD1tsuGPXYzcIOEl_nnnzGtHa9NvC9TFOCAqlbK0ZWPl4O2uqAKAZU_jp0Qw32hiq8IPjcz98wBFYFhao84Hs3Pq98x7FpuOkLNqf5i-l35jNekvPd0rIluP9dkW3ktU2hq1fzr3xFGw21hOKbFSyWXNpdRR4WPYK5wsjNmGdu56QMnuFwwArPAi3wb45nXnTlSvFdjsQFGQ"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface/80 via-transparent to-transparent" />
                    <div className="absolute top-3 left-3 bg-tertiary text-on-tertiary px-space-xs py-space-2xs rounded-full flex items-center gap-1 shadow-sm font-label-sm text-label-sm font-bold">
                      <span className="material-symbols-outlined text-xs">sports_soccer</span>
                      <span>Turf & Courts</span>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-inverse-on-surface">
                      <span className="font-label-md text-label-md font-semibold">Live Calendar Sync</span>
                      <span className="font-label-sm text-label-sm bg-tertiary-fixed text-on-tertiary-container px-2 py-0.5 rounded-full font-bold">
                        Split Bills
                      </span>
                    </div>
                  </div>
                  <div className="p-space-md flex flex-col gap-space-sm flex-1 justify-between">
                    <div>
                      <div className="flex items-center gap-space-xs mb-1">
                        <span className="w-6 h-6 rounded-md bg-amber-100 flex items-center justify-center text-amber-900">
                          <span className="material-symbols-outlined text-sm">sports_tennis</span>
                        </span>
                        <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Sports & Turfs</h3>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                        Indoor badminton wooden courts, 7-a-side floodlit football turfs, cricket nets & gear rentals.
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
              LIVE PULSE STATS STRIP (Real-time buyer telemetry)
             ========================================================================= */}
          <section className="w-full max-w-7xl mx-auto px-margin-mobile lg:px-margin py-space-sm">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm bg-surface-container-low p-space-md rounded-2xl shadow-xs border border-surface-container">
              <div className="flex items-center gap-space-sm">
                <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-primary shrink-0">
                  <span className="material-symbols-outlined text-xl">speed</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm font-bold text-on-surface">19.4m</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">Median Delivery Time</p>
                </div>
              </div>
              <div className="flex items-center gap-space-sm">
                <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-secondary shrink-0">
                  <span className="material-symbols-outlined text-xl">verified_user</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm font-bold text-on-surface">100%</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">Vetted Local Merchants</p>
                </div>
              </div>
              <div className="flex items-center gap-space-sm">
                <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-tertiary shrink-0">
                  <span className="material-symbols-outlined text-xl">calendar_month</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm font-bold text-on-surface">312</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">Slots Booked Today</p>
                </div>
              </div>
              <div className="flex items-center gap-space-sm">
                <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-primary shrink-0">
                  <span className="material-symbols-outlined text-xl">currency_exchange</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm font-bold text-on-surface">Escrow</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">Buyer Protection Assured</p>
                </div>
              </div>
            </div>
          </section>

          {/* =========================================================================
              INTERACTIVE FEED: DYNAMIC TABS & LIVE DEALS GRID
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
                    Fresh inventory updated by local vendors in real-time
                  </p>
                </div>
                {/* Category Tab Buttons */}
                <div className="flex items-center gap-space-2xs bg-surface-container-low p-space-2xs rounded-xl overflow-x-auto">
                  {[
                    { id: 'all', label: 'All Offers' },
                    { id: 'dining', label: 'Dining Special' },
                    { id: 'grocery', label: 'Pantry Bundles' },
                    { id: 'wellness', label: 'Salon Deals' },
                    { id: 'turf', label: 'Court Openings' }
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      className={`deal-tab-btn px-space-md py-space-xs rounded-lg font-label-md text-label-md transition-all ${
                        activeFilterTab === tab.id
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
                            ${card.price.toFixed(2)}
                          </span>
                          {card.originalPrice && (
                            <span className="font-label-md text-label-md text-outline line-through">
                              ${card.originalPrice.toFixed(2)}
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
                          <span>{card.category === 'turf' ? 'Reserve Court Now' : 'Select Stylist & Slot'}</span>
                        </button>
                      ) : (
                        <button
                          className={`w-full py-space-xs px-space-md rounded-xl font-label-md text-label-md font-semibold active:scale-95 transition-all flex items-center justify-center gap-1 shadow-xs stitch-btn ${
                            card.category === 'grocery'
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
          5-MINUTE ATOMIC SLOT RESERVATION MODAL
         ========================================================================= */}
      {isSlotModalOpen && selectedServiceItem && (
        <div className="fixed inset-0 z-50 bg-inverse-surface/60 backdrop-blur-sm flex items-center justify-center p-space-md animate-in fade-in duration-200">
          <div className="bg-surface-container-lowest max-w-lg w-full rounded-2xl shadow-2xl p-space-lg flex flex-col gap-space-md border border-surface-container">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-xs">
                <span className="material-symbols-outlined text-primary text-2xl">calendar_month</span>
                <h4 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                  {bookingConfirmedReceipt ? 'Booking Confirmed!' : selectedServiceItem.title}
                </h4>
              </div>
              <button
                className="p-1 rounded-full hover:bg-surface-container text-outline hover:text-on-surface"
                onClick={() => setIsSlotModalOpen(false)}
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
                    Pass Generated & Locked in Escrow
                  </h3>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                    Receipt #{bookingConfirmedReceipt.receiptId} • Token #{bookingConfirmedReceipt.tokenNumber}
                  </p>
                </div>
                <div className="bg-surface-container p-space-sm rounded-xl font-mono text-sm text-primary font-bold">
                  {bookingConfirmedReceipt.qrVerificationCode}
                </div>
                <button
                  className="w-full py-space-xs px-space-md rounded-xl bg-primary text-on-primary font-label-md text-label-md font-semibold"
                  onClick={() => setIsSlotModalOpen(false)}
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-space-xs">
                  <p className="font-body-sm text-body-sm text-on-surface-variant font-medium">
                    {selectedServiceItem.vendorName} • ${selectedServiceItem.price.toFixed(2)}
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
                      className={`slot-pill px-space-sm py-space-xs rounded-xl font-label-md text-label-md font-semibold transition-all ${
                        selectedSlotTime === time
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
                      ₹{(selectedServiceItem.price * 83).toFixed(0)}
                    </span>
                  </div>
                ) : (
                  <div className="bg-surface-container-low rounded-xl p-space-sm flex items-center gap-2 text-on-surface-variant font-label-sm text-label-sm">
                    <span className="material-symbols-outlined text-base text-primary">lock_clock</span>
                    <span>5-Minute atomic holding lock guarantees no double bookings.</span>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="pt-space-sm flex items-center justify-between border-t border-surface-container">
                  <div className="flex items-center gap-1 text-secondary font-label-sm text-label-sm font-semibold">
                    <span className="material-symbols-outlined text-base">verified</span> Instant SMS & Escrow Pass
                  </div>
                  {!isSlotLocked ? (
                    <button
                      className="px-space-md py-space-xs rounded-xl bg-primary text-on-primary font-label-md text-label-md font-semibold shadow-sm hover:opacity-95"
                      onClick={handleLockSlot}
                      type="button"
                    >
                      {isLocking ? 'Locking Slot...' : 'Lock Slot (5 Mins)'}
                    </button>
                  ) : (
                    <button
                      className="px-space-md py-space-xs rounded-xl bg-secondary text-on-secondary font-label-md text-label-md font-semibold shadow-sm hover:opacity-95 animate-pulse"
                      onClick={handleConfirmBooking}
                      type="button"
                    >
                      Confirm with UPI
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          SLIDE-OVER TRAY / CART DRAWER
         ========================================================================= */}
      {isTrayOpen && (
        <div className="fixed inset-0 z-50 bg-inverse-surface/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-md bg-surface-container-lowest h-full shadow-2xl p-space-lg flex flex-col justify-between animate-in slide-in-from-right duration-300 border-l border-surface-container">
            <div>
              <div className="flex items-center justify-between pb-space-md border-b border-surface-container">
                <div className="flex items-center gap-space-xs">
                  <span className="material-symbols-outlined text-primary text-2xl">shopping_bag</span>
                  <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">Your Food & Pantry Tray</h3>
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
                        <p className="font-label-sm text-label-sm text-outline">${t.item.price.toFixed(2)} each</p>
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
                  <span>${traySubtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-label-md text-label-md text-outline">
                  <span>Hyperlocal Dispatch Fee</span>
                  <span>{trayDeliveryFee === 0 ? 'FREE' : `$${trayDeliveryFee.toFixed(2)}`}</span>
                </div>
                <div className="flex justify-between font-label-md text-label-md text-outline">
                  <span>Taxes & GST (5%)</span>
                  <span>${trayTaxes.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-headline-sm text-headline-sm font-bold text-on-surface pt-1 border-t border-surface-container">
                  <span>Total Amount</span>
                  <span>${trayTotal.toFixed(2)}</span>
                </div>
                <button
                  className="w-full mt-2 py-space-sm px-space-md rounded-xl bg-primary text-on-primary font-label-md text-label-md font-bold hover:opacity-95 shadow-md flex items-center justify-center gap-2"
                  onClick={() => {
                    alert(`Order placed successfully with Escrow Lock for $${trayTotal.toFixed(2)}! Dispatched in 19 mins.`);
                    setTray([]);
                    setIsTrayOpen(false);
                  }}
                >
                  <span className="material-symbols-outlined text-lg">lock</span>
                  <span>Checkout with Direct UPI (${trayTotal.toFixed(2)})</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          MODALS: BUYER AUTH & PROFILE SETTINGS
         ========================================================================= */}
      {isAuthOpen && (
        <div className="fixed inset-0 z-50 bg-inverse-surface/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="relative max-w-md w-full">
            <button
              className="absolute top-4 right-4 z-10 text-on-surface hover:text-error"
              onClick={() => setIsAuthOpen(false)}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
            <BuyerAuth
              onAuthSuccess={(user) => {
                setCurrentUser(user);
                setIsAuthOpen(false);
              }}
            />
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <ProfileSettingsModal
          user={currentUser}
          onClose={() => setIsSettingsOpen(false)}
          onUserUpdated={(updatedUser) => {
            setCurrentUser(updatedUser);
            localStorage.setItem('streetverse_buyer_user', JSON.stringify(updatedUser));
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
              StreetVerse Marketplace
            </span>
          </div>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            © 2026 StreetVerse Platform Inc. Dual-Platform Architecture. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
