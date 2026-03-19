import { createHash } from 'node:crypto'

type InvoiceNumberInput = {
  billingPeriodId?: string | null
  provider?: string | null
  providerInvoiceId?: string | null
}

export function generateInvoiceNumber(input: InvoiceNumberInput): string {
  const periodId = input.billingPeriodId ? String(input.billingPeriodId).trim() : ''
  const provider = input.provider ? String(input.provider).trim() : ''
  const providerInvoiceId = input.providerInvoiceId ? String(input.providerInvoiceId).trim() : ''

  if (periodId && !providerInvoiceId) {
    return `INV-${periodId}`
  }

  const hashSource = `${provider}|${providerInvoiceId}|${periodId}`
  const hash = createHash('sha256').update(hashSource).digest('hex').slice(0, 10).toUpperCase()
  return periodId ? `INV-${periodId}-${hash}` : `INV-${hash}`
}
