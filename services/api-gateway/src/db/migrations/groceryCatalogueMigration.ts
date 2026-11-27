import fs from 'fs';
import path from 'path';
import { StrictPgPool, withPgTransaction } from '../postgres';

const migrationPath = path.resolve(
  process.cwd(), 'packages', 'database-schemas', 'merchant-db', 'migrations', '007_grocery_catalogue.sql'
);

export function loadGroceryCatalogueMigrationSql(): string {
  return fs.readFileSync(migrationPath, 'utf8');
}

/** Applies the idempotent Phase 2.1 DDL only after the merchant identity tables exist. */
export async function applyGroceryCatalogueMigration(
  pool: StrictPgPool,
  options: { migrationSql?: string } = {}
): Promise<{ applied: true }> {
  const sql = options.migrationSql ?? loadGroceryCatalogueMigrationSql();
  await withPgTransaction(pool, async (client) => {
    const prerequisites = await client.query(
      `SELECT to_regclass('public.merchants') AS merchants,
              to_regclass('public.seller_accounts') AS seller_accounts,
              to_regclass('public.admin_accounts') AS admin_accounts`
    );
    const row = prerequisites.rows[0] || {};
    if (!row.merchants || !row.seller_accounts || !row.admin_accounts) {
      throw new Error('Catalogue migration requires merchants, seller_accounts, and admin_accounts.');
    }
    await client.query(sql);
  });
  return { applied: true };
}
