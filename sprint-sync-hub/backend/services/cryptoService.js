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
    // In dev with no key set, fall back to a deterministic dev key (insecure — only for local dev)
    console.warn('[cryptoService] ENCRYPTION_KEY not set — using dev fallback. Set a real key in production!');
    return Buffer.from('automation-hub-dev-key-0000000000'.slice(0, 32), 'utf8');
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
function decrypt(ciphertext) {
  if (ciphertext == null || ciphertext === '') return ciphertext;
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext; // not encrypted — return as-is
    const [ivHex, tagHex, encHex] = parts;
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return ciphertext; // fallback — return raw value if decryption fails
  }
}

/** Masks a secret for display — shows first 4 and last 4 chars. */
function mask(value) {
  if (!value || value.length < 8) return '••••••••';
  const show = Math.min(4, Math.floor(value.length * 0.15));
  return value.slice(0, show) + '••••' + value.slice(-4);
}

module.exports = { encrypt, decrypt, mask };
