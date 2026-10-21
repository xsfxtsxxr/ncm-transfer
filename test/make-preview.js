/**
 * 生成可视化验收页：test/preview.html
 * 复制 index.html 的 DOM，并把路径改为上级目录，末尾注入脚本自动灌入
 * 两个样本 + 一个非法文件，用于核对列表 / 进度 / 错误态的真实渲染效果。
 *
 * 用法：node test/make-preview.js
 *      再用浏览器打开 test/preview.html（或配合无头浏览器截图）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

html = html
  .replace('href="assets/style.css"', 'href="../assets/style.css"')
  .replace(/src="js\//g, 'src="../js/')
  .replace('src="vendor/', 'src="../vendor/');

const inject = `
<script src="sample.js"></script>
<script>
// 预览专用：注入样本文件，触发真实的解析流程
setTimeout(function () {
  function makeFile(b64, name) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], name, { type: 'application/octet-stream' });
  }
  var broken = new File([new TextEncoder().encode('this is definitely not a ncm file')], 'broken-file.ncm');
  window.NCMConverter.addFiles([
    makeFile(window.NCM_SAMPLE.b64, '晴天.ncm'),
    makeFile(window.NCM_SAMPLE.b64, '晴天-副本.ncm'),
    broken
  ]);

  // ?auto=mp3 / ?auto=orig：自动选择格式并开始转换，用于核对完成态
  var m = /[?&]auto=(mp3|orig)/.exec(location.search);
  if (m) {
    window.NCMConverter.setTarget(m[1] === 'mp3' ? 'mp3' : 'original');
    setTimeout(function () { window.NCMConverter.start(); }, 60);
  }
}, 120);
</script>
`;

html = html.replace('</body>', inject + '</body>');
fs.writeFileSync(path.join(__dirname, 'preview.html'), html);
console.log('已生成 test/preview.html（用浏览器打开即可查看填充后的效果）');
