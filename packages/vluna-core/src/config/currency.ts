const DEFAULT_WALLET_LEDGER_CURRENCY = 'XUSD'

function resolveLedgerCurrency(): string {
  const raw = process.env.WALLET_LEDGER_CURRENCY
  const normalized = raw ? raw.trim() : ''
  return normalized || DEFAULT_WALLET_LEDGER_CURRENCY
}

export const WALLET_LEDGER_CURRENCY = resolveLedgerCurrency()
export { DEFAULT_WALLET_LEDGER_CURRENCY }

export function getLedgerCurrency(): string {
  return WALLET_LEDGER_CURRENCY
}
