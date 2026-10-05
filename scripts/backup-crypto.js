const crypto = require('crypto');

const MAGIC = Buffer.from('MPBK1');
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function readKey(value = process.env.BACKUP_ENCRYPTION_KEY) {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters');
  }
  return Buffer.from(value, 'hex');
}

function encryptBackup(plaintext, key) {
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptBackup(envelope, key) {
  const headerLength = MAGIC.length + NONCE_LENGTH + TAG_LENGTH;
  if (envelope.length <= headerLength || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Invalid encrypted backup format');
  }
  const nonce = envelope.subarray(MAGIC.length, MAGIC.length + NONCE_LENGTH);
  const tag = envelope.subarray(MAGIC.length + NONCE_LENGTH, headerLength);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(envelope.subarray(headerLength)), decipher.final()]);
}

module.exports = { readKey, encryptBackup, decryptBackup };
