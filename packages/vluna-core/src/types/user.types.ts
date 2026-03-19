

/**
 * Python class `Address`
 */
export interface Address {
  formatted?: string;
  streetAddress?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Python class `Profile`
 */
export interface Profile {
  familyName?: string;
  givenName?: string;
  middleName?: string;
  nickname?: string;
  preferredUsername?: string;
  profile?: string;
  website?: string;
  gender?: string;
  birthdate?: string;
  zoneinfo?: string;
  locale?: string;
  address?: Address;
}

/**
 * Python class `IdentityRecord`
 */
export interface IdentityRecord {
  userId: string;
  details?: Record<string, unknown>;
}

/**
 * Python class `SsoIdentity`
 */
export interface SsoIdentity {
  tenantId: string;
  id: string;
  userId: string;
  issuer: string;
  identityId: string;
  detail: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
ssoConnectorId: string;
}

/**
 * Python class `ManagementUser`
 */
export interface ManagementUser {
  id: string;
  username?: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  name?: string | null;
  avatar?: string | null;
  customData: Record<string, unknown>;
  identities: Record<string, IdentityRecord>;
  lastSignInAt?: number | null;
  createdAt: number;
  updatedAt: number;
  profile: Profile;
  applicationId?: string | null;
  isSuspended: boolean;
  hasPassword?: boolean;
  ssoIdentities?: SsoIdentity[];
  organizationData?: Record<string, unknown>[];
  organizations?: string[];
}
