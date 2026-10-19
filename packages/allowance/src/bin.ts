#!/usr/bin/env node
import { start } from './server.js';

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(major) || major < 22) {
  process.stderr.write('allowance needs Node 22 or newer.\n');
  process.exit(1);
}

const raw = process.env['ALLOWANCE_PORT'] ?? '4877';
const port = Number(raw);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('ALLOWANCE_PORT needs a port number.\n');
  process.exit(1);
}

const server = await start({ port });
const address = server.address();
const bound = address !== null && typeof address === 'object' ? address.port : port;
process.stdout.write(`what's left  http://127.0.0.1:${bound}\n`);

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
