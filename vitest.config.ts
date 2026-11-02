import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests. The suite starts many child processes at once, so the
// per-test timeouts stay generous enough that a loaded machine neither fails a test nor hides a real hang for long.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], testTimeout: 30_000, hookTimeout: 30_000 } })
