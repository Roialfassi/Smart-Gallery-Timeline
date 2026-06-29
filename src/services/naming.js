'use strict';

const { countryName } = require('./geocode');
const { extractKeywords } = require('./keywords');

/**
 * Shared labelling for spatiotemporal groups (the Timeline view) and spatial
 * clusters. One source of truth so a "place" reads the same everywhere.
 *
 *   placeName(photos)            -> "Paris, France" | "France" | "Area"
 *   dateRangeLabel(start, end)   -> "May 4–7, 2024" | "Summer 2024" | "2024"
 */

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Most common value in a list; first-seen wins ties (stable for fixed input). */
function mode(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/**
 * A human "place" label for a set of photos: the strongest folder keyword
 * (folder names usually lead with the place), qualified by the dominant
 * country's name — e.g. "Old Town, Italy". Tokens that merely repeat the country
 * are dropped so they don't crowd out the real place or duplicate the suffix.
 * Falls back to the country name, then a generic "Area".
 */
function placeName(photos) {
  const cc = mode(photos.map((p) => p.country_code));
  const country = cc ? countryName(cc) : null;
  const countryLc = country ? country.toLowerCase() : null;
  const ccLc = cc ? cc.toLowerCase() : null;

  const counts = new Map();
  for (const p of photos) {
    for (const kw of extractKeywords(p.folder_name)) {
      if (kw === ccLc || kw === countryLc) continue;
      counts.set(kw, (counts.get(kw) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [kw, n] of counts) if (n > bestN) { best = kw; bestN = n; }

  if (best) {
    const label = titleCase(best);
    return country && label.toLowerCase() !== countryLc ? `${label}, ${country}` : label;
  }
  return country || 'Area';
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEASONS = ['Winter', 'Spring', 'Summer', 'Autumn']; // N-hemisphere, by month
const DAY_MS = 24 * 3600 * 1000;
const seasonOf = (m) => SEASONS[Math.floor(((m + 1) % 12) / 3)]; // Dec–Feb=Winter

/**
 * Compact, scale-aware date label for a group's [start, end] span (UTC, matching
 * how dates are stored/shown elsewhere). The wider the span, the coarser the
 * label — a single day stays a day; a whole year collapses to just the year.
 */
function dateRangeLabel(startIso, endIso) {
  const a = new Date(startIso);
  const b = new Date(endIso || startIso);
  if (Number.isNaN(a.getTime())) return '';
  const ay = a.getUTCFullYear(), by = b.getUTCFullYear();
  const am = a.getUTCMonth(), bm = b.getUTCMonth();
  const ad = a.getUTCDate(), bd = b.getUTCDate();
  const spanDays = (b.getTime() - a.getTime()) / DAY_MS;

  if (ay === by && am === bm && ad === bd) return `${MON[am]} ${ad}, ${ay}`;          // one day
  if (ay === by && am === bm) return `${MON[am]} ${ad}–${bd}, ${ay}`;                  // within a month
  if (ay === by) {
    // A whole calendar year, or a single season inside it, else a month span.
    if (am === 0 && bm === 11 && spanDays > 300) return String(ay);
    if (seasonOf(am) === seasonOf(bm)) return `${seasonOf(am)} ${ay}`;
    return `${MON[am]} – ${MON[bm]} ${ay}`;
  }
  if (spanDays > 330 * (by - ay)) return `${ay}–${by}`;                                // multi-year run
  return `${MON[am]} ${ay} – ${MON[bm]} ${by}`;
}

module.exports = { placeName, dateRangeLabel };
