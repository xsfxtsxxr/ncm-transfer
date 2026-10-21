/**
 * 编解码器实测：用自研 FLAC 编码器与 lamejs 生成文件，
 * 再由 Python 的 libsndfile（独立第三方解码器）读回比对。
 *
 * 用法：
 *   node test/codec-check.js      # 生成 /tmp/ncm-codec/*.flac|*.mp3|*.raw
 *   然后 python test/verify-audio.py 校验
 */
const fs = require('fs');
const path = require('path');
const FlacEncoder = require('../js/flac-encoder.js');

const OUT = path.join(process.env.TEMP || '/tmp', 'ncm-codec');
fs.mkdirSync(OUT, { recursive: true });

function makeSignal(rate, seconds, ch) {
  const n = Math.round(rate * seconds);
  const out = [];
  for (let c = 0; c < ch; c++) out.push(new Int32Array(n));
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // 音乐化信号：多音 + 包络 + 轻微噪声，覆盖大幅度与小幅度残差
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.7 * t);
    for (let c = 0; c < ch; c++) {
      const f1 = c === 0 ? 440 : 554.37;
      let v = Math.sin(2 * Math.PI * f1 * t) * 9000
            + Math.sin(2 * Math.PI * f1 * 2.01 * t) * 4000
            + Math.sin(2 * Math.PI * (f1 / 3) * t) * 6000;
      v *= env;
      v += (Math.random() - 0.5) * 120;             // 类噪底，制造非平凡残差
      out[c][i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
  }
  return out;
}

function writeRawInterleaved(channels, file) {
  const n = channels[0].length;
  const buf = Buffer.alloc(n * channels.length * 2);
  let p = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels.length; c++) {
      buf.writeInt16LE(channels[c][i], p);
      p += 2;
    }
  }
  fs.writeFileSync(file, buf);
}

function loadLame() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'lame.min.js'), 'utf8');
  // lame.min.js 是全局函数声明，这里在受控作用域里取回
  return new Function(src + '; return lamejs;')();
}

function encodeMp3(channels, sampleRate, kbps) {
  const lamejs = loadLame();
  const enc = new lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
  const total = channels[0].length;
  const CH = 1152;
  const parts = [];
  const l = new Int16Array(CH), r = new Int16Array(CH);

  for (let i = 0; i < total; i += CH) {
    const n = Math.min(CH, total - i);
    const lv = l.subarray(0, n), rv = r.subarray(0, n);
    for (let j = 0; j < n; j++) {
      lv[j] = channels[0][i + j];
      if (channels.length > 1) rv[j] = channels[1][i + j];
    }
    const buf = channels.length > 1 ? enc.encodeBuffer(lv, rv) : enc.encodeBuffer(lv);
    if (buf.length) parts.push(Buffer.from(buf));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(Buffer.from(tail));
  return Buffer.concat(parts);
}

const cases = [
  { name: 'stereo-44100', ch: 2, rate: 44100, sec: 4 },
  { name: 'mono-44100', ch: 1, rate: 44100, sec: 3 },
  { name: 'stereo-48000', ch: 2, rate: 48000, sec: 3 },
  { name: 'stereo-96000', ch: 2, rate: 96000, sec: 2 },
];

for (const c of cases) {
  const pcm = makeSignal(c.rate, c.sec, c.ch);

  const flac = FlacEncoder.encode({
    channels: pcm,
    sampleRate: c.rate,
    bitsPerSample: 16,
    blockSize: 4096,
  });
  fs.writeFileSync(path.join(OUT, c.name + '.flac'), Buffer.from(flac));
  writeRawInterleaved(pcm, path.join(OUT, c.name + '.raw'));

  // 96k 超出 lame 支持范围，MP3 只测 44.1/48
  if (c.rate <= 48000) {
    const mp3 = encodeMp3(pcm, c.rate, 192);
    fs.writeFileSync(path.join(OUT, c.name + '.mp3'), mp3);
  }

  const rawBytes = pcm[0].length * c.ch * 2;
  console.log(`${c.name}: PCM ${rawBytes} B → FLAC ${flac.length} B (${(flac.length / rawBytes * 100).toFixed(1)}%)`);
}

// 记录用例清单，供 Python 端读取
fs.writeFileSync(
  path.join(OUT, 'cases.json'),
  JSON.stringify(cases.map(c => ({ name: c.name, ch: c.ch, rate: c.rate, sec: c.sec })), null, 2)
);
console.log('输出目录:', OUT);
