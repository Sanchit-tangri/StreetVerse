import pg from 'pg';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

export interface ResilientPoolLike {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
  on: (event: string, listener: (...args: any[]) => void) => any;
  end: () => Promise<void>;
}

// In-Memory Fallback Stores for when Docker/PostgreSQL is offline
interface UserRecord {
  id: string;
  phone: string;
  full_name: string;
  email: string;
  home_address: string;
  password_hash: string;
  is_verified: boolean;
  role: string;
  created_at: Date;
  updated_at: Date;
}

interface MerchantRecord {
  id: string;
  business_name: string;
  category: string;
  owner_phone: string;
  owner_email: string;
  password_hash: string;
  upi_vpa: string;
  address: string;
  pincode: string;
  latitude: number;
  longitude: number;
  is_verified: boolean;
  role: string;
  created_at: Date;
}

interface ServiceSlotRecord {
  id: string;
  merchant_id: string;
  service_name: string;
  status: string;
  booked_count: number;
  price: number;
}

interface InventoryItemRecord {
  id: string;
  merchant_id: string;
  item_name: string;
  category: string;
  price: number;
  stock_quantity: number;
  is_available: boolean;
}

// Global in-memory storage singletons
const inMemoryUsers: UserRecord[] = [];
const inMemoryMerchants: MerchantRecord[] = [];
const inMemorySlots: ServiceSlotRecord[] = [];
const inMemoryInventory: InventoryItemRecord[] = [];

let memoryInitialized = false;

async function initInMemoryData() {
  if (memoryInitialized) return;
  memoryInitialized = true;

  const defaultBuyerHash = await bcrypt.hash('Buyer1234!', 10);
  const defaultSellerHash = await bcrypt.hash('Seller1234!', 10);

  // Seed default test buyer
  inMemoryUsers.push({
    id: 'c1000000-0000-0000-0000-000000000001',
    phone: '+919890123456',
    full_name: 'Rahul Deshmukh',
    email: 'rahul.d@example.com',
    home_address: 'Flat 402, Mayur Colony, Kothrud, Pune',
    password_hash: defaultBuyerHash,
    is_verified: true,
    role: 'buyer',
    created_at: new Date(),
    updated_at: new Date()
  });

  // Seed default merchants
  const m1Id = 'm1000000-0000-0000-0000-000000000001';
  inMemoryMerchants.push({
    id: m1Id,
    business_name: 'Sharma Kirana & General Store',
    category: 'GROCERY',
    owner_phone: '+919876543210',
    owner_email: 'sharma.kirana@example.com',
    password_hash: defaultSellerHash,
    upi_vpa: 'sharma.kirana@okhdfcbank',
    address: 'Shop 4, Mayur Colony, Kothrud, Pune',
    pincode: '411038',
    latitude: 18.5074,
    longitude: 73.8077,
    is_verified: true,
    role: 'seller',
    created_at: new Date()
  });

  const m2Id = 'm2000000-0000-0000-0000-000000000002';
  inMemoryMerchants.push({
    id: m2Id,
    business_name: 'Aura Unisex Neighborhood Salon',
    category: 'SALON',
    owner_phone: '+919876543211',
    owner_email: 'aura.salon@streetverse.local',
    password_hash: defaultSellerHash,
    upi_vpa: 'aurasalon.kothrud@okaxis',
    address: 'Plot 12, Ideal Colony, Kothrud, Pune',
    pincode: '411038',
    latitude: 18.5085,
    longitude: 73.8055,
    is_verified: true,
    role: 'seller',
    created_at: new Date()
  });

  // Seed salon service slots
  inMemorySlots.push({
    id: 's1000000-0000-0000-0000-000000000001',
    merchant_id: m2Id,
    service_name: 'Executive Haircut & Beard Grooming',
    status: 'AVAILABLE',
    booked_count: 0,
    price: 250
  });

  inMemorySlots.push({
    id: 's2000000-0000-0000-0000-000000000002',
    merchant_id: m2Id,
    service_name: 'Organic Fruit Facial & Head Massage',
    status: 'AVAILABLE',
    booked_count: 0,
    price: 499
  });

  // Seed inventory
  inMemoryInventory.push(
    {
      id: uuidv4(),
      merchant_id: m1Id,
      item_name: 'Whole Wheat Brown Bread (400g)',
      category: 'GROCERY',
      price: 45,
      stock_quantity: 15,
      is_available: true
    },
    {
      id: uuidv4(),
      merchant_id: m1Id,
      item_name: 'Farm Fresh Organic Eggs (Pack of 6)',
      category: 'GROCERY',
      price: 60,
      stock_quantity: 30,
      is_available: true
    },
    {
      id: uuidv4(),
      merchant_id: m1Id,
      item_name: 'Pure Cow Milk (1 Litre)',
      category: 'GROCERY',
      price: 65,
      stock_quantity: 25,
      is_available: true
    }
  );
}

