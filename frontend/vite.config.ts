import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: path.resolve(__dirname, './src/test/setup.ts'),
    css: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'src/test/'],
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50,
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 5173,
    proxy: {
	'/api/v1': 'http://localhost:8081/api/v1',
        '/ws': { target: 'ws://localhost:8081', ws: true }
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-markdown')) {
              return 'markdown';
            }
            if (id.includes('react-router')) {
              return 'router';
            }
            if (id.includes('@dnd-kit')) {
              return 'dnd-kit';
            }
            if (id.includes('i18next') || id.includes('react-i18next')) {
              return 'i18n';
            }
            if (id.includes('react-dom') || (id.includes('react') && !id.includes('jsx'))) {
              return 'react-vendor';
            }
          }
        },
      },
    },
  },
})
