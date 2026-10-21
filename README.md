# NCM 转换器

在浏览器中将网易云音乐 `.ncm` 文件还原为 MP3、FLAC 等常见音频格式。文件在本地处理，不会上传到服务器。

[![运行方式：纯浏览器](https://img.shields.io/badge/runtime-browser--only-ff2d55)](#隐私与使用须知)
[![许可证：MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[在线预览](https://ncm-converter-46246.app.workbuddy.host/?sharecode=GDKVQF3BU7)

## 功能

- **本地处理**：无需账号、后端或构建步骤，断网也可使用。
- **批量转换**：拖放或选择多个 `.ncm` 文件，完成后可逐个下载或打包为 ZIP。
- **灵活输出**：还原原格式，或按需转换为 MP3 / FLAC。
- **保留音频信息**：原格式还原会保留原始音频数据、歌曲标签和封面。
- **转换前校验**：检查解密后的音频格式，识别异常文件并避免输出无效结果。

## 快速开始

1. 下载或克隆本项目。
2. 在浏览器中打开 `index.html` 即可使用。

也可以在项目目录启动本地服务器：

```bash
python -m http.server 8000
```

然后访问 <http://localhost:8000>。

## 使用方法

1. 将 `.ncm` 文件拖入页面，或点击选择文件。
2. 选择输出格式：**原格式**、**MP3** 或 **FLAC**。
3. 点击「开始转换」，完成后下载文件，或使用 ZIP 打包下载。

| 输出选项 | 处理方式 |
| --- | --- |
| 原格式 | 直接还原音频，不重新编码，速度快且不会引入转码损失。 |
| MP3 | 可选择 128、192 或 320 kbps；源文件为 MP3 时直接还原，其他支持的音频格式按需转码。 |
| FLAC | 源文件为 FLAC 时直接还原；其他支持的音频格式按需转码为 16-bit FLAC。 |

> 将有损音频（例如 MP3）转换为 FLAC 不会恢复已损失的音质，且通常会增加文件体积。

## 项目结构

```text
.
├── index.html             页面入口
├── assets/style.css       页面样式
├── js/
│   ├── aes.js             AES 解密实现
│   ├── ncm.js             NCM 容器解析与音频解密
│   ├── transcode.js       音频转码
│   ├── flac-encoder.js    FLAC 编码器
│   ├── zip.js             ZIP 打包
│   └── app.js             页面交互与转换队列
├── vendor/lame.min.js     本地 MP3 编码器
└── test/                  测试与验证脚本
```

## 开发与测试

项目使用原生 HTML、CSS 和 JavaScript，无需安装依赖或构建。

运行 NCM 解密往返测试：

```bash
node test/roundtrip.js
```

编解码器验证需要 Node.js、Python 和可供 `soundfile` 使用的 libsndfile：

```bash
node test/codec-check.js
python test/verify-audio.py
```

浏览器转码依赖 `OfflineAudioContext`。浏览器是否支持该 API 会影响 MP3 / FLAC 转码；原格式还原不需要重新编码。

## 隐私与使用须知

- 文件的读取、解密和转码均在浏览器本地完成，本项目不会将文件上传到服务器。
- 请遵守适用法律及相关服务条款，仅处理你有权使用的文件。项目许可证不授予任何音乐作品的使用权。
- 大文件的处理能力取决于设备和浏览器可用内存。

## 许可证

本项目采用 [MIT License](LICENSE)。
