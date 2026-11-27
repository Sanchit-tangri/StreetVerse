/**
 * Phase 2.1A live PostgreSQL tests for catalogue CREATE validation,
 * persisted PATCH merges, and seller/admin authorization.
 *
 * Uses one disposable postgres:16-alpine container on a dynamic port.
 * Does not touch development compose containers.
 */

import { execFile } from 'child_process';
import http from 'http';
import { createRequire } from 'module';
import net, { AddressInfo } from 'net';
import path from 'path';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';

const express = createRequire(path.resolve(__dirname, '../../services/api-gateway/package.json'))('express') as typeof import('express');
import { createCatalogueRouter } from '../../services/api-gateway/src/routes/catalogue';
import { applyGroceryCatalogueMigration } from '../../services/api-gateway/src/db/migrations/groceryCatalogueMigration';
import { createStrictPgPool, StrictPgPool } from '../../services/api-gateway/src/db/postgres';
import { JwtAuthConfig, ADMIN_ACCOUNT_PRINCIPAL_TYPE, SELLER_ACCOUNT_PRINCIPAL_TYPE } from '../../services/api-gateway/src/middleware/authJwt';

const execFileAsync = promisify(execFile);
const RESERVED_PORTS = new Set([5432, 5433, 5434, 6379, 6380, 8000]);
const PG_PASSWORD = 'p21a_catalogue_test';
const DB_NAME = 'streetverse_catalogue_test';

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SELLER_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SELLER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const STORE_1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const STORE_2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';

const JWT_CONFIG: JwtAuthConfig = {
  jwtSecret: 'p21a-catalogue-test-secret-at-least-32b',
  jwtIssuer: 'streetverse-api',
  jwtBuyerAudience: 'streetverse-buyer',
  jwtSellerAudience: 'streetverse-seller',
  jwtExpiresIn: '1h',
  jwtAdminAudience: 'streetverse-admin',
  jwtAdminExpiresIn: '8h'
};

type TestFn = () => Promise<void>;
const TESTS: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  TESTS.push({ name, fn });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', args, { timeout: 120000, encoding: 'utf8' });
}

async function waitForUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`${message}${lastErr instanceof Error ? ` (${lastErr.message})` : ''}`);
}

async function getFreePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        server.close((err) => (err ? reject(err) : resolve(addr.port)));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('Could not allocate isolated port.');
}

