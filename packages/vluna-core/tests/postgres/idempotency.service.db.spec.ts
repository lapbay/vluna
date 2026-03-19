import path from 'node:path'
import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { db, setRlsSession, withDatabaseConnection } from '../../src/db/index.js'
import { GateIdempotencyService } from '../../src/features/gate/services/idempotency.service.js'
import { prepareDbTestContext } from '../utils/db-setup.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/idempotency.sql')
const realmId = 'realm-test'
const billingAccountId = 'ba-test'

describe('GateIdempotencyService (db)', { tags: ['db'] }, () => {
  let stop: () => Promise<void>
  let skipped = false

  beforeAll(async () => {
    try {
      const ctx = await prepareDbTestContext({ fixtures: [FIXTURE] })
      process.env.DATABASE_URI = ctx.connectionString
      stop = ctx.stop
    } catch (err) {
      // Likely testcontainers missing; mark suite as skipped
      skipped = true
      console.warn('[db test] skipping idempotency.service because db unavailable:', (err as Error)?.message)
    }
  })

  afterAll(async () => {
    if (stop) await stop()
  })

  const svc = new GateIdempotencyService()

  it('acquires new envelope and rejects payload mismatch on duplicate', async () => {
    if (skipped) return
    // first insert
    const first = await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingAccountId })
        return svc.acquire(trx, {
          realmId,
          billingAccountId,
          operation: 'commit',
          scopeType: 'lease',
          scopeId: '123',
          key: 'idem-1',
          requestHash: 'hash-a',
        })
      }),
    )
    expect(first.isNew).toBe(true)

    // duplicate same hash should return existing
    const dup = await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingAccountId })
        return svc.acquire(trx, {
          realmId,
          billingAccountId,
          operation: 'commit',
          scopeType: 'lease',
          scopeId: '123',
          key: 'idem-1',
          requestHash: 'hash-a',
          metadata: { retry: true },
        })
      }),
    )
    expect(dup.isNew).toBe(false)

    // hash mismatch should throw
    await expect(
      withDatabaseConnection(process.env.DATABASE_URI!, async () =>
        db().transaction().execute(async (trx) => {
          await setRlsSession(trx, { realmId, billingAccountId })
          return svc.acquire(trx, {
            realmId,
            billingAccountId,
            operation: 'commit',
            scopeType: 'lease',
            scopeId: '123',
            key: 'idem-1',
            requestHash: 'hash-b',
          })
        }),
      ),
    ).rejects.toBeInstanceOf(Error)
  })

  it('finalizes pending envelope', async () => {
    if (skipped) return
    await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingAccountId })

        const { envelope } = await svc.acquire(trx, {
          realmId,
          billingAccountId,
          operation: 'commit',
          scopeType: 'lease',
          scopeId: '124',
          key: 'idem-2',
          requestHash: 'hash-x',
        })

        await svc.finalize(trx, {
          idempotencyId: envelope.idempotency_id,
          status: 'completed',
          responseSnapshot: { ok: true },
          resultRef: { id: 1 },
        })

        const row = await trx
          .selectFrom('idempotency_envelopes')
          .select(['status', 'response_snapshot', 'result_ref'])
          .where('idempotency_id', '=', envelope.idempotency_id)
          .executeTakeFirstOrThrow()

        expect(row.status).toBe('completed')
        expect((row.response_snapshot as Record<string, unknown>).ok).toBe(true)
      }),
    )
  })

  it('merges metadata/request snapshot while pending', async () => {
    if (skipped) return
    await withDatabaseConnection(process.env.DATABASE_URI!, async () =>
      db().transaction().execute(async (trx) => {
        await setRlsSession(trx, { realmId, billingAccountId })

        const first = await svc.acquire(trx, {
          realmId,
          billingAccountId,
          operation: 'authorize',
          scopeType: 'account',
          scopeId: null,
          key: 'idem-merge',
          requestHash: 'hash-merge',
          metadata: { attempt: 1 },
          requestSnapshot: { foo: 'bar' },
        })
        expect(first.isNew).toBe(true)

        const second = await svc.acquire(trx, {
          realmId,
          billingAccountId,
          operation: 'authorize',
          scopeType: 'account',
          scopeId: null,
          key: 'idem-merge',
          requestHash: 'hash-merge',
          metadata: { attempt: 2 },
        })
        expect(second.isNew).toBe(false)
        expect(second.envelope.metadata?.attempt).toBe(2)
        expect(second.envelope.request_snapshot).toEqual({ foo: 'bar' })
      }),
    )
  })
})
