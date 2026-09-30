#!/usr/bin/env bun
/**
 * scripts/dev.ts — run the Parcel watcher (client) and the Bun server together.
 * Parcel is a Node program; Bun's script runner hands it to node via its shebang.
 */
import { spawn } from 'node:child_process'

const procs = [
  spawn('bun', ['run', 'dev:client'], { stdio: 'inherit', cwd: import.meta.dir + '/..' }),
  spawn('bun', ['run', 'dev:server'], { stdio: 'inherit', cwd: import.meta.dir + '/..' }),
]
const stop = (): void => {
  for (const p of procs) p.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const p of procs) p.on('exit', (code) => { if (code && code !== 0) stop() })
