/**
 * ncm.js — 网易云音乐 .ncm 文件解析与解密
 *
 * .ncm 结构（小端序）：
 *   0x00  8   文件头 "CTENFDAM"
 *   0x08  2   保留字节 0x01 0x70
 *   0x0A  4   RC4 密钥段长度 keyLen
 *   0x0E  n   密钥段   —— 每字节 ^0x64，AES-128-ECB 解密，去掉 "neteasecloudmusic" 前缀与 PKCS#7 填充
 *   ...   4   元数据长度 metaLen
 *   ...   m   元数据   —— 每字节 ^0x63，"163 key(Don't modify):" 前缀，Base64，AES-128-ECB 解密，"music:"/"dj:" 前缀
 *   ...   4   CRC32（不校验）
 *   ...   1   封面版本（跳过）
 *   ...   4   封面帧长度 coverFrameLen（整个封面帧占用字节数，含帧内填充）
 *   ...   4   帧内真实图片长度 imageLen（可为 0）
 *   ...   k   封面图片（明文 JPEG/PNG）
 *   ...   p   填充，p = coverFrameLen - imageLen
 *   ...   *   音频数据 —— 用还原出的密钥做 RC4 变体流解密，得到原始 mp3 / flac
 *
 * ⚠️ 关于封面区：文件名气最大的坑就在这里。旧文件 p = 0（coverFrameLen == imageLen），
 * 而 2025 年后下载的文件常见 imageLen = 0、帧内预留 7~8KB 填充。若把填充当成音频起点，
 * 流密钥会因为偏移错位而把每个字节都解错，输出文件头变成随机字节，播放器报“格式不支持”。
 * 因此这里不硬编码某一种布局，而是枚举候选偏移并用解密后的真实文件头验证。
 */
