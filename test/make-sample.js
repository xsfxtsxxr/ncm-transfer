/**
 * 生成浏览器端测试用样本：test/sample.js
 *
 * 采用 2025 年后下载文件常见的布局（封面帧内带填充），即用户遇到“格式不支持”
 * 的那一类文件：crc32(4) + 版本(1) + coverFrameLen + imageLen + 图片 + 填充 + 音频
 *
 * 用法：node test/make-sample.js
 */
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const crc32 = require('../js/zip.js').crc32;
const Ncm = require('../js/ncm.js');

const CORE_KEY = Buffer.from('hzHRAmso5kInbaxW', 'binary');
const META_KEY = Buffer.from("#14ljk_!\\]&0U<'(", 'binary');

const pkcs7 = (b) => {
  const p = 16 - (b.length % 16);
  return Buffer.concat([b, Buffer.alloc(p, p)]);
};
const xor = (b, x) => {
  for (let i = 0; i < b.length; i++) b[i] ^= x;
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const fnv1a = (buf) => {
  let h = 0x811c9dc5;
  for (const byte of buf) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

/** 生成一张真实的 16x16 PNG 封面 */
function makePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 构造真实可解码的 FLAC 负载（1.5 秒立体声测试音） ----------
const FlacEncoder = require('../js/flac-encoder.js');
const RATE = 44100;
const SECONDS = 1.5;
const N = Math.round(RATE * SECONDS);
const left = new Int32Array(N);
const right = new Int32Array(N);
for (let i = 0; i < N; i++) {
  const t = i / RATE;
  const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.8 * t);
  left[i] = Math.round((Math.sin(2 * Math.PI * 440 * t) * 9000 + Math.sin(2 * Math.PI * 880 * t) * 3500) * env);
  right[i] = Math.round((Math.sin(2 * Math.PI * 554.37 * t) * 8000 + Math.sin(2 * Math.PI * 1108 * t) * 3000) * env);
}
const payload = Buffer.from(FlacEncoder.encode({
  channels: [left, right],
  sampleRate: RATE,
  bitsPerSample: 16,
  blockSize: 4096,
}));

const rc4Key = crypto.randomBytes(24);
const meta = {
  format: 'flac',
  musicName: '晴天',
  artist: [['周杰伦', 6452]],
  album: '叶惠美',
  bitrate: 900000,
  duration: 269000,
};

// ---------- 密钥段 ----------
const keyPlain = pkcs7(Buffer.concat([Buffer.from('neteasecloudmusic', 'binary'), rc4Key]));
const kc = crypto.createCipheriv('aes-128-ecb', CORE_KEY, null).setAutoPadding(false);
const keyData = xor(Buffer.concat([kc.update(keyPlain), kc.final()]), 0x64);

// ---------- 元数据段 ----------
const mc = crypto.createCipheriv('aes-128-ecb', META_KEY, null).setAutoPadding(false);
const metaEnc = Buffer.concat([mc.update(pkcs7(Buffer.from('music:' + JSON.stringify(meta), 'utf8'))), mc.final()]);
const metaStr = Buffer.from("163 key(Don't modify):", 'binary').toString('binary') + metaEnc.toString('base64');
const metaData = xor(Buffer.from(metaStr, 'binary'), 0x63);

// ---------- 封面帧（图片 + 填充） ----------
const cover = makePng(16, 16, [255, 45, 85]);
const PAD_LEN = 7552;
const coverFrameLen = cover.length + PAD_LEN;

// ---------- 音频（流密钥加密） ----------
const encAudio = Buffer.from(payload);
const box = Ncm.buildKeyBox(new Uint8Array(rc4Key));
for (let i = 0; i < encAudio.length; i++) encAudio[i] ^= Ncm.keystreamByte(box, i);

const ncm = Buffer.concat([
  Buffer.from('CTENFDAM', 'binary'),
  Buffer.from([0x01, 0x70]),
  u32(keyData.length), keyData,
  u32(metaData.length), metaData,
  crypto.randomBytes(4),          // crc32
  Buffer.from([0x01]),            // 封面版本
  u32(coverFrameLen),             // 整个封面帧长度
  u32(cover.length),              // 帧内真实图片长度
  cover,
  Buffer.alloc(PAD_LEN, 0x00),    // 填充（曾把旧实现带偏的地方）
  encAudio,
]);

const out = `window.NCM_SAMPLE = {
  b64: ${JSON.stringify(ncm.toString('base64'))},
  size: ${ncm.length},
  payloadHash: ${JSON.stringify(fnv1a(payload))},
  payloadSize: ${payload.length},
  coverSize: ${cover.length},
  coverHash: ${JSON.stringify(fnv1a(cover))},
  coverFrameLen: ${coverFrameLen},
  padLen: ${PAD_LEN}
};
`;
fs.writeFileSync(path.join(__dirname, 'sample.js'), out);

console.log('样本生成完成：', ncm.length, 'bytes');
console.log('  payload 哈希', fnv1a(payload), '，封面', cover.length, 'B，填充', PAD_LEN, 'B');
