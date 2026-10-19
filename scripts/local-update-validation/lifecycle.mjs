/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'

// Keep read-only process probes outside the terminal signal group so Ctrl-C can finish evidence.
// execFile does not forward detached to spawn; use spawn directly and preserve real probe errors.
export function inspectProcesses(command, args, { maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = { stdout: [], stderr: [] }
    const sizes = { stdout: 0, stderr: 0 }
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (bytes) => {
        sizes[name] += bytes.length
        if (sizes[name] > maxBuffer) {
          reject(new Error(`Process inspection exceeded ${name} buffer: ${command}`))
          child.kill()
        } else output[name].push(bytes)
      })
    }
    child.once('error', reject)
    child.once('close', (code, signal) => {
      const result = {
        stdout: Buffer.concat(output.stdout).toString(),
        stderr: Buffer.concat(output.stderr).toString()
      }
      if (code === 0) resolve(result)
      else
        reject(
          Object.assign(new Error(`Process inspection failed: ${command}`), {
            ...result,
            code,
            signal
          })
        )
    })
  })
}

// npm and a foreground terminal can deliver the same stop request more than once. Retain both
// handlers until the caller has finished its verification, source shutdown, and evidence writes.
export function installRunSignalHandlers(onStop) {
  let requested = false
  const stop = () => {
    if (requested) return
    requested = true
    onStop()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return () => {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