// Initialise memory store async
initInMemoryData();

/**
 * Creates a resilient pool wrapper that talks to PostgreSQL if available,
 * and transparently falls back to the in-memory store if Docker / PostgreSQL is down.
 */
export function createResilientPool(
  connectionString: string,
  dbType: 'customer' | 'merchant'
): ResilientPoolLike {
  const realPool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 2000
  });

  realPool.on('error', (err) => {
    // Suppress unhandled ECONNREFUSED when Docker is stopped
  });

  let pgOfflineNoticeLogged = false;

  return {
    on: (event: string, listener: (...args: any[]) => void) => {
      return (realPool as any).on(event, listener);
    },
    end: async () => {
      try {
        await realPool.end();
      } catch {}
    },
    query: async (text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
      await initInMemoryData();

      // 1. Try real PostgreSQL first
      try {
        const client = await realPool.connect();
        try {
          const res = await client.query(text, params);
          return { rows: res.rows, rowCount: res.rowCount || res.rows.length };
        } finally {
          client.release();
        }
      } catch (err: any) {
        if (!pgOfflineNoticeLogged) {
          console.warn(`[StreetVerse DB Resilience] PostgreSQL on ${dbType} DB is offline (Docker down). Transparently switching to resilient in-memory datastore.`);
          pgOfflineNoticeLogged = true;
        }

        // 2. Fall back to in-memory query evaluation
        return executeInMemoryQuery(dbType, text, params);
      }
    }
  };
}

