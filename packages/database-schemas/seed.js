import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database 1: Customer DB (Port 5433)
const customerPool = new pg.Pool({
  connectionString: process.env.CUSTOMER_DB_URL || 'postgresql://postgres:postgres@localhost:5433/streetverse_customer_db'
});

// Database 2: Merchant DB (Port 5434)
const merchantPool = new pg.Pool({
  connectionString: process.env.MERCHANT_DB_URL || 'postgresql://postgres:postgres@localhost:5434/streetverse_merchant_db'
});

async function runSeed() {
  console.log('========================================================');
  console.log('   StreetVerse Dual Database Migration & Seeding       ');
  console.log('========================================================\n');

  try {
    // 1. Migrate Customer DB
    console.log('1. Applying DDL schema to Customer DB (port 5433)...');
    const customerDdl = fs.readFileSync(path.join(__dirname, 'customer-db', 'schema.sql'), 'utf-8');
    await customerPool.query(customerDdl);
    await customerPool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
    `);
    console.log('   ✓ Customer DB schema and auth columns applied successfully.');

    // 2. Migrate Merchant DB (cube + earthdistance + vector)
    console.log('2. Applying DDL schema to Merchant DB (port 5434)...');
    const merchantDdl = fs.readFileSync(path.join(__dirname, 'merchant-db', 'schema.sql'), 'utf-8');
    await merchantPool.query(merchantDdl);
    await merchantPool.query(`
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255) UNIQUE;
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
    `);
    console.log('   ✓ Merchant DB schema and auth columns applied successfully.');

    // 3. Seed Merchant DB with Neighborhood Businesses in Kothrud, Pune
    console.log('3. Seeding Merchants with Geospatial Coordinates & Auth Passwords...');
    const demoPasswordHash = await bcrypt.hash('Password123!', 10);
    
    // Merchant 1: Green Valley Daily Needs (GPS: 18.5074° N, 73.8077° E - Kothrud)
    const m1Res = await merchantPool.query(`
      INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open, rating)
      VALUES (
        'Green Valley Daily Needs & Organic Grocery',
        'GROCERY',
        '+919876543210',
        'greenvalley@streetverse.local',
        $1,
        true,
        'greenvalley.store@okhdfcbank',
        'Shop 4, Mayur Colony, Kothrud, Pune',
        '411038',
        18.5074000,
        73.8077000,
        true,
        4.8
      )
      ON CONFLICT (owner_phone) DO UPDATE SET 
        business_name = EXCLUDED.business_name,
        owner_email = EXCLUDED.owner_email,
        password_hash = EXCLUDED.password_hash,
        is_verified = true
      RETURNING id;
    `, [demoPasswordHash]);
    const m1Id = m1Res.rows[0].id;

    // Merchant 2: Aura Unisex Salon (GPS: 18.5085° N, 73.8055° E)
    const m2Res = await merchantPool.query(`
      INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open, rating)
      VALUES (
        'Aura Unisex Neighborhood Salon',
        'SALON',
        '+919876543211',
        'aura.salon@streetverse.local',
        $1,
        true,
        'aurasalon.kothrud@okaxis',
        'Plot 12, Ideal Colony, Kothrud, Pune',
        '411038',
        18.5085000,
        73.8055000,
        true,
        4.9
      )
      ON CONFLICT (owner_phone) DO UPDATE SET 
        business_name = EXCLUDED.business_name,
        owner_email = EXCLUDED.owner_email,
        password_hash = EXCLUDED.password_hash,
        is_verified = true
      RETURNING id;
    `, [demoPasswordHash]);
    const m2Id = m2Res.rows[0].id;

    // Merchant 3: Apollo Lifecare Pharmacy (GPS: 18.5060° N, 73.8090° E)
    const m3Res = await merchantPool.query(`
      INSERT INTO merchants (business_name, category, owner_phone, owner_email, password_hash, is_verified, upi_vpa, address, pincode, latitude, longitude, is_open, rating)
      VALUES (
        'Apollo Lifecare Pharmacy',
        'PHARMACY',
        '+919876543212',
        'apollo.lifecare@streetverse.local',
        $1,
        true,
        'apollo.lifecare@okicici',
        'Shop 1, Dahanukar Colony, Kothrud, Pune',
        '411038',
        18.5060000,
        73.8090000,
        true,
        4.7
      )
      ON CONFLICT (owner_phone) DO UPDATE SET 
        business_name = EXCLUDED.business_name,
        owner_email = EXCLUDED.owner_email,
        password_hash = EXCLUDED.password_hash,
        is_verified = true
      RETURNING id;
    `, [demoPasswordHash]);
    const m3Id = m3Res.rows[0].id;

    console.log('   ✓ Seeded 3 local neighborhood merchants with GPS coordinates & auth passwords.');

    // 4. Seed Inventory Items with Vector Embeddings (1536-dim normalized vectors)
    console.log('4. Seeding Inventory Items with pgvector embeddings...');
    const dummyVector = '[' + Array(1536).fill(0.01).join(',') + ']';

    await merchantPool.query(`
      INSERT INTO inventory_items (merchant_id, item_name, category, description, price, stock_quantity, unit, is_available, embedding)
      VALUES 
        ($1, 'Whole Wheat Brown Bread (400g)', 'GROCERY', 'Freshly baked daily whole wheat brown bread with zero preservatives', 45.00, 15, 'pcs', true, $2::vector),
        ($1, 'Farm Fresh Organic Eggs (Pack of 6)', 'GROCERY', 'Locally sourced free-range organic eggs', 60.00, 30, 'packet', true, $2::vector),
        ($1, 'Pure Cow Milk (1 Litre)', 'GROCERY', 'Pasteurized fresh whole cow milk', 65.00, 25, 'litre', true, $2::vector),
        ($3, 'Digital Infrared Thermometer', 'PHARMACY', 'Non-contact instant body temperature monitor', 850.00, 8, 'pcs', true, $2::vector),
        ($3, 'First Aid Emergency Care Kit', 'PHARMACY', 'Complete antiseptic bandages, gauze, and ointment pack', 220.00, 14, 'pcs', true, $2::vector)
      ON CONFLICT DO NOTHING;
    `, [m1Id, dummyVector, m3Id]);

    console.log('   ✓ Seeded inventory items with pgvector embeddings.');

    // 5. Seed Service Appointment Slots
    console.log('5. Seeding Service Appointment Slots for Salon...');
    const now = new Date();
    const slot1Start = new Date(now.getTime() + 60 * 60 * 1000);
    const slot1End = new Date(now.getTime() + 90 * 60 * 1000);

    const slot2Start = new Date(now.getTime() + 120 * 60 * 1000);
    const slot2End = new Date(now.getTime() + 150 * 60 * 1000);

    await merchantPool.query(`
      INSERT INTO service_slots (merchant_id, service_name, slot_start, slot_end, price, status)
      VALUES 
        ($1, 'Executive Haircut & Beard Styling', $2, $3, 250.00, 'AVAILABLE'),
        ($1, 'Skin Detox Facial & Hair Spa', $4, $5, 650.00, 'AVAILABLE')
      ON CONFLICT DO NOTHING;
    `, [m2Id, slot1Start, slot1End, slot2Start, slot2End]);

    console.log('   ✓ Seeded available service appointment slots.');

    // 6. Seed Sample Customer in Customer DB
    console.log('6. Seeding Test Customer in Customer DB with Auth...');
    await customerPool.query(`
      INSERT INTO users (phone, full_name, email, password_hash, is_verified, preferred_language, home_address)
      VALUES ('+919890123456', 'Rahul Deshmukh', 'rahul.d@example.com', $1, true, 'en', 'Kothrud, Pune')
      ON CONFLICT (phone) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        is_verified = true;
    `, [demoPasswordHash]);
    console.log('   ✓ Seeded test customer in Customer DB.');

    console.log('\n========================================================');
    console.log('   ✓ StreetVerse Database Initialization Complete!      ');
    console.log('========================================================');
  } catch (error) {
    console.error('Migration/Seeding Error:', error);
  } finally {
    await customerPool.end();
    await merchantPool.end();
  }
}

runSeed();
