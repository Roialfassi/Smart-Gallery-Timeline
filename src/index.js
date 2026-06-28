'use strict';

const config = require('./config');
const { createApp } = require('./api/server');
const geocode = require('./services/geocode');

// The server always starts with no project open, so the web UI lands on the
// project launcher ("choose a project"). Recent projects are still listed
// there for one-click reopening — we just don't auto-open the last one.
function main() {
  const app = createApp();
  app.listen(config.server.PORT, config.server.HOST, () => {
    const url = `http://${config.server.HOST}:${config.server.PORT}`;
    console.log('Smart Gallery Timeline');
    console.log(`  Server:   ${url}`);
    console.log('  Project:  none — open or create one in the app');
    console.log(`  Geocoder: ${geocode.isLoaded() ? 'offline country dataset loaded' : 'dataset MISSING (run scripts/build-countries.js)'}`);
    console.log('\nOpen the URL in your browser, then create or open a project.');
  });
}

main();
