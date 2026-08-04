import { describe, expect, it } from 'vitest'

import { createPlanDocumentV1, isPlanApprovalResponse } from './contract'

describe('Plan response text', () => {
  it.each(['approve', 'Approved.', 'go ahead!', 'proceed', 'looks good', 'do it.', 'continue!'])(
    'recognizes prototype approval phrase %s',
    (text) => expect(isPlanApprovalResponse(text)).toBe(true)
  )

  it('keeps change requests on the feedback path', () => {
    expect(isPlanApprovalResponse('Approve after splitting by cohort.')).toBe(false)
  })
})

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
})
