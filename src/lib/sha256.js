/**
 * SHA-256 en JavaScript pur : repli quand Web Crypto (crypto.subtle) est
 * absent, c'est-à-dire hors contexte sécurisé (http sur une IP du réseau local).
 */
const primes = [];
for (let n = 2; primes.length < 64; n++) {
  if (primes.every((p) => n % p !== 0)) primes.push(n);
}
const frac = (x) => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;
// Constantes définies par la norme : parties fractionnaires des racines des nombres premiers.
const K = Uint32Array.from(primes, (p) => frac(Math.cbrt(p)));
const H0 = Uint32Array.from(primes.slice(0, 8), (p) => frac(Math.sqrt(p)));

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** @param {Uint8Array} bytes @returns {string} empreinte hexadécimale */
export function sha256Hex(bytes) {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);

  const hash = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => (hash[i] = (hash[i] + v) >>> 0));
  }
  return [...hash].map((v) => v.toString(16).padStart(8, '0')).join('');
}
