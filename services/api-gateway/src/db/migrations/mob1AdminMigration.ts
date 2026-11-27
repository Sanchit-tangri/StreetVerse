import fs from 'fs';
import path from 'path';
import { StrictPgPool, StrictPgClient, withPgTransaction } from '../postgres';

export const MOB1_MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '..', '..', '..', '..', '..',
  'packages', 'database-schemas', 'merchant-db', 'migrations',
  '003_mo_b1_admin_accounts.sql'
);

export function loadMob1MigrationSql(): string {
  return fs.readFileSync(MOB1_MIGRATION_SQL_PATH, 'utf8');
}

export interface Mob1MigrationResult {
  applied: boolean;
  adminAccountsCount: number;
}

/**
 * Applies MO-B1 migration (`003_mo_b1_admin_accounts.sql`) atomically inside a
 * Merchant DB transaction. Idempotent and preserves all existing onboarding data.
 */
export async function applyMob1Migration(
  merchantPool: StrictPgPool,
  options: { migrationSql?: string } = {}
): Promise<Mob1MigrationResult> {
  const migrationSql = options.migrationSql ?? loadMob1MigrationSql();

  return withPgTransaction(merchantPool, async (client: StrictPgClient) => {
    await client.query(migrationSql);
    const countRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM admin_accounts`);
    return {
      applied: true,
      adminAccountsCount: Number(countRes.rows[0]?.cnt ?? 0)
    };
  });
}
