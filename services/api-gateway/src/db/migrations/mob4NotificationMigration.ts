import fs from 'fs';
import path from 'path';
import { StrictPgPool, StrictPgClient, withPgTransaction } from '../postgres';

export const MOB4_MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '..', '..', '..', '..', '..',
  'packages', 'database-schemas', 'merchant-db', 'migrations',
  '006_mo_b4_reliable_notifications_and_audit.sql'
);

export function loadMob4MigrationSql(): string {
  return fs.readFileSync(MOB4_MIGRATION_SQL_PATH, 'utf8');
}

export interface Mob4MigrationResult {
  applied: boolean;
  outboxCount: number;
  inAppNotificationCount: number;
}

/**
 * Applies MO-B4 migration (`006_mo_b4_reliable_notifications_and_audit.sql`)
 * atomically inside Merchant DB. Idempotent and preserves existing data.
 */
export async function applyMob4Migration(
  merchantPool: StrictPgPool,
  options: { migrationSql?: string } = {}
): Promise<Mob4MigrationResult> {
  const migrationSql = options.migrationSql ?? loadMob4MigrationSql();

  return withPgTransaction(merchantPool, async (client: StrictPgClient) => {
    await client.query(migrationSql);
    const outboxRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM owner_notification_events`);
    const inboxRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM owner_notifications`);
    return {
      applied: true,
      outboxCount: Number(outboxRes.rows[0]?.cnt ?? 0),
      inAppNotificationCount: Number(inboxRes.rows[0]?.cnt ?? 0)
    };
  });
}
