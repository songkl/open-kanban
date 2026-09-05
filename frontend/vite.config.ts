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
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'src/test/'],
      // Coverage thresholds are intentionally below the actual
      // code-coverage levels so a regression shows up in code
      // review (and in a future "add more tests" sweep) without
      // breaking the test job. Current actuals (Sep 2026):
      //   statements  ~48%, branches ~45%, functions ~38%, lines ~49%.
      // Bumping any of these to 50% would require new tests for
      // services/api.ts and store/uiStore.ts which currently have
      // none. Until that's done, keep the gate below reality so
      // CI doesn't fail on a non-regression.
      thresholds: {
        statements: 40,
        branches: 40,
        functions: 30,
        lines: 40,
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
      '/api/v1': 'http://localhost:8081',
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