function httpRequest(options: {
  port: number;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        timeout: 8000,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try { json = body ? JSON.parse(body) : null; } catch { json = null; }
          resolve({ statusCode: res.statusCode || 0, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function adminToken(): string {
  return jwt.sign(
    { sub: ADMIN_ID, role: 'ADMIN', principalType: ADMIN_ACCOUNT_PRINCIPAL_TYPE, email: 'catalogue.admin@streetverse.test' },
    JWT_CONFIG.jwtSecret,
    { issuer: JWT_CONFIG.jwtIssuer, audience: 'streetverse-admin', expiresIn: '1h' }
  );
}

function sellerToken(sub: string): string {
  return jwt.sign(
    { sub, role: 'SELLER', principalType: SELLER_ACCOUNT_PRINCIPAL_TYPE },
    JWT_CONFIG.jwtSecret,
    { issuer: JWT_CONFIG.jwtIssuer, audience: JWT_CONFIG.jwtSellerAudience, expiresIn: '1h' }
  );
}

function buyerToken(): string {
  return jwt.sign(
    { sub: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', role: 'BUYER' },
    JWT_CONFIG.jwtSecret,
    { issuer: JWT_CONFIG.jwtIssuer, audience: JWT_CONFIG.jwtBuyerAudience, expiresIn: '1h' }
  );
}

function attrsOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value);
  return (value || {}) as Record<string, unknown>;
}

const BASE_SQL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_name VARCHAR(150) NOT NULL,
  is_open BOOLEAN NOT NULL DEFAULT true,
  is_verified BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS seller_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone VARCHAR(15) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE IF NOT EXISTS store_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seller_account_id UUID NOT NULL REFERENCES seller_accounts(id),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  role VARCHAR(20) NOT NULL CHECK (role IN ('OWNER', 'STAFF')),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(40) NOT NULL DEFAULT 'ADMIN',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
);
`;

let pool: StrictPgPool;
let apiPort = 0;
let server: http.Server;

test('valid global product creation persists category and attributes', async () => {
  const res = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    headers: bearer(adminToken()),
    body: { name: 'Basmati Rice', brand: 'StreetMill', category: 'grocery', barcode: 'P21A-RICE-1', attributes: { unit: 'KG', vegetarian: true } }
  });
  assertEqual(res.statusCode, 201, 'create status');
  assertEqual(res.json?.product?.category, 'GROCERY', 'category stored uppercase');
  assertEqual(attrsOf(res.json?.product?.attributes).unit, 'KG', 'unit stored');
  const row = await pool.query(`SELECT category, attributes FROM catalogue_products WHERE barcode=$1`, ['P21A-RICE-1']);
  assertEqual(row.rows.length, 1, 'one product row');
  assertEqual(row.rows[0].category, 'GROCERY', 'db category');
});

test('invalid global product attributes are rejected and leave no row', async () => {
  const before = await pool.query(`SELECT count(*)::int AS c FROM catalogue_products`);
  const res = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    headers: bearer(adminToken()),
    body: { name: 'Bad Cola', category: 'BEVERAGES', barcode: 'P21A-BAD-COLA', attributes: { unit: 'PCS', flavour: 'Cola' } }
  });
  assertEqual(res.statusCode, 400, 'invalid attributes status');
  assertEqual(res.json?.code, 'INVALID_CATALOGUE_ATTRIBUTES', 'error code');
  const after = await pool.query(`SELECT count(*)::int AS c FROM catalogue_products`);
  assertEqual(after.rows[0].c, before.rows[0].c, 'product count unchanged');
  const named = await pool.query(`SELECT id FROM catalogue_products WHERE barcode=$1 OR name=$2`, ['P21A-BAD-COLA', 'Bad Cola']);
  assertEqual(named.rows.length, 0, 'rejected product not inserted');
});

test('valid global variant creation and invalid variant leaves no row', async () => {
  const created = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    headers: bearer(adminToken()),
    body: { name: 'Mango Drink', category: 'BEVERAGES', attributes: { unit: 'ML', flavour: 'Mango' } }
  });
  assertEqual(created.statusCode, 201, 'parent created');
  const productId = created.json.product.id as string;
  const ok = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/admin/catalogue/products/${productId}/variants`,
    headers: bearer(adminToken()),
    body: { name: '300 ml', attributes: { unit: 'ML', flavour: 'Mango' } }
  });
  assertEqual(ok.statusCode, 201, 'valid variant');
  assertEqual(attrsOf(ok.json?.variant?.attributes).unit, 'ML', 'variant unit');
  const bad = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/admin/catalogue/products/${productId}/variants`,
    headers: bearer(adminToken()),
    body: { name: 'Piece Pack', category: 'GROCERY', attributes: { unit: 'PCS' } }
  });
  assertEqual(bad.statusCode, 400, 'invalid variant status');
  assertEqual(bad.json?.code, 'INVALID_CATALOGUE_ATTRIBUTES', 'invalid variant code');
  const rows = await pool.query(`SELECT name FROM catalogue_product_variants WHERE product_id=$1 ORDER BY name`, [productId]);
  assertEqual(rows.rows.length, 1, 'only the valid variant exists');
  assertEqual(rows.rows[0].name, '300 ml', 'invalid name was not inserted');
  const parent = await pool.query(`SELECT category, attributes FROM catalogue_products WHERE id=$1`, [productId]);
  assertEqual(parent.rows[0].category, 'BEVERAGES', 'variant category resolved from persisted parent');
  assertEqual(attrsOf(parent.rows[0].attributes).flavour, 'Mango', 'parent attributes unchanged');
});

test('global variant ignores client-supplied category and uses the persisted parent category', async () => {
  const created = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    headers: bearer(adminToken()),
    body: { name: 'Parent Grocery', category: 'GROCERY', attributes: { unit: 'KG' } }
  });
  assertEqual(created.statusCode, 201, 'grocery parent created');
  const productId = created.json.product.id as string;

  // KG is valid for the persisted GROCERY parent but invalid for the submitted BEVERAGES category.
  const ok = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/admin/catalogue/products/${productId}/variants`,
    headers: bearer(adminToken()),
    body: { name: 'Five KG', category: 'BEVERAGES', attributes: { unit: 'KG' } }
  });
  assertEqual(ok.statusCode, 201, 'persisted parent category wins over client category');
  assertEqual(attrsOf(ok.json?.variant?.attributes).unit, 'KG', 'variant attributes persisted');

  // ML/flavour is valid for the submitted BEVERAGES category but invalid for the persisted GROCERY parent.
  const bad = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/admin/catalogue/products/${productId}/variants`,
    headers: bearer(adminToken()),
    body: { name: 'Five Hundred ML', category: 'BEVERAGES', attributes: { unit: 'ML', flavour: 'Sweet' } }
  });
  assertEqual(bad.statusCode, 400, 'persisted parent category rejects client-category attributes');
  assertEqual(bad.json?.code, 'INVALID_CATALOGUE_ATTRIBUTES', 'persisted category error code');
  const rows = await pool.query(`SELECT name FROM catalogue_product_variants WHERE product_id=$1`, [productId]);
  assertEqual(rows.rows.length, 1, 'only the persisted-category-valid variant exists');
  assertEqual(rows.rows[0].name, 'Five KG', 'rejected variant left no row');
});

test('valid and invalid store-specific product creation', async () => {
  const ok = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Store Milk', category: 'DAIRY', attributes: { unit: 'L', vegetarian: true } }
  });
  assertEqual(ok.statusCode, 201, 'store product created');
  assertEqual(ok.json?.product?.category, 'DAIRY', 'store category');
  const before = await pool.query(`SELECT count(*)::int AS c FROM store_specific_products WHERE merchant_id=$1`, [STORE_1]);
  const bad = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Store Bad Milk', category: 'DAIRY', attributes: { unit: 'PCS' } }
  });
  assertEqual(bad.statusCode, 400, 'invalid store product');
  assertEqual(bad.json?.code, 'INVALID_CATALOGUE_ATTRIBUTES', 'store product error code');
  const after = await pool.query(`SELECT count(*)::int AS c FROM store_specific_products WHERE merchant_id=$1`, [STORE_1]);
  assertEqual(after.rows[0].c, before.rows[0].c, 'invalid store product left no row');
});

test('valid and invalid store-specific variant creation uses parent category', async () => {
  const parent = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Store Juice', category: 'BEVERAGES', attributes: { unit: 'ML' } }
  });
  assertEqual(parent.statusCode, 201, 'store parent');
  const productId = parent.json.product.id as string;
  const ok = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}/variants`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Can', attributes: { unit: 'ML', flavour: 'Lime' } }
  });
  assertEqual(ok.statusCode, 201, 'store variant created');
  const bad = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}/variants`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Loose Piece', category: 'GROCERY', attributes: { unit: 'PCS', vegetarian: true } }
  });
  assertEqual(bad.statusCode, 400, 'store variant rejected');
  assertEqual(bad.json?.code, 'INVALID_CATALOGUE_ATTRIBUTES', 'store variant code');
  const rows = await pool.query(`SELECT name, attributes FROM store_specific_product_variants WHERE store_product_id=$1`, [productId]);
  assertEqual(rows.rows.length, 1, 'invalid store variant left no row');
  assertEqual(rows.rows[0].name, 'Can', 'only valid variant remains');
  const storedParent = await pool.query(`SELECT category, attributes FROM store_specific_products WHERE id=$1`, [productId]);
  assertEqual(storedParent.rows[0].category, 'BEVERAGES', 'parent category unchanged');
  assertEqual(Object.keys(attrsOf(storedParent.rows[0].attributes)).includes('unit') && attrsOf(storedParent.rows[0].attributes).unit, 'ML', 'parent unit unchanged');
});

test('store-specific variant ignores client-supplied category and uses the persisted parent category', async () => {
  const parent = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Parent Store Beverage', category: 'BEVERAGES', attributes: { unit: 'ML' } }
  });
  assertEqual(parent.statusCode, 201, 'beverage parent created');
  const productId = parent.json.product.id as string;

  // L is valid for the persisted BEVERAGES parent but invalid for the submitted GROCERY category.
  const ok = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}/variants`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'One Litre', category: 'GROCERY', attributes: { unit: 'L' } }
  });
  assertEqual(ok.statusCode, 201, 'persisted store parent category wins over client category');
  assertEqual(attrsOf(ok.json?.variant?.attributes).unit, 'L', 'store variant attributes persisted');

  // PCS is valid for the submitted GROCERY category but invalid for the persisted BEVERAGES parent.
  const bad = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}/variants`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Loose Piece', category: 'GROCERY', attributes: { unit: 'PCS' } }
  });
  assertEqual(bad.statusCode, 400, 'persisted store parent category rejects client-category attributes');
  assertEqual(bad.json?.code, 'INVALID_CATALOGUE_ATTRIBUTES', 'store persisted category error code');
  const rows = await pool.query(`SELECT name FROM store_specific_product_variants WHERE store_product_id=$1`, [productId]);
  assertEqual(rows.rows.length, 1, 'only the persisted-category-valid store variant exists');
  assertEqual(rows.rows[0].name, 'One Litre', 'rejected store variant left no row');
});

test('admin variant PATCH keeps omitted persisted attributes and rolls back invalid patches', async () => {
  const created = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    headers: bearer(adminToken()),
    body: { name: 'Patch Soda', category: 'BEVERAGES', attributes: { unit: 'L', flavour: 'Cola' } }
  });
  const productId = created.json.product.id as string;
  const variant = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/admin/catalogue/products/${productId}/variants`,
    headers: bearer(adminToken()),
    body: { name: 'Bottle', attributes: { unit: 'L', flavour: 'Cola' } }
  });
  const variantId = variant.json.variant.id as string;
  const patched = await httpRequest({
    port: apiPort,
    method: 'PATCH',
    path: `/api/v1/admin/catalogue/products/${productId}/variants/${variantId}`,
    headers: bearer(adminToken()),
    body: { attributes: { flavour: 'Lime' } }
  });
  assertEqual(patched.statusCode, 200, 'partial patch');
  assertEqual(attrsOf(patched.json?.variant?.attributes).unit, 'L', 'omitted unit preserved');
  assertEqual(attrsOf(patched.json?.variant?.attributes).flavour, 'Lime', 'flavour updated');
  const bad = await httpRequest({
    port: apiPort,
    method: 'PATCH',
    path: `/api/v1/admin/catalogue/products/${productId}/variants/${variantId}`,
    headers: bearer(adminToken()),
    body: { name: 'Broken Bottle', attributes: { unit: 'KG' } }
  });
  assertEqual(bad.statusCode, 400, 'invalid patch');
  assertEqual(bad.json?.code, 'INVALID_CATALOGUE_ATTRIBUTES', 'invalid patch code');
  const row = await pool.query(`SELECT name, attributes FROM catalogue_product_variants WHERE id=$1`, [variantId]);
  assertEqual(row.rows[0].name, 'Bottle', 'invalid patch did not rename');
  assertEqual(attrsOf(row.rows[0].attributes).unit, 'L', 'invalid patch kept unit');
  assertEqual(attrsOf(row.rows[0].attributes).flavour, 'Lime', 'invalid patch kept flavour');
});

