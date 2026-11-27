/* Keeps the secrets (GitHub token, Apps Script password) on this device only, encrypted with a passphrase the owner chooses
   (PBKDF2 -> AES-GCM). The page is served from a shared github.io address, so a plain token in localStorage would be readable by
   any other page under the same address. Without the passphrase the stored data is useless. */
const enc = new TextEncoder(), dec = new TextDecoder();
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const ITER = 250000;

export async function seal(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(pass, salt, ITER), enc.encode(JSON.stringify(obj))));
  return { v: 1, iter: ITER, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

/** Throws when the passphrase is wrong (AES-GCM refuses to decrypt). */
export async function open(sealed, pass) {
  const k = await key(pass, fromB64(sealed.salt), sealed.iter);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv) }, k, fromB64(sealed.data));
  return JSON.parse(dec.decode(plain));
}

const KEY = 'jarofotos-admin';
export const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
export const store = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch { return false; } };
export const forget = () => { try { localStorage.removeItem(KEY); } catch { /* nothing to do */ } };
