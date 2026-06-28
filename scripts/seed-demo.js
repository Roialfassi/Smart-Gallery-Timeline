'use strict';

/**
 * Generate a demo photo library with real embedded EXIF (date, GPS, camera).
 * Output: ./demo-photos/<Trip folder>/IMG_####.jpg
 *
 * The images are synthetic gradients labelled with place + date so thumbnails
 * are visually distinct. EXIF is injected with piexifjs so the scan pipeline
 * sees genuine DateTimeOriginal / GPS / Make / Model tags.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const piexif = require('piexifjs');

const OUT_ROOT = path.resolve(__dirname, '..', 'demo-photos');

const TRIPS = [
  {
    folder: 'Paris France Spring 2024',
    make: 'Apple', model: 'iPhone 15 Pro', offset: '+02:00', hue: 210,
    start: '2024-05-04', days: 3, perDay: 4,
    spots: [
      ['Eiffel Tower', 48.8584, 2.2945], ['Louvre Museum', 48.8606, 2.3376],
      ['Notre Dame', 48.8530, 2.3499], ['Montmartre', 48.8867, 2.3431],
      ['Palace of Versailles', 48.8049, 2.1204], ['Arc de Triomphe', 48.8738, 2.2950],
    ],
  },
  {
    folder: 'Rome Florence Italy Vacation 2023',
    make: 'Canon', model: 'Canon EOS R5', offset: '+02:00', hue: 28,
    start: '2023-09-12', days: 3, perDay: 4,
    spots: [
      ['Colosseum Rome', 41.8902, 12.4922], ['Vatican City', 41.9029, 12.4534],
      ['Trevi Fountain', 41.9009, 12.4833], ['Florence Duomo', 43.7731, 11.2560],
      ['Leaning Tower of Pisa', 43.7228, 10.3966], ['Roman Forum', 41.8925, 12.4853],
    ],
  },
  {
    folder: 'Tokyo Japan Adventure 2025',
    make: 'Sony', model: 'Sony A7 IV', offset: '+09:00', hue: 330,
    start: '2025-03-21', days: 3, perDay: 4,
    spots: [
      ['Shibuya Crossing', 35.6595, 139.7005], ['Senso-ji Temple', 35.7148, 139.7967],
      ['Tokyo Tower', 35.6586, 139.7454], ['Shinjuku Gyoen', 35.6852, 139.7100],
      ['Mount Fuji View', 35.3606, 138.7274], ['Akihabara', 35.7022, 139.7745],
    ],
  },
  {
    folder: 'California Road Trip USA 2024',
    make: 'Nikon', model: 'Nikon Z6', offset: '-07:00', hue: 110,
    start: '2024-07-08', days: 4, perDay: 3,
    spots: [
      ['San Francisco', 37.7749, -122.4194], ['Yosemite Valley', 37.8651, -119.5383],
      ['Las Vegas Strip', 36.1699, -115.1398], ['Grand Canyon', 36.1069, -112.1129],
      ['Los Angeles', 34.0522, -118.2437], ['Santa Monica Pier', 34.0094, -118.4973],
    ],
  },
  {
    folder: 'London England Weekend 2022',
    make: 'Apple', model: 'iPhone 14', offset: '+00:00', hue: 265,
    start: '2022-12-17', days: 2, perDay: 4,
    spots: [
      ['Big Ben', 51.5007, -0.1246], ['London Eye', 51.5033, -0.1196],
      ['Tower Bridge', 51.5055, -0.0754], ['British Museum', 51.5194, -0.1270],
      ['Buckingham Palace', 51.5014, -0.1419], ['Camden Market', 51.5414, -0.1460],
    ],
  },
];

function jitter(v, amount = 0.0009) {
  return v + (Math.random() * 2 - 1) * amount;
}

function fmtExifDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function makeImage(outPath, title, subtitle, hue) {
  const w = 1200, h = 800;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue},68%,55%)"/>
        <stop offset="100%" stop-color="hsl(${(hue + 45) % 360},65%,32%)"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w - 200}" cy="180" r="120" fill="rgba(255,255,255,0.12)"/>
    <circle cx="220" cy="${h - 220}" r="90" fill="rgba(255,255,255,0.10)"/>
    <text x="60" y="${h - 130}" font-family="Arial, sans-serif" font-size="66" fill="white" font-weight="bold">${esc(title)}</text>
    <text x="62" y="${h - 64}" font-family="Arial, sans-serif" font-size="34" fill="rgba(255,255,255,0.9)">${esc(subtitle)}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(outPath);
}

function injectExif(filePath, { dateStr, offset, lat, lon, make, model }) {
  const jpeg = fs.readFileSync(filePath).toString('binary');
  const zeroth = {}, exif = {}, gps = {};
  zeroth[piexif.ImageIFD.Make] = make;
  zeroth[piexif.ImageIFD.Model] = model;
  zeroth[piexif.ImageIFD.Software] = 'Smart Gallery Timeline Seeder';
  exif[piexif.ExifIFD.DateTimeOriginal] = dateStr;
  exif[piexif.ExifIFD.DateTimeDigitized] = dateStr;
  // Note: piexifjs lacks OffsetTimeOriginal (0x9011); the scan pipeline derives
  // the tz offset from GPS longitude for these geotagged photos instead.
  if (lat != null && lon != null) {
    gps[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
    gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lat));
    gps[piexif.GPSIFD.GPSLongitudeRef] = lon >= 0 ? 'E' : 'W';
    gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lon));
  }
  const exifStr = piexif.dump({ '0th': zeroth, 'Exif': exif, 'GPS': gps });
  const newJpeg = piexif.insert(exifStr, jpeg);
  fs.writeFileSync(filePath, Buffer.from(newJpeg, 'binary'));
}

async function main() {
  if (fs.existsSync(OUT_ROOT)) fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  let totalPhotos = 0;
  for (const trip of TRIPS) {
    const dir = path.join(OUT_ROOT, trip.folder);
    fs.mkdirSync(dir, { recursive: true });
    const startDate = new Date(`${trip.start}T09:00:00Z`);
    let idx = 0;
    for (let day = 0; day < trip.days; day++) {
      for (let j = 0; j < trip.perDay; j++) {
        const spot = trip.spots[(day * trip.perDay + j) % trip.spots.length];
        const [place, baseLat, baseLon] = spot;
        const lat = jitter(baseLat);
        const lon = jitter(baseLon);
        // Day boundary => +24h base; within day +90min steps (keeps segments intact).
        const t = new Date(startDate.getTime() + day * 86400000 + j * 90 * 60000);
        const dateStr = fmtExifDate(t);
        const fileName = `IMG_${String(1000 + idx).padStart(4, '0')}.jpg`;
        const outPath = path.join(dir, fileName);
        const subtitle = `${t.toISOString().slice(0, 10)} · ${trip.model}`;
        await makeImage(outPath, place, subtitle, trip.hue);
        injectExif(outPath, {
          dateStr, offset: trip.offset, lat, lon, make: trip.make, model: trip.model,
        });
        idx++; totalPhotos++;
      }
    }
    console.log(`  ${trip.folder}: ${idx} photos`);
  }
  console.log(`\nGenerated ${totalPhotos} demo photos in ${OUT_ROOT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
