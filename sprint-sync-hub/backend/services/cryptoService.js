'use strict';

const crypto = require('crypto');
const ALGO   = 'aes-256-gcm';

/**
 * Returns the 32-byte encryption key from ENCRYPTION_KEY env var.
 * Accepts either a 64-char hex string or a 32-char plain string.
 */
function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Stored credentials cannot be read or written without it.\n' +
      '  Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (raw.length === 64) return Buffer.from(raw, 'hex');     // 32 bytes as hex
  if (raw.length === 32) return Buffer.from(raw, 'utf8');    // 32 raw chars
  throw new Error('ENCRYPTION_KEY must be 32 characters or 64 hex characters');
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns "iv_hex:authtag_hex:ciphertext_hex".
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  const iv       = crypto.randomBytes(12);
  const cipher   = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc      = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag      = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/**
 * Decrypts a value produced by encrypt().
 */
const ENCRYPTED_SHAPE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/i;

/**
 * Decrypts a value produced by encrypt().
 *
 * Values that were stored before encryption was introduced are passed through
 * unchanged. A value that IS in encrypted form but fails to decrypt throws —
 * returning the raw ciphertext instead would hand a corrupt string to whatever
 * asked for a credential, turning a key mismatch into a confusing API error
 * somewhere far away.
 */
function decrypt(ciphertext) {
  if (ciphertext == null || ciphertext === '') return ciphertext;
  if (!ENCRYPTED_SHAPE.test(ciphertext)) return ciphertext;

  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  try {
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch (err) {
    throw new Error(`Failed to decrypt stored value — ENCRYPTION_KEY may have changed since it was saved (${err.message})`);
  }
}

/** Masks a secret for display — shows first 4 and last 4 chars. */
function mask(value) {
  if (!value || value.length < 8) return '••••••••';
  const show = Math.min(4, Math.floor(value.length * 0.15));
  return value.slice(0, show) + '••••' + value.slice(-4);
}

module.exports = { encrypt, decrypt, mask };
