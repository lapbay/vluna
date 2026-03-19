export type TestEdition = 'community' | 'enterprise'

export const getTestEdition = (): TestEdition =>
  process.env.VLUNA_EDITION === 'enterprise' ? 'enterprise' : 'community'

export const isEnterpriseEdition = (): boolean => getTestEdition() === 'enterprise'

export const ensureEnterprise = (): void => {
  if (!isEnterpriseEdition()) {
    throw new Error('This test requires VLUNA_EDITION=enterprise')
  }
}
