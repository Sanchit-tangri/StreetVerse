import pg from 'pg';

const customerPool = new pg.Pool({
  connectionString: process.env.CUSTOMER_DB_URL || 'postgresql://postgres:postgres@localhost:5433/streetverse_customer_db'
});

async function clean() {
  console.log('Cleaning non-seed customer accounts...');
  const res = await customerPool.query("DELETE FROM users WHERE email != 'rahul.d@example.com'");
  console.log(`✓ Deleted ${res.rowCount} test accounts from Customer DB. Ready for fresh registration!`);
  await customerPool.end();
}

clean().catch(err => {
  console.error(err);
  process.exit(1);
});
