/**
 * StreetVerse Unified Test Runner
 * Executes Unit Tests, Whitebox Tests, and Blackbox Tests across the monorepo.
 */
import { runUnitTests } from './auth/unit-tests.test';
import { runWhiteboxTests } from './auth/whitebox-tests.test';
import { runBlackboxTests } from './auth/blackbox-tests.test';

async function main() {
  console.log('\n================================================================');
  console.log('   StreetVerse Automated Test Suite Execution');
  console.log('   Scope: Unit, Whitebox, and Blackbox Security Audits');
  console.log('================================================================\n');

  const startTime = Date.now();

  console.log('▶ [1/3] Running Unit Tests...');
  const unitResults = await runUnitTests();

  console.log('▶ [2/3] Running Whitebox Tests...');
  const whiteboxResults = await runWhiteboxTests();

  console.log('▶ [3/3] Running Blackbox Tests (SQL Injection & Boundary Contracts)...');
  const blackboxResults = await runBlackboxTests();

  const allResults = [...unitResults, ...whiteboxResults, ...blackboxResults];

  console.log('\n----------------------------------------------------------------');
  console.log('Test Execution Results:');
  console.log('----------------------------------------------------------------');

  let passedCount = 0;
  let failedCount = 0;

  for (const res of allResults) {
    if (res.passed) {
      console.log(`  ✓ [PASS] ${res.name}`);
      passedCount++;
    } else {
      console.log(`  ✗ [FAIL] ${res.name}`);
      if (res.error) console.log(`      Error: ${res.error}`);
      failedCount++;
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('================================================================');
  console.log(`Summary: ${passedCount} passed, ${failedCount} failed (${duration}s)`);
  console.log('================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
