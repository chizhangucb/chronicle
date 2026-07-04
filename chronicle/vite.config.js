import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mount the Express API inside the Vite dev server: one process, one port.
function chronicleApi() {
  return {
    name: 'chronicle-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        try {
          const { api } = await server.ssrLoadModule('/server/api.js');
          api(req, res, next);
        } catch (err) { next(err); }
      });
      // Aggregating MCP Hub endpoint (Streamable HTTP)
      server.middlewares.use('/mcp', async (req, res, next) => {
        try {
          const { mcpEndpoint } = await server.ssrLoadModule('/server/mcp/hub.js');
          mcpEndpoint(req, res, next);
        } catch (err) { next(err); }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), chronicleApi()],
  server: { port: 4173, strictPort: true },
});
