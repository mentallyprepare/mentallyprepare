#!/usr/bin/env node
// Download the latest recorded encrypted object and verify a private restore.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { readStatus, writeStatus } = require('./backup-status');
const { signedS3Request } = require('./backup');
const { restoreBackup } = require('./restore-backup');

async function verifyOffsiteBackup() {
  let dir;
  try {
    const status = readStatus();
    const key = status.lastOffsiteKey;
    const prefix = (process.env.BACKUP_S3_KEY_PREFIX || 'mentally-prepare/backups').replace(/^\/+|\/+$/g, '');
    if (!key || !key.startsWith(`${prefix}/`) || !/^mentally-prepare-[\w-]+\.db\.enc$/.test(key.slice(prefix.length + 1))) {
      throw new Error('No valid recorded offsite backup key');
    }
    const bucket = process.env.BACKUP_S3_BUCKET;
    const accessKey = process.env.BACKUP_S3_ACCESS_KEY;
    const secretKey = process.env.BACKUP_S3_SECRET_KEY;
    if (!bucket || !accessKey || !secretKey) throw new Error('Offsite read configuration is incomplete');
    const res = await signedS3Request({ method: 'GET', bucket, region: process.env.BACKUP_S3_REGION || 'us-east-1', accessKey, secretKey, endpoint: process.env.BACKUP_S3_ENDPOINT, key });
    if (!res.ok) throw new Error(`S3 GET ${res.status}`);
    const maxBytes = 512 * 1024 * 1024;
    if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('Backup exceeds restore drill size limit');
    const encrypted = Buffer.from(await res.arrayBuffer());
    if (encrypted.length > maxBytes) throw new Error('Backup exceeds restore drill size limit');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-restore-check-'));
    const input = path.join(dir, 'backup.db.enc');
    const output = path.join(dir, 'restored.db');
    fs.writeFileSync(input, encrypted, { mode: 0o600 });
    restoreBackup(input, output);
    const db = new Database(output, { readonly: true, fileMustExist: true });
    try { db.prepare('SELECT count(*) AS n FROM users').get(); }
    finally { db.close(); }
    writeStatus({ lastRestoreSuccessAt: new Date().toISOString(), lastRestoreFailureCode: null });
    console.log('Encrypted offsite restore verified: SQLite integrity and users table ok');
    return { ok: true };
  } catch (error) {
    writeStatus({ lastRestoreFailureCode: 'restore_verification_failed' });
    console.error('Encrypted offsite restore verification failed:', error.message);
    return { ok: false, reason: 'restore_verification_failed' };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  verifyOffsiteBackup().then(result => { process.exitCode = result.ok ? 0 : 1; });
}

module.exports = { verifyOffsiteBackup };
