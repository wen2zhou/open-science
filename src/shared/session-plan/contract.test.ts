import { describe, expect, it } from 'vitest'

import { createPlanDocumentV1, isExplicitPlanContinuation } from './contract'

describe('Plan document V1', () => {
  it('adds the server-owned schema version to a valid single-step plan', () => {
    expect(
      createPlanDocumentV1({
        task_summary: 'Prepare a review-ready result',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: ['Analysis result'],
        feasibility: { confidence: 'high', rationale: 'The required inputs are available.' }
      })
    ).toEqual({
      schema_version: 1,
      task_summary: 'Prepare a review-ready result',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
            }
          ]
        }
      ],
      desired_outputs: ['Analysis result'],
      feasibility: { confidence: 'high', rationale: 'The required inputs are available.' }
    })
  })

  it('distinguishes explicit restart continuation from unrelated conversation', () => {
    expect(isExplicitPlanContinuation('Please resume the approved plan.')).toBe(true)
    expect(isExplicitPlanContinuation('Go ahead with the plan')).toBe(true)
    expect(isExplicitPlanContinuation('What files are in this project?')).toBe(false)
  })
})
