import { describe, expect, it } from 'vitest'

import {
  sanitizeAcpModelCallUsage,
  sanitizeAcpTurnTokenUsage,
  sumAcpTurnTokenUsage,
  toAcpTurnTokenUsage
} from './acp'

describe('ACP turn token usage', () => {
  it('preserves cache details only when the agent reports both read and write categories', () => {
    expect(
      toAcpTurnTokenUsage({
        totalTokens: 160,
        inputTokens: 100,
        cachedReadTokens: 30,
        cachedWriteTokens: 20,
        outputTokens: 10
      })
    ).toEqual({
      inputTokens: 100,
      cacheTokens: 50,
      cachedReadTokens: 30,
      cachedWriteTokens: 20,
      outputTokens: 10
    })

    expect(
      toAcpTurnTokenUsage({
        totalTokens: 140,
        inputTokens: 100,
        cachedReadTokens: 30,
        outputTokens: 10
      })
    ).toEqual({ inputTokens: 100, cacheTokens: 30, outputTokens: 10 })
  })

  it('normalizes model-call identities before durable projection', () => {
    const call = {
      id: '  call-1  ',
      index: 0,
      sourceInvocationId: '   ',
      inputTokens: 4,
      cacheTokens: 2,
      outputTokens: 3
    }

    expect(sanitizeAcpModelCallUsage(call)).toEqual({
      id: 'call-1',
      index: 0,
      inputTokens: 4,
      cacheTokens: 2,
      outputTokens: 3
    })
    expect(sanitizeAcpModelCallUsage({ ...call, id: '   ' })).toBeUndefined()
  })

  it('rejects a whole-turn total that is unsafe even when every category is safe', () => {
    const unsafeCategories = {
      inputTokens: Number.MAX_SAFE_INTEGER,
      cacheTokens: 0,
      outputTokens: 1
    }

    expect(sanitizeAcpTurnTokenUsage(unsafeCategories)).toBeUndefined()
    expect(
      toAcpTurnTokenUsage({
        inputTokens: Number.MAX_SAFE_INTEGER,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 1
      })
    ).toBeUndefined()
  })

  it('safely aggregates complete turn usage and drops optional details that are not shared', () => {
    expect(
      sumAcpTurnTokenUsage(
        {
          inputTokens: 10,
          cacheTokens: 3,
          cachedReadTokens: 2,
          cachedWriteTokens: 1,
          outputTokens: 4,
          turnCount: 1
        },
        { inputTokens: 20, cacheTokens: 5, outputTokens: 6 }
      )
    ).toEqual({ inputTokens: 30, cacheTokens: 8, outputTokens: 10 })
    expect(
      sumAcpTurnTokenUsage(
        { inputTokens: Number.MAX_SAFE_INTEGER, cacheTokens: 0, outputTokens: 0 },
        { inputTokens: 1, cacheTokens: 0, outputTokens: 0 }
      )
    ).toBeUndefined()
    expect(
      sumAcpTurnTokenUsage(
        { inputTokens: Number.MAX_SAFE_INTEGER - 2, cacheTokens: 1, outputTokens: 1 },
        { inputTokens: 0, cacheTokens: 0, outputTokens: 1 }
      )
    ).toBeUndefined()
  })
})
