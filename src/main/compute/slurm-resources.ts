// Slurm resource renderer (design.md §5).
//
// Maps the provider-neutral `ResourceRequest` into `#SBATCH` directives. Structured resources are
// authoritative — the renderer is the single place a structured field becomes scheduler syntax, so the
// renderer must NEVER interpolate raw user strings (tokens are pre-validated printable-ASCII by
// `schedulerToken` in compute-resources.ts; numeric fields are pre-validated non-negative integers).
// This keeps the output free of shell injection (cross-cutting requirement: schema/parser validation
// before any value reaches a directive).
//
// The rendered directives are deterministic and ordered so the approval/audit snapshot is stable.

import type { ResourceRequest } from '../../shared/compute-resources'

// Formats a wall-clock limit in seconds into Slurm's `--time` syntax:
//   < 1 day  → H:MM:SS
//   >= 1 day → D-H:MM:SS
// Slurm accepts both forms; we emit D-H:MM:SS only past a day so a 1-hour job reads "1:00:00".
export const renderTimeLimit = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const rem = total - days * 86_400
  const hours = Math.floor(rem / 3600)
  const mins = Math.floor((rem % 3600) / 60)
  const secs = rem % 60
  const mm = String(mins).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  if (days > 0) {
    // Slurm D-H:MM:SS; zero-pad the hour field to two digits for a stable snapshot.
    return `${days}-${String(hours).padStart(2, '0')}:${mm}:${ss}`
  }
  return `${hours}:${mm}:${ss}`
}

// Renders a ResourceRequest into ordered #SBATCH directive lines. Returns an empty array for an empty
// request (Direct/Sbatch with no structured resources). The order is fixed so the snapshot is stable;
// gpuType is folded into --gres when present (gpu:a100:N form), and gpus alone renders gpu:N.
export const renderResourceDirectives = (request: ResourceRequest): string[] => {
  const lines: string[] = []
  if (request.partition) lines.push(`#SBATCH --partition=${request.partition}`)
  if (request.account) lines.push(`#SBATCH --account=${request.account}`)
  if (request.qos) lines.push(`#SBATCH --qos=${request.qos}`)
  if (request.nodes !== undefined) lines.push(`#SBATCH --nodes=${request.nodes}`)
  if (request.tasks !== undefined) lines.push(`#SBATCH --ntasks=${request.tasks}`)
  if (request.cpusPerTask !== undefined)
    lines.push(`#SBATCH --cpus-per-task=${request.cpusPerTask}`)
  if (request.memoryMib !== undefined) lines.push(`#SBATCH --mem=${request.memoryMib}`)
  if (request.gpus !== undefined || request.gpuType) {
    const count = request.gpus ?? 1
    const gres = request.gpuType ? `gpu:${request.gpuType}:${count}` : `gpu:${count}`
    lines.push(`#SBATCH --gres=${gres}`)
  }
  if (request.timeLimitSeconds !== undefined) {
    lines.push(`#SBATCH --time=${renderTimeLimit(request.timeLimitSeconds)}`)
  }
  return lines
}
