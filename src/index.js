'use strict';

const config = require('./config');
const { createApp } = require('./api/server');
const project = require('./services/project');
const geocode = require('./services/geocode');

// Re-open the most recently used project (if any) so a restart lands back where
// you left off. With no recent project, the server still starts and the web UI
// shows the project launcher.
function autoOpenRecent() {
  try {
    const recent = project.listRecent();
    if (recent.length > 0) {
      const active = project.openProject(recent[0].baseDir);
      return active;
    }
  } catch (_) { /* fall through to launcher */ }
  return null;
}

function main() {
  const active = autoOpenRecent();
  const app = createApp();
  app.listen(config.server.PORT, config.server.HOST, () => {
    const url = `http://${config.server.HOST}:${config.server.PORT}`;
    console.log('Smart Gallery Timeline');
    console.log(`  Server:   ${url}`);
    console.log(`  Project:  ${active ? active.name + ' (' + active.baseDir + ')' : 'none — open or create one in the app'}`);
    console.log(`  Geocoder: ${geocode.isLoaded() ? 'offline country dataset loaded' : 'dataset MISSING (run scripts/build-countries.js)'}`);
    console.log('\nOpen the URL in your browser, then create or open a project.');
  });
}

main();
