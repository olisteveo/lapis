import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Dev only: POST /__shot?name=x with a JPEG data URL saves docs/showcase/x.jpg (for README art). */
function showcaseShots(): Plugin {
  return {
    name: 'lapis-showcase-shots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (req.method !== 'POST' || !/^[a-z0-9-]{1,40}$/.test(name)) {
          res.statusCode = 400;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const data = Buffer.concat(chunks).toString().replace(/^data:image\/jpeg;base64,/, '');
          const dir = resolve(__dirname, 'docs/showcase');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${name}.jpg`), Buffer.from(data, 'base64'));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  server: { port: 5180 },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  plugins: [showcaseShots()],
});
