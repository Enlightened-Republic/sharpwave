// packages/server/src/crypt.ts
//
// Encrypted backup artifacts (".swbk") — Node built-in crypto only.
//
// Cipher: AES-256-GCM, 96-bit random nonce, 128-bit tag, streamed (the
// plaintext snapshot is never held in memory as a whole).
//
// Artifact format, version 1 (all integers big-endian):
//
//   offset  len  field
//   0       4    magic   "SWBK" (0x53 0x57 0x42 0x4B)
//   4       1    version 0x01
//   5       8    key id  first 8 bytes of SHA-256("sharpwave-backup-key-id/v1" || key)
//   13      12   nonce   random per artifact (crypto.randomBytes)
//   25      n    ciphertext (same length as the plaintext SQLite snapshot)
//   25+n    16   GCM authentication tag
//
// The 25-byte header is bound into the tag as AAD, so the magic, version, key
// id and nonce can't be altered without failing authentication.
//
// Next to each artifact a JSON manifest (<artifact>.json) records the SHA-256
// of the whole artifact file (verifiable WITHOUT the key, e.g. to check an
// upload), its size, the key id and an HMAC-SHA256 of the plaintext under a
// subkey derived from the backup key (HKDF), so a restore can prove that the
// decrypted bytes are exactly the bytes that were snapshotted without
// publishing a plaintext hash off-PC.
//
// The key is 32 random bytes. Key file: optional "#" comment lines plus one
// line of base64 (or 64 hex chars). Env var: the same base64/hex string.
// Nothing in this module ever logs, prints or embeds the key in an error.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

export const MAGIC = Buffer.from("SWBK", "ascii");
export const FORMAT_VERSION = 1;
export const KEY_BYTES = 32;
export const KEY_ID_BYTES = 8;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES + NONCE_BYTES; // 25
export const ARTIFACT_EXT = ".swbk";
export const MANIFEST_EXT = ".json";