function executeInMemoryQuery(
  dbType: 'customer' | 'merchant',
  sql: string,
  params: any[]
): { rows: any[]; rowCount: number } {
  const cleanSql = sql.replace(/\s+/g, ' ').trim();

  // -------------------------------------------------------------
  // CUSTOMER DB HANDLERS
  // -------------------------------------------------------------
  if (dbType === 'customer') {
    // 1. SELECT id, phone, email FROM users WHERE phone = $1 OR email = $2
    if (/SELECT.*FROM users WHERE.*phone = \$1 OR.*email = \$2/i.test(cleanSql)) {
      const phone = String(params[0] || '').trim();
      const email = String(params[1] || '').trim().toLowerCase();
      const match = inMemoryUsers.find(
        (u) => u.phone === phone || u.email.toLowerCase() === email
      );
      const rows = match ? [{ id: match.id, phone: match.phone, email: match.email }] : [];
      return { rows, rowCount: rows.length };
    }

    // 2. INSERT INTO users (...) VALUES (...) RETURNING id, full_name, email, phone, role
    if (/INSERT INTO users/i.test(cleanSql)) {
      const fullName = params[0] || '';
      const phone = params[1] || '';
      const email = (params[2] || '').toLowerCase();
      const passwordHash = params[3] || '';
      const homeAddress = params[4] || '';
      const isVerified = Boolean(params[5]);

      const newUser: UserRecord = {
        id: uuidv4(),
        full_name: fullName,
        phone,
        email,
        password_hash: passwordHash,
        home_address: homeAddress,
        is_verified: isVerified,
        role: 'buyer',
        created_at: new Date(),
        updated_at: new Date()
      };

      inMemoryUsers.push(newUser);
      return {
        rows: [{
          id: newUser.id,
          full_name: newUser.full_name,
          email: newUser.email,
          phone: newUser.phone,
          role: newUser.role
        }],
        rowCount: 1
      };
    }

    // 3. SELECT ... FROM users WHERE LOWER(email) = $1 OR phone = $1
    if (/SELECT.*FROM users WHERE.*(email.*=.*\$1|phone.*=.*\$1)/i.test(cleanSql)) {
      const ident = String(params[0] || '').trim().toLowerCase();
      const match = inMemoryUsers.find(
        (u) => u.email.toLowerCase() === ident || u.phone.toLowerCase() === ident
      );
      const rows = match ? [{
        id: match.id,
        full_name: match.full_name,
        email: match.email,
        phone: match.phone,
        password_hash: match.password_hash,
        is_verified: match.is_verified,
        home_address: match.home_address,
        role: match.role
      }] : [];
      return { rows, rowCount: rows.length };
    }

    // 4. UPDATE users SET is_verified = true WHERE id = $1
    if (/UPDATE users SET is_verified = true WHERE id = \$1/i.test(cleanSql)) {
      const id = params[0];
      const match = inMemoryUsers.find((u) => u.id === id);
      if (match) match.is_verified = true;
      return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
    }

    // 5. SELECT id FROM users WHERE email = $1
    if (/SELECT id FROM users WHERE email = \$1/i.test(cleanSql)) {
      const email = String(params[0] || '').trim().toLowerCase();
      const match = inMemoryUsers.find((u) => u.email.toLowerCase() === email);
      return { rows: match ? [{ id: match.id }] : [], rowCount: match ? 1 : 0 };
    }

    // 6. UPDATE users SET email = $1, updated_at = ... WHERE id = $2 RETURNING ...
    if (/UPDATE users SET email = \$1.*WHERE id = \$2/i.test(cleanSql)) {
      const newEmail = String(params[0] || '').trim().toLowerCase();
      const id = params[1];
      const match = inMemoryUsers.find((u) => u.id === id);
      if (match) {
        match.email = newEmail;
        match.updated_at = new Date();
        return {
          rows: [{
            id: match.id,
            full_name: match.full_name,
            email: match.email,
            phone: match.phone,
            role: match.role
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    }
  }

  // -------------------------------------------------------------
  // MERCHANT DB HANDLERS
  // -------------------------------------------------------------
  if (dbType === 'merchant') {
    // 1. SELECT id, owner_phone, owner_email FROM merchants WHERE owner_phone = $1 OR owner_email = $2
    if (/SELECT.*FROM merchants WHERE.*owner_phone = \$1 OR.*owner_email = \$2/i.test(cleanSql)) {
      const phone = String(params[0] || '').trim();
      const email = String(params[1] || '').trim().toLowerCase();
      const match = inMemoryMerchants.find(
        (m) => m.owner_phone === phone || m.owner_email.toLowerCase() === email
      );
      const rows = match ? [{ id: match.id, owner_phone: match.owner_phone, owner_email: match.owner_email }] : [];
      return { rows, rowCount: rows.length };
    }

    // 2. INSERT INTO merchants (...) VALUES (...) RETURNING id, business_name, category, owner_email, owner_phone, role
    if (/INSERT INTO merchants/i.test(cleanSql)) {
      const businessName = params[0] || '';
      const category = params[1] || '';
      const ownerPhone = params[2] || '';
      const ownerEmail = (params[3] || '').toLowerCase();
      const passwordHash = params[4] || '';
      const upiVpa = params[5] || '';
      const address = params[6] || '';
      const pincode = params[7] || '';
      const isVerified = Boolean(params[8]);

      const newMerchant: MerchantRecord = {
        id: uuidv4(),
        business_name: businessName,
        category,
        owner_phone: ownerPhone,
        owner_email: ownerEmail,
        password_hash: passwordHash,
        upi_vpa: upiVpa,
        address,
        pincode,
        latitude: 18.5074,
        longitude: 73.8077,
        is_verified: isVerified,
        role: 'seller',
        created_at: new Date()
      };

      inMemoryMerchants.push(newMerchant);
      return {
        rows: [{
          id: newMerchant.id,
          business_name: newMerchant.business_name,
          category: newMerchant.category,
          owner_email: newMerchant.owner_email,
          owner_phone: newMerchant.owner_phone,
          role: newMerchant.role
        }],
        rowCount: 1
      };
    }

    // 3. SELECT ... FROM merchants WHERE owner_email = $1 OR owner_phone = $1
    if (/SELECT.*FROM merchants WHERE.*(owner_email.*=.*\$1|owner_phone.*=.*\$1)/i.test(cleanSql)) {
      const ident = String(params[0] || '').trim().toLowerCase();
      const match = inMemoryMerchants.find(
        (m) => m.owner_email.toLowerCase() === ident || m.owner_phone.toLowerCase() === ident
      );
      const rows = match ? [{
        id: match.id,
        business_name: match.business_name,
        category: match.category,
        owner_phone: match.owner_phone,
        owner_email: match.owner_email,
        password_hash: match.password_hash,
        is_verified: match.is_verified,
        upi_vpa: match.upi_vpa,
        address: match.address,
        pincode: match.pincode,
        role: match.role
      }] : [];
      return { rows, rowCount: rows.length };
    }

    // 4. UPDATE merchants SET is_verified = true WHERE id = $1
    if (/UPDATE merchants SET is_verified = true WHERE id = \$1/i.test(cleanSql)) {
      const id = params[0];
      const match = inMemoryMerchants.find((m) => m.id === id);
      if (match) match.is_verified = true;
      return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
    }

    // 5. SELECT status FROM service_slots WHERE id = $1 AND merchant_id = $2
    if (/SELECT.*status.*FROM service_slots/i.test(cleanSql)) {
      const slotId = params[0];
      const match = inMemorySlots.find((s) => s.id === slotId);
      if (match) {
        return { rows: [{ status: match.status }], rowCount: 1 };
      }
      return { rows: [{ status: 'AVAILABLE' }], rowCount: 1 };
    }

    // 6. UPDATE service_slots SET status = 'BOOKED' ...
    if (/UPDATE service_slots SET status = 'BOOKED'/i.test(cleanSql)) {
      const slotId = params[0];
      const match = inMemorySlots.find((s) => s.id === slotId);
      if (match) {
        match.status = 'BOOKED';
        match.booked_count += 1;
      }
      return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
    }

    // 7. SELECT ... FROM inventory_items i JOIN merchants m ...
    if (/FROM inventory_items/i.test(cleanSql)) {
      const patternParam = params.find(p => typeof p === 'string') || '';
      const q = String(patternParam).replace(/%/g, '').toLowerCase().trim();
      const limit = Number(params[params.length - 1] || 10);

      const itemMatches = inMemoryInventory.filter((i) =>
        !q || i.item_name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)
      ).map((item, idx) => {
        const merch = inMemoryMerchants.find((m) => m.id === item.merchant_id);
        return {
          item_id: item.id,
          item_name: item.item_name,
          category: item.category,
          price: item.price,
          stock_quantity: item.stock_quantity,
          is_available: item.is_available,
          merchant_id: item.merchant_id,
          business_name: merch ? merch.business_name : 'Local Merchant',
          distance_meters: 150 + idx * 120,
          relevance_score: 0.95
        };
      });

      const slotMatches = inMemorySlots.filter((s) =>
        !q || s.service_name.toLowerCase().includes(q) || 'salon'.includes(q)
      ).map((slot, idx) => {
        const merch = inMemoryMerchants.find((m) => m.id === slot.merchant_id);
        return {
          item_id: slot.id,
          item_name: slot.service_name,
          category: 'SALON & SPA',
          price: slot.price,
          stock_quantity: 1,
          is_available: slot.status === 'AVAILABLE',
          merchant_id: slot.merchant_id,
          business_name: merch ? merch.business_name : 'Aura Unisex Salon',
          distance_meters: 260 + idx * 100,
          relevance_score: 0.95
        };
      });

      const allRows = [...itemMatches, ...slotMatches].slice(0, limit);
      return { rows: allRows, rowCount: allRows.length };
    }
  }

  // Generic fallback: return empty
  return { rows: [], rowCount: 0 };
}
