'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { decryptBackup, readKey } = require('../scripts/backup-crypto');
const { restoreBackup } = require('../scripts/restore-backup');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-backup-test-'));
  const originalFetch = global.fetch;
  try {
    const sourcePath = path.join(dir, 'source.db');
    const source = new Database(sourcePath);
    source.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES (1, \'private-test-marker\')');
    source.close();
    process.env.DB_PATH = sourcePath;
    process.env.BACKUP_DIR = path.join(dir, 'backups');
    process.env.BACKUP_S3_BUCKET = 'test-bucket';
    process.env.BACKUP_S3_REGION = 'us-west-004';
    process.env.BACKUP_S3_ENDPOINT = 'https://s3.us-west-004.backblazeb2.com';
    process.env.BACKUP_S3_ACCESS_KEY = 'test-access-key';
    process.env.BACKUP_S3_SECRET_KEY = 'test-secret-key';
    process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    const { runBackup } = require('../scripts/backup');

    let uploaded;
    global.fetch = async (url, options) => {
      assert.match(url, /\.db\.enc$/);
      uploaded = Buffer.from(options.body);
      assert.equal(uploaded.includes(Buffer.from('private-test-marker')), false);
      assert.equal(options.headers['x-amz-content-sha256'], crypto.createHash('sha256').update(uploaded).digest('hex'));
      return { ok: true };
    };
    const result = await runBackup();
    assert.equal(result.ok, true);
    assert.equal(result.s3, true);
    assert.ok(uploaded);
    assert.ok(decryptBackup(uploaded, readKey()).equals(fs.readFileSync(result.local)));

    const encryptedFile = path.join(dir, 'downloaded.db.enc');
    fs.writeFileSync(encryptedFile, uploaded);
    const restored = restoreBackup(encryptedFile, path.join(dir, 'restored.db'));
    const db = new Database(restored, { readonly: true });
    assert.equal(db.prepare('SELECT count(*) AS count FROM users').get().count, 1);
    db.close();
    assert.throws(() => restoreBackup(encryptedFile, restored), /already exists/);

    const damaged = Buffer.from(uploaded);
    damaged[damaged.length - 1] ^= 1;
    fs.writeFileSync(encryptedFile, damaged);
    assert.throws(() => restoreBackup(encryptedFile, path.join(dir, 'tampered.db')), /authenticate/);
    assert.equal(fs.existsSync(path.join(dir, 'tampered.db')), false);

    delete process.env.BACKUP_ENCRYPTION_KEY;
    global.fetch = async () => { throw new Error('Upload must not happen without encryption'); };
    const missingKey = await runBackup();
    assert.equal(missingKey.ok, false);
    assert.equal(missingKey.s3, false);
    console.log('Encrypted backup and restore tests passed');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
