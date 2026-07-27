// Composes the resolved environment preamble with the workload command (design.md §8.2 / cross-cutting:
// submit path must keep Direct SSH and Slurm driver indifferent consumers of ONE resolved preamble).
//
// Both drivers call this to build the final command body before writing command.sh / the sbatch wrapper
// body, so activation runs BEFORE the workload identically regardless of backend. The preamble is
// already a deterministic, validated sequence of shell lines (see renderEnvironmentPreamble); this
// helper only joins it with the workload using a single newline separator.

// Returns the command unchanged when no preamble is supplied (plain command job). Otherwise prepends
// the preamble lines followed by the workload on its own line. Pure and deterministic.
export const applyEnvironmentPreamble = (preamble: string | undefined, command: string): string => {
  if (!preamble) return command
  return `${preamble}\n${command}`
}
