export const WSL2_BASH_DEVELOPMENT_FLAG = 'OPEN_SCIENCE_ENABLE_WSL2_BASH'
export const WSL2_BASH_UNAVAILABLE_MESSAGE = 'Notebook WSL2 Bash runtime is unavailable.'

// Main-process selection admission and sandbox execution share this exact opt-in contract. The
// renderer receives availability from its owner and must not interpret the environment itself.
export const isWsl2BashDevelopmentEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[WSL2_BASH_DEVELOPMENT_FLAG] === '1'

export const assertWsl2BashDevelopmentEnabled = (env: NodeJS.ProcessEnv = process.env): void => {
  if (!isWsl2BashDevelopmentEnabled(env)) throw new Error(WSL2_BASH_UNAVAILABLE_MESSAGE)
}
