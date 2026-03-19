import { describe, it, expect } from 'vitest'
import type { Transaction, Kysely } from 'kysely'
import type { Database } from '../../src/types/database.js'
import { HttpException } from '@nestjs/common'
import {
  applyPrepaidRounding,
  applyRoundingWithResidual,
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
  parsePositiveInt,
  parseTstzRange,
  parseBooleanParam,
  parseMinor,
  createLeaseToken,
  parseLeaseToken,
  runInTransaction,
  buildErrorObject,
} from '../../src/features/gate/services/gate.utils.js'

describe('gate.utils numeric parsing', { tags: ['unit'] }, () => {
  it('accepts non-negative ints and trims strings', () => {
    expect(parseOptionalNonNegativeInt('12', 'f')).toBe(12)
    expect(parseOptionalNonNegativeInt(0, 'f')).toBe(0)
    expect(parseOptionalNonNegativeInt(undefined, 'f')).toBeUndefined()
  })

  it('rejects negatives and non-numeric', () => {
    expect(() => parseOptionalNonNegativeInt(-1, 'f')).toThrow(HttpException)
    expect(() => parseOptionalNonNegativeInt('x', 'f')).toThrow(HttpException)
  })

  it('parses positive int and rejects zero', () => {
    expect(parsePositiveInt(3, 'f')).toBe(3)
    expect(() => parsePositiveInt(0, 'f')).toThrow(HttpException)
    expect(parseOptionalPositiveInt(null, 'f')).toBeUndefined()
  })
})

describe('gate.utils rounding helpers', { tags: ['unit'] }, () => {
  it('applyRoundingWithResidual handles floor/nearest/ceil', () => {
    expect(applyRoundingWithResidual(10n, 3n, 'floor')).toEqual({ blocks: 3n, remainder: 1n })
    expect(applyRoundingWithResidual(10n, 3n, 'ceil')).toEqual({ blocks: 4n, remainder: 0n })
    expect(applyRoundingWithResidual(5n, 3n, 'nearest')).toEqual({ blocks: 2n, remainder: 0n })
  })

  it('applyPrepaidRounding consumes prepaid then rounds up remaining', () => {
    // prepaid fully covers
    expect(applyPrepaidRounding(5n, 3n, 6n)).toEqual({ blocks: 2n, remainder: 1n })
    // prepaid partially covers
    expect(applyPrepaidRounding(5n, 3n, 2n)).toEqual({ blocks: 1n, remainder: 0n })
    // denom 1 behaves as simple subtraction
    expect(applyPrepaidRounding(4n, 1n, 2n)).toEqual({ blocks: 2n, remainder: 0n })
  })
})

describe('gate.utils range/time/string parsing', { tags: ['unit'] }, () => {
  it('parses tstzrange strings and objects', () => {
    const str = '[2024-01-01T00:00:00Z,2024-02-01T00:00:00Z)'
    expect(parseTstzRange(str)).toEqual({
      from: new Date('2024-01-01T00:00:00Z'),
      to: new Date('2024-02-01T00:00:00Z'),
    })
    const obj = { lower: '2024-03-01T00:00:00Z', upper: 'infinity' }
    expect(parseTstzRange(obj)).toEqual({
      from: new Date('2024-03-01T00:00:00Z'),
      to: null,
    })
    expect(parseTstzRange('empty')).toBeNull()
  })

  it('parses boolean params with defaults', () => {
    expect(parseBooleanParam('true', false)).toBe(true)
    expect(parseBooleanParam('no', true)).toBe(false)
    expect(parseBooleanParam(undefined, true)).toBe(true)
  })

  it('parses minor values of various types', () => {
    expect(parseMinor('5')).toBe(5)
    expect(parseMinor(2n)).toBe(2)
    expect(parseMinor({})).toBeUndefined()
  })
})

describe('gate.utils lease/token helpers', { tags: ['unit'] }, () => {
  it('creates and parses lease token', () => {
    const token = createLeaseToken('123')
    expect(parseLeaseToken(token)).toBe('123')
  })

  it('buildErrorObject extracts code/details from HttpException', () => {
    const err = new HttpException({ code: 'X', message: 'details' }, 400)
    expect(buildErrorObject(err)).toEqual({ type: 'X', details: 'details' })
    const plain = new Error('oops')
    expect(buildErrorObject(plain)).toEqual({ type: 'SERVER.ERROR', details: 'oops' })
  })

  it('rejects invalid lease token', () => {
    expect(() => parseLeaseToken('bad-token')).toThrow(HttpException)
  })
})

  describe('gate.utils transaction helpers', { tags: ['unit'] }, () => {
    it('runInTransaction uses existing trx without starting new one', async () => {
      const trx = { isTransaction: true } as unknown as Transaction<Database>
      const result = await runInTransaction(trx, async (t) => (t === trx ? 'ok' : 'bad'))
      expect(result).toBe('ok')
    })

    it('runInTransaction starts transaction when given db', async () => {
      const trx = { isTransaction: true } as unknown as Transaction<Database>
      const db = {
        transaction: () => ({
          execute: (cb: (t: Transaction<Database>) => Promise<unknown>) => cb(trx),
        }),
      } as unknown as Kysely<Database>
      const result = await runInTransaction(
        db,
        async (t: Transaction<Database>) => (t === trx ? 'ok' : 'bad'),
      )
      expect(result).toBe('ok')
    })
  })
