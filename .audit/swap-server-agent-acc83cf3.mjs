// sirv in production mode builds its file map once at startup, so swapping the directory
// under it serves 404s for every asset the new build hashed differently. That invalidated the
// first run of the returning-user check: the page rendered a mix of two builds. `dev: true`
// re-reads per request, which is what a directory that changes between two page loads needs.
import { createServer } from 'node:http';
import sirv from 'sirv';

const [dir, port] = process.argv.slice(2);
const serve = sirv(dir, { dev: true });
createServer((req, res) =>
	serve(req, res, () => {
		res.statusCode = 404;
		res.end('Not found');
	})
).listen(Number(port), () => console.log(`swap server on ${port} from ${dir}`));
