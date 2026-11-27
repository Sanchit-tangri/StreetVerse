export const GROCERY_CATEGORIES = new Set(['GROCERY', 'BEVERAGES', 'SNACKS', 'PANTRY', 'DAIRY', 'FRESH_PRODUCE', 'HOUSEHOLD', 'PERSONAL_CARE']);

type Rule = { required?: boolean; type: 'string' | 'number' | 'boolean'; values?: readonly string[] };
const RULES: Record<string, Record<string, Rule>> = {
  GROCERY: { unit: { required: true, type: 'string', values: ['PCS', 'G', 'KG', 'ML', 'L'] }, vegetarian: { type: 'boolean' } },
  BEVERAGES: { unit: { required: true, type: 'string', values: ['ML', 'L'] }, flavour: { type: 'string' } },
  SNACKS: { unit: { required: true, type: 'string', values: ['PCS', 'G', 'KG'] }, vegetarian: { type: 'boolean' } },
  PANTRY: { unit: { required: true, type: 'string', values: ['G', 'KG', 'ML', 'L'] }, vegetarian: { type: 'boolean' } },
  DAIRY: { unit: { required: true, type: 'string', values: ['G', 'KG', 'ML', 'L'] }, vegetarian: { type: 'boolean' } },
  FRESH_PRODUCE: { unit: { required: true, type: 'string', values: ['PCS', 'G', 'KG'] }, organic: { type: 'boolean' } },
  HOUSEHOLD: { unit: { required: true, type: 'string', values: ['PCS', 'ML', 'L'] }, packSize: { type: 'number' } },
  PERSONAL_CARE: { unit: { required: true, type: 'string', values: ['PCS', 'ML', 'L'] }, skinType: { type: 'string' } }
};

export function validateCatalogueAttributes(category: string, value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const rules = RULES[category];
  if (!rules) return { ok: false, error: 'Unsupported grocery category.' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Attributes must be an object.' };
  const attributes = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(attributes)) {
    const rule = rules[key];
    if (!rule) return { ok: false, error: `Unsupported attribute: ${key}.` };
    if (typeof raw !== rule.type || (rule.values && !rule.values.includes(String(raw).toUpperCase()))) return { ok: false, error: `Invalid attribute: ${key}.` };
  }
  for (const [key, rule] of Object.entries(rules)) if (rule.required && attributes[key] === undefined) return { ok: false, error: `Missing required attribute: ${key}.` };
  return { ok: true, value: attributes };
}
