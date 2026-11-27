/**
 * Phase 2.1A unit tests: grocery catalogue attribute rules.
 * No database; the route handlers are covered by the live PostgreSQL suite.
 */

import { validateCatalogueAttributes } from '../../services/api-gateway/src/services/catalogueValidation';

type TestFn = () => void | Promise<void>;
const TESTS: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  TESTS.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

test('GROCERY accepts required unit and optional vegetarian flag', () => {
  const result = validateCatalogueAttributes('GROCERY', { unit: 'KG', vegetarian: true });
  assert(result.ok, 'expected valid grocery attributes');
  if (result.ok) {
    assert(result.value.unit === 'KG', 'unit preserved');
    assert(result.value.vegetarian === true, 'vegetarian preserved');
  }
});

test('missing required unit is rejected', () => {
  const result = validateCatalogueAttributes('SNACKS', { vegetarian: false });
  assert(!result.ok, 'missing unit must fail');
  if (!result.ok) assert(result.error.includes('unit'), result.error);
});

test('unsupported attribute and category are rejected', () => {
  const extra = validateCatalogueAttributes('PANTRY', { unit: 'G', colour: 'red' });
  assert(!extra.ok && extra.error.includes('colour'), 'unknown key rejected');
  const category = validateCatalogueAttributes('ELECTRONICS', { unit: 'PCS' });
  assert(!category.ok, 'unknown category rejected');
});

test('category rules are distinct: BEVERAGES rejects PCS, HOUSEHOLD checks packSize', () => {
  const beverages = validateCatalogueAttributes('BEVERAGES', { unit: 'PCS', flavour: 'Mango' });
  assert(!beverages.ok, 'PCS is not a beverage unit');
  const household = validateCatalogueAttributes('HOUSEHOLD', { unit: 'PCS', packSize: 6 });
  assert(household.ok, 'numeric packSize accepted');
  const badPack = validateCatalogueAttributes('HOUSEHOLD', { unit: 'ML', packSize: 'six' });
  assert(!badPack.ok, 'string packSize rejected');
});

test('attributes must be a plain object', () => {
  for (const value of [null, [], 'KG', 1]) {
    const result = validateCatalogueAttributes('DAIRY', value);
    assert(!result.ok, `rejected non-object ${JSON.stringify(value)}`);
  }
});

test('PERSONAL_CARE and FRESH_PRODUCE accept their optional fields', () => {
  const care = validateCatalogueAttributes('PERSONAL_CARE', { unit: 'ML', skinType: 'dry' });
  const produce = validateCatalogueAttributes('FRESH_PRODUCE', { unit: 'PCS', organic: false });
  assert(care.ok && produce.ok, 'optional category fields accepted');
});

async function run() {
  let failed = 0;
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
  const skipped = 0;
  console.log(`\nCatalogue unit summary: ${TESTS.length - failed} passed, ${failed} failed, ${skipped} skipped (${TESTS.length} total)`);
  if (failed > 0) process.exit(1);
}

run();
