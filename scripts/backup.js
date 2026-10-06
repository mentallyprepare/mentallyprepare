#!/usr/bin/env node
// SQLite backup: snapshot DB to local file, upload to S3 if configured.
// Run standalone: node scripts/backup.js
// Or called from cron in server.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { readKey, encryptBackup } = require('./backup-crypto');

const IS_PROD = process.env.NODE_ENV === 'production';
const DB_PATH = process.env.DB_PATH
  || path.join(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || (IS_PROD ? '/data/db' : path.join(__dirname, '..')), 'mentally-prepare.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');

async function runBackup() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('Backup skipped: DB not found at', DB_PATH);
    return { ok: false, reason: 'db_not_found' };
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `mentally-prepare-${timestamp}.db`);

  const source = new Database(DB_PATH, { readonly: true });
  try {
    await source.backup(backupFile);
  } finally {
    source.close();
  }

  const stat = fs.statSync(backupFile);
  console.log(`Backup created: ${backupFile} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

  // Prune local backups older than 7 days
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const fp = path.join(BACKUP_DIR, f);
    try {
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        console.log('Pruned old backup:', f);
      }
    } catch {}
  }

  // Upload to S3 if configured
  const bucket = process.env.BACKUP_S3_BUCKET;
  const region = process.env.BACKUP_S3_REGION || 'us-east-1';
  const accessKey = process.env.BACKUP_S3_ACCESS_KEY;
  const secretKey = process.env.BACKUP_S3_SECRET_KEY;
  const endpoint = process.env.BACKUP_S3_ENDPOINT;

  const anyOffsiteSetting = [bucket, accessKey, secretKey, endpoint].some(Boolean);
  if (anyOffsiteSetting && !(bucket && accessKey && secretKey)) {
    console.error('Offsite backup configuration is incomplete');
    return { ok: false, local: backupFile, s3: false, reason: 'offsite_configuration_incomplete' };
  }

  if (bucket && accessKey && secretKey) {
    try {
      const encryptionKey = readKey();
      const plaintext = fs.readFileSync(backupFile);
      const encrypted = encryptBackup(plaintext, encryptionKey);
      await uploadToS3({ bucket, region, accessKey, secretKey, endpoint, body: encrypted, timestamp });
      console.log('Encrypted backup uploaded to S3:', bucket);
    } catch (e) {
      console.error('Encrypted offsite backup failed:', e.message);
      return { ok: false, local: backupFile, s3: false, reason: 'offsite_backup_failed' };
    }
  } else {
    console.log('S3 not configured (set BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY). Local backup only.');
  }

  return { ok: true, local: backupFile, s3: Boolean(bucket), size: stat.size };
}

async function uploadToS3({ bucket, region, accessKey, secretKey, endpoint, body, timestamp }) {
  const prefix = (process.env.BACKUP_S3_KEY_PREFIX || 'mentally-prepare/backups').replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('BACKUP_S3_KEY_PREFIX must be a nonempty object key prefix');
  }
  const key = `${prefix}/mentally-prepare-${timestamp}.db.enc`;
  const encodedKey = key.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  const host = endpoint || `${bucket}.s3.${region}.amazonaws.com`;
  const url = endpoint ? `${endpoint}/${bucket}/${encodedKey}` : `https://${host}/${encodedKey}`;

  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const shortDate = dateStamp.slice(0, 8);
  const scope = `${shortDate}/${region}/s3/aws4_request`;

  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = [
    'PUT', new URL(url).pathname, '',
    `host:${new URL(url).host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${dateStamp}`,
    '',
    'host;x-amz-content-sha256;x-amz-date',
    payloadHash
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256', dateStamp, scope,
    crypto.createHash('sha256').update(canonical).digest('hex')
  ].join('\n');

  const sigKey = [shortDate, region, 's3', 'aws4_request'].reduce(
    (k, msg) => crypto.createHmac('sha256', k).update(msg).digest(),
    Buffer.from('AWS4' + secretKey)
  );
  const signature = crypto.createHmac('sha256', sigKey).update(stringToSign).digest('hex');

  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Host': new URL(url).host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': dateStamp,
      'Authorization': auth,
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length.toString()
    },
    body
  });

  if (!res.ok) {
    throw new Error(`S3 PUT ${res.status}`);
  }
}

// Run standalone
if (require.main === module) {
  runBackup().then(r => {
    console.log('Backup result:', JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }).catch(e => {
    console.error('Backup failed:', e);
    process.exit(1);
  });
}

module.exports = { runBackup };
