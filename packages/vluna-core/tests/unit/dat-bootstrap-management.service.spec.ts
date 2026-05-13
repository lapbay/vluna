import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('../../src/db/index.js', () => ({
  pool: {
    query: queryMock,
  },
}))

import { DatBootstrapManagementService } from '../../src/features/dat/services/dat-bootstrap-management.service.js'

describe('DatBootstrapManagementService', { tags: ['unit'] }, () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('limits subject token listing to the verified organization scope', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })

    const service = new DatBootstrapManagementService()
    await service.listForSubject(' user_123 ', ' org_123 ')

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('organization_id is not distinct from $2'),
      ['user_123', 'org_123'],
    )
  })

  it('limits subject token reveal to personal scope when no organization is verified', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })

    const service = new DatBootstrapManagementService()
    await expect(service.revealForSubject('user_123', null, 'dbt_123')).rejects.toMatchObject({
      response: { code: 'DAT.BOOTSTRAP_TOKEN_NOT_FOUND' },
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('organization_id is not distinct from $3'),
      ['dbt_123', 'user_123', null],
    )
  })

  it('limits subject token revoke to the verified organization scope', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 })

    const service = new DatBootstrapManagementService()
    const revoked = await service.revokeForSubject('user_123', 'org_123', 'dbt_123')

    expect(revoked).toBe(true)
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('organization_id is not distinct from $3'),
      ['dbt_123', 'user_123', 'org_123'],
    )
  })
})
