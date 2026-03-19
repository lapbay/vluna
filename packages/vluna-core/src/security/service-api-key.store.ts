import type { DerivedServiceApiKey } from './service-api-key.helpers.js'

let registry: Map<string, DerivedServiceApiKey> = new Map()

export function setServiceApiKeyRegistry(next: Map<string, DerivedServiceApiKey>): void {
  registry = new Map(next)
}

export function getServiceApiKeyRegistry(): ReadonlyMap<string, DerivedServiceApiKey> {
  return registry
}

export function getServiceApiKey(keyId: string): DerivedServiceApiKey | undefined {
  return registry.get(keyId)
}
