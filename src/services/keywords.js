'use strict';

const config = require('../config');
const { getDb } = require('../db/database');

/**
 * Folder-name keyword extraction (plan/features.md Section 3B).
 *
 * Extracts clean keywords from folder names for word clustering and the tag
 * recommendation engine. Filters dates, numbers, system strings (DCIM, IMG_01,
 * 100CANON), and stopwords (English defaults + user-defined).
 */

const DEFAULT_STOPWORDS = new Set([
  ...config.tagging.STOPWORDS,
  // common English stopwords
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'my', 'our', 'new', 'old', 'misc', 'untitled', 'folder', 'pictures', 'photos',
]);

// system / device noise patterns
const SYSTEM_RE = /^(dcim|img|dsc|pano|mvimg|vid|mov|gopr|p\d+|100\w+|\d+canon|screenshot)$/i;

function extractKeywords(folderName, extraStopwords = []) {
  if (!folderName) return [];
  const stop = new Set([...DEFAULT_STOPWORDS, ...extraStopwords.map((w) => w.toLowerCase())]);
  const tokens = String(folderName)
    .replace(/[_\-.]+/g, ' ')
    .split(/[^A-Za-z]+/) // split on anything non-alphabetic (drops numbers/dates)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const tok of tokens) {
    if (tok.length < 3) continue;          // drop very short tokens
    if (stop.has(tok)) continue;
    if (SYSTEM_RE.test(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * (Re)generate automatic folder-keyword tags for all active photos.
 *
 * Each photo's automatic tags are reconciled to mirror its *current* folder name:
 * missing keywords are linked and keywords the folder no longer yields are
 * unlinked. This keeps a moved/renamed photo from carrying its old folder's
 * keyword tags forever (which would otherwise pollute search, clustering, and
 * recommendations). Manual tags (type='manual') are never read or removed here.
 */
function regenerateFolderTags() {
  const db = getDb();
  const photos = db
    .prepare("SELECT id, folder_name FROM photos WHERE status = 'active'")
    .all();

  const upsertTag = db.prepare(
    "INSERT INTO tags (name, type) VALUES (?, 'automatic') ON CONFLICT(name) DO NOTHING"
  );
  const getTagId = db.prepare('SELECT id FROM tags WHERE name = ?');
  const link = db.prepare(
    'INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)'
  );
  const curAuto = db.prepare(
    "SELECT t.id, t.name FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id " +
    "WHERE pt.photo_id = ? AND t.type = 'automatic'"
  );
  const unlink = db.prepare('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?');

  let created = 0;
  const tx = db.transaction(() => {
    for (const p of photos) {
      const want = new Set(extractKeywords(p.folder_name));
      // Drop automatic links the current folder name no longer implies.
      for (const t of curAuto.all(p.id)) {
        if (!want.has(t.name)) unlink.run(p.id, t.id);
      }
      // Add automatic links for any keyword the photo is missing.
      for (const kw of want) {
        upsertTag.run(kw);
        const tag = getTagId.get(kw);
        if (!tag) continue;
        if (link.run(p.id, tag.id).changes) created++;
      }
    }
    // Sweep automatic tags that now link to no photo (e.g. a renamed folder's old
    // keywords) so the tags table doesn't accumulate dead rows.
    db.prepare(
      "DELETE FROM tags WHERE type = 'automatic' AND id NOT IN (SELECT tag_id FROM photo_tags)"
    ).run();
  });
  tx();
  return created;
}

module.exports = { extractKeywords, regenerateFolderTags };
