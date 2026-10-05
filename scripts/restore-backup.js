#!/usr/bin/env node
// Decrypt a downloaded .db.enc backup into a new local SQLite file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { readKey, decryptBackup } = require('./backup-crypto');

function restoreBackup(input, output, key = readKey()) {
  if (!input || !output) throw new Error('Usage: node scripts/restore-backup.js <downloaded.db.enc> <new.db>');
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) throw new Error('Restore destination already exists');
  const plaintext = decryptBackup(fs.readFileSync(input), key);
  const temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let db;
  try {
    fs.writeFileSync(temporary, plaintext, { mode: 0o600, flag: 'wx' });
    db = new Database(temporary, { readonly: true, fileMustExist: true });
    const result = db.pragma('integrity_check');
    if (result.length !== 1 || result[0].integrity_check !== 'ok') {
      throw new Error('Restored SQLite integrity check failed');
    }
    db.close();
    db = null;
    fs.renameSync(temporary, destination);
    return destination;
  } finally {
    if (db) db.close();
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

if (require.main === module) {
  try {
    const destination = restoreBackup(process.argv[2], process.argv[3]);
    console.log('Encrypted backup restored and SQLite integrity check passed:', destination);
  } catch (error) {
    console.error('Restore failed:', error.message);
    process.exitCode = 1;
  }
}

module.exports = { restoreBackup };
