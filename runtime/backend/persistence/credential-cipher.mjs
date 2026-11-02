import crypto from 'node:crypto';
import { problem } from '../common.mjs';

// The native host supplies this sandbox's Keystore-wrapped key in process
// memory. No plaintext fallback, key export API or secret logging is provided.
export function createCredentialCipher(keyHex) {
  if (typeof keyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(keyHex)) throw problem('CREDENTIAL_KEY_REQUIRED', '本机受保护凭据密钥未就绪', 503);
  const key = Buffer.from(keyHex, 'hex');
  return Object.freeze({
    encrypt(value) {
      if (typeof value !== 'string') throw problem('CREDENTIAL_VALUE_INVALID', '凭据必须是文本', 400);
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return 'enc:v1:' + [nonce, cipher.getAuthTag(), ciphertext].map(bytes => bytes.toString('base64url')).join('.');
    },
    decrypt(envelope) {
      if (typeof envelope !== 'string' || !envelope.startsWith('enc:v1:')) throw problem('CREDENTIAL_ENVELOPE_REQUIRED', '凭据不是受保护密文，原资料已保留', 503);
      try {
        const parts = envelope.slice(7).split('.').map(text => Buffer.from(text, 'base64url'));
        if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error('shape');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, parts[0]); decipher.setAuthTag(parts[1]);
        return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8');
      } catch { throw problem('CREDENTIAL_DECRYPTION_FAILED', '本机凭据无法安全读取，原密文已保留', 503); }
    },
  });
}
