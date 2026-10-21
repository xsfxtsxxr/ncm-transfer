/**
 * zip.js — 极简 ZIP 打包器（仅 STORE 存储模式，不压缩）
 *
 * 音频本身已是压缩格式，再套 deflate 收益极低，因此直接存储即可，
 * 这样无需任何第三方库、速度最快，且兼容所有解压软件。
 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    var time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
    var date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time: time, date: date };
  }

  /**
   * @param {Array<{name: string, data: Uint8Array}>} entries
   * @returns {Blob}
   */
  function createZip(entries) {
    var encoder = new TextEncoder();
    var now = dosTime(new Date());
    var parts = [];
    var central = [];
    var offset = 0;

    entries.forEach(function (entry) {
      var nameBytes = encoder.encode(entry.name);
      var data = entry.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // 本地文件头签名
      lv.setUint16(4, 20, true);           // 解压所需版本
      lv.setUint16(6, 0x0800, true);       // bit 11：文件名为 UTF-8
      lv.setUint16(8, 0, true);            // 压缩方法：存储
      lv.setUint16(10, now.time, true);
      lv.setUint16(12, now.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // 压缩后大小
      lv.setUint32(22, data.length, true); // 原始大小
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // 扩展字段长度
      local.set(nameBytes, 30);

      parts.push(local, data);

      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);   // 中央目录签名
      cv.setUint16(4, 20, true);           // 创建版本
      cv.setUint16(6, 20, true);           // 解压所需版本
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, now.time, true);
      cv.setUint16(14, now.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // 扩展字段
      cv.setUint16(32, 0, true);           // 注释
      cv.setUint16(34, 0, true);           // 起始磁盘号
      cv.setUint16(36, 0, true);           // 内部属性
      cv.setUint32(38, 0, true);           // 外部属性
      cv.setUint32(42, offset, true);      // 本地头偏移
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    });

    var centralSize = central.reduce(function (n, c) { return n + c.length; }, 0);

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  }

  var Zip = { createZip: createZip, crc32: crc32 };

  if (typeof module !== 'undefined' && module.exports) module.exports = Zip;
  else root.NcmZip = Zip;
})(typeof globalThis !== 'undefined' ? globalThis : this);
