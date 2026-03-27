// =============================================================================
// Fleet Commander — Encryption Utilities (AES-256-GCM)
// =============================================================================
// Provides transparent encryption/decryption for sensitive data stored in SQLite.
// Uses Node.js built-in `crypto` module — no external dependencies.
//
// Key resolution order:
//   1. FLEET_ENCRYPTION_KEY env var (64 hex characters = 32 bytes)
//   2. Auto-generated key file at {dataDir}/fleet-encryption.key
// =============================================================================

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;      // 128-bit auth tag
const KEY_LENGTH = 32;      // 256-bit key

// Base64 lengths for the encoded components (used by isEncrypted)
const IV_BASE64_LENGTH = 16;   // 12 bytes -> 16 base64 chars
const TAG_BASE64_LENGTH = 24;  // 16 bytes -> 24 base64 chars

// Module-level cached key
let _encryptionKey: Buffer | null = null;

/**
 * Validate that a string is exactly 64 hex characters (32 bytes).
 */
function isValidHexKey(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Resolve and cache the encryption key.
 *
 * Resolution order:
 *   1. `FLEET_ENCRYPTION_KEY` env var (64 hex chars = 32 bytes)
 *   2. Read from `{dataDir}/fleet-encryption.key`
 *   3. Generate a new random key and write it to `{dataDir}/fleet-encryption.key`
 *
 * The data directory is determined by `FLEET_DB_PATH` (dirname) or the
 * platform default data dir, matching the logic in config.ts.
 *
 * @throws Error if FLEET_ENCRYPTION_KEY is set but invalid
 */
export function initEncryptionKey(): void {
  if (_encryptionKey) return;

  const envKey = process.env['FLEET_ENCRYPTION_KEY'];

  if (envKey) {
    if (!isValidHexKey(envKey)) {
      throw new Error(
        'FLEET_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
        `Got ${envKey.length} characters.`
      );
    }
    _encryptionKey = Buffer.from(envKey, 'hex');
    return;
  }

  // Resolve the data directory from FLEET_DB_PATH or platform default
  const keyFilePath = resolveKeyFilePath();

  if (fs.existsSync(keyFilePath)) {
    const hex = fs.readFileSync(keyFilePath, 'utf-8').trim();
    if (!isValidHexKey(hex)) {
      throw new Error(
        `Encryption key file ${keyFilePath} contains invalid data. ` +
        'Expected 64 hex characters (32 bytes).'
      );
    }
    _encryptionKey = Buffer.from(hex, 'hex');
    return;
  }

  // Auto-generate a new key
  const newKey = crypto.randomBytes(KEY_LENGTH);
  const dir = path.dirname(keyFilePath);
  fs.mkdirSync(dir, { recursive: true });

  // Use exclusive create to prevent race conditions
  try {
    fs.writeFileSync(keyFilePath, newKey.toString('hex') + '\n', {
      flag: 'wx',
      mode: 0o600,  // owner-only read/write (no-op on Windows, acceptable)
    });
  } catch (err: unknown) {
    // If the file was created by another process between our check and write,
    // read it instead
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
      const hex = fs.readFileSync(keyFilePath, 'utf-8').trim();
      if (!isValidHexKey(hex)) {
        throw new Error(
          `Encryption key file ${keyFilePath} contains invalid data. ` +
          'Expected 64 hex characters (32 bytes).'
        );
      }
      _encryptionKey = Buffer.from(hex, 'hex');
      return;
    }
    throw err;
  }

  _encryptionKey = newKey;
  console.log(`[Crypto] Generated new encryption key at ${keyFilePath}`);
}

/**
 * Resolve the path to the encryption key file.
 * Co-located with the database file in the data directory.
 */
function resolveKeyFilePath(): string {
  // Import config dynamically to avoid circular dependency at module load time.
  // We only need the dbPath to find the data directory.
  const dbPath = process.env['FLEET_DB_PATH'] || getDefaultDbDir();
  return path.join(path.dirname(dbPath), 'fleet-encryption.key');
}

/**
 * Get the default database directory (mirrors config.ts defaultDataDir logic).
 */
function getDefaultDbDir(): string {
  const os = require('os') as typeof import('os');
  const APP_DIR = 'fleet-commander';

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_DIR, 'fleet.db');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR, 'fleet.db');
  }

  const dataHome = process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, APP_DIR, 'fleet.db');
}

/**
 * Get the resolved encryption key, initializing lazily if needed.
 */
function getKey(): Buffer {
  if (!_encryptionKey) {
    initEncryptionKey();
  }
  return _encryptionKey!;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt (UTF-8)
 * @returns Encrypted string in format `base64(iv):base64(ciphertext):base64(authTag)`
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

/**
 * Decrypt an encrypted string using AES-256-GCM with the module-level key.
 *
 * @param encrypted - String in format `base64(iv):base64(ciphertext):base64(authTag)`
 * @returns Decrypted plaintext (UTF-8)
 * @throws Error if the data is tampered, invalid, or the key is wrong
 */
export function decrypt(encrypted: string): string {
  return decryptWithKey(encrypted, getKey());
}

/**
 * Decrypt an encrypted string using AES-256-GCM with an explicitly provided key.
 * Used for key rotation where the old key differs from the current module-level key.
 *
 * @param encrypted - String in format `base64(iv):base64(ciphertext):base64(authTag)`
 * @param key - 32-byte encryption key
 * @returns Decrypted plaintext (UTF-8)
 * @throws Error if the data is tampered, invalid, or the key is wrong
 */
export function decryptWithKey(encrypted: string, key: Buffer): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format: expected 3 colon-separated base64 segments');
  }

  const [ivB64, ciphertextB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: expected ${TAG_LENGTH}, got ${tag.length}`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

/**
 * Check if a string appears to be in the encrypted format.
 *
 * Returns true if the value matches the `base64:base64:base64` pattern where:
 * - First segment is 16 chars (12-byte IV in base64)
 * - Third segment is 24 chars (16-byte auth tag in base64)
 * - All segments are valid base64
 *
 * This is used to distinguish plaintext from encrypted values during migration.
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;

  const [ivB64, , tagB64] = parts;

  // Check base64 lengths for IV and tag
  if (ivB64.length !== IV_BASE64_LENGTH) return false;
  if (tagB64.length !== TAG_BASE64_LENGTH) return false;

  // Validate all parts are valid base64
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  return parts.every(part => part.length > 0 && base64Regex.test(part));
}

/**
 * Get the current encryption key for testing purposes only.
 */
export function getEncryptionKeyForTesting(): Buffer | null {
  return _encryptionKey;
}

/**
 * Clear the cached encryption key. Used for test isolation.
 */
export function resetEncryptionKey(): void {
  _encryptionKey = null;
}
