import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // @pqi/protocol from its source, so a fresh clone runs `dev` and `build` without building it first.
  resolve: { alias: { '@deployments': resolve(__dirname, '../../deployments'), '@pqi/protocol': resolve(__dirname, '../protocol/src/index.ts') } },
  server: { port: 5181, strictPort: true, fs: { allow: [resolve(__dirname, '../..')] } },
});
