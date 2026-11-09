#!/usr/bin/env node
import { runDevSite } from './dev-site.ts';

// npm run dev (the scaffold's "dev" script), run from vhost/.
// npm run dev -- --tunnel or --local skips the question.
const session = await runDevSite({ vhostDir: process.cwd(), argv: process.argv.slice(2) });

// Ctrl+C (with no shortcuts listening) or a stop from elsewhere: end
// the site and the tunnel cleanly, as the site does on its own.
process.once('SIGINT', () => void session.stop());
process.once('SIGTERM', () => void session.stop());

process.exit(await session.done);
