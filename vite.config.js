import { defineConfig } from 'vite'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(__dirname, 'client/web'),
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