test('seller product and variant PATCH preserve omitted attributes and reject invalid updates', async () => {
  const created = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Patch Soap', category: 'PERSONAL_CARE', attributes: { unit: 'PCS', skinType: 'dry' } }
  });
  const productId = created.json.product.id as string;
  const patched = await httpRequest({
    port: apiPort,
    method: 'PATCH',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { attributes: { skinType: 'oily' } }
  });
  assertEqual(patched.statusCode, 200, 'product patch');
  assertEqual(attrsOf(patched.json?.product?.attributes).unit, 'PCS', 'omitted product unit preserved');
  assertEqual(attrsOf(patched.json?.product?.attributes).skinType, 'oily', 'skin type updated');
  const badProduct = await httpRequest({
    port: apiPort,
    method: 'PATCH',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Broken Soap', attributes: { unit: 'KG' } }
  });
  assertEqual(badProduct.statusCode, 400, 'invalid product patch');
  const productRow = await pool.query(`SELECT name, attributes FROM store_specific_products WHERE id=$1`, [productId]);
  assertEqual(productRow.rows[0].name, 'Patch Soap', 'invalid product patch did not rename');
  assertEqual(attrsOf(productRow.rows[0].attributes).skinType, 'oily', 'invalid product patch kept skin type');

  const variant = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}/variants`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Bar', attributes: { unit: 'PCS', skinType: 'oily' } }
  });
  const variantId = variant.json.variant.id as string;
  const variantPatch = await httpRequest({
    port: apiPort,
    method: 'PATCH',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}/variants/${variantId}`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { attributes: { skinType: 'sensitive' } }
  });
  assertEqual(variantPatch.statusCode, 200, 'variant patch');
  assertEqual(attrsOf(variantPatch.json?.variant?.attributes).unit, 'PCS', 'omitted variant unit preserved');
  const badVariant = await httpRequest({
    port: apiPort,
    method: 'PATCH',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${productId}/variants/${variantId}`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Broken Bar', attributes: { unit: 'KG' } }
  });
  assertEqual(badVariant.statusCode, 400, 'invalid variant patch');
  const variantRow = await pool.query(`SELECT name, attributes FROM store_specific_product_variants WHERE id=$1`, [variantId]);
  assertEqual(variantRow.rows[0].name, 'Bar', 'invalid variant patch did not rename');
  assertEqual(attrsOf(variantRow.rows[0].attributes).unit, 'PCS', 'invalid variant patch kept unit');
  assertEqual(attrsOf(variantRow.rows[0].attributes).skinType, 'sensitive', 'invalid variant patch kept skin type');
});

test('unauthorized and cross-store catalogue writes stay rejected', async () => {
  const beforeProducts = await pool.query(`SELECT count(*)::int AS c FROM catalogue_products`);
  const beforeStore = await pool.query(`SELECT count(*)::int AS c FROM store_specific_products`);
  const noToken = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    body: { name: 'Ghost', category: 'GROCERY', attributes: { unit: 'PCS' } }
  });
  assertEqual(noToken.statusCode, 401, 'admin route requires a token');
  const sellerOnAdmin = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Seller Ghost', category: 'GROCERY', attributes: { unit: 'PCS' } }
  });
  assertEqual(sellerOnAdmin.statusCode, 401, 'seller token cannot curate the global catalogue');
  const buyerOnStore = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products`,
    headers: bearer(buyerToken()),
    body: { name: 'Buyer Ghost', category: 'GROCERY', attributes: { unit: 'PCS' } }
  });
  assertEqual(buyerOnStore.statusCode, 403, 'buyer token rejected');
  const crossStore = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_2}/catalogue/products`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Cross Store Ghost', category: 'GROCERY', attributes: { unit: 'PCS' } }
  });
  assertEqual(crossStore.statusCode, 403, 'cross-store create rejected');
  assertEqual(crossStore.json?.code, 'STORE_ACCESS_DENIED', 'cross-store code');

  const foreign = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_2}/catalogue/products`,
    headers: bearer(sellerToken(SELLER_2)),
    body: { name: 'Store Two Rice', category: 'GROCERY', attributes: { unit: 'KG' } }
  });
  assertEqual(foreign.statusCode, 201, 'store two owner can create');
  const crossVariant = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: `/api/v1/seller/stores/${STORE_1}/catalogue/products/${foreign.json.product.id}/variants`,
    headers: bearer(sellerToken(SELLER_1)),
    body: { name: 'Stolen Variant', attributes: { unit: 'KG' } }
  });
  assertEqual(crossVariant.statusCode, 404, 'variant parent must belong to the authenticated store');
  const stolen = await pool.query(`SELECT id FROM store_specific_product_variants WHERE name=$1`, ['Stolen Variant']);
  assertEqual(stolen.rows.length, 0, 'cross-store variant was not inserted');
  const afterProducts = await pool.query(`SELECT count(*)::int AS c FROM catalogue_products`);
  const ghosts = await pool.query(`SELECT id FROM store_specific_products WHERE name IN ('Buyer Ghost','Cross Store Ghost')`);
  assertEqual(afterProducts.rows[0].c, beforeProducts.rows[0].c, 'rejected global creates left no product');
  assertEqual(ghosts.rows.length, 0, 'rejected store creates left no product');
  const afterStore = await pool.query(`SELECT count(*)::int AS c FROM store_specific_products`);
  assert(afterStore.rows[0].c === beforeStore.rows[0].c + 1, 'only the authorized store-two product was inserted');
});

