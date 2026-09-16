import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
    console.log('   ✓ Customer DB schema applied successfully.');

    // 2. Migrate Merchant DB (cube + earthdistance + vector)
    console.log('2. Applying DDL schema to Merchant DB (port 5434)...');
    const merchantDdl = fs.readFileSync(path.join(__dirname, 'merchant-db', 'schema.sql'), 'utf-8');
    await merchantPool.query(merchantDdl);
    console.log('   ✓ Merchant DB schema applied successfully.');

    // 3. Seed Merchant DB with Neighborhood Businesses in Kothrud, Pune
    console.log('3. Seeding Merchants with Geospatial Coordinates...');
    
    // Merchant 1: Green Valley Daily Needs (GPS: 18.5074° N, 73.8077° E - Kothrud)
    const m1Res = await merchantPool.query(`
      INSERT INTO merchants (business_name, category, owner_phone, upi_vpa, address, pincode, latitude, longitude, is_open, rating)
      VALUES (
        'Green Valley Daily Needs & Organic Grocery',
        'GROCERY',
        '+919876543210',
        'greenvalley.store@okhdfcbank',
        'Shop 4, Mayur Colony, Kothrud, Pune',
        '411038',
        18.5074000,
        73.8077000,
        true,
        4.8
      )
      ON CONFLICT (owner_phone) DO UPDATE SET business_name = EXCLUDED.business_name
      RETURNING id;
    `);
    const m1Id = m1Res.rows[0].id;

    // Merchant 2: Aura Unisex Salon (GPS: 18.5085° N, 73.8055° E)
    const m2Res = await merchantPool.query(`
      INSERT INTO merchants (business_name, category, owner_phone, upi_vpa, address, pincode, latitude, longitude, is_open, rating)
      VALUES (
        'Aura Unisex Neighborhood Salon',
        'SALON',
        '+919876543211',
        'aurasalon.kothrud@okaxis',
        'Plot 12, Ideal Colony, Kothrud, Pune',
        '411038',
        18.5085000,
        73.8055000,
        true,
        4.9
      )
      ON CONFLICT (owner_phone) DO UPDATE SET business_name = EXCLUDED.business_name
      RETURNING id;
    `);
    const m2Id = m2Res.rows[0].id;

    // Merchant 3: Apollo Lifecare Pharmacy (GPS: 18.5060° N, 73.8090° E)
    const m3Res = await merchantPool.query(`
      INSERT INTO merchants (business_name, category, owner_phone, upi_vpa, address, pincode, latitude, longitude, is_open, rating)
      VALUES (
        'Apollo Lifecare Pharmacy',
        'PHARMACY',
        '+919876543212',
        'apollo.lifecare@okicici',
        'Shop 1, Dahanukar Colony, Kothrud, Pune',
        '411038',
        18.5060000,
        73.8090000,
        true,
        4.7
      )
      ON CONFLICT (owner_phone) DO UPDATE SET business_name = EXCLUDED.business_name
      RETURNING id;
    `);
    const m3Id = m3Res.rows[0].id;

    console.log('   ✓ Seeded 3 local neighborhood merchants with GPS coordinates.');

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

    console.log('   ✓ Seeded 5 inventory items with 1536d embeddings.');

    // 5. Seed Service Appointment Slots
    console.log('5. Seeding Service Appointment Slots for Aura Salon...');
    const now = new Date();
    const slot1Start = new Date(now.getTime() + 2 * 3600000);
    const slot1End = new Date(slot1Start.getTime() + 45 * 60000);

    const slot2Start = new Date(now.getTime() + 4 * 3600000);
    const slot2End = new Date(slot2Start.getTime() + 45 * 60000);

    await merchantPool.query(`
      INSERT INTO service_slots (merchant_id, service_name, slot_start, slot_end, price, status)
      VALUES 
        ($1, 'Executive Haircut & Beard Styling', $2, $3, 250.00, 'AVAILABLE'),
        ($1, 'Skin Detox Facial & Hair Spa', $4, $5, 650.00, 'AVAILABLE')
      ON CONFLICT DO NOTHING;
    `, [m2Id, slot1Start, slot1End, slot2Start, slot2End]);

    console.log('   ✓ Seeded available service appointment slots.');

    // 6. Seed Sample Customer in Customer DB
    console.log('6. Seeding Test Customer in Customer DB...');
    await customerPool.query(`
      INSERT INTO users (phone, full_name, email, preferred_language, home_address)
      VALUES ('+919890123456', 'Rahul Deshmukh', 'rahul.d@example.com', 'en', 'Kothrud, Pune')
      ON CONFLICT (phone) DO NOTHING;
    `);
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
