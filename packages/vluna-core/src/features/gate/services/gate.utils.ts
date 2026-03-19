import { HttpException } from '@nestjs/common'
import type { Kysely, Transaction } from 'kysely'
import crypto from 'node:crypto'
import type { Database } from '../../../types/database.js'

export const nowIso = () => new Date().toISOString()

export function parseMinor(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function throwNumericError(field: string, constraint: string): never {
  throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `${field} must be ${constraint}` }, 422)
}

export function parseOptionalNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = parseMinor(value)
  if (parsed === undefined) throwNumericError(field, 'a number or numeric string')
  const floored = Math.floor(parsed)
  if (floored < 0) throwNumericError(field, 'greater than or equal to 0')
  return floored
}

export function parsePositiveInt(value: unknown, field: string): number {
  const parsed = parseOptionalNonNegativeInt(value, field)
  if (parsed === undefined || parsed <= 0) throwNumericError(field, 'greater than 0')
  return parsed
}

export function parseOptionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = parsePositiveInt(value, field)
  return parsed
}

export function bigintFromUnknown(value: unknown): bigint | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return BigInt(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new HttpException({ code: 'SERVER.CONFIG', message: 'value exceeds numeric range' }, 500)
  }
  return Number(value)
}

export function hashRequest(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function createLeaseToken(leaseId: string): string {
  return `lease.${leaseId}.${crypto.randomBytes(8).toString('hex')}`
}

export function parseLeaseToken(token: string): string {
  if (!token.startsWith('lease.')) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid lease token format' }, 422)
  }
  const payload = token.slice('lease.'.length)
  const lastDotIndex = payload.lastIndexOf('.')
  if (lastDotIndex <= 0 || lastDotIndex >= payload.length - 1) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'invalid lease token format' }, 422)
  }
  const leaseId = payload.slice(0, lastDotIndex).trim()
  if (!leaseId) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'lease token missing lease id' }, 422)
  }
  return leaseId
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function buildErrorObject(error: unknown): { type?: string; details?: string } {
  if (error instanceof HttpException) {
    const payload = error.getResponse() as Record<string, unknown>
    const type = typeof payload?.code === 'string' ? (payload.code as string) : undefined
    const details = typeof payload?.message === 'string' ? (payload.message as string) : undefined
    return { type, details }
  }
  if (error instanceof Error) {
    return { type: 'SERVER.ERROR', details: error.message }
  }
  return { type: 'SERVER.ERROR', details: String(error) }
}

export function applyRoundingWithResidual(total: bigint, denom: bigint, rounding: 'floor' | 'nearest' | 'ceil'): { blocks: bigint; remainder: bigint } {
  if (denom <= 1n) {
    return { blocks: total, remainder: 0n }
  }

  const floorBlocks = total / denom
  const remainder = total % denom

  if (rounding === 'ceil') {
    const blocks = remainder > 0n ? floorBlocks + 1n : floorBlocks
    return { blocks, remainder: 0n }
  }

  if (rounding === 'nearest') {
    if (remainder * 2n >= denom) {
      return { blocks: floorBlocks + 1n, remainder: 0n }
    }
    return { blocks: floorBlocks, remainder }
  }

  // floor
  return { blocks: floorBlocks, remainder }
}

export function applyPrepaidRounding(total: bigint, denom: bigint, previousPrepaid: bigint): { blocks: bigint; remainder: bigint } {
  if (total <= 0n) {
    return { blocks: 0n, remainder: previousPrepaid > 0n ? previousPrepaid : 0n }
  }

  let prepaid = previousPrepaid
  if (prepaid < 0n) prepaid = 0n
  if (denom > 1n && prepaid >= denom) {
    prepaid %= denom
  }

  if (denom <= 1n) {
    if (prepaid >= total) {
      return { blocks: 0n, remainder: prepaid - total }
    }
    const remaining = total - prepaid
    return { blocks: remaining, remainder: 0n }
  }

  if (prepaid >= total) {
    return { blocks: 0n, remainder: prepaid - total }
  }

  const remaining = total - prepaid
  const blocks = (remaining + denom - 1n) / denom
  const consumedFromNewBlocks = blocks * denom
  const leftover = consumedFromNewBlocks > remaining ? consumedFromNewBlocks - remaining : 0n
  return { blocks, remainder: leftover }
}


export function isTransaction(db: Kysely<Database> | Transaction<Database> | undefined): db is Transaction<Database> {
  return Boolean(db && typeof (db as Transaction<Database>).isTransaction === 'boolean')
}

export async function runInTransaction<T>(db: Kysely<Database> | Transaction<Database>, callback: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return isTransaction(db) ? callback(db) : db.transaction().execute(callback)
}

export function parseStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') {
        return item.split(',').map((s) => s.trim()).filter(Boolean)
      }
      return []
    })
  }
  return []
}

export function parseBooleanParam(value: unknown, defaultValue: boolean): boolean {
  if (value === null || value === undefined) return defaultValue
  const lower = String(value).trim().toLowerCase()
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false
  return defaultValue
}

export function parseAsOfTimestamp(value: unknown): Date {
  if (typeof value === 'string') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
      return date
    }
  }
  return new Date()
}

export function makeWindowSignature(window: { windowStart: Date; windowEnd: Date }): string {
  return `${window.windowStart.toISOString()}|${window.windowEnd.toISOString()}`
}

export function parseTstzRange(range: unknown): { from: Date; to: Date | null } | null {
  if (!range) return null

  if (typeof range === 'object' && range !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rangeAsAny = range as any
    const lower = rangeAsAny.lower ?? rangeAsAny.from ?? rangeAsAny.start
    const upper = rangeAsAny.upper ?? rangeAsAny.to ?? rangeAsAny.end
    const from = lower ? new Date(lower) : null
    if (!from || Number.isNaN(from.getTime())) return null
    if (!upper || upper === 'infinity') return { from, to: null }
    const to = new Date(upper)
    return Number.isNaN(to.getTime()) ? { from, to: null } : { from, to }
  }

  if (typeof range === 'string') {
    if (range === 'empty') return null
    const trimmed = range.trim()
    if (trimmed.length < 2) return null
    const inner = trimmed.slice(1, trimmed.length - 1)
    const [lowerRaw, upperRaw] = inner.split(',', 2)
    const from = lowerRaw ? new Date(lowerRaw.replace(/^"|"$/g, '').trim()) : null
    if (!from || Number.isNaN(from.getTime())) return null
    const upperText = upperRaw?.replace(/^"|"$/g, '').trim()
    if (!upperText || upperText === '' || upperText === 'infinity') {
      return { from, to: null }
    }
    const to = new Date(upperText)
    return Number.isNaN(to.getTime()) ? { from, to: null } : { from, to }
  }

  return null
}