test('unknown category and duplicate barcode keep their existing contracts', async () => {
  const unknown = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    headers: bearer(adminToken()),
    body: { name: 'Laptop', category: 'ELECTRONICS', attributes: { unit: 'PCS' } }
  });
  assertEqual(unknown.statusCode, 400, 'unknown category');
  assertEqual(unknown.json?.code, 'INVALID_CATALOGUE_PRODUCT', 'category contract');
  const dup = await httpRequest({
    port: apiPort,
    method: 'POST',
    path: '/api/v1/admin/catalogue/products',
    headers: bearer(adminToken()),
    body: { name: 'Basmati Rice Copy', category: 'GROCERY', barcode: 'P21A-RICE-1', attributes: { unit: 'KG' } }
  });
  assertEqual(dup.statusCode, 409, 'duplicate barcode');
  assertEqual(dup.json?.code, 'DUPLICATE_BARCODE', 'duplicate contract');
});

async function boot(): Promise<{ container: string; pool: StrictPgPool; server: http.Server }> {
  const port = await getFreePort();
  const container = `sv-p21a-catalogue-${process.pid}`;
  await runDocker([
    'run', '-d', '--name', container,
    '-p', `127.0.0.1:${port}:5432`,
    '-e', 'POSTGRES_USER=postgres',
    '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e', `POSTGRES_DB=${DB_NAME}`,
    'postgres:16-alpine'
  ]);
  let db: StrictPgPool | undefined;
  let httpServer: http.Server | undefined;
  try {
    await waitForUntil(async () => {
      await runDocker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', DB_NAME]);
      return true;
    }, 40000, 400, 'Disposable PostgreSQL ready timeout');

    db = createStrictPgPool(`postgresql://postgres:${PG_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`, 'merchant');
    await waitForUntil(async () => (await db!.query('SELECT 1')).rows.length === 1, 20000, 300, 'pool connect');
    await db.query(BASE_SQL);
    await applyGroceryCatalogueMigration(db);
    await db.query(
      `INSERT INTO merchants (id, business_name) VALUES ($1, 'Store One'), ($2, 'Store Two')`,
      [STORE_1, STORE_2]
    );
    await db.query(
      `INSERT INTO seller_accounts (id, phone, email, status) VALUES
        ($1, '+919800000001', 'seller1@streetverse.test', 'ACTIVE'),
        ($2, '+919800000002', 'seller2@streetverse.test', 'ACTIVE')`,
      [SELLER_1, SELLER_2]
    );
    await db.query(
      `INSERT INTO store_memberships (seller_account_id, merchant_id, role, status) VALUES
        ($1, $2, 'OWNER', 'ACTIVE'),
        ($3, $4, 'OWNER', 'ACTIVE')`,
      [SELLER_1, STORE_1, SELLER_2, STORE_2]
    );
    await db.query(
      `INSERT INTO admin_accounts (id, email, full_name, password_hash, role, status)
       VALUES ($1, 'catalogue.admin@streetverse.test', 'Catalogue Admin', 'not-a-login-hash', 'ADMIN', 'ACTIVE')`,
      [ADMIN_ID]
    );

    const app = express();
    app.use(express.json());
    app.use('/api/v1', createCatalogueRouter(db, JWT_CONFIG));
    httpServer = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    apiPort = (httpServer.address() as AddressInfo).port;
    pool = db;
    server = httpServer;
    return { container, pool: db, server: httpServer };
  } catch (err) {
    if (httpServer) {
      const startedServer = httpServer;
      await new Promise<void>((resolve) => startedServer.close(() => resolve()));
    }
    if (db) await db.end().catch(() => undefined);
    await runDocker(['rm', '-f', container]).catch(() => undefined);
    throw err;
  }
}

async function main() {
  let container = '';
  let failed = 0;
  let skipped = 0;
  try {
    const started = await boot();
    container = started.container;
    for (const t of TESTS) {
      try {
        await t.fn();
        console.log(`PASS: ${t.name}`);
      } catch (err: unknown) {
        failed++;
        console.error(`FAIL: ${t.name}`);
        console.error(err instanceof Error ? err.stack || err.message : String(err));
      }
    }
  } catch (err: unknown) {
    skipped = TESTS.length;
    failed = 1;
    console.error('SETUP FAILED: disposable PostgreSQL did not start');
    console.error(err instanceof Error ? err.stack || err.message : String(err));
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pool) await pool.end().catch(() => undefined);
    if (container) {
      await runDocker(['rm', '-f', container]).catch((err) => {
        console.error(`Cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
  const passed = skipped > 0 ? 0 : TESTS.length - failed;
  console.log(`\nCatalogue live summary: ${passed} passed, ${failed} failed, ${skipped} skipped (${TESTS.length} total)`);
  if (failed > 0 || skipped > 0) process.exit(1);
}

main();
