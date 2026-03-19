import type { UsageAttributionWriter } from '../../../types/usage-attribution.js'
export type { UsageAttributionInput, UsageAttributionEntitlement, UsageAttributionWriter } from '../../../types/usage-attribution.js'
export { USAGE_ATTRIBUTION_WRITER } from '../../../types/usage-attribution.js'

export class NoopUsageAttributionWriter implements UsageAttributionWriter {
  async write(): Promise<void> {}
}
