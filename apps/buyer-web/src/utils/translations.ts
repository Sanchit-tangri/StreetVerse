export interface Translations {
  [key: string]: {
    en: string;
    hi: string;
    mr?: string;
  };
}

export const DICTIONARY: Translations = {
  // Navigation & Header
  deliverTo: {
    en: 'Deliver to',
    hi: 'डिलीवरी स्थान',
    mr: 'डिलिव्हरी पत्ता'
  },
  searchPlaceholder: {
    en: 'Search biryani, kirana, salon stylists, box cricket...',
    hi: 'बिरयानी, किराना, सैलून स्टाइलिस्ट, बॉक्स क्रिकेट खोजें...',
    mr: 'बिर्याणी, किराणा, सलून, बॉक्स क्रिकेट शोधा...'
  },
  voiceListening: {
    en: 'Listening... Speak your order or venue now',
    hi: 'सुन रहे हैं... अपना ऑर्डर या दुकान का नाम बोलें',
    mr: 'ऐकत आहोत... तुमची ऑर्डर किंवा नाव बोला'
  },
  exploreHub: {
    en: 'Explore Hub',
    hi: 'खोजें',
    mr: 'शोधा'
  },
  searching: {
    en: 'Searching...',
    hi: 'खोज जारी है...',
    mr: 'शोधत आहे...'
  },
  allHubs: {
    en: 'Explore All India Hubs',
    hi: 'सभी सेवाएं',
    mr: 'सर्व सेवा'
  },
  catDining: {
    en: 'Dining & Street Food',
    hi: 'खान-पान और स्ट्रीट फूड',
    mr: 'खान-पान आणि स्ट्रीट फूड'
  },
  catGrocery: {
    en: 'Daily Kirana & Mandi',
    hi: 'दैनिक किराना और मंडी',
    mr: 'दैनिक किराणा आणि भाजीपाला'
  },
  catWellness: {
    en: 'Salons & Parlours',
    hi: 'सैलून और ब्यूटी',
    mr: 'सलून आणि ब्युटी'
  },
  catTurf: {
    en: 'Box Cricket & Turfs',
    hi: 'बॉक्स क्रिकेट और टर्फ',
    mr: 'बॉक्स क्रिकेट आणि टर्फ'
  },

  // Main Hero & Lifelines
  lifelinesHeader: {
    en: 'Neighborhood Lifelines',
    hi: 'पड़ोस की प्रमुख सेवाएं',
    mr: 'परिसरातील प्रमुख सेवा'
  },
  lifelinesSub: {
    en: 'Instant booking, fresh local groceries, authentic dining & sports arenas nearby.',
    hi: 'स्थानीय दुकानों से ताज़ा सामान, लज़ीज़ खाना और तुरंत स्लॉट बुकिंग।',
    mr: 'स्थानिक दुकानांतून ताज्या वस्तू, स्वादिष्ट जेवण आणि त्वरित स्लॉट बुकिंग.'
  },
  trendingDeals: {
    en: 'Trending Deals & Ready-To-Book Nearby',
    hi: 'नजदीकी लोकप्रिय डील्स और तुरंत बुकिंग',
    mr: 'जवळपासच्या लोकप्रिय डील्स आणि त्वरित बुकिंग'
  },
  trendingDealsSub: {
    en: 'Fresh mandi vegetables, chef specials, salon stylists & box cricket slots',
    hi: 'ताज़ी मंडी सब्जियां, शेफ स्पेशल, सैलून स्टाइलिस्ट और बॉक्स क्रिकेट स्लॉट्स',
    mr: 'ताजा भाजीपाला, शेफ स्पेशल, सलून स्टायलिस्ट आणि बॉक्स क्रिकेट स्लॉट्स'
  },
  allOffers: {
    en: 'All Offers',
    hi: 'सभी ऑफर्स',
    mr: 'सर्व ऑफर्स'
  },

  // Actions & Buttons
  orderNow: {
    en: 'Quick Order',
    hi: 'अभी ऑर्डर करें',
    mr: 'आताच ऑर्डर करा'
  },
  bookSlot: {
    en: 'Instant Book',
    hi: 'स्लॉट बुक करें',
    mr: 'स्लॉट बुक करा'
  },
  addToTray: {
    en: 'Add to Tray',
    hi: 'थैली में जोड़ें',
    mr: 'पिशवीत जोडा'
  },
  inTray: {
    en: 'In Tray',
    hi: 'थैली में है',
    mr: 'पिशवीत आहे'
  },
  viewDetails: {
    en: 'View Details',
    hi: 'विवरण देखें',
    mr: 'तपशील पहा'
  },
  browse: {
    en: 'Browse Category',
    hi: 'श्रेणी देखें',
    mr: 'श्रेणी पहा'
  },
  shopFast: {
    en: 'Shop Fast',
    hi: 'तुरंत खरीदें',
    mr: 'झटपट खरेदी'
  },
  backToAll: {
    en: '← Back to All Categories',
    hi: '← सभी श्रेणियों पर वापस जाएं',
    mr: '← सर्व श्रेण्यांवर परत जा'
  },
  homeBreadcrumb: {
    en: 'Home',
    hi: 'होम',
    mr: 'मुख्य'
  },
  inStock: {
    en: 'In Stock Near You',
    hi: 'आपके पास उपलब्ध',
    mr: 'तुमच्या जवळ उपलब्ध'
  },
  availableNow: {
    en: 'Available Now',
    hi: 'अभी खुला है',
    mr: 'आत्ता उपलब्ध'
  },

  // 4 Lifeline Cards
  diningTitle: {
    en: 'Dining & Street Gourmet',
    hi: 'खान-पान और लज़ीज़ स्ट्रीट फूड',
    mr: 'खान-पान आणि स्ट्रीट फूड'
  },
  diningDesc: {
    en: 'Authentic Hyderabadi dum biryani, woodfired paneer pizzas, street chaat, and live table reservation locks.',
    hi: 'हैदराबादी दम बिरयानी, तंदूरी पनीर पिज़्ज़ा, चाट और रेस्टोरेंट टेबल बुकिंग।',
    mr: 'हैदराबादी दम बिर्याणी, तंदुरी पनीर पिझ्झा, चाट आणि रेस्टॉरंट टेबल बुकिंग.'
  },
  groceryTitle: {
    en: 'Kirana, Mandi & Daily Dairy',
    hi: 'किराना, मंडी और ताज़ा डेयरी',
    mr: 'किराणा, भाजीपाला आणि ताजी डेअरी'
  },
  groceryDesc: {
    en: 'Fresh mandi vegetables, A2 Gir cow milk, chakki fresh atta, pulses, and same-hour kirana replenishment.',
    hi: 'ताज़ी मंडी सब्जियां, A2 गाय का दूध, चक्की का ताज़ा आटा, दालें और त्वरित डिलीवरी।',
    mr: 'ताजा भाजीपाला, A2 गाईचे दूध, चक्कीचे ताजे पीठ आणि त्वरित डिलिव्हरी.'
  },
  wellnessTitle: {
    en: 'Salons, Grooming & Spa',
    hi: 'सैलून, ग्रूमिंग और ब्यूटी पार्लर',
    mr: 'सलून, ग्रूमिंग आणि ब्युटी पार्लर'
  },
  wellnessDesc: {
    en: 'Precision fade cuts, royal beard sculpting, bridal facials, and guaranteed zero-wait appointment tokens.',
    hi: 'स्टाइलिश हेयरकट, दाढ़ी ट्रिम, फेशियल और बिना इंतज़ार के गारंटीकृत टोकन।',
    mr: 'स्टायलिश हेअरकट, दाढी ट्रिम, फेशिअल आणि विना प्रतीक्षा टोकन.'
  },
  turfTitle: {
    en: 'Box Cricket & Sports Turfs',
    hi: 'बॉक्स क्रिकेट और स्पोर्ट्स टर्फ',
    mr: 'बॉक्स क्रिकेट आणि स्पोर्ट्स टर्फ'
  },
  turfDesc: {
    en: 'Floodlit artificial turf pitches, box cricket arenas, wooden badminton courts with 5-minute atomic holding locks.',
    hi: 'फ्लडलाइट बॉक्स क्रिकेट ग्राउंड, फुटबॉल टर्फ, बैडमिंटन कोर्ट और तुरंत स्लॉट बुकिंग।',
    mr: 'फ्लडलाइट बॉक्स क्रिकेट ग्राउंड, फुटबॉल टर्फ आणि त्वरित स्लॉट बुकिंग.'
  },

  // Badges & Details
  fastDeliveryBadge: {
    en: 'Avg ETA 20 mins',
    hi: 'औसतन 20 मिनट',
    mr: 'सरासरी 20 मिनिटे'
  },
  freeDeliveryBadge: {
    en: 'Free Delivery ₹199+',
    hi: 'मुफ़्त डिलीवरी ₹199+',
    mr: 'मोफत डिलिव्हरी ₹199+'
  },
  zeroWaitBadge: {
    en: 'Zero Wait Token',
    hi: 'जीरो वेट टोकन',
    mr: 'झिरो वेट टोकन'
  },
  instantSlotSyncBadge: {
    en: 'Live Slot Sync',
    hi: 'लाइव स्लॉट सिंक',
    mr: 'थेट स्लॉट सिंक'
  },
  tableTakeaway: {
    en: 'Table & Takeaway',
    hi: 'टेबल और पार्सल',
    mr: 'टेबल आणि पार्सल'
  },
  perSlot: {
    en: '/ slot',
    hi: '/ स्लॉट',
    mr: '/ स्लॉट'
  },
  instantLockText: {
    en: 'Today · Instant Lock',
    hi: 'आज · तुरंत स्लॉट लॉक',
    mr: 'आज · तत्काळ स्लॉट लॉक'
  },

  // Profile & Theme Customization
  profileTitle: {
    en: 'Profile & Account',
    hi: 'प्रोफ़ाइल और खाता',
    mr: 'प्रोफाइल आणि खाते'
  },
  themeAppearance: {
    en: 'Canvas Theme & Colors',
    hi: 'थीम और रंग पसंद',
    mr: 'थीम आणि रंग'
  },
  themeDefault: {
    en: 'Default',
    hi: 'डिफ़ॉल्ट',
    mr: 'डीफॉल्ट'
  },
  themeNoir: {
    en: 'Dark Noir',
    hi: 'डार्क नोयर',
    mr: 'डार्क नोयर'
  },
  themeBeige: {
    en: 'Warm Beige',
    hi: 'वार्म बेज',
    mr: 'वॉर्म बेज'
  },
  themeSky: {
    en: 'Soft Sky',
    hi: 'आसमानी नीला',
    mr: 'आकाशी निळा'
  },
  accentLabel: {
    en: 'Accent Color',
    hi: 'हाइलाइट रंग',
    mr: 'हायलाइट रंग'
  },
  signOut: {
    en: 'Sign Out (Exit to Login)',
    hi: 'लॉग आउट करें',
    mr: 'लॉग आउट करा'
  },
  trayTitle: {
    en: 'Order & Booking Tray',
    hi: 'ऑर्डर और बुकिंग थैली',
    mr: 'ऑर्डर आणि बुकिंग पिशवी'
  },
  proceedToPay: {
    en: 'Proceed to UPI Pay',
    hi: 'यूपीआई भुगतान करें',
    mr: 'यूपीआय पेमेंट करा'
  },
  emptyCatalog: {
    en: 'No items match your query. Try searching for "biryani" or clear filters.',
    hi: 'कोई परिणाम नहीं मिला। "बिरयानी" खोजें या फ़िल्टर साफ़ करें।',
    mr: 'काहीही आढळले नाही. "बिर्याणी" शोधून पहा.'
  }
};

export function getTranslation(lang: string, key: string, fallback?: string): string {
  const isHindi = lang.includes('HI') || lang.toLowerCase().startsWith('hi');
  const isMarathi = lang.includes('MR') || lang.toLowerCase().startsWith('mr');
  const langKey = isHindi ? 'hi' : (isMarathi ? 'mr' : 'en');

  const entry = DICTIONARY[key];
  if (!entry) return fallback || key;
  return entry[langKey] || entry.en || fallback || key;
}

