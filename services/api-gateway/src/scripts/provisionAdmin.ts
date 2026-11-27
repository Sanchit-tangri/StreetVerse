import dotenv from 'dotenv';
import { createStrictPgPool } from '../db/postgres';
import { applyMob1Migration } from '../db/migrations/mob1AdminMigration';
import { applyGroceryCatalogueMigration } from '../db/migrations/groceryCatalogueMigration';
import { provisionAdminAccount, validateAdminPasswordStrength } from '../services/adminAuth';

dotenv.config();

const PLACEHOLDER_EMAILS = new Set(['admin@example.com', 'your_admin_email_here']);

async function main(): Promise<void> {
  const merchantDbUrl = process.env.MERCHANT_DB_URL?.trim();
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase() ?? '';
  const fullName = process.env.ADMIN_BOOTSTRAP_NAME?.trim() ?? '';
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? '';

  if (!merchantDbUrl) {
    throw new Error('MERCHANT_DB_URL must be configured before provisioning an Admin account.');
  }

  if (!email || PLACEHOLDER_EMAILS.has(email) || email.includes('example.com')) {
    throw new Error(
      'ADMIN_BOOTSTRAP_EMAIL must be set to a real non-placeholder administrative email address.'
    );
  }

  if (!fullName || fullName.toLowerCase().startsWith('replace_with_') || fullName.toLowerCase().startsWith('your_')) {
    throw new Error('ADMIN_BOOTSTRAP_NAME must be configured.');
  }

  const pwCheck = validateAdminPasswordStrength(password);
  if (!pwCheck.ok) {
    throw new Error(`ADMIN_BOOTSTRAP_PASSWORD rejected: ${pwCheck.error}`);
  }

  const pool = createStrictPgPool(merchantDbUrl, 'merchant');

  try {
    await applyMob1Migration(pool);
    await applyGroceryCatalogueMigration(pool);
    const result = await provisionAdminAccount(pool, {
      email,
      fullName,
      password: pwCheck.value
    });

    if (!result.ok) {
      throw new Error(`Provisioning failed (${result.code}): ${result.error}`);
    }

    console.log(
      JSON.stringify({
        success: true,
        admin: {
          id: result.data.id,
          email: result.data.email,
          fullName: result.data.fullName,
          role: result.data.role,
          status: result.data.status
        }
      })
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'Unknown admin provisioning error.';
  console.error(`[Admin Provision CLI Error]: ${msg}`);
  process.exit(1);
});
