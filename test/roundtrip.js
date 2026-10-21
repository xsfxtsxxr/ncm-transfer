/**
 * 测试：按真实世界的多种封面区布局生成 .ncm，再用解析器还原，逐字节比对。
 *
 * 为什么要测多种布局：
 *   旧文件封面帧无填充（coverFrameLen == imageLen），而 2025 年后下载的文件常见
 *   imageLen = 0 + 帧内预留 7~8KB 填充。只按“图片长度”跳过会把填充当成音频起点，
 *   流密钥错位后每个字节都解错 → 播放器报“格式不支持”。这里把所有已知布局都覆盖到。
 *
 * 运行：node test/roundtrip.js
 */
const crypto = require('crypto');
const AES = require('../js/aes.js');
const Ncm = require('../js/ncm.js');

const CORE_KEY = Buffer.from('hzHRAmso5kInbaxW', 'binary');
const META_KEY = Buffer.from("#14ljk_!\\]&0U<'(", 'binary');

const pkcs7 = (buf) => {
  const pad = 16 - (buf.length % 16);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
};
const xorInPlace = (buf, byte) => {
  for (let i = 0; i < buf.length; i++) buf[i] ^= byte;
  return buf;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

// 构造一个真实的 MPEG1 Layer III 帧序列（无 ID3），用于校验裸 MP3 的帧头识别
function rawMp3Frames(count) {
  const frame = Buffer.alloc(417);          // 128kbps / 44.1kHz，无 padding
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const f = Buffer.from(frame);
    crypto.randomFillSync(f, 4);
    parts.push(f);
  }
  return Buffer.concat(parts);
}


// 构造结构合法的 FLAC：fLaC + STREAMINFO 块（类型 0、长度 34）+ 伪音频帧
function flacFile(size) {
  const info = Buffer.alloc(4 + 34);
  info[0] = 0x00;                 // 块头：类型 STREAMINFO，非最后一个块
  info.writeUIntBE(34, 1, 3);     // 块长度 34
  return Buffer.concat([Buffer.from('fLaC'), info, crypto.randomBytes(Math.max(0, size - 42))]);
}

function id3Mp3(bodySize) {
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'binary');
  head[3] = 0x03; head[4] = 0x00; head[5] = 0x00;
  // synchsafe 长度
  const size = bodySize;
  head[6] = (size >> 21) & 0x7f;
  head[7] = (size >> 14) & 0x7f;
  head[8] = (size >> 7) & 0x7f;
  head[9] = size & 0x7f;
  return Buffer.concat([head, crypto.randomBytes(bodySize), rawMp3Frames(4)]);
}

/**
 * 生成 NCM。
 * layout:
 *   'legacy'             [crc][ver][imgLen][img]                             音频 = +9+imgLen
 *   'modern'             [crc][ver][frame][len][img][padLen]                  音频 = +13+frame
 *   'frame-includes-len' [crc][ver][frame=4+imgLen][len][img]                 音频 = +9+frame
 */
function buildNcm({ payload, meta, cover, layout, padLen = 0, keyLen = 16 }) {
  const parts = [];
  parts.push(Buffer.from('CTENFDAM', 'binary'), Buffer.from([0x01, 0x70]));

  const rc4Key = crypto.randomBytes(keyLen);
  const keyPlain = pkcs7(Buffer.concat([Buffer.from('neteasecloudmusic', 'binary'), rc4Key]));
  const kc = crypto.createCipheriv('aes-128-ecb', CORE_KEY, null).setAutoPadding(false);
  const keyData = xorInPlace(Buffer.concat([kc.update(keyPlain), kc.final()]), 0x64);
  parts.push(u32(keyData.length), keyData);

  let metaData = Buffer.alloc(0);
  if (meta) {
    const json = Buffer.from('music:' + JSON.stringify(meta), 'utf8');
    const mc = crypto.createCipheriv('aes-128-ecb', META_KEY, null).setAutoPadding(false);
    const enc = Buffer.concat([mc.update(pkcs7(json)), mc.final()]);
    const text = Buffer.from("163 key(Don't modify):", 'binary').toString('binary') + enc.toString('base64');
    metaData = xorInPlace(Buffer.from(text, 'binary'), 0x63);
  }
  parts.push(u32(metaData.length), metaData);

  const img = cover || Buffer.alloc(0);
  parts.push(crypto.randomBytes(4));   // crc32
  parts.push(Buffer.from([0x01]));     // 封面版本

  if (layout === 'legacy') {
    parts.push(u32(img.length), img);
  } else if (layout === 'modern') {
    // coverFrameLen 为整个封面帧长度（图片 + 填充），imageLen 为帧内真实图片长度
    parts.push(u32(img.length + padLen), u32(img.length), img, Buffer.alloc(padLen, 0x00));
  } else if (layout === 'frame-includes-len') {
    parts.push(u32(4 + img.length), u32(img.length), img);
  } else {
    throw new Error('unknown layout ' + layout);
  }

  const audio = Buffer.from(payload);
  const box = Ncm.buildKeyBox(new Uint8Array(rc4Key));
  for (let i = 0; i < audio.length; i++) audio[i] ^= Ncm.keystreamByte(box, i);
  parts.push(audio);

  return Buffer.concat(parts);
}

