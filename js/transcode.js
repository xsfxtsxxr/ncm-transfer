/**
 * transcode.js — 输出的目标格式转换
 *
 * 流程：解密出的原始音频 → OfflineAudioContext 解码成 PCM → 目标编码器重新编码
 *   - MP3：lamejs（纯 JS，已随项目打包在 vendor/，可离线）
 *   - FLAC：自研编码器（js/flac-encoder.js）
 *
 * 若目标格式与源格式相同，直接原样输出（不重新编码，避免二次损失）。
 */
(function (root) {
  'use strict';

  // lamejs 支持的采样率
  var MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  function nearestRate(rate, list) {
    var best = list[0];
    var diff = Math.abs(rate - best);
    for (var i = 1; i < list.length; i++) {
      var d = Math.abs(rate - list[i]);
      if (d < diff) { diff = d; best = list[i]; }
    }
    return best;
  }

  /* ---------------- 从文件头读采样率 ---------------- */
  function readSampleRate(bytes, format) {
    try {
      if (format === 'flac') {
        // fLaC + STREAMINFO（第一个元数据块）：采样率在偏移 18 起的 20 位
        if (bytes.length > 21 && bytes[0] === 0x66 && bytes[1] === 0x4c) {
          return ((bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4)) || 44100;
        }
      } else if (format === 'mp3') {
        // 跳过 ID3v2
        var off = 0;
        if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
          off = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
                      ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
        }
        var rates = [44100, 48000, 32000];
        for (var i = off; i + 4 < bytes.length && i < off + 200000; i++) {
          if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
            var b1 = bytes[i + 1], b2 = bytes[i + 2];
            var verBits = (b1 >> 3) & 0x03;
            var srIdx = (b2 >> 2) & 0x03;
            if (verBits === 3) return rates[srIdx] || 44100;
            if (verBits === 2) return [22050, 24000, 16000][srIdx] || 22050;
            if (verBits === 0) return [11025, 12000, 8000][srIdx] || 11025;
          }
        }
      }
    } catch (e) { /* 读不出来就用默认值 */ }
    return 44100;
  }

  /* ---------------- 解码为 PCM ---------------- */
  async function decode(bytes, rate) {
    var Ctx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('当前浏览器不支持音频解码（缺少 OfflineAudioContext）');

    // decodeAudioData 会接管传入的 ArrayBuffer，这里复制一份，避免影响原始数据
    var copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    var ctx = new Ctx(1, 1, rate);
    try {
      return await ctx.decodeAudioData(copy);
    } catch (e) {
      throw new Error('音频解码失败，当前浏览器可能不支持解码该源格式');
    }
  }

  /** AudioBuffer → 1/2 声道 Int16 PCM，>2 声道时下混 */
  function toPcm(audio) {
    var n = audio.length;
    var src = [];
    for (var c = 0; c < audio.numberOfChannels; c++) src.push(audio.getChannelData(c));

    var chans;
    if (src.length === 1) {
      chans = [src[0]];
    } else if (src.length === 2) {
      chans = [src[0], src[1]];
    } else {
      // 多声道下混为立体声：奇数位进左、偶数位进右
      var l = new Float32Array(n), r = new Float32Array(n);
      for (var c2 = 0; c2 < src.length; c2++) {
        var target = (c2 % 2 === 0) ? l : r;
        var gain = c2 < 2 ? 1 : 0.5;
        for (var i = 0; i < n; i++) target[i] += src[c2][i] * gain;
      }
      chans = [l, r];
    }

    return chans.map(function (f32) {
      var out = new Int16Array(n);
      for (var i = 0; i < n; i++) {
        var v = f32[i] * 32767;
        out[i] = v > 32767 ? 32767 : (v < -32768 ? -32768 : (v < 0 ? v - 0.5 : v + 0.5) | 0);
      }
      return out;
    });
  }

  /* ---------------- MP3 编码（lamejs） ---------------- */
  async function encodeMp3(channels, sampleRate, kbps, onProgress) {
    if (typeof root.lamejs !== 'function') {
      throw new Error('MP3 编码器未加载（vendor/lame.min.js）');
    }
    var enc = new root.lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
    var total = channels[0].length;
    var CH = 1152;
    var parts = [];
    var left = new Int16Array(CH);
    var right = new Int16Array(CH);
    var stereo = channels.length > 1;

    for (var i = 0; i < total; i += CH) {
      var n = Math.min(CH, total - i);
      var lv = left.subarray(0, n);
      var rv = right.subarray(0, n);
      var j;
      for (j = 0; j < n; j++) {
        lv[j] = channels[0][i + j];
        if (stereo) rv[j] = channels[1][i + j];
      }
      var buf = stereo ? enc.encodeBuffer(lv, rv) : enc.encodeBuffer(lv);
      if (buf.length) parts.push(new Uint8Array(buf));   // lamejs 返回 Int8Array，逐字节转型
      if (onProgress) onProgress(Math.min(1, (i + n) / total));

      // 每约 1/20 让出主线程，保证界面不假死
      if ((i / CH) % 200 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    var tail = enc.flush();
    if (tail.length) parts.push(new Uint8Array(tail));

    var size = 0;
    for (var p = 0; p < parts.length; p++) size += parts[p].length;
    var out = new Uint8Array(size);
    var pos = 0;
    for (var q = 0; q < parts.length; q++) {
      out.set(parts[q], pos);
      pos += parts[q].length;
    }
    return out;
  }

  /* ---------------- 对外接口 ---------------- */
  function isPassthrough(sourceFormat, target) {
    return !target || target === 'original' || target === sourceFormat;
  }

  /**
   * @param {Object} parsed NcmParser.parse 的结果
   * @param {string} target 'original' | 'mp3' | 'flac'
   * @param {Object} opts { bitrate, onProgress(0..1), onStage(text) }
   * @returns {Promise<{data: Uint8Array, format: string, transcoded: boolean}>}
   */
  async function transcode(parsed, target, opts) {
    opts = opts || {};
    var sourceFormat = parsed.format;

    if (isPassthrough(sourceFormat, target)) {
      return { data: parsed.audio, format: sourceFormat, transcoded: false };
    }
    if (target !== 'mp3' && target !== 'flac') {
      throw new Error('不支持的目标格式：' + target);
    }

    var sourceRate = readSampleRate(parsed.audio, sourceFormat);
    var rate = target === 'mp3' ? nearestRate(Math.min(sourceRate, 48000), MP3_RATES) : sourceRate;

    if (opts.onStage) opts.onStage('解码音频');
    var audio = await decode(parsed.audio, rate);
    var pcm = toPcm(audio);
    if (opts.onProgress) opts.onProgress(0.12);

    var encodeStart = 0.15;
    var span = 0.85;

    if (target === 'mp3') {
      if (opts.onStage) opts.onStage('编码 MP3');
      var kbps = opts.bitrate || 192;
      var mp3 = await encodeMp3(pcm, rate, kbps, function (p) {
        if (opts.onProgress) opts.onProgress(encodeStart + p * span);
      });
      if (opts.onProgress) opts.onProgress(1);
      return { data: mp3, format: 'mp3', transcoded: true, bitrate: kbps * 1000 };
    }

    if (opts.onStage) opts.onStage('编码 FLAC');
    var flac = await root.FlacEncoder.encodeAsync({
      channels: pcm,
      sampleRate: rate,
      bitsPerSample: 16,
      blockSize: 4096
    }, function (p) {
      if (opts.onProgress) opts.onProgress(encodeStart + p * span);
    });
    if (opts.onProgress) opts.onProgress(1);
    return { data: flac, format: 'flac', transcoded: true, bitrate: 0 };
  }

  var NcmTranscode = {
    transcode: transcode,
    isPassthrough: isPassthrough,
    readSampleRate: readSampleRate,
    nearestRate: nearestRate
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NcmTranscode;
  else root.NcmTranscode = NcmTranscode;
})(typeof globalThis !== 'undefined' ? globalThis : this);
