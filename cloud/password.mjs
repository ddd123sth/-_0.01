// Async scrypt password hashing with a bounded semaphore.
import crypto from 'node:crypto';

const ALGORITHM = 'scrypt';

export function createPasswordHasher(scryptConfig) {
  const { n, r, p, keylen, maxmem, concurrency, queueLimit } = scryptConfig;
  let active = 0;
  const waiting = [];

  function acquire() {
    if (waiting.length >= queueLimit) {
      throw Object.assign(new Error('服务器繁忙，请稍后重试'), { status: 503, code: 'SERVER_BUSY' });
    }
    if (active < concurrency) { active += 1; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      if (waiting.length > queueLimit) {
        const overflow = waiting.shift();
        overflow.reject(Object.assign(new Error('服务器繁忙，请稍后重试'), { status: 503, code: 'SERVER_BUSY' }));
      }
    });
  }
  function release() {
    if (waiting.length) { const next = waiting.shift(); next.resolve(); return; }
    active -= 1;
  }

  // Parameters come from the stored hash when verifying so old records stay
  // readable if the configured work factor changes later.
  function derive(password, salt, workN = n, workR = r, workP = p) {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, keylen, { N: workN, r: workR, p: workP, maxmem }, (error, buffer) => {
        if (error) reject(Object.assign(new Error('口令处理失败，请稍后重试'), { status: 503, code: 'PASSWORD_FAILED', cause: error }));
        else resolve(buffer);
      });
    });
  }

  async function hash(password) {
    if (typeof password !== 'string' || !password.length) throw Object.assign(new Error('口令处理失败'), { status: 400, code: 'INPUT_INVALID' });
    await acquire();
    try {
      const salt = crypto.randomBytes(16);
      const digest = await derive(password, salt);
      return [ALGORITHM, n, r, p, salt.toString('base64'), digest.toString('base64')].join('$');
    } finally { release(); }
  }

  async function verify(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;
    const [, sN, sR, sP, saltB64, hashB64] = parts;
    const candidate = Buffer.from(hashB64, 'base64');
    if (candidate.length !== keylen) return false;
    await acquire();
    try {
      const salt = Buffer.from(saltB64, 'base64');
      const digest = await derive(password, salt, Number(sN), Number(sR), Number(sP));
      return digest.length === candidate.length && crypto.timingSafeEqual(digest, candidate);
    } catch { return false; } finally { release(); }
  }

  return { hash, verify, algorithm: ALGORITHM };
}
