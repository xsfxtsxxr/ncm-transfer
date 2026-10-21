/**
 * flac-encoder.js — 纯 JavaScript 的 FLAC 编码器（无依赖，可在 file:// 下运行）
 *
 * 为什么自己写：现成的 FLAC 编码器基本是 wasm 版，需要 fetch 加载 .wasm，
 * 而本站要求「双击 index.html 就能用」，file:// 下 fetch 会被拦。纯 JS 版没有这个问题。
 *
 * 实现：STREAMINFO + 变块长帧 + fixed 预测(order 0/1/2) + Rice 编码，逐帧择优。
 * 输出为 16 bit PCM 的无损容器。
 *
 * 已用 libsndfile 交叉验证：解码结果与原始 PCM 逐样本一致。
 * STREAMINFO 的 MD5 填 0（规范允许，表示“未提供”）。
 */
(function (root) {
  'use strict';

  /* ---------------- 位写入器 ----------------
     不变量：cnt < 8，单次 writeBits 的 n <= 24，合并后不超过 31 位 */
  function BitWriter(initial) {
    this.buf = new Uint8Array(initial || 65536);
    this.len = 0;
    this.acc = 0;
    this.cnt = 0;
  }

  BitWriter.prototype._push = function (byte) {
    if (this.len === this.buf.length) {
      var next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = byte;
  };

  BitWriter.prototype.writeBits = function (value, n) {
    if (n <= 0) return;
    if (n > 24) throw new Error('writeBits 单次最多 24 位');
    this.acc = (this.acc << n) | (value & ((1 << n) - 1));
    this.cnt += n;
    while (this.cnt >= 8) {
      this.cnt -= 8;
      this._push((this.acc >>> this.cnt) & 0xff);
    }
    this.acc &= (1 << this.cnt) - 1;
  };

  BitWriter.prototype.writeBytes = function (arr) {
    if (this.cnt !== 0) throw new Error('writeBytes 需要字节对齐');
    for (var i = 0; i < arr.length; i++) this._push(arr[i]);
  };

  /** 写 q 个 0 再写 1（Rice 一元码） */
  BitWriter.prototype.writeUnary = function (q) {
    var chunks = Math.floor(q / 8);
    for (var i = 0; i < chunks; i++) this.writeBits(0, 8);
    this.writeBits(1, q - chunks * 8 + 1);
  };

  BitWriter.prototype.align = function () {
    if (this.cnt > 0) this.writeBits(0, 8 - this.cnt);
  };

  BitWriter.prototype.bytes = function () {
    return this.buf.subarray(0, this.len);
  };

  /* ---------------- CRC ---------------- */
  var CRC8_TABLE = (function () {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
      t[i] = c;
    }
    return t;
  })();

  var CRC16_TABLE = (function () {
    var t = new Uint16Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i << 8;
      for (var k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
      t[i] = c;
    }
    return t;
  })();

  function crc8(bytes, len) {
    var c = 0;
    for (var i = 0; i < len; i++) c = CRC8_TABLE[c ^ bytes[i]];
    return c;
  }

  function crc16(bytes, len) {
    var c = 0;
    for (var i = 0; i < len; i++) c = ((c << 8) & 0xffff) ^ CRC16_TABLE[(c >> 8) ^ bytes[i]];
    return c & 0xffff;
  }

  /* ---------------- UTF-8 采样号 ---------------- */
  function utf8Number(v) {
    if (v < 0x80) return [v];
    if (v < 0x800) return [0xc0 | (v >> 6), 0x80 | (v & 0x3f)];
    if (v < 0x10000) return [0xe0 | (v >> 12), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f)];
    if (v < 0x200000) {
      return [0xf0 | (v >> 18), 0x80 | ((v >> 12) & 0x3f), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f)];
    }
    if (v < 0x4000000) {
      return [0xf8 | (v >> 24), 0x80 | ((v >> 18) & 0x3f), 0x80 | ((v >> 12) & 0x3f),
              0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f)];
    }
    return [0xfc | (v >> 30), 0x80 | ((v >> 24) & 0x3f), 0x80 | ((v >> 18) & 0x3f),
            0x80 | ((v >> 12) & 0x3f), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f)];
  }

  /* ---------------- 固定预测 ---------------- */
  function residualAt(chan, start, i, order) {
    var v = chan[start + i];
    if (order === 0) return v;
    if (order === 1) return i === 0 ? v : v - chan[start + i - 1];
    if (i === 0) return v;
    if (i === 1) return v - chan[start];
    return v - 2 * chan[start + i - 1] + chan[start + i - 2];
  }

  function zigzag(r) {
    return ((r << 1) ^ (r >> 31)) >>> 0;
  }

  /** 一次遍历估算该阶预测的 Rice 参数与总比特数 */
  function estimate(chan, start, n, order) {
    var count = n - order;
    if (count <= 0) return { order: order, k: 0, bits: Infinity };

    var sum = 0;
    for (var i = order; i < n; i++) sum += zigzag(residualAt(chan, start, i, order));

    var mean = sum / count;
    var k = 0;
    while (k < 14 && (1 << k) < mean) k++;

    // 在 k-1 / k / k+1 中挑最省比特的
    var bestK = k, bestBits = Infinity;
    for (var c = Math.max(0, k - 1); c <= Math.min(14, k + 1); c++) {
      var bits = Math.round(sum / (1 << c)) + count * (1 + c);
      if (bits < bestBits) { bestBits = bits; bestK = c; }
    }
    return { order: order, k: bestK, bits: bestBits };
  }

  /* ---------------- 帧生成器 ---------------- */
  function* frameChunks(opt) {
    var channels = opt.channels;
    var sampleRate = opt.sampleRate | 0;
    var bps = opt.bitsPerSample || 16;
    var blockSize = opt.blockSize || 4096;
    var nch = channels.length;
    var total = channels[0].length;
    var mask = (1 << bps) - 1;

    if (nch < 1 || nch > 8) throw new Error('FLAC 声道数需在 1..8 之间');
    if (bps !== 8 && bps !== 16) throw new Error('当前仅支持 8/16 bit 输出');

    // ---- "fLaC" 魔数（注意大写 L：0x4C） ----
    yield new Uint8Array([0x66, 0x4c, 0x61, 0x43]);

    // ---- STREAMINFO ----
    var si = new BitWriter(32);
    si.writeBits(1, 1);              // 这是最后一个元数据块
    si.writeBits(0, 7);              // 块类型 0 = STREAMINFO
    si.writeBits(34, 24);            // 块长度
    var lastN = total % blockSize;
    var minBlock = lastN === 0 ? Math.min(blockSize, total) : Math.min(blockSize, lastN);
    si.writeBits(minBlock, 16);
    si.writeBits(Math.min(blockSize, total), 16);
    si.writeBits(0, 24);             // 最小帧长未知
    si.writeBits(0, 24);             // 最大帧长未知
    si.align();
    yield new Uint8Array(si.bytes());

    var sb = new BitWriter(16);
    sb.writeBits(sampleRate, 20);
    sb.writeBits(nch - 1, 3);
    sb.writeBits(bps - 1, 5);
    var lo32 = total % 4294967296;
    sb.writeBits(Math.floor(total / 4294967296), 4);
    sb.writeBits(Math.floor(lo32 / 65536), 16);
    sb.writeBits(lo32 % 65536, 16);
    sb.align();
    yield new Uint8Array(sb.bytes());

    yield new Uint8Array(16);        // MD5（0 = 未提供）

    // ---- 逐帧 ----
    for (var start = 0; start < total; start += blockSize) {
      var n = Math.min(blockSize, total - start);

      // 帧头：14+1+1+4+4+4+3+1 = 32 位，正好 4 字节
      var hw = new BitWriter(16);
      hw.writeBits(0x3ffe, 14);
      hw.writeBits(0, 1);                  // 保留
      hw.writeBits(1, 1);                  // 变块长策略
      hw.writeBits(n <= 256 ? 6 : 7, 4);   // 块长码
      hw.writeBits(0, 4);                  // 采样率码 0 = 见 STREAMINFO
      hw.writeBits(nch - 1, 4);            // 声道分配
      hw.writeBits(0, 3);                  // 位深码 0 = 见 STREAMINFO
      hw.writeBits(0, 1);                  // 保留
      var hb = hw.bytes();

      var hdrArr = [hb[0], hb[1], hb[2], hb[3]].concat(utf8Number(start));
      if (n <= 256) hdrArr.push(n - 1);
      else hdrArr.push(((n - 1) >> 8) & 0xff, (n - 1) & 0xff);
      var hdr = new Uint8Array(hdrArr);

      var bw = new BitWriter(blockSize * nch * 2 + 512);
      bw.writeBytes(hdr);
      bw.writeBits(crc8(hdr, hdr.length), 8);

      for (var ch = 0; ch < nch; ch++) {
        var chan = channels[ch];

        var best = null;
        for (var order = 0; order <= 2; order++) {
          if (order > 0 && n <= order) continue;
          var cand = estimate(chan, start, n, order);
          if (!isFinite(cand.bits)) continue;
          var cost = cand.bits + order * bps + 8;
          if (best === null || cost < best.cost) best = { order: cand.order, k: cand.k, cost: cost };
        }
        if (best === null) best = { order: 0, k: 0, cost: 0 };

        bw.writeBits(0, 1);                  // 填充位
        bw.writeBits(8 + best.order, 6);     // 子帧类型：fixed
        bw.writeBits(0, 1);                  // 无 wasted bits
        for (var w = 0; w < best.order; w++) {
          bw.writeBits(chan[start + w] & mask, bps);   // 预热样本
        }
        bw.writeBits(0, 2);                  // 残差方式：Rice（4 位参数）
        bw.writeBits(0, 4);                  // 分区阶数 0（单分区）
        bw.writeBits(best.k, 4);             // Rice 参数

        // 残差数量为 n - order（前 order 个样本已作为预热样本写出）
        for (var i = best.order; i < n; i++) {
          var u = zigzag(residualAt(chan, start, i, best.order));
          bw.writeUnary(u >>> best.k);
          if (best.k > 0) bw.writeBits(u, best.k);
        }
      }

      bw.align();
      var frameBytes = bw.bytes();
      var fcrc = crc16(frameBytes, frameBytes.length);
      var frameOut = new Uint8Array(frameBytes.length + 2);
      frameOut.set(frameBytes, 0);
      frameOut[frameBytes.length] = (fcrc >> 8) & 0xff;
      frameOut[frameBytes.length + 1] = fcrc & 0xff;
      yield frameOut;
    }
  }

  function concat(parts) {
    var size = 0;
    for (var i = 0; i < parts.length; i++) size += parts[i].length;
    var out = new Uint8Array(size);
    var pos = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], pos);
      pos += parts[j].length;
    }
    return out;
  }

  function encode(opt) {
    var parts = [];
    var it = frameChunks(opt);
    var r = it.next();
    while (!r.done) { parts.push(r.value); r = it.next(); }
    return concat(parts);
  }

  /** 带进度、定期让出主线程的版本 */
  async function encodeAsync(opt, onProgress) {
    var parts = [];
    var it = frameChunks(opt);
    var r = it.next();
    var count = 0;
    var totalFrames = Math.ceil(opt.channels[0].length / (opt.blockSize || 4096));
    while (!r.done) {
      parts.push(r.value);
      count++;
      if (onProgress) onProgress(Math.min(1, count / (totalFrames + 3)));
      if (count % 8 === 0) await new Promise(function (res) { setTimeout(res, 0); });
      r = it.next();
    }
    if (onProgress) onProgress(1);
    return concat(parts);
  }

  var FlacEncoder = { encode: encode, encodeAsync: encodeAsync, crc8: crc8, crc16: crc16 };

  if (typeof module !== 'undefined' && module.exports) module.exports = FlacEncoder;
  else root.FlacEncoder = FlacEncoder;
})(typeof globalThis !== 'undefined' ? globalThis : this);
