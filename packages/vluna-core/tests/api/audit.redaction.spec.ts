import { describe, expect, it } from 'vitest'
import { redactAuditValue } from '../../src/support/audit/audit.redaction.js'

describe('audit redaction', () => {
  it('fully redacts generic token-like fields by default', () => {
    expect(
      redactAuditValue({
        token: 'abcdefgh12345678',
        authorization: 'Bearer abcdefgh12345678',
      }),
    ).toEqual({
      token: '[REDACTED]',
      authorization: '[REDACTED]',
    })
  })

  it('supports explicit mask paths for selected fields', () => {
    expect(
      redactAuditValue(
        {
          secret: 'abcd1234wxyz5678',
          token: 'datb_tokenvalue_12345678',
        },
        { maskPaths: ['secret', 'token'] },
      ),
    ).toEqual({
      secret: 'abcd⋯5678',
      token: 'datb⋯5678',
    })
  })
})
