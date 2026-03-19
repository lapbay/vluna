// Canonical scopes for Billing v1 (minimal set; extensible later)
export const BILLING_SCOPES = {
  READ_ALL: 'billing:read',   // project owner/admin: read all billing data in realm/account
  WRITE: 'billing:write',     // service/backend: write/report usage, consume credits
  // Regular members have no billing scope (implicitly none)
} as const

export type BillingScope = typeof BILLING_SCOPES[keyof typeof BILLING_SCOPES]

// Canonical scopes for IAM (Organizations/Memberships/RBAC)
export const IAM_SCOPES = {
  READ_ALL: 'iam:read',
  WRITE: 'iam:write',
} as const

export type IamScope = typeof IAM_SCOPES[keyof typeof IAM_SCOPES]
