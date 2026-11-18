import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { RESTStore } from './store.js';
import { LIMITS } from './domain.js';
import { runWorker } from './worker.js';
const db = new RESTStore(process.env.POSTGREST_URL ?? 'http://rest:3000');
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => controller.abort());
if (process.argv[2] === 'worker') {
    await runWorker(db, controller.signal);
}
else {
    const app = createApp(db, { token: process.env.ADMIN_TOKEN ?? 'stockroom-local-admin', secureCookies: process.env.COOKIE_SECURE === 'true' });
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/src/app.js': ['src/app.js', 'text/javascript; charset=utf-8'] };
    async function readBody(req) { let length = 0; const chunks = []; for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > LIMITS.fileBytes)
            throw new Error('TOO_LARGE');
        chunks.push(bytes);
    } return Buffer.concat(chunks); }
    const server = createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
        try {
            const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
            if (req.method === 'GET' && files[pathname]) {
                const [file, mime] = files[pathname];
                res.setHeader('Content-Type', mime);
                res.end(await readFile(new URL('../web/' + file, import.meta.url)));
                return;
            }
            const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]));
            const result = await app({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body: await readBody(req) });
            res.statusCode = result.status;
            for (const [key, value] of Object.entries(result.headers ?? {}))
                res.setHeader(key, value);
            if (Buffer.isBuffer(result.body) || typeof result.body === 'string')
                res.end(result.body);
            else {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(result.body));
            }
        }
        catch (error) {
            res.statusCode = error instanceof Error && error.message === 'TOO_LARGE' ? 413 : 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: res.statusCode === 413 ? 'Maximum upload size is 5 MiB.' : 'Service could not complete the request.' }));
        }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 50;
    controller.signal.addEventListener('abort', () => { server.close(); setTimeout(() => server.closeAllConnections(), 5000).unref(); });
    server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log('Stockroom API listening on port ' + (process.env.PORT ?? 8080)));
}
