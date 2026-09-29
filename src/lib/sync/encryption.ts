/**
 * 同步加密服务：PBKDF2(600k, SHA-256) → AES-256-GCM（移植自 Netcatty EncryptionService）。
 *
 * 安全模型：
 * - 同步密码 → PBKDF2 派生 AES-256 密钥，密码不落任何存储
 * - 每次加密使用新随机 salt + IV
 * - 通过 verificationHash（SHA-256(派生密钥)）校验密码正确性
 */

import { SYNC_CONSTANTS, type MasterKeyConfig, type SyncedFile, type SyncPayload, type UnlockedMasterKey } from "../../types/sync";

// ============================================================================
// 基础工具
// ============================================================================

/** TS 5.x 要求显式转 ArrayBuffer（Uint8Array<ArrayBufferLike> → BufferSource） */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export const arrayBufferToBase64 = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const generateRandomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

export const sha256 = async (data: Uint8Array): Promise<Uint8Array> => {
  const hashBuffer = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
  return new Uint8Array(hashBuffer);
};

const stringToBytes = (str: string): Uint8Array => new TextEncoder().encode(str);
const bytesToString = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// ============================================================================
// 密钥派生
// ============================================================================

export const deriveKey = async (
  password: string,
  salt: Uint8Array,
  iterations: number = SYNC_CONSTANTS.PBKDF2_ITERATIONS,
): Promise<CryptoKey> => {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(stringToBytes(password)),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: SYNC_CONSTANTS.PBKDF2_HASH,
    },
    passwordKey,
    { name: "AES-GCM", length: SYNC_CONSTANTS.AES_KEY_LENGTH },
    true, // 可导出，用于计算 verificationHash
    ["encrypt", "decrypt"],
  );
};

const exportKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key));

/** 由派生密钥生成校验哈希（验证密码是否正确，不存密钥本身） */
export const createVerificationHash = async (derivedKey: CryptoKey): Promise<string> =>
  arrayBufferToBase64(await sha256(await exportKey(derivedKey)));

export const verifyPassword = async (password: string, config: MasterKeyConfig): Promise<boolean> => {
  try {
    const salt = base64ToUint8Array(config.salt);
    const derivedKey = await deriveKey(password, salt, config.kdfIterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS);
    return (await createVerificationHash(derivedKey)) === config.verificationHash;
  } catch {
    return false;
  }
};

// ============================================================================
// 加密 / 解密
// ============================================================================

const encryptRaw = async (plaintext: string, key: CryptoKey): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> => {
  const iv = generateRandomBytes(SYNC_CONSTANTS.GCM_IV_LENGTH);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), tagLength: SYNC_CONSTANTS.GCM_TAG_LENGTH },
    key,
    toArrayBuffer(stringToBytes(plaintext)),
  );
  return { ciphertext: new Uint8Array(ciphertextBuffer), iv };
};

const decryptRaw = async (ciphertext: Uint8Array, iv: Uint8Array, key: CryptoKey): Promise<string> => {
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), tagLength: SYNC_CONSTANTS.GCM_TAG_LENGTH },
    key,
    toArrayBuffer(ciphertext),
  );
  return bytesToString(new Uint8Array(plaintextBuffer));
};

// ============================================================================
// 高层 API：SyncPayload ↔ SyncedFile
// ============================================================================

/** 加密同步载荷，生成可上传的 SyncedFile（每次新 salt + IV，version = existing + 1） */
export const encryptPayload = async (
  payload: SyncPayload,
  password: string,
  deviceId: string,
  deviceName: string,
  appVersion: string,
  existingVersion?: number,
): Promise<SyncedFile> => {
  const salt = generateRandomBytes(SYNC_CONSTANTS.SALT_LENGTH);
  const key = await deriveKey(password, salt);
  const encrypted = await encryptRaw(JSON.stringify(payload), key);

  return {
    meta: {
      version: (existingVersion || 0) + 1,
      updatedAt: Date.now(),
      deviceId,
      deviceName,
      appVersion,
      iv: arrayBufferToBase64(encrypted.iv),
      salt: arrayBufferToBase64(salt),
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2",
      kdfIterations: SYNC_CONSTANTS.PBKDF2_ITERATIONS,
    },
    payload: arrayBufferToBase64(encrypted.ciphertext),
  };
};

/** 解密云端 SyncedFile；密码错误时抛出异常（由调用方路由到冲突 UI） */
export const decryptPayload = async (syncedFile: SyncedFile, password: string): Promise<SyncPayload> => {
  const { meta, payload } = syncedFile;
  const salt = base64ToUint8Array(meta.salt);
  const iv = base64ToUint8Array(meta.iv);
  const ciphertext = base64ToUint8Array(payload);

  const key = await deriveKey(password, salt, meta.kdfIterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS);
  const decrypted = await decryptRaw(ciphertext, iv, key);
  return JSON.parse(decrypted) as SyncPayload;
};

/** 仅校验云端文件可用给定密码解密 */
export const verifySyncedFile = async (syncedFile: SyncedFile, password: string): Promise<boolean> => {
  try {
    await decryptPayload(syncedFile, password);
    return true;
  } catch {
    return false;
  }
};

// ============================================================================
// 主密钥管理
// ============================================================================

/** 首次设置同步密码：生成持久化配置（verificationHash + salt，不含密码） */
export const createMasterKeyConfig = async (password: string): Promise<MasterKeyConfig> => {
  const salt = generateRandomBytes(SYNC_CONSTANTS.SALT_LENGTH);
  const key = await deriveKey(password, salt);
  return {
    verificationHash: await createVerificationHash(key),
    salt: arrayBufferToBase64(salt),
    kdf: "PBKDF2",
    kdfIterations: SYNC_CONSTANTS.PBKDF2_ITERATIONS,
    createdAt: Date.now(),
  };
};

/** 解锁：密码校验通过后返回仅内存持有的密钥状态 */
export const unlockMasterKey = async (
  password: string,
  config: MasterKeyConfig,
): Promise<UnlockedMasterKey | null> => {
  if (!(await verifyPassword(password, config))) return null;
  const salt = base64ToUint8Array(config.salt);
  const derivedKey = await deriveKey(password, salt, config.kdfIterations || SYNC_CONSTANTS.PBKDF2_ITERATIONS);
  return { derivedKey, salt, unlockedAt: Date.now() };
};

/** 修改同步密码（云端文件将在下次同步时以新密码整体重传） */
export const changeMasterPassword = async (
  oldPassword: string,
  newPassword: string,
  config: MasterKeyConfig,
): Promise<MasterKeyConfig | null> => {
  if (!(await verifyPassword(oldPassword, config))) return null;
  return createMasterKeyConfig(newPassword);
};
