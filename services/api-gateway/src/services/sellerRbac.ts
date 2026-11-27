import { StrictPgPool } from '../db/postgres';

export type SellerAccountStatus = 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
export type StoreMembershipRole = 'OWNER' | 'STAFF';
export type StoreMembershipStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'REVOKED';

export type SellerPermission =
  | 'INVENTORY_READ'
  | 'INVENTORY_WRITE'
  | 'PRICE_WRITE'
  | 'ORDER_MANAGE'
  | 'SLOT_MANAGE'
  | 'STAFF_MANAGE'
  | 'KYC_MANAGE'
  | 'FINANCIAL_REPORTS_READ'
  | 'STORE_SETTINGS_WRITE';

const STAFF_PERMISSIONS: readonly SellerPermission[] = [
  'INVENTORY_READ',
  'INVENTORY_WRITE',
  'PRICE_WRITE',
  'ORDER_MANAGE',
  'SLOT_MANAGE'
];

const OWNER_PERMISSIONS: readonly SellerPermission[] = [
  ...STAFF_PERMISSIONS,
  'STAFF_MANAGE',
  'KYC_MANAGE',
  'FINANCIAL_REPORTS_READ',
  'STORE_SETTINGS_WRITE'
];

const ROLE_PERMISSION_SET: Record<StoreMembershipRole, ReadonlySet<SellerPermission>> = {
  OWNER: new Set(OWNER_PERMISSIONS),
  STAFF: new Set(STAFF_PERMISSIONS)
};

export const STORE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoreAccessContext {
  sellerAccountId: string;
  storeId: string;
  businessName: string;
  role: StoreMembershipRole;
  permissions: SellerPermission[];
}

export interface SellerStoreMembershipSummary {
  membershipId: string;
  storeId: string;
  role: StoreMembershipRole;
  status: StoreMembershipStatus;
  permissions: SellerPermission[];
  store: {
    id: string;
    businessName: string;
    category: string;
    upiVpa: string;
    address: string;
    pincode: string;
    isOpen: boolean;
  };
}

export interface SellerAccountSummary {
  id: string;
  phone: string;
  email: string;
  isEmailVerified: boolean;
  status: SellerAccountStatus;
  createdAt?: string | Date;
}

export type StorePermissionCheckResult =
  | { ok: true; access: StoreAccessContext }
  | { ok: false; status: 400 | 401 | 403 | 404; code: string; error: string };

export type SellerProfileLookupResult =
  | {
      ok: true;
      sellerAccount: SellerAccountSummary;
      memberships: SellerStoreMembershipSummary[];
    }
  | { ok: false; status: 401 | 403 | 404; code: string; error: string };

export function isValidStoreMembershipRole(role: unknown): role is StoreMembershipRole {
  return role === 'OWNER' || role === 'STAFF';
}

export function getPermissionsForRole(role: StoreMembershipRole): SellerPermission[] {
  return role === 'OWNER' ? [...OWNER_PERMISSIONS] : [...STAFF_PERMISSIONS];
}

export function hasStorePermission(role: StoreMembershipRole, permission: SellerPermission): boolean {
  return ROLE_PERMISSION_SET[role]?.has(permission) ?? false;
}

/**
 * Retrieves an active Seller Account and its active store memberships from Merchant PostgreSQL.
 * Never derives permissions from client payloads or maps email verification to KYC approval.
 */
export async function listSellerAccountWithMemberships(
  merchantPool: Pick<StrictPgPool, 'query'>,
  sellerAccountId: string
): Promise<SellerProfileLookupResult> {
  const acctRes = await merchantPool.query(
    `SELECT id, phone, email, is_email_verified, status, created_at
     FROM seller_accounts
     WHERE id = $1`,
    [sellerAccountId]
  );

  if (acctRes.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      code: 'SELLER_ACCOUNT_NOT_FOUND',
      error: 'Seller account not found.'
    };
  }

  const acct = acctRes.rows[0];
  if (acct.status !== 'ACTIVE') {
    return {
      ok: false,
      status: 403,
      code: 'SELLER_ACCOUNT_INACTIVE',
      error: 'Seller account is not active.'
    };
  }

  const memRes = await merchantPool.query(
    `SELECT
       m.id AS store_id,
       m.business_name,
       m.category,
       m.upi_vpa,
       m.address,
       m.pincode,
       m.is_open,
       sm.id AS membership_id,
       sm.role AS membership_role,
       sm.status AS membership_status
     FROM store_memberships sm
     JOIN merchants m ON m.id = sm.merchant_id
     WHERE sm.seller_account_id = $1
       AND sm.status = 'ACTIVE'
     ORDER BY CASE WHEN sm.role = 'OWNER' THEN 0 ELSE 1 END, sm.created_at ASC, m.created_at ASC`,
    [sellerAccountId]
  );

  const memberships: SellerStoreMembershipSummary[] = [];
  for (const row of memRes.rows) {
    if (!isValidStoreMembershipRole(row.membership_role)) {
      continue;
    }
    memberships.push({
      membershipId: String(row.membership_id ?? `${sellerAccountId}:${row.store_id}`),
      storeId: String(row.store_id),
      role: row.membership_role,
      status: 'ACTIVE',
      permissions: getPermissionsForRole(row.membership_role),
      store: {
        id: String(row.store_id),
        businessName: String(row.business_name || ''),
        category: String(row.category || ''),
        upiVpa: String(row.upi_vpa || ''),
        address: String(row.address || ''),
        pincode: String(row.pincode || ''),
        isOpen: Boolean(row.is_open)
      }
    });
  }

  return {
    ok: true,
    sellerAccount: {
      id: String(acct.id),
      phone: String(acct.phone),
      email: String(acct.email),
      isEmailVerified: Boolean(acct.is_email_verified),
      status: acct.status as SellerAccountStatus,
      ...(acct.created_at !== undefined ? { createdAt: acct.created_at } : {})
    },
    memberships
  };
}

