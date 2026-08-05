import { describe, expect, it } from 'vitest'

import {
  createPlanDocumentV1,
  derivePlanLifecycle,
  generatePlanContentSchema,
  isPlanApprovalResponse,
  isPlanComplete,
  parsePlanDocumentV1,
  PlanCommandError
} from './contract'

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
  it('publishes one canonical content contract for Plan producers', () => {
    expect(Object.keys(generatePlanContentSchema.shape)).toEqual([
      'task_summary',
      'phases',
      'desired_outputs',
      'feasibility'
    ])
    expect(generatePlanContentSchema.description).toContain('four content fields')
    expect(
      generatePlanContentSchema.safeParse({
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      }).success
    ).toBe(true)
  })

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

  it('accepts an empty desired-output list and preserves every phase, delegation, and step', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Compare two cohorts',
      phases: [
        {
          name: 'Preparation',
          delegations: [
            {
              name: 'Data intake',
              steps: [
                { title: 'Read the dictionary', description: 'Confirm field meanings.' },
                { title: 'Validate inputs', description: 'Check both cohorts.' }
              ]
            }
          ]
        },
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Comparison',
              steps: [{ title: 'Compare cohorts', description: 'Calculate differences.' }]
            },
            {
              name: 'Evidence review',
              steps: [{ title: 'Review evidence', description: 'Check supporting evidence.' }]
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'medium', rationale: 'Inputs may need confirmation.' }
    })

    expect(document.phases).toHaveLength(2)
    expect(document.phases[0].delegations).toHaveLength(1)
    expect(document.phases[1].delegations).toHaveLength(2)
    expect(document.phases[0].delegations[0].steps).toHaveLength(2)
    expect(document.desired_outputs).toEqual([])
  })

  it('rejects an explicitly unsupported schema version at the shared contract boundary', () => {
    expect(() =>
      createPlanDocumentV1({
        schema_version: 2,
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      })
    ).toThrow(
      expect.objectContaining<Partial<PlanCommandError>>({
        code: 'invalid-plan',
        message: 'schema_version must be 1.'
      })
    )
  })

  it('requires the V1 discriminator when parsing a persisted Plan document', () => {
    expect(() =>
      parsePlanDocumentV1({
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      })
    ).toThrow(
      expect.objectContaining<Partial<PlanCommandError>>({
        code: 'invalid-plan',
        message: 'schema_version must be 1.'
      })
    )
  })

  it.each([
    [undefined, 'Plan document must be an object.'],
    [{}, 'task_summary must be non-empty.'],
    [
      {
        task_summary: 'Analyze data',
        phases: [{ name: 'Analysis', delegations: 'not-an-array' }],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      'Each phase requires at least one delegation.'
    ],
    [
      {
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [
                  { title: 'Analyze data', description: 'First description.' },
                  { title: ' Analyze data ', description: 'Second description.' }
                ]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      'Duplicate step title: Analyze data'
    ]
  ])('returns structured invalid-plan for malformed runtime input %#', (input, message) => {
    expect(() => createPlanDocumentV1(input)).toThrow(
      expect.objectContaining<Partial<PlanCommandError>>({ code: 'invalid-plan', message })
    )
  })

  it('checks each phase name before validating later phase fields', () => {
    expect(() =>
      createPlanDocumentV1({
        task_summary: 'Analyze data',
        phases: [{ name: '', delegations: 'not-an-array' }],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      })
    ).toThrow(
      expect.objectContaining<Partial<PlanCommandError>>({
        code: 'invalid-plan',
        message: 'phase name must be non-empty.'
      })
    )
  })
})

describe('derived Plan lifecycle', () => {
  it('derives blocked once blocked work has no remaining active execution', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Analyze data',

      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: [
                { title: 'Inspect inputs', description: 'Check the data.' },
                { title: 'Analyze data', description: 'Produce the result.' }
              ]
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
    })

    expect(
      derivePlanLifecycle(document, 'approved', {
        'Inspect inputs': { status: 'blocked' }
      })
    ).toBe('blocked')
  })

  it('uses one completion rule for durable status facts', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Prepare a result',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: [
                { title: 'Analyze', description: 'Analyze the inputs.' },
                { title: 'Summarize', description: 'Summarize the result.' }
              ]
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
    })

    expect(
      isPlanComplete(document, {
        Analyze: { status: 'completed' },
        Summarize: { status: 'skipped' }
      })
    ).toBe(true)
    expect(isPlanComplete(document, { Analyze: { status: 'completed' } })).toBe(false)
  })
})