(function (root) {
  'use strict';

  var AES = root.NcmAES || (typeof require === 'function' ? require('./aes.js') : null);

  var MAGIC = 'CTENFDAM';
  var META_PREFIX_STR = "163 key(Don't modify):";
  var META_PREFIX_LEN = META_PREFIX_STR.length; // 22
  var NCM_PREFIX = 'neteasecloudmusic';

  var CORE_KEY = strToBytes('hzHRAmso5kInbaxW');
  var META_KEY = strToBytes("#14ljk_!\\]&0U<'(");

  function strToBytes(s) {
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  function decodeUTF8(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function base64ToBytes(b64) {
    var clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
    var bin = root.atob ? root.atob(clean) : Buffer.from(clean, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  /* ---------------- RC4 变体：密钥调度 ---------------- */
  function buildKeyBox(key) {
    var box = new Uint8Array(256);
    var i;
    for (i = 0; i < 256; i++) box[i] = i;

    var c = 0, lastByte = 0, keyOffset = 0;
    for (i = 0; i < 256; i++) {
      var swap = box[i];
      c = (swap + lastByte + key[keyOffset]) & 0xff;
      keyOffset++;
      if (keyOffset >= key.length) keyOffset = 0;
      box[i] = box[c];
      box[c] = swap;
      lastByte = c;
    }
    return box;
  }

  // 音频第 off 个字节（从音频起点算起）的密钥字节。只依赖偏移，周期 256。
  function keystreamByte(box, off) {
    var j = (off + 1) & 0xff;
    return box[(box[j] + box[(box[j] + j) & 0xff]) & 0xff];
  }

  /* ---------------- 音频流解密（原地修改） ---------------- */
  async function decryptAudio(audio, box, onProgress) {
    var CHUNK = 1 << 20; // 1MB 一段，分段解密以便刷新进度、避免长时间卡住主线程

    for (var pos = 0; pos < audio.length; pos += CHUNK) {
      var end = Math.min(pos + CHUNK, audio.length);
      for (var i = pos; i < end; i++) {
        audio[i] ^= keystreamByte(box, i);
      }
      if (onProgress) onProgress(Math.min(1, end / audio.length));
      // 让出主线程，保证界面上的进度条和列表能刷新
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    return audio;
  }

  /* ---------------- 音频文件头识别 ---------------- */
  var MP3_BITRATES = {
    1: [[0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],   // MPEG1 Layer I
        [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],      // MPEG1 Layer II
        [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]],      // MPEG1 Layer III
    0: [[0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],      // MPEG2/2.5 Layer I
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],           // MPEG2/2.5 Layer II
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]]           // MPEG2/2.5 Layer III
  };
  var MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

  /** 解析 MPEG 帧头，返回帧长（字节），非法则返回 0 */
  function mp3FrameLength(buf, off) {
    if (off + 4 > buf.length) return 0;
    if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return 0;

    var b1 = buf[off + 1], b2 = buf[off + 2];
    var versionBits = (b1 >> 3) & 0x03;  // 0=MPEG2.5 2=MPEG2 3=MPEG1
    var layerBits = (b1 >> 1) & 0x03;    // 1=LayerIII 2=LayerII 3=LayerI
    if (versionBits === 1 || layerBits === 0) return 0;

    var brIndex = (b2 >> 4) & 0x0f;
    var srIndex = (b2 >> 2) & 0x03;
    if (brIndex === 0 || brIndex === 15 || srIndex === 3) return 0;

    var isV1 = versionBits === 3;
    // layerBits: 1=LayerIII 2=LayerII 3=LayerI；表按 [LayerI, LayerII, LayerIII] 排列
    var row = 3 - layerBits;
    var bitrate = MP3_BITRATES[isV1 ? 1 : 0][row][brIndex] * 1000;
    var rate = MP3_RATES[versionBits][srIndex];
    if (!bitrate || !rate) return 0;

    var padding = (b2 >> 1) & 1;
    if (layerBits === 3) return Math.floor((12 * bitrate) / rate + padding) * 4;
    if (layerBits === 2) return Math.floor((144 * bitrate) / rate + padding);
    return Math.floor((isV1 ? 144 : 72) * bitrate / rate + padding);
  }

  /** 依据解密后的前若干字节判断格式，识别不出返回 null */
  function detectFormat(buf) {
    var n = buf.length;

    // ID3v2：'ID3' + 版本号 + 非 0xFF 的 flags + synchsafe 长度
    if (n >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 &&
        buf[3] >= 2 && buf[3] <= 4 && buf[4] !== 0xff &&
        buf[6] < 0x80 && buf[7] < 0x80 && buf[8] < 0x80 && buf[9] < 0x80) {
      return 'mp3';
    }
    if (n >= 4) {
      if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return 'flac';
      if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';
      if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
          n >= 12 && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) return 'wav';
      if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'm4a';
    }

    // 无 ID3 的裸 MP3：校验帧头，并要求约 2KB 内下一个帧同步位置也合法（避免撞运气）
    var frameLen = mp3FrameLength(buf, 0);
    if (frameLen > 0) {
      if (frameLen >= buf.length) return 'mp3';
      if (mp3FrameLength(buf, frameLen) > 0) return 'mp3';
      // 下一帧落在缓冲区内但校验失败 → 不是真正的帧头
      return null;
    }
    return null;
  }

  /** 在候选偏移处按“音频起点”重新从 0 开始取密钥，解出前若干字节并判断格式 */
  function probeAt(bytes, start, box, probeLen) {
    if (start < 0 || start >= bytes.length) return null;
    var len = Math.min(probeLen || 4096, bytes.length - start);
    if (len < 10) return null;
    var head = new Uint8Array(len);
    for (var i = 0; i < len; i++) head[i] = bytes[start + i] ^ keystreamByte(box, i);
    return detectFormat(head);
  }

  /** 结构性校验：拒绝被截断的音频，避免输出一个打不开的文件 */
  function validateAudio(audio, format) {
    if (format === 'mp3') {
      // 带 ID3v2 的文件：标签长度不得超出实际数据
      if (audio.length >= 10 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) {
        var size = ((audio[6] & 0x7f) << 21) | ((audio[7] & 0x7f) << 14) |
                   ((audio[8] & 0x7f) << 7) | (audio[9] & 0x7f);
        if (10 + size >= audio.length) {
          throw new Error('音频数据不完整（ID3 标签长度超出文件），可能下载中断了');
        }
      }
    } else if (format === 'flac') {
      // fLaC + STREAMINFO 块（块头 4 字节 + 34 字节数据）
      if (audio.length < 42) throw new Error('音频数据不完整（FLAC 头缺失），可能下载中断了');
      var blockType = audio[4] & 0x7f;
      var blockLen = (audio[5] << 16) | (audio[6] << 8) | audio[7];
      if (blockType !== 0 || blockLen !== 34) {
        throw new Error('FLAC 结构异常，音频数据可能被截断');
      }
    }
    if (audio.length < 256) {
      throw new Error('音频数据过短（' + audio.length + ' 字节），文件可能不完整');
    }
  }

  /* ---------------- 封面提取 ---------------- */
  function findImage(bytes, from, to) {
    var limit = Math.min(to, bytes.length);
    for (var i = from; i + 3 < limit; i++) {
      // PNG
      if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x47) {
        // 找到 IEND 块结尾
        for (var j = i; j + 8 <= limit; j++) {
          if (bytes[j] === 0x49 && bytes[j + 1] === 0x45 && bytes[j + 2] === 0x4e &&
              bytes[j + 3] === 0x44) {
            return bytes.subarray(i, Math.min(j + 8, limit));
          }
        }
        return bytes.subarray(i, limit);
      }
      // JPEG
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
        var end = -1;
        for (var k = limit - 2; k > i; k--) {
          if (bytes[k] === 0xff && bytes[k + 1] === 0xd9) { end = k + 2; break; }
        }
        return bytes.subarray(i, end > i ? end : limit);
      }
    }
    return null;
  }

  /* ---------------- 文件名清洗 ---------------- */
  function sanitize(name) {
    var s = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s_]+|[.\s_]+$/g, '');
    if (s.length > 110) s = s.slice(0, 110);
    return s || '未命名';
  }

  function isNcm(buffer) {
    if (!buffer || buffer.byteLength < 16) return false;
    var head = decodeUTF8(new Uint8Array(buffer, 0, 8));
    return head === MAGIC;
  }

  /* ---------------- 主流程 ---------------- */
  async function parse(arrayBuffer, options) {
    options = options || {};
    var onProgress = options.onProgress;

    function report(stage, value, text) {
      if (onProgress) onProgress({ stage: stage, value: value, text: text });
    }

    if (!isNcm(arrayBuffer)) {
      throw new Error('不是有效的 NCM 文件（文件头不是 CTENFDAM）');
    }

    var bytes = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);
    var offset = 0;

    report('header', 0.04, '解析文件头');
    offset = 8;                 // 文件头
    offset += 2;                // 保留位 0x01 0x70

    // ---- 密钥段 ----
    if (offset + 4 > bytes.length) throw new Error('文件已损坏：缺少密钥段长度');
    var keyLen = dv.getUint32(offset, true); offset += 4;
    if (keyLen === 0 || keyLen % 16 !== 0 || offset + keyLen > bytes.length) {
      throw new Error('文件已损坏：密钥段长度异常（' + keyLen + '）');
    }
    var encKey = new Uint8Array(bytes.subarray(offset, offset + keyLen));
    for (var i = 0; i < encKey.length; i++) encKey[i] ^= 0x64;
    offset += keyLen;

    var keyPlain = AES.decryptECB(CORE_KEY, encKey);
    var keyText = decodeUTF8(keyPlain);
    if (keyText.indexOf(NCM_PREFIX) !== 0) throw new Error('密钥段解密失败，文件可能不是标准 NCM');
    // 去掉 "neteasecloudmusic" 前缀，再去掉 PKCS#7 填充
    var cut = keyPlain.length;
    var pad = keyPlain[cut - 1];
    if (pad > 0 && pad <= 16 && pad <= cut - NCM_PREFIX.length) cut -= pad;
    var rc4Key = keyPlain.subarray(NCM_PREFIX.length, cut);
    if (rc4Key.length === 0) throw new Error('密钥段为空');

    // ---- 元数据段 ----
    report('meta', 0.08, '解析歌曲信息');
    if (offset + 4 > bytes.length) throw new Error('文件已损坏：缺少元数据长度');
    var metaLen = dv.getUint32(offset, true); offset += 4;

    var meta = null;
    if (metaLen > 0) {
      if (offset + metaLen > bytes.length) throw new Error('文件已损坏：元数据长度越界');
      var encMeta = new Uint8Array(bytes.subarray(offset, offset + metaLen));
      offset += metaLen;
      try {
        for (var m = 0; m < encMeta.length; m++) encMeta[m] ^= 0x63;
        var metaStr = decodeUTF8(encMeta);
        var cipher = base64ToBytes(metaStr.slice(META_PREFIX_LEN));
        if (cipher.length && cipher.length % 16 === 0) {
          var jsonText = decodeUTF8(AES.decryptECBPadded(META_KEY, cipher));
          if (jsonText.indexOf('music:') === 0) jsonText = jsonText.slice(6);
          else if (jsonText.indexOf('dj:') === 0) jsonText = jsonText.slice(3);
          meta = JSON.parse(jsonText);
          // 电台节目（dj:）的有效信息在 mainMusic 里
          if (meta && meta.mainMusic) meta = meta.mainMusic;
        }
      } catch (e) {
        // 元数据损坏不影响音频解密，降级处理
        meta = null;
      }
    }

    // ---- 封面区：确定音频起点 ----
    report('cover', 0.1, '定位音频数据');
    var coverStart = offset;                       // 封面区起点（CRC32 之前）
    if (coverStart + 5 > bytes.length) throw new Error('文件已损坏：缺少封面区');
    var coverFrameLen = 0, imageLen = 0;
    if (coverStart + 9 <= bytes.length) coverFrameLen = dv.getUint32(coverStart + 5, true);
    if (coverStart + 13 <= bytes.length) imageLen = dv.getUint32(coverStart + 9, true);

    var box = buildKeyBox(rc4Key);
    var PROBE = 4096;

    // 候选偏移：覆盖已知的几种布局读法
    var candidates = [];
    function pushCandidate(value, label) {
      if (value > coverStart + 4 && value < bytes.length &&
          candidates.every(function (c) { return c.value !== value; })) {
        candidates.push({ value: value, label: label });
      }
    }
    // ① 帧长度 + 图片长度字段（2025 年后文件的正确读法，见 taurusxin/ncmdump）
    pushCandidate(coverStart + 13 + coverFrameLen, 'frame+len-field');
    // ② 帧长度，无额外长度字段（经典读法）
    pushCandidate(coverStart + 9 + coverFrameLen, 'frame-only');
    // ③④ 只按图片长度跳过
    pushCandidate(coverStart + 13 + imageLen, 'image+len-field');
    pushCandidate(coverStart + 9 + imageLen, 'image-only');

    var audioStart = -1;
    var layout = '';
    var probeFormat = null;

    for (var ci = 0; ci < candidates.length; ci++) {
      var fmt = probeAt(bytes, candidates[ci].value, box, PROBE);
      if (fmt) {
        audioStart = candidates[ci].value;
        layout = candidates[ci].label;
        probeFormat = fmt;
        break;
      }
    }

    // 兜底：在封面区内逐字节扫描（封面最多几十 KB，开销可忽略）
    if (audioStart < 0) {
      var scanEnd = Math.min(bytes.length - 16, coverStart + 5 + Math.max(coverFrameLen, imageLen) + 64);
      for (var s = coverStart + 5; s <= scanEnd; s++) {
        var f2 = probeAt(bytes, s, box, PROBE);
        if (f2) {
          audioStart = s;
          layout = 'scanned@' + (s - coverStart);
          probeFormat = f2;
          break;
        }
      }
    }

    if (audioStart < 0) {
      throw new Error('解密后没有识别到有效的音频数据：文件可能已损坏，或是尚未支持的 NCM 新变体');
    }

    var image = null;
    if (imageLen > 0 && coverStart + 13 + imageLen <= audioStart) {
      image = bytes.subarray(coverStart + 13, coverStart + 13 + imageLen);
    } else {
      // 图片长度字段不可靠时，按文件魔数在封面区内截取
      image = findImage(bytes, coverStart + 5, audioStart);
    }

    // ---- 音频 ----
    report('audio', 0, '解密音频流');
    var audio = new Uint8Array(bytes.subarray(audioStart));
    await decryptAudio(audio, box, function (p) {
      report('audio', p, '解密音频流');
    });

    // 解密完成后再校验一次文件头，避免输出坏文件
    var format = detectFormat(audio.subarray(0, Math.min(4096, audio.length)));
    if (!format) {
      throw new Error('解密结果的文件头异常（识别不到 mp3/flac 等格式），已放弃输出');
    }
    if (probeFormat && format !== probeFormat) {
      throw new Error('解密结果前后不一致（' + probeFormat + ' → ' + format + '），已放弃输出');
    }
    validateAudio(audio, format);

    report('done', 1, '完成');

    var title = (meta && (meta.musicName || meta.songName || meta.album)) || '';
    var artist = '';
    if (meta && Array.isArray(meta.artist) && meta.artist.length) {
      artist = meta.artist.map(function (a) {
        return Array.isArray(a) ? a[0] : String(a);
      }).filter(Boolean).join('、');
    }

    var baseName = title ? (artist ? artist + ' - ' + title : title) : '';

    return {
      audio: audio,
      format: format,
      meta: meta,
      image: image,
      title: title || '未知歌曲',
      artist: artist || '未知歌手',
      album: (meta && meta.album) || '',
      bitrate: (meta && (meta.bitrate || meta.Bitrate)) || 0,
      duration: (meta && meta.duration) || 0,
      fileName: sanitize(baseName) + '.' + format,
      sourceName: '',
      // 诊断信息：定位布局、封面尺寸等，便于排查新变体
      diag: {
        layout: layout,
        coverFrameLen: coverFrameLen,
        imageLen: imageLen,
        audioStart: audioStart,
        audioSize: audio.length
      }
    };
  }

  var NcmParser = {
    parse: parse,
    isNcm: isNcm,
    sanitize: sanitize,
    detectFormat: detectFormat,
    buildKeyBox: buildKeyBox,
    keystreamByte: keystreamByte
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NcmParser;
  else root.NcmParser = NcmParser;
})(typeof globalThis !== 'undefined' ? globalThis : this);
