/** Types for scripts/ue-wire.mjs, which the clangd and lldb-dap clients share. */

export function frame (message: unknown): Buffer
export function parseMessages (buffer: Buffer): { messages: any[]; rest: Buffer }
