import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

// Mount the Express API inside the Vite dev server: one process, one port.
function chronicleApi() {
  return {
    name: 'chronicle-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        try {
          const { api } = await server.ssrLoadModule('/server/api.ts');
          api(req, res, next);
        } catch (err) { next(err); }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), chronicleApi()],
  // `@shared` → repo-root shared/ (the cross-boundary type contract). Mirrors the
  // tsconfig.client.json `paths` mapping so `tsc` and Vite resolve it the same way.
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: { port: 4173, strictPort: true },
});
