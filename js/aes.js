/**
 * aes.js — 纯 JavaScript 实现的 AES-128 解密（ECB 模式）
 *
 * 浏览器原生 WebCrypto 不提供 ECB 模式（且 CBC 会自动去除 PKCS#7 填充），
 * 而 NCM 的密钥段与元数据段都是 AES-128-ECB，因此这里自带一份实现。
 * 只做解密，代码体积小、无依赖，也便于在 Node 中做单元测试。
 */
(function (root) {
  'use strict';

  /* ---------------- S 盒（按 GF(2^8) 乘法逆元生成） ---------------- */
  var SBOX = new Uint8Array(256);
  var INV_SBOX = new Uint8Array(256);

  (function buildSBox() {
    function rotl8(x, n) {
      return ((x << n) | (x >>> (8 - n))) & 0xff;
    }
    var p = 1, q = 1;
    do {
      p = (p ^ ((p << 1) & 0xff) ^ ((p & 0x80) ? 0x1b : 0)) & 0xff;
      q = (q ^ ((q << 1) & 0xff)) & 0xff;
      q = (q ^ ((q << 2) & 0xff)) & 0xff;
      q = (q ^ ((q << 4) & 0xff)) & 0xff;
      if (q & 0x80) q = (q ^ 0x09) & 0xff;
      SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;

    for (var i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  })();

  /* ---------------- GF(2^8) 乘法 ---------------- */
  function gmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      var hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p & 0xff;
  }

  /* ---------------- 密钥扩展（AES-128 → 11 轮密钥 = 176 字节） ---------------- */
  function expandKey(key) {
    if (key.length !== 16) throw new Error('AES-128 需要 16 字节密钥');
    var w = new Uint8Array(176);
    w.set(key, 0);
    var rcon = 1;

    for (var i = 16; i < 176; i += 4) {
      var t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];

      if (i % 16 === 0) {
        // RotWord + SubWord + Rcon
        t0 = SBOX[t1] ^ rcon;
        t1 = SBOX[t2];
        t2 = SBOX[t3];
        t3 = SBOX[w[i - 4]];
        rcon = gmul(rcon, 2);
      }

      w[i] = w[i - 16] ^ t0;
      w[i + 1] = w[i - 15] ^ t1;
      w[i + 2] = w[i - 14] ^ t2;
      w[i + 3] = w[i - 13] ^ t3;
    }
    return w;
  }

  /* ---------------- 轮变换（状态按列主序展开，s[r + 4c]） ---------------- */
  function invShiftRows(s) {
    // 第 r 行循环右移 r 位
    for (var r = 1; r < 4; r++) {
      var a0 = s[r], a1 = s[r + 4], a2 = s[r + 8], a3 = s[r + 12];
      var row = [a0, a1, a2, a3];
      for (var c = 0; c < 4; c++) {
        s[r + 4 * c] = row[(c - r + 4) % 4];
      }
    }
  }

  function invMixColumns(s) {
    for (var c = 0; c < 4; c++) {
      var i = 4 * c;
      var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
      s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
  }

  /* ---------------- 单块解密 ---------------- */
  var STATE = new Uint8Array(16);

  function decryptBlock(w, input, inOff, out, outOff) {
    var s = STATE;
    var i;

    for (i = 0; i < 16; i++) s[i] = input[inOff + i] ^ w[160 + i];

    for (var round = 9; round >= 1; round--) {
      invShiftRows(s);
      for (i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
      var off = round * 16;
      for (i = 0; i < 16; i++) s[i] ^= w[off + i];
      invMixColumns(s);
    }

    invShiftRows(s);
    for (i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    for (i = 0; i < 16; i++) out[outOff + i] = s[i] ^ w[i];
  }

  /**
   * AES-128-ECB 解密
   * @param {Uint8Array} key 16 字节密钥
   * @param {Uint8Array} data 密文（长度须为 16 的整数倍）
   * @returns {Uint8Array} 明文
   */
  function decryptECB(key, data) {
    if (data.length % 16 !== 0) {
      throw new Error('密文长度不是 16 的整数倍');
    }
    var w = expandKey(key instanceof Uint8Array ? key : new Uint8Array(key));
    var out = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i += 16) {
      decryptBlock(w, data, i, out, i);
    }
    return out;
  }

  /**
   * AES-128-ECB 解密并去除 PKCS#7 填充（NCM 的密钥段 / 元数据段都带填充）
   */
  function decryptECBPadded(key, data) {
    var out = decryptECB(key, data);
    if (out.length === 0) return out;

    var pad = out[out.length - 1];
    if (pad > 0 && pad <= 16 && pad <= out.length) {
      // 校验填充是否合法，容忍极少数不规范文件
      var ok = true;
      for (var i = out.length - pad; i < out.length; i++) {
        if (out[i] !== pad) { ok = false; break; }
      }
      if (ok) return out.subarray(0, out.length - pad);
    }
    return out;
  }

  var AES = { decryptECB: decryptECB, decryptECBPadded: decryptECBPadded, SBOX: SBOX };

  if (typeof module !== 'undefined' && module.exports) module.exports = AES;
  else root.NcmAES = AES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
