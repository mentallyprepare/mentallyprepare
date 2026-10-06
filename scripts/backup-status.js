const fs = require('fs');
const path = require('path');
const { getDBPath } = require('./backup-paths');

const statusPath = () => process.env.BACKUP_STATUS_PATH || path.join(path.dirname(getDBPath()), 'backup-status.json');

function readStatus() {
  try { return JSON.parse(fs.readFileSync(statusPath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function writeStatus(changes) {
  const target = statusPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...readStatus(), ...changes }) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = { readStatus, writeStatus, statusPath };
