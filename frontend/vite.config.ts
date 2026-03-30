import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 5173,
    proxy: {
	'/api': 'http://localhost:8080',
        '/ws': { target: 'ws://localhost:8080', ws: true }
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@uiw/react-md-editor') || id.includes('react-markdown')) {
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
