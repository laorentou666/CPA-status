import fs from 'node:fs';
import path from 'node:path';

function integer(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function chownTree(target, uid, gid) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      chownTree(path.join(target, entry), uid, gid);
    }
  }
  fs.chownSync(target, uid, gid);
}

function prepareDataDirectory() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;

  const databasePath = process.env.DATABASE_PATH || '/data/cpa-status.db';
  const directory = path.dirname(path.resolve(databasePath));
  const uid = integer(process.env.DATA_UID, 1000);
  const gid = integer(process.env.DATA_GID, 1000);

  fs.mkdirSync(directory, { recursive: true });
  try {
    chownTree(directory, uid, gid);
    process.setgid(gid);
    process.setuid(uid);
    console.log(`[cpa-status] data directory ready: ${directory} (uid=${uid}, gid=${gid})`);
  } catch (error) {
    // Rootless and some network filesystems reject chown. Continue as the current
    // container user so writable mounts still work, and let Store report a clear error otherwise.
    console.warn(`[cpa-status] could not change data ownership for ${directory}: ${error.message}`);
  }
}

prepareDataDirectory();
await import('./main.js');
