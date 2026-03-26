// ═══════════════════════════════════════
// MENTALLY PREPARE — Database Backup
// Run daily via cron: node backup.js
// ═══════════════════════════════════════
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data/mentally-prepare.db';
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 14; // Keep last 14 days

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const backupFile = path.join(BACKUP_DIR, `backup-${date}.db`);

if (!fs.existsSync(DB_PATH)) {
  console.log('No database found at', DB_PATH);
  process.exit(1);
}

// Use SQLite's online backup API for a safe copy
const Database = require('better-sqlite3');
const db = new Database(DB_PATH, { readonly: true });
db.backup(backupFile).then(() => {
  db.close();
  console.log(`✓ Backup saved: ${backupFile}`);

  // Clean old backups
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
    .sort()
    .reverse();

  if (files.length > MAX_BACKUPS) {
    for (const old of files.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
      console.log(`  Removed old backup: ${old}`);
    }
  }

  console.log(`✓ ${Math.min(files.length, MAX_BACKUPS)} backups retained`);
}).catch(err => {
  db.close();
  console.error('Backup failed:', err);
  process.exit(1);
});
