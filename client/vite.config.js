import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Bind the IPv4 loopback explicitly. Left unset, Vite asks the OS to resolve
    // "localhost" and on Windows that can land on ::1 only - which serves IPv6
    // loopback traffic and refuses 127.0.0.1, so a browser that resolves
    // localhost to IPv4 gets a connection refused. Loopback rather than 0.0.0.0
    // keeps the dev server off the network.
    host: '127.0.0.1',
    proxy: {
      // Proxy the API in development so the browser talks to a single origin.
      // This keeps the httpOnly session cookie working without CORS relaxations.
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Split vendor code so a design change does not invalidate the framework
    // chunk for returning visitors.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
