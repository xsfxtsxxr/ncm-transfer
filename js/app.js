/**
 * app.js — 页面交互：拖拽入队 / 选择输出格式 / 点击开始转换 / 进度 / 下载
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  var dropzone = $('#dropzone');
  var fileInput = $('#fileInput');
  var board = $('#board');
  var listEl = $('#list');
  var statsEl = $('#boardStats');
  var zipBtn = $('#zipBtn');
  var clearBtn = $('#clearBtn');
  var startBtn = $('#startBtn');
  var formatSeg = $('#formatSeg');
  var bitrateField = $('#bitrateField');
  var bitrateSel = $('#bitrateSel');
  var boardHint = $('#boardHint');
  var toasts = $('#toasts');

  var MIME = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    wav: 'audio/wav'
  };

  var HINTS = {
    original: '原格式：直接还原原始音频，不重新编码，音质无损',
    mp3: 'MP3：有损压缩，体积小，适合手机与车载；源是 FLAC 时会转码一次',
    flac: 'FLAC：无损容器。若源本身是 MP3，转成 FLAC 不会提升音质，体积反而明显变大'
  };

  var state = { items: [], running: false, seq: 0, target: 'original', bitrate: 192 };

  /* ---------------- 工具函数 ---------------- */
  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB'];
    var v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
  }

  function fmtDuration(ms) {
    if (!ms || ms <= 0) return '';
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function toast(text, type, ms) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = text;
    toasts.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 240);
    }, ms || 3000);
  }

  function baseName(name) {
    return String(name).replace(/\.[^./\\]+$/, '');
  }

  function coverMime(bytes) {
    if (!bytes || bytes.length < 4) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
    return 'image/jpeg';
  }

  function pendingItems() {
    return state.items.filter(function (i) { return i.status === 'pending'; });
  }

  /* ---------------- 渲染 ---------------- */
  var ICON_NOTE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="8" cy="18" r="3"/><path d="M11 18V5l9-2v11"/><circle cx="17" cy="15" r="3"/></svg>';

  function createRow(item) {
    var li = document.createElement('li');
    li.className = 'row';

    var cover = document.createElement('div');
    cover.className = 'row-cover';
    cover.innerHTML = ICON_NOTE;

    var main = document.createElement('div');
    main.className = 'row-main';

    var line1 = document.createElement('div');
    line1.className = 'row-line1';
    var title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = baseName(item.name);
    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'NCM';
    line1.appendChild(title);
    line1.appendChild(badge);

    var line2 = document.createElement('div');
    line2.className = 'row-line2';
    line2.textContent = fmtBytes(item.size);

    var bar = document.createElement('div');
    bar.className = 'bar';
    var fill = document.createElement('i');
    bar.appendChild(fill);

    main.appendChild(line1);
    main.appendChild(line2);
    main.appendChild(bar);

    var side = document.createElement('div');
    side.className = 'row-side';
    var status = document.createElement('span');
    status.className = 'row-status';
    status.textContent = '待转换';
    var dl = document.createElement('button');
    dl.className = 'btn-dl';
    dl.type = 'button';
    dl.textContent = '下载';
    dl.hidden = true;
    dl.addEventListener('click', function () {
      if (item.status === 'done') downloadItem(item);
      else if (item.status === 'error') retryItem(item);
    });
    side.appendChild(status);
    side.appendChild(dl);

    li.appendChild(cover);
    li.appendChild(main);
    li.appendChild(side);
    listEl.appendChild(li);

    item.el = { li: li, cover: cover, title: title, badge: badge, line2: line2, fill: fill, bar: bar, status: status, dl: dl };
  }

  function updateRow(item) {
    var el = item.el;
    if (!el) return;

    if (item.status === 'pending') {
      el.status.textContent = '待转换';
      el.status.className = 'row-status';
    } else if (item.status === 'working') {
      var pct = Math.round((item.progress || 0) * 100);
      el.status.textContent = (item.stageText || '处理中') + ' ' + pct + '%';
      el.status.className = 'row-status';
      el.fill.style.width = Math.max(2, pct) + '%';
    } else if (item.status === 'done') {
      el.status.textContent = item.result && item.result.transcoded ? '已转码' : '已完成';
      el.status.className = 'row-status ok';
      el.fill.style.width = '100%';
      el.bar.classList.add('is-done');
      el.dl.hidden = false;
      el.dl.textContent = '下载';
    } else if (item.status === 'error') {
      el.status.textContent = '失败';
      el.status.className = 'row-status';
      el.fill.style.width = '100%';
      el.fill.style.background = 'linear-gradient(90deg,#ff3b3b,#ff7b7b)';
      el.badge.className = 'badge err';
      el.badge.textContent = 'ERR';
      el.dl.hidden = false;
      el.dl.textContent = '重试';
    }
  }

  function resetRow(item) {
    item.status = 'pending';
    item.progress = 0;
    item.error = null;
    item.stageText = '待转换';
    item.result = null;
    if (item.el) {
      item.el.badge.className = 'badge';
      item.el.badge.textContent = 'NCM';
      item.el.line2.textContent = fmtBytes(item.size);
      item.el.fill.style.width = '0';
      item.el.fill.style.background = '';
      item.el.bar.classList.remove('is-done');
      item.el.dl.hidden = true;
    }
    updateRow(item);
  }

  function updateStats() {
    var total = state.items.length;
    if (!total) {
      board.hidden = true;
      startBtn.disabled = true;
      startBtn.textContent = '开始转换';
      zipBtn.disabled = true;
      zipBtn.hidden = true;
      return;
    }
    board.hidden = false;

    var pending = state.items.filter(function (i) { return i.status === 'pending'; }).length;
    var done = state.items.filter(function (i) { return i.status === 'done'; }).length;
    var failed = state.items.filter(function (i) { return i.status === 'error'; }).length;
    var size = state.items.reduce(function (n, i) { return n + i.size; }, 0);

    var text = total + ' 个文件 · 共 ' + fmtBytes(size);
    if (state.running) text = '转换中… ' + text;
    if (done || failed) {
      text += ' · 已完成 ' + done;
      if (failed) text += ' · 失败 ' + failed;
    } else if (!state.running && pending) {
      text += ' · 待转换 ' + pending;
    }
    statsEl.textContent = text;

    startBtn.disabled = pending === 0 || state.running;
    startBtn.textContent = pending ? '开始转换 (' + pending + ')' : (state.running ? '转换中…' : '开始转换');

    zipBtn.disabled = done === 0;
    zipBtn.hidden = done === 0;
    zipBtn.textContent = done > 1 ? '打包下载 ZIP (' + done + ')' : '打包下载 ZIP';

    var locked = state.running || state.items.some(function (i) { return i.status === 'working'; });
    formatSeg.classList.toggle('is-locked', locked);
    bitrateSel.disabled = locked;
  }

  /* ---------------- 入队 ---------------- */
  function addFiles(files) {
    var accepted = 0, rejected = 0;

    Array.prototype.forEach.call(files, function (file) {
      if (!/\.ncm$/i.test(file.name)) { rejected++; return; }
      if (state.items.some(function (i) { return i.name === file.name && i.size === file.size; })) return;

      var item = {
        id: ++state.seq,
        file: file,
        name: file.name,
        size: file.size,
        status: 'pending',
        progress: 0,
        stageText: '待转换',
        result: null,
        error: null,
        el: null
      };
      state.items.push(item);
      createRow(item);
      accepted++;
    });

    if (rejected) toast('已跳过 ' + rejected + ' 个非 .ncm 文件', 'err');
    if (accepted) {
      updateStats();
      toast('已加入 ' + accepted + ' 个文件，点击「开始转换」即可', null, 2600);
    }
  }

  /* ---------------- 转换流程 ---------------- */
  async function processQueue() {
    if (state.running) return;
    state.running = true;
    updateStats();

    var item;
    while ((item = state.items.find(function (i) { return i.status === 'pending'; }))) {
      await runItem(item);
      updateStats();
    }

    state.running = false;
    updateStats();

    var done = state.items.filter(function (i) { return i.status === 'done'; }).length;
    var failed = state.items.filter(function (i) { return i.status === 'error'; }).length;
    if (done + failed > 0) {
      toast('转换结束：成功 ' + done + ' 个' + (failed ? '，失败 ' + failed + ' 个' : ''), failed ? 'err' : 'ok', 3400);
    }
  }

  async function runItem(item) {
    item.status = 'working';
    item.progress = 0;
    item.stageText = '解析文件';
    updateRow(item);

    var target = state.target;
    var passthroughTarget = target === 'original';

    try {
      var buffer = await item.file.arrayBuffer();

      // 转码时把进度预算的 60% 留给解析，其余留给解码 + 编码
      var parseSpan = passthroughTarget ? 1 : 0.6;
      var parsed = await window.NcmParser.parse(buffer, {
        onProgress: function (p) {
          item.progress = p.value * parseSpan;
          item.stageText = p.text;
          updateRow(item);
        }
      });

      var out = await window.NcmTranscode.transcode(parsed, target, {
        bitrate: state.bitrate,
        onStage: function (t) {
          item.stageText = t;
          updateRow(item);
        },
        onProgress: function (p) {
          item.progress = parseSpan + p * (1 - parseSpan);
          updateRow(item);
        }
      });

      // 文件名：有元数据就用「歌手 - 歌名」，否则退回原文件名
      var stem;
      if (parsed.meta && parsed.title && parsed.title !== '未知歌曲') {
        stem = (parsed.artist && parsed.artist !== '未知歌手' ? parsed.artist + ' - ' : '') + parsed.title;
      } else {
        stem = baseName(item.name);
      }

      item.result = {
        data: out.data,
        format: out.format,
        sourceFormat: parsed.format,
        transcoded: out.transcoded,
        title: parsed.title,
        artist: parsed.artist,
        album: parsed.album,
        bitrate: out.transcoded ? (out.bitrate || state.bitrate * 1000) : parsed.bitrate,
        duration: parsed.duration,
        image: parsed.image,
        fileName: window.NcmParser.sanitize(stem) + '.' + out.format,
        diag: parsed.diag
      };

      item.status = 'done';
      item.progress = 1;
      item.stageText = '完成';
      renderResult(item);
      updateRow(item);
    } catch (err) {
      item.status = 'error';
      item.error = err && err.message ? err.message : String(err);
      item.progress = 1;
      if (item.el) {
        item.el.line2.textContent = '';
        var span = document.createElement('span');
        span.className = 'err-text';
        span.textContent = item.error;
        item.el.line2.appendChild(span);
      }
      updateRow(item);
      toast(item.name + '：' + item.error, 'err', 4600);
    }
  }

  function renderResult(item) {
    var res = item.result;
    var el = item.el;
    if (!el || !res) return;

    el.title.textContent = res.title && res.title !== '未知歌曲' ? res.title : baseName(item.name);

    el.badge.className = 'badge ' + res.format;
    el.badge.textContent = res.format;

    var bits = [];
    if (res.transcoded) bits.push('由 ' + res.sourceFormat.toUpperCase() + ' 转码');
    if (res.artist && res.artist !== '未知歌手') bits.push(res.artist);
    if (res.album) bits.push(res.album);
    if (res.bitrate) bits.push(Math.round(res.bitrate / 1000) + ' kbps');
    var dur = fmtDuration(res.duration);
    if (dur) bits.push(dur);
    bits.push(fmtBytes(res.data.length));
    el.line2.textContent = bits.join(' · ');

    if (res.image && res.image.length) {
      try {
        var blob = new Blob([res.image], { type: coverMime(res.image) });
        var img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        img.alt = '';
        img.onload = function () { URL.revokeObjectURL(this.src); };
        el.cover.innerHTML = '';
        el.cover.appendChild(img);
      } catch (e) { /* 封面失败不影响主流程 */ }
    }
  }

  /* ---------------- 下载 ---------------- */
  function saveBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
  }

  function downloadItem(item) {
    if (!item.result) return;
    var res = item.result;
    saveBlob(new Blob([res.data], { type: MIME[res.format] || 'application/octet-stream' }), res.fileName);
    toast('已保存 ' + res.fileName, 'ok', 2200);
  }

  function retryItem(item) {
    if (item.status !== 'error') return;
    resetRow(item);
    updateStats();
    processQueue();
  }

  function uniqueName(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var i = 2;
    var candidate = stem + ' (' + i + ')' + ext;
    while (used.has(candidate)) {
      i++;
      candidate = stem + ' (' + i + ')' + ext;
    }
    used.add(candidate);
    return candidate;
  }

  function zipAll() {
    var done = state.items.filter(function (i) { return i.status === 'done' && i.result; });
    if (!done.length) return;
    if (done.length === 1) { downloadItem(done[0]); return; }

    var used = new Set();
    var entries = done.map(function (i) {
      return { name: uniqueName(i.result.fileName, used), data: i.result.data };
    });

    try {
      var blob = window.NcmZip.createZip(entries);
      var d = new Date();
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var name = 'ncm-converted-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.zip';
      saveBlob(blob, name);
      toast('已打包 ' + entries.length + ' 首歌曲（' + fmtBytes(blob.size) + '）', 'ok', 3200);
    } catch (e) {
      toast('打包失败：' + (e.message || e), 'err', 4200);
    }
  }

  function clearAll() {
    if (state.running && !window.confirm('还有文件正在转换，确定要清空吗？')) return;
    state.items.forEach(function (item) {
      if (item.el) item.el.li.remove();
      item.result = null;
    });
    state.items = [];
    updateStats();
  }

  /* ---------------- 输出格式 ---------------- */
  function setTarget(target) {
    if (state.target === target) return;
    if (state.running) return;

    state.target = target;

    Array.prototype.forEach.call(formatSeg.querySelectorAll('.seg-btn'), function (btn) {
      var active = btn.dataset.format === target;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    bitrateField.hidden = target !== 'mp3';
    boardHint.textContent = HINTS[target] || '';
    boardHint.classList.toggle('is-warn', target === 'flac');

    // 已有结果时切换格式 → 全部回到待转换，避免列表里混着不同格式
    var hasResult = state.items.some(function (i) { return i.status === 'done' || i.status === 'error'; });
    if (hasResult) {
      state.items.forEach(resetRow);
      updateStats();
      toast('输出格式已切换为「' + labelOf(target) + '」，请重新点击开始转换', null, 3400);
    } else {
      updateStats();
    }
  }

  function labelOf(target) {
    return target === 'original' ? '原格式' : target.toUpperCase();
  }

  /* ---------------- 事件绑定 ---------------- */
  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = '';
  });

  var dragDepth = 0;
  document.addEventListener('dragenter', function (e) {
    e.preventDefault();
    dragDepth++;
    if (dragDepth > 0) dropzone.classList.add('is-drag');
  });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('is-drag');
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-drag');
    var dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(dt.files);
  });

  formatSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (btn && btn.dataset.format) setTarget(btn.dataset.format);
  });

  bitrateSel.addEventListener('change', function () {
    state.bitrate = parseInt(bitrateSel.value, 10) || 192;
  });

  startBtn.addEventListener('click', processQueue);
  zipBtn.addEventListener('click', zipAll);
  clearBtn.addEventListener('click', clearAll);

  boardHint.textContent = HINTS.original;
  updateStats();

  // 对外暴露最小接口，便于嵌入其它页面或做自动化测试
  window.NCMConverter = {
    addFiles: addFiles,
    clear: clearAll,
    start: processQueue,
    setTarget: setTarget,
    get items() { return state.items; }
  };
})();