/** A loaded backup key. `toString`/`toJSON`/inspect never reveal the bytes. */
export class BackupKey {
  readonly id: string;
  readonly #bytes: Buffer;
  constructor(bytes: Buffer, readonly source: string) {
    if (bytes.length !== KEY_BYTES) throw new Error(`backup key from ${source} must be ${KEY_BYTES} bytes (got ${bytes.length})`);
    this.#bytes = Buffer.from(bytes);
    this.id = keyIdOf(this.#bytes);
  }
  /** Raw key bytes — only for the cipher. Never log the result. */
  material(): Buffer {
    return this.#bytes;
  }
  macKey(): Buffer {
    return Buffer.from(hkdfSync("sha256", this.#bytes, Buffer.alloc(0), "sharpwave-backup/v1/plaintext-mac", 32));
  }
  toString(): string {
    return `BackupKey(${this.id})`;
  }
  toJSON(): string {
    return this.toString();
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update("sharpwave-backup-key-id/v1").update(key).digest().subarray(0, KEY_ID_BYTES).toString("hex");
}

/** Parse key text (comments allowed). Errors never echo the input. */
export function parseKeyText(text: string, source: string): BackupKey {
  const body = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join("");
  let bytes: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(body)) bytes = Buffer.from(body, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) {
    const b = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === KEY_BYTES) bytes = b;
  }
  if (!bytes) throw new Error(`backup key from ${source} is not a ${KEY_BYTES}-byte base64 or hex value`);
  return new BackupKey(bytes, source);
}

export const DEFAULT_KEY_ENV = "SHARPWAVE_BACKUP_KEY";

/** Env var wins when set and non-empty; otherwise the key file. */
export function loadKey(opts: { keyFile?: string; keyEnv?: string; env?: NodeJS.ProcessEnv }): BackupKey {
  const env = opts.env ?? process.env;
  const envName = opts.keyEnv ?? DEFAULT_KEY_ENV;
  const fromEnv = env[envName];
  if (fromEnv && fromEnv.trim()) return parseKeyText(fromEnv, `env ${envName}`);
  if (!opts.keyFile) throw new Error(`no backup key: set offsiteBackup.keyFile or the ${envName} env var (create one with: sharpwave-server backup keygen)`);
  if (!existsSync(opts.keyFile)) throw new Error(`backup key file ${opts.keyFile} does not exist (create it with: sharpwave-server backup keygen)`);
  return parseKeyText(readFileSync(opts.keyFile, "utf8"), `file ${opts.keyFile}`);
}

/** Write a fresh random key with owner-only permissions. Refuses to overwrite unless `force`; with `force` the old key is renamed to `<path>.old-<UTC>`, never deleted. */
export function generateKeyFile(path: string, force = false): BackupKey {
  if (existsSync(path) && !force) throw new Error(`${path} already exists — refusing to overwrite a backup key (backups made with it would become unreadable). Pass --force to replace it.`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = randomBytes(KEY_BYTES);
  const key = new BackupKey(bytes, `file ${path}`);
  const text =
    `# SharpWave off-PC backup key — AES-256-GCM, key id ${key.id}\n` +
    `# Anyone holding this file can decrypt your backups. Without it they are unrecoverable.\n` +
    `# Keep a copy in your password manager; never put it in the synced backup folder or the repo.\n` +
    `${bytes.toString("base64")}\n`;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600, flag: "w" });
  try { chmodSync(tmp, 0o600); } catch { /* windows: use icacls (README) */ }
  // --force: keep the previous key next to it (old artifacts still need it).
  if (existsSync(path)) renameSync(path, `${path}.old-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  renameSync(tmp, path);
  bytes.fill(0);
  return key;
}

export interface Manifest {
  format: "sharpwave-backup";
  version: number;
  cipher: "AES-256-GCM";
  artifact: string;
  /** SHA-256 (hex) of the entire artifact file. */
  sha256: string;
  bytes: number;
  keyId: string;
  plaintextBytes: number;
  /** HMAC-SHA256 of the plaintext under HKDF(key, "sharpwave-backup/v1/plaintext-mac"). */
  plaintextHmac: string;
  brain?: string;
  createdAt: string;
  source?: string;
}

export interface EncryptResult {
  artifact: string;
  manifestPath: string;
  manifest: Manifest;
}

/** Stream-encrypt `src` to `out` (+ `out.json` manifest). Writes via `.partial` then renames. */
export async function encryptFile(src: string, out: string, key: BackupKey, meta: { brain?: string; source?: string; now?: Date } = {}): Promise<EncryptResult> {
  mkdirSync(dirname(out), { recursive: true });
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), Buffer.from(key.id, "hex"), nonce]);
  const cipher = createCipheriv("aes-256-gcm", key.material(), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);
  const fileHash = createHash("sha256");
  const mac = createHmac("sha256", key.macKey());
  let plainBytes = 0;
  let outBytes = 0;
  const emit = (b: Buffer) => { fileHash.update(b); outBytes += b.length; return b; };
  const tmp = `${out}.partial`;
  try {
    await pipeline(
      createReadStream(src),
      async function* (source: AsyncIterable<Buffer>) {
        yield emit(header);
        for await (const chunk of source) {
          plainBytes += chunk.length;
          mac.update(chunk);
          const c = cipher.update(chunk);
          if (c.length) yield emit(c);
        }
        const f = cipher.final();
        if (f.length) yield emit(f);
        yield emit(cipher.getAuthTag());
      },
      createWriteStream(tmp, { mode: 0o600 }),
    );
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
  renameSync(tmp, out);
  const manifest: Manifest = {
    format: "sharpwave-backup",
    version: FORMAT_VERSION,
    cipher: "AES-256-GCM",
    artifact: out.split(/[\\/]/).pop()!,
    sha256: fileHash.digest("hex"),
    bytes: outBytes,
    keyId: key.id,
    plaintextBytes: plainBytes,
    plaintextHmac: mac.digest("hex"),
    ...(meta.brain ? { brain: meta.brain } : {}),
    createdAt: (meta.now ?? new Date()).toISOString(),
    ...(meta.source ? { source: meta.source } : {}),
  };
  const manifestPath = out + MANIFEST_EXT;
  writeFileSync(`${manifestPath}.partial`, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${manifestPath}.partial`, manifestPath);
  return { artifact: out, manifestPath, manifest };
}

export interface ArtifactHeader {
  version: number;
  keyId: string;
  nonce: Buffer;
  size: number;
}

/** True when the first bytes of `path` are the SWBK magic. */
export function isArtifact(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const b = Buffer.alloc(MAGIC.length);
      return readSync(fd, b, 0, b.length, 0) === b.length && b.equals(MAGIC);
    } finally { closeSync(fd); }
  } catch { return false; }
}

