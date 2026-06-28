'use strict';

/**
 * CLI: scan a directory into its own project catalog.
 *   node scripts/scan-cli.js <directory>
 *
 * Each folder is its own isolated project: the scan reads/writes only the
 * `<directory>/.smartgallery/` catalog, never a shared bucket. The folder is
 * opened if it is already a project, otherwise initialized as a new one.
 */

const path = require('path');
const { scanDirectory } = require('../src/services/scanner');
const project = require('../src/services/project');
const { closeDb } = require('../src/db/database');

async function main() {
  const target = path.resolve(process.argv[2] || path.resolve(__dirname, '..', 'demo-photos'));
  if (project.isProject(target)) project.openProject(target);
  else project.createProject({ baseDir: target, name: path.basename(target) });
  console.log(`Scanning: ${target}\n`);
  const start = Date.now();
  const summary = await scanDirectory(target, {
    onProgress: (evt) => {
      if (evt.phase === 'ingest') {
        process.stdout.write(`\r  ingest ${evt.processed}/${evt.total}   `);
      } else if (evt.phase === 'thumbnails') {
        process.stdout.write(`\r  thumbnails ${evt.processed}/${evt.total}   `);
      } else if (['discovery', 'purge', 'rollups'].includes(evt.phase)) {
        process.stdout.write(`\n  ${evt.message}`);
      }
    },
  });
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n\nDone in ${secs}s:`, summary);
  closeDb();
}

main().catch((err) => { console.error('\nScan failed:', err); process.exit(1); });
