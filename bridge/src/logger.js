// Minimal timestamped logger. No deps, writes to stdout/stderr.
const stamp = () => new Date().toISOString()

export const log = (...args) => console.log(`[askd ${stamp()}]`, ...args)
export const warn = (...args) => console.warn(`[askd ${stamp()}]`, ...args)
export const error = (...args) => console.error(`[askd ${stamp()}]`, ...args)
