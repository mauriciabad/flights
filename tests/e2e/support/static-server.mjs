// Serves the built static site (`build/`) exactly the way GitHub Pages will: plain
// files over HTTP, no server-side rendering. `vite preview` was deliberately not used
// here — for a SvelteKit app it boots the Node SSR preview server from
// `.svelte-kit/output/server`, which is not what this app ships (AGENTS.md: "No
// backend. None."). Testing against that server would validate a code path production
// never runs, including for the service worker and manifest.
//
// `sirv` is already a transitive dependency of @sveltejs/kit (it's what kit's own
// preview server uses internally), so it is declared directly here rather than adding
// a second static-file-server dependency.
import { createServer } from 'node:http';
import process from 'node:process';
import sirv from 'sirv';

const dir = process.argv[2] ?? 'build';
const port = Number(process.argv[3] ?? 4173);

const serveStatic = sirv(dir, { etag: true, dev: false });

createServer((req, res) => {
	serveStatic(req, res, () => {
		res.statusCode = 404;
		res.end('Not found');
	});
}).listen(port, () => {
	console.log(`Serving ${dir} at http://127.0.0.1:${port}`);
});
