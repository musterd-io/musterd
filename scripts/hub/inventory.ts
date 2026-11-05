/*
 * The hub inventory (ADR 796), run on store files during a hub relocation. Read-only.
 *
 *   node scripts/hub/inventory.ts <db>                         print the inventory as JSON
 *   node scripts/hub/inventory.ts <db> --compare <inv.json>    exit 1 on any table mismatch
 *   node scripts/hub/inventory.ts --replica <db> --hub <db>    exit 1 if the replica holds a
 *                                                              non-ephemeral row the hub does not
 *   node scripts/hub/inventory.ts <db> --require-drained       exit 1 if the store has unpushed events
 *
 * Flags combine. Every report goes to stdout as one JSON object; a failing check also prints one
 * line to stderr naming it.
 */
import { readFileSync } from 'node:fs';
import {
  compareInventories,
  openReadOnly,
  readInventory,
  rowsOnlyInAny,
  takeInventory,
} from '../../packages/server/src/ops/inventory.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const replicaPath = flag('--replica');
const hubPath = flag('--hub');
const comparePath = flag('--compare');
const requireDrained = process.argv.includes('--require-drained');
const dbPath = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));

const report: Record<string, unknown> = {};
let failed = false;

if (dbPath) {
  const db = openReadOnly(dbPath);
  const inventory = takeInventory(db);
  report['inventory'] = inventory;
  if (comparePath) {
    const before = readInventory(JSON.parse(readFileSync(comparePath, 'utf8')));
    const mismatches = compareInventories(before, inventory);
    report['mismatches'] = mismatches;
    if (mismatches.length > 0) {
      failed = true;
      process.stderr.write(`✗ ${mismatches.length} table(s) differ from ${comparePath}\n`);
    }
  }
  if (requireDrained && inventory.outbox_pending > 0) {
    failed = true;
    process.stderr.write(`✗ ${inventory.outbox_pending} event(s) not yet pushed — drain first\n`);
  }
  db.close();
}

if (replicaPath && hubPath) {
  const replica = openReadOnly(replicaPath);
  const hub = openReadOnly(hubPath);
  const only = rowsOnlyInAny(replica, hub);
  report['replica_only'] = only.map((t) => ({ table: t.table, rows: t.keys.length, keys: t.keys }));
  if (only.length > 0) {
    failed = true;
    process.stderr.write(
      `✗ the replica holds rows the hub does not: ${only.map((t) => `${t.table} (${t.keys.length})`).join(', ')}\n`,
    );
  }
  replica.close();
  hub.close();
}

if (!dbPath && !(replicaPath && hubPath)) {
  process.stderr.write(
    'usage: node scripts/hub/inventory.ts <db> [--compare <inv.json>] [--require-drained] | --replica <db> --hub <db>\n',
  );
  process.exit(2);
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
// Not process.exit(): on a pipe stdout is asynchronous, and exiting at once cut a large report off
// at 64 KB (rehearsal 1). Setting the code lets node exit once the write has drained.
process.exitCode = failed ? 1 : 0;