async function run() {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crypto.randomBytes(600),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);

  const meta = (fmt) => ({
    format: fmt,
    musicName: '测试歌曲',
    artist: [['测试歌手', 123]],
    album: '测试专辑',
    bitrate: 320000,
    duration: 215000,
  });

  const cases = [
    {
      name: '旧布局 + FLAC + 封面',
      layout: 'legacy', payload: flacFile(200000),
      cover: png, expectLayout: 'frame-only',
    },
    {
      name: '新布局（封面 + 512 字节填充）',
      layout: 'modern', padLen: 512, payload: id3Mp3(150000), cover: png,
      expectLayout: 'frame+len-field',
    },
    {
      name: '新布局（imageLen=0 + 7552 字节填充）—— 2025 年后常见',
      layout: 'modern', padLen: 7552, payload: id3Mp3(120000), cover: null,
      expectLayout: 'frame+len-field',
    },
    {
      name: '新布局（无 ID3 的裸 MP3 帧）',
      layout: 'modern', padLen: 300, payload: rawMp3Frames(40), cover: null,
      expectLayout: 'frame+len-field',
    },
    {
      name: 'coverFrameLen 含长度字段的变体',
      layout: 'frame-includes-len', payload: flacFile(80000),
      cover: png, expectLayout: 'frame-only',
    },
    {
      name: '无元数据段的文件',
      layout: 'modern', padLen: 7552, payload: id3Mp3(30000), cover: null, noMeta: true,
      expectLayout: 'frame+len-field',
    },
  ];

  let passed = 0;
  for (const c of cases) {
    const ncm = buildNcm({
      payload: c.payload, meta: c.noMeta ? null : meta(c.payload.slice(0, 4).toString() === 'fLaC' ? 'flac' : 'mp3'),
      cover: c.cover, layout: c.layout, padLen: c.padLen || 0,
    });
    const ab = ncm.buffer.slice(ncm.byteOffset, ncm.byteOffset + ncm.byteLength);

    const res = await Ncm.parse(ab, {});
    const intact = Buffer.from(res.audio).equals(c.payload);
    const fmtOk = res.format === (c.payload.slice(0, 4).toString() === 'fLaC' ? 'flac' : 'mp3');
    const layoutOk = res.diag.layout === c.expectLayout;
    const coverOk = c.cover ? (res.image && Buffer.from(res.image).equals(c.cover)) : res.image === null;
    const metaOk = c.noMeta ? res.meta === null : (res.meta && res.meta.musicName === '测试歌曲');
    const ok = intact && fmtOk && layoutOk && coverOk && metaOk;

    if (ok) passed++;
    console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`   文件 ${ncm.length} B → 音频 ${res.audio.length} B，格式 ${res.format}，命中布局 ${res.diag.layout}`);
    console.log(`   逐字节一致=${intact} 格式=${fmtOk} 布局=${layoutOk} 封面=${coverOk} 元数据=${metaOk}`);
    if (!intact) {
      for (let i = 0; i < c.payload.length; i++) {
        if (res.audio[i] !== c.payload[i]) { console.log(`   首个差异字节 offset=${i}（共 ${c.payload.length} B）`); break; }
      }
    }
  }

  // ---- 异常输入：必须报错，而不是输出坏文件 ----
  console.log('\n--- 异常输入（应当拒绝输出）---');
  const good = buildNcm({ payload: id3Mp3(5000), meta: meta('mp3'), cover: null, layout: 'modern', padLen: 7552 });
  const badCases = [
    ['非 NCM 数据', Buffer.from('hello world, definitely not ncm')],
    ['文件头截断', Buffer.from('CTENFDAM')],
    ['音频段被截断', good.subarray(0, good.length - 4900)],
  ];
  for (const [label, buf] of badCases) {
    try {
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const r = await Ncm.parse(ab, {});
      console.log(`[FAIL] ${label} 未抛错（输出了 ${r.audio.length} B）`);
    } catch (e) {
      console.log(`[PASS] ${label} → ${e.message}`);
      passed++;
    }
  }

  const total = cases.length + badCases.length;
  console.log(`\n结果: ${passed}/${total} 通过`);
  process.exit(passed === total ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
