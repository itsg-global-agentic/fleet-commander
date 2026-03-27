// =============================================================================
// Fleet Commander — Encryption Utility Tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  encrypt,
  decrypt,
  decryptWithKey,
  isEncrypted,
  initEncryptionKey,
  resetEncryptionKey,
  getEncryptionKeyForTesting,
} from '../../src/server/utils/crypto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 32-byte hex key for testing. */
function randomHexKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

let tempDir: string;

function createTempDir(): string {
  const dir = path.join(os.tmpdir(), `fleet-crypto-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(): void {
  try {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown — ensure clean state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetEncryptionKey();
  // Clear env vars
  delete process.env['FLEET_ENCRYPTION_KEY'];
  delete process.env['FLEET_ENCRYPTION_KEY_OLD'];
  delete process.env['FLEET_DB_PATH'];
  tempDir = createTempDir();
});

afterEach(() => {
  resetEncryptionKey();
  delete process.env['FLEET_ENCRYPTION_KEY'];
  delete process.env['FLEET_ENCRYPTION_KEY_OLD'];
  delete process.env['FLEET_DB_PATH'];
  cleanupTempDir();
});

// =============================================================================
// Key initialization
// =============================================================================

describe('initEncryptionKey', () => {
  it('should use FLEET_ENCRYPTION_KEY env var when set', () => {
    const key = randomHexKey();
    process.env['FLEET_ENCRYPTION_KEY'] = key;
    initEncryptionKey();
    const resolved = getEncryptionKeyForTesting();
    expect(resolved).not.toBeNull();
    expect(resolved!.toString('hex')).toBe(key);
  });

  it('should throw when FLEET_ENCRYPTION_KEY is invalid hex', () => {
    process.env['FLEET_ENCRYPTION_KEY'] = 'not-valid-hex';
    expect(() => initEncryptionKey()).toThrow('FLEET_ENCRYPTION_KEY must be exactly 64 hex characters');
  });

  it('should throw when FLEET_ENCRYPTION_KEY is wrong length', () => {
    process.env['FLEET_ENCRYPTION_KEY'] = 'abcdef1234567890'; // only 16 chars
    expect(() => initEncryptionKey()).toThrow('FLEET_ENCRYPTION_KEY must be exactly 64 hex characters');
  });

  it('should auto-generate key file when no env var is set', () => {
    const dbPath = path.join(tempDir, 'fleet.db');
    process.env['FLEET_DB_PATH'] = dbPath;

    initEncryptionKey();

    const keyFilePath = path.join(tempDir, 'fleet-encryption.key');
    expect(fs.existsSync(keyFilePath)).toBe(true);

    const hex = fs.readFileSync(keyFilePath, 'utf-8').trim();
    expect(hex).toMatch(/^[0-9a-fA-F]{64}$/);

    const resolved = getEncryptionKeyForTesting();
    expect(resolved).not.toBeNull();
    expect(resolved!.toString('hex')).toBe(hex);
  });

  it('should read existing key file', () => {
    const dbPath = path.join(tempDir, 'fleet.db');
    process.env['FLEET_DB_PATH'] = dbPath;

    const existingKey = randomHexKey();
    const keyFilePath = path.join(tempDir, 'fleet-encryption.key');
    fs.writeFileSync(keyFilePath, existingKey + '\n');

    initEncryptionKey();

    const resolved = getEncryptionKeyForTesting();
    expect(resolved).not.toBeNull();
    expect(resolved!.toString('hex')).toBe(existingKey);
  });

  it('should not reinitialize if already initialized', () => {
    const key = randomHexKey();
    process.env['FLEET_ENCRYPTION_KEY'] = key;
    initEncryptionKey();

    // Change env var — should have no effect since key is cached
    process.env['FLEET_ENCRYPTION_KEY'] = randomHexKey();
    initEncryptionKey();

    expect(getEncryptionKeyForTesting()!.toString('hex')).toBe(key);
  });
});

// =============================================================================
// Encrypt / Decrypt round-trip
// =============================================================================

describe('encrypt / decrypt', () => {
  beforeEach(() => {
    process.env['FLEET_ENCRYPTION_KEY'] = randomHexKey();
  });

  it('should round-trip a simple string', () => {
    const plaintext = 'hello world';
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('should round-trip an empty string', () => {
    const plaintext = '';
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('should round-trip Unicode text', () => {
    const plaintext = 'Hello \u{1F600} \u00E9\u00E8\u00EA \u4F60\u597D';
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('should round-trip JSON with credentials', () => {
    const plaintext = JSON.stringify({
      baseUrl: 'https://myco.atlassian.net',
      apiToken: 'secret-token-12345',
    });
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
    expect(JSON.parse(decrypt(encrypted))).toEqual({
      baseUrl: 'https://myco.atlassian.net',
      apiToken: 'secret-token-12345',
    });
  });

  it('should produce different ciphertext on each call (random IV)', () => {
    const plaintext = 'same input';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);  // Different IVs
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it('should produce output in base64:base64:base64 format', () => {
    const encrypted = encrypt('test');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    // Each part should be valid base64
    const base64Regex = /^[A-Za-z0-9+/]+=*$/;
    for (const part of parts) {
      expect(part).toMatch(base64Regex);
    }
  });

  it('should throw on tampered ciphertext', () => {
    const encrypted = encrypt('original');
    const parts = encrypted.split(':');
    // Tamper with the ciphertext part
    const tampered = `${parts[0]}:${Buffer.from('tampered').toString('base64')}:${parts[2]}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('should throw on tampered auth tag', () => {
    const encrypted = encrypt('original');
    const parts = encrypted.split(':');
    // Replace auth tag with random bytes
    const fakeTag = crypto.randomBytes(16).toString('base64');
    const tampered = `${parts[0]}:${parts[1]}:${fakeTag}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('should throw on invalid format (missing parts)', () => {
    expect(() => decrypt('onlyonepart')).toThrow('expected 3 colon-separated');
    expect(() => decrypt('two:parts')).toThrow('expected 3 colon-separated');
  });
});

// =============================================================================
// decryptWithKey
// =============================================================================

describe('decryptWithKey', () => {
  it('should decrypt with an explicitly provided key', () => {
    const keyHex = randomHexKey();
    process.env['FLEET_ENCRYPTION_KEY'] = keyHex;
    const plaintext = 'decrypt with explicit key';
    const encrypted = encrypt(plaintext);

    // Reset the module key and use explicit key
    resetEncryptionKey();
    const key = Buffer.from(keyHex, 'hex');
    expect(decryptWithKey(encrypted, key)).toBe(plaintext);
  });

  it('should fail with wrong key', () => {
    process.env['FLEET_ENCRYPTION_KEY'] = randomHexKey();
    const encrypted = encrypt('secret data');

    const wrongKey = crypto.randomBytes(32);
    expect(() => decryptWithKey(encrypted, wrongKey)).toThrow();
  });
});

// =============================================================================
// isEncrypted
// =============================================================================

describe('isEncrypted', () => {
  beforeEach(() => {
    process.env['FLEET_ENCRYPTION_KEY'] = randomHexKey();
  });

  it('should return true for encrypted values', () => {
    const encrypted = encrypt('test');
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it('should return false for plain JSON', () => {
    expect(isEncrypted('{"baseUrl":"https://example.com","apiToken":"abc"}')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isEncrypted('')).toBe(false);
  });

  it('should return false for simple strings', () => {
    expect(isEncrypted('hello world')).toBe(false);
    expect(isEncrypted('not-encrypted')).toBe(false);
  });

  it('should return false for two-part colon string', () => {
    expect(isEncrypted('part1:part2')).toBe(false);
  });

  it('should return false for three parts with wrong IV length', () => {
    expect(isEncrypted('short:data:data')).toBe(false);
  });

  it('should return false for URL-like strings with colons', () => {
    expect(isEncrypted('https://example.com:8080/path')).toBe(false);
  });
});

// =============================================================================
// resetEncryptionKey
// =============================================================================

describe('resetEncryptionKey', () => {
  it('should clear the cached key', () => {
    process.env['FLEET_ENCRYPTION_KEY'] = randomHexKey();
    initEncryptionKey();
    expect(getEncryptionKeyForTesting()).not.toBeNull();

    resetEncryptionKey();
    expect(getEncryptionKeyForTesting()).toBeNull();
  });
});
