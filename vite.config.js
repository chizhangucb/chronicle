import { defineConfig } from 'vite';
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
  // No path alias: `shared/` is imported by relative path from both sides (#307),
  // so Vite, `tsc` and plain `node --test` all resolve it the same way.
  server: { port: 4173, strictPort: true },
});
