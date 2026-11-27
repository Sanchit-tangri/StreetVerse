import fs from 'fs';
import path from 'path';
import { StrictPgPool, StrictPgClient, withPgTransaction } from '../postgres';

export const MOB2_MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '..', '..', '..', '..', '..',
  'packages', 'database-schemas', 'merchant-db', 'migrations',
  '004_mo_b2_admin_review_and_notifications.sql'
);

export function loadMob2MigrationSql(): string {
  return fs.readFileSync(MOB2_MIGRATION_SQL_PATH, 'utf8');
}

export interface Mob2MigrationResult {
  applied: boolean;
  ownerNotificationEventsCount: number;
}

/**
 * Applies MO-B2 migration (`004_mo_b2_admin_review_and_notifications.sql`)
 * transactionally inside Merchant DB. Idempotent and non-destructive.
 */
export async function applyMob2Migration(
  merchantPool: StrictPgPool,
  options: { migrationSql?: string } = {}
): Promise<Mob2MigrationResult> {
  const migrationSql = options.migrationSql ?? loadMob2MigrationSql();

  return withPgTransaction(merchantPool, async (client: StrictPgClient) => {
    await client.query(migrationSql);
    const countRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM owner_notification_events`);
    return {
      applied: true,
      ownerNotificationEventsCount: Number(countRes.rows[0]?.cnt ?? 0)
    };
  });
}
