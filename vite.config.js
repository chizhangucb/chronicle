import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mount the Express API inside the Vite dev server: one process, one port.
//
// The dev server drives the same explicit lifecycle the standalone entry does
// (issue #275): open the database, build the app over it, start auto-sync.
// The app is cached against the loaded api.ts module object, so an SSR reload
// of a server file rebuilds it (that is the point of ssrLoadModule per request)
// while an unchanged one does not re-mount 17 routers on every API call.
// openDatabase() is idempotent per data folder, so a reload reuses the handle
// rather than opening a second one over the same file.
function chronicleApi() {
  const apps = new WeakMap();
  return {
    name: 'chronicle-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        try {
          const mod = await server.ssrLoadModule('/server/api.ts');
          let app = apps.get(mod);
          if (!app) {
            const { openDatabase } = await server.ssrLoadModule('/server/db.ts');
            const { startAutoSync } = await server.ssrLoadModule('/server/autosync.ts');
            app = mod.createApp(openDatabase());
            startAutoSync();
            apps.set(mod, app);
          }
          app(req, res, next);
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