export function readHeader(path: string): ArtifactHeader {
  const size = statSync(path).size;
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error(`${path}: too short to be a SharpWave backup artifact`);
  const fd = openSync(path, "r");
  try {
    const h = Buffer.alloc(HEADER_BYTES);
    readSync(fd, h, 0, HEADER_BYTES, 0);
    if (!h.subarray(0, 4).equals(MAGIC)) throw new Error(`${path}: not a SharpWave backup artifact (bad magic)`);
    const version = h[4]!;
    if (version !== FORMAT_VERSION) throw new Error(`${path}: unsupported artifact version ${version}`);
    return { version, keyId: h.subarray(5, 13).toString("hex"), nonce: Buffer.from(h.subarray(13, 25)), size };
  } finally { closeSync(fd); }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest("hex");
}

export function readManifest(path: string): Manifest | undefined {
  if (!existsSync(path)) return undefined;
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (m.format !== "sharpwave-backup") throw new Error(`${path}: not a SharpWave backup manifest`);
  return m;
}

export interface DecryptResult {
  keyId: string;
  plaintextBytes: number;
  manifestChecked: boolean;
}

/**
 * Verify + decrypt `artifact` into `out`. Order: manifest sha256 of the whole
 * file (when a manifest is present or required), key id, then a streamed
 * decrypt into `out.partial`; the partial is deleted unless the GCM tag AND
 * the manifest plaintext HMAC both verify. `out` itself is only created by the
 * final rename, so unauthenticated plaintext never lands at `out`.
 */
export async function decryptFile(artifact: string, out: string, key: BackupKey, opts: { manifestPath?: string; requireManifest?: boolean } = {}): Promise<DecryptResult> {
  const hdr = readHeader(artifact);
  const manifestPath = opts.manifestPath ?? artifact + MANIFEST_EXT;
  const manifest = readManifest(manifestPath);
  if (!manifest && opts.requireManifest) throw new Error(`manifest ${manifestPath} not found`);
  if (manifest) {
    const actual = await sha256File(artifact);
    if (actual !== manifest.sha256) throw new Error(`sha256 mismatch: artifact does not match its manifest (file corrupted or tampered)`);
    if (manifest.keyId !== hdr.keyId) throw new Error(`manifest key id ${manifest.keyId} does not match artifact key id ${hdr.keyId}`);
  }
  if (hdr.keyId !== key.id) throw new Error(`wrong key: artifact was encrypted with key id ${hdr.keyId}, but the supplied key has id ${key.id}`);

  const fd = openSync(artifact, "r");
  const tag = Buffer.alloc(TAG_BYTES);
  const header = Buffer.alloc(HEADER_BYTES);
  try {
    readSync(fd, header, 0, HEADER_BYTES, 0);
    readSync(fd, tag, 0, TAG_BYTES, hdr.size - TAG_BYTES);
  } finally { closeSync(fd); }

  const decipher = createDecipheriv("aes-256-gcm", key.material(), hdr.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const mac = createHmac("sha256", key.macKey());
  let plainBytes = 0;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.partial`;
  const ctLen = hdr.size - HEADER_BYTES - TAG_BYTES;
  try {
    await pipeline(
      ctLen > 0 ? createReadStream(artifact, { start: HEADER_BYTES, end: hdr.size - TAG_BYTES - 1 }) : (async function* () { /* empty */ })(),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          const p = decipher.update(chunk);
          plainBytes += p.length;
          mac.update(p);
          if (p.length) yield p;
        }
        let f: Buffer;
        try { f = decipher.final(); } catch {
          throw new Error("authentication failed: GCM tag did not verify (wrong key, or the artifact was corrupted/tampered)");
        }
        plainBytes += f.length;
        mac.update(f);
        if (f.length) yield f;
      },
      createWriteStream(tmp, { mode: 0o600 }),
    );
    if (manifest) {
      if (manifest.plaintextBytes !== plainBytes) throw new Error(`plaintext size ${plainBytes} != manifest ${manifest.plaintextBytes}`);
      if (mac.digest("hex") !== manifest.plaintextHmac) throw new Error("plaintext HMAC does not match the manifest");
    }
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
  renameSync(tmp, out);
  return { keyId: hdr.keyId, plaintextBytes: plainBytes, manifestChecked: !!manifest };
}
