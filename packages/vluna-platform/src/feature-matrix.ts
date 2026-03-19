export type EditionId = 'community' | 'enterprise' | 'cloud'

export type FeatureFlag = 'reports' | 'iam' | 'oidc'

export interface EditionProfile {
  id: EditionId
  label: string
  description: string
  features: FeatureFlag[]
}

const base: EditionProfile = {
  id: 'community',
  label: 'Community',
  description: 'Open-source self-hosted build with billing + gate core',
  features: [],
}

const enterprise: EditionProfile = {
  id: 'enterprise',
  label: 'Enterprise',
  description: 'Adds realm-level reports and ops endpoints',
  features: ['reports'],
}

const cloud: EditionProfile = {
  id: 'cloud',
  label: 'Cloud',
  description: 'Hosted control plane with IAM/OIDC surface',
  features: ['iam', 'oidc', 'reports'],
}

export const FEATURE_MATRIX: Record<EditionId, EditionProfile> = {
  community: base,
  enterprise,
  cloud,
}

export const getEditionProfile = (id: EditionId): EditionProfile => FEATURE_MATRIX[id]

export const editionHasFeature = (id: EditionId, feature: FeatureFlag): boolean => {
  const profile = FEATURE_MATRIX[id]
  return profile?.features.includes(feature) ?? false
}
