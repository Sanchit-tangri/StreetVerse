import fs from 'fs';
import path from 'path';
import { StrictPgPool, StrictPgClient, withPgTransaction } from '../postgres';

export const MOB3_MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '..', '..', '..', '..', '..',
  'packages', 'database-schemas', 'merchant-db', 'migrations',
  '005_mo_b3_store_compliance_enforcement.sql'
);

export function loadMob3MigrationSql(): string {
  return fs.readFileSync(MOB3_MIGRATION_SQL_PATH, 'utf8');
}

export interface Mob3MigrationResult {
  applied: boolean;
  warningsCount: number;
}

/**
 * Applies MO-B3 migration (`005_mo_b3_store_compliance_enforcement.sql`)
 * atomically inside Merchant DB. Idempotent and preserves existing data.
 */
export async function applyMob3Migration(
  merchantPool: StrictPgPool,
  options: { migrationSql?: string } = {}
): Promise<Mob3MigrationResult> {
  const migrationSql = options.migrationSql ?? loadMob3MigrationSql();

  return withPgTransaction(merchantPool, async (client: StrictPgClient) => {
    await client.query(migrationSql);
    const countRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM store_compliance_warnings`);
    return {
      applied: true,
      warningsCount: Number(countRes.rows[0]?.cnt ?? 0)
    };
  });
}