/**
 * Authoritatively verifies `Seller Account -> Store Membership -> Requested Store`
 * directly against Merchant PostgreSQL. Never trusts client-provided roles or locally stored store IDs.
 */
export async function verifySellerStorePermission(params: {
  merchantPool: Pick<StrictPgPool, 'query'>;
  sellerAccountId: string;
  storeId: string;
  requiredPermission?: SellerPermission;
  allowedRoles?: readonly StoreMembershipRole[];
}): Promise<StorePermissionCheckResult> {
  const normalizedStoreId = typeof params.storeId === 'string' ? params.storeId.trim() : '';
  if (!normalizedStoreId || !STORE_UUID_REGEX.test(normalizedStoreId)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_MERCHANT_ID',
      error: 'Invalid merchantId format. Expected a valid UUID.'
    };
  }

  const acctRes = await params.merchantPool.query(
    `SELECT id, status
     FROM seller_accounts
     WHERE id = $1`,
    [params.sellerAccountId]
  );

  if (acctRes.rows.length === 0) {
    return {
      ok: false,
      status: 401,
      code: 'SELLER_ACCOUNT_NOT_FOUND',
      error: 'Authenticated seller account was not found.'
    };
  }

  if (acctRes.rows[0].status !== 'ACTIVE') {
    return {
      ok: false,
      status: 403,
      code: 'SELLER_ACCOUNT_INACTIVE',
      error: 'Seller account is not active.'
    };
  }

  const accessRes = await params.merchantPool.query(
    `SELECT
       m.id AS store_id,
       m.business_name,
       sm.role AS membership_role,
       sm.status AS membership_status
     FROM merchants m
     LEFT JOIN store_memberships sm
       ON sm.merchant_id = m.id
      AND sm.seller_account_id = $1
     WHERE m.id = $2
     LIMIT 1`,
    [params.sellerAccountId, normalizedStoreId]
  );

  if (accessRes.rows.length === 0) {
    return {
      ok: false,
      status: 404,
      code: 'MERCHANT_NOT_FOUND',
      error: 'Merchant account not found.'
    };
  }

  const row = accessRes.rows[0];
  if (!row.membership_role) {
    return {
      ok: false,
      status: 403,
      code: 'STORE_ACCESS_DENIED',
      error: 'Seller account does not have membership for this store.'
    };
  }

  if (row.membership_status !== 'ACTIVE') {
    return {
      ok: false,
      status: 403,
      code: 'MEMBERSHIP_INACTIVE',
      error: 'Store membership is not active.'
    };
  }

  if (!isValidStoreMembershipRole(row.membership_role)) {
    return {
      ok: false,
      status: 403,
      code: 'INSUFFICIENT_STORE_PERMISSIONS',
      error: 'Invalid store membership role.'
    };
  }

  const role: StoreMembershipRole = row.membership_role;

  if (params.allowedRoles && !params.allowedRoles.includes(role)) {
    return {
      ok: false,
      status: 403,
      code: 'INSUFFICIENT_STORE_PERMISSIONS',
      error: 'Insufficient store permissions for this operation.'
    };
  }

  if (params.requiredPermission && !hasStorePermission(role, params.requiredPermission)) {
    return {
      ok: false,
      status: 403,
      code: 'INSUFFICIENT_STORE_PERMISSIONS',
      error: 'Insufficient store permissions for this operation.'
    };
  }

  return {
    ok: true,
    access: {
      sellerAccountId: params.sellerAccountId,
      storeId: String(row.store_id),
      businessName: String(row.business_name || ''),
      role,
      permissions: getPermissionsForRole(role)
    }
  };
}
