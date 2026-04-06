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
      '/boards': 'http://localhost:8081/boards',
      '/columns': 'http://localhost:8081/columns',
      '/tasks': 'http://localhost:8081/tasks',
      '/templates': 'http://localhost:8081/templates',
      '/drafts': 'http://localhost:8081/drafts',
      '/archived': 'http://localhost:8081/archived',
      '/comments': 'http://localhost:8081/comments',
      '/subtasks': 'http://localhost:8081/subtasks',
      '/attachments': 'http://localhost:8081/attachments',
      '/upload': 'http://localhost:8081/upload',
      '/auth': 'http://localhost:8081/auth',
      '/users': 'http://localhost:8081/users',
      '/agents': 'http://localhost:8081/agents',
      '/activities': 'http://localhost:8081/activities',
      '/permissions': 'http://localhost:8081/permissions',
      '/config': 'http://localhost:8081/config',
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
