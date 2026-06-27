import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The runner's JSON-RPC HTTP endpoint is proxied so the UI can call it
// same-origin in dev. PROJECT_ROOT and runner port are set when launching
// the runner (php -S 127.0.0.1:9777 bin/server.php).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/rpc': {
        target: 'http://127.0.0.1:9777',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rpc/, '/'),
      },
    },
  },
});
