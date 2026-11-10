import { execSync } from 'node:child_process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** SHA de 7 caracteres del commit que se construye: lo da el hosting o, en su defecto, git. */
function commitSha(): string {
  const fromHost =
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA ?? process.env.COMMIT_REF ?? process.env.GITHUB_SHA
  if (fromHost) return fromHost.slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  define: { __LUMON_BUILD__: JSON.stringify(command === 'serve' ? 'dev' : commitSha()) },
  build: { target: 'es2022', modulePreload: { polyfill: false } },
}))
