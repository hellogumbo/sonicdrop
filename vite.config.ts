import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['sonicdrop.ngrok.io'],
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
