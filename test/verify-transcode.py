"""
校验「浏览器内转码」产出的 MP3：从 transcode-test.html 的 DOM dump 里取出 base64，
用 libsndfile 独立解码，再与预期测试音（与 make-sample.js 同一公式）比对。

用法：
  chrome --headless=new --dump-dom test/transcode-test.html > /tmp/tc-dump.html
  python test/verify-transcode.py /tmp/tc-dump.html
"""
import base64
import io
import os
import re
import sys

import numpy as np
import soundfile as sf

RATE = 44100
SECONDS = 1.5
N = round(RATE * SECONDS)


def expected_pcm():
    t = np.arange(N) / RATE
    env = 0.6 + 0.4 * np.sin(2 * np.pi * 0.8 * t)
    left = np.round((np.sin(2 * np.pi * 440 * t) * 9000 + np.sin(2 * np.pi * 880 * t) * 3500) * env)
    right = np.round((np.sin(2 * np.pi * 554.37 * t) * 8000 + np.sin(2 * np.pi * 1108 * t) * 3000) * env)
    return np.stack([left, right], axis=1).astype(np.int16)


def main(path):
    html = open(path, encoding="utf-8", errors="ignore").read()
    m = re.search(r'<div id="mp3base64"[^>]*>([A-Za-z0-9+/=]+)</div>', html)
    if not m:
        print("[FAIL] 未在 DOM 中找到导出的 MP3 数据")
        return 1

    raw = base64.b64decode(m.group(1))
    print(f"取出 MP3：{len(raw)} 字节，前 4 字节 {raw[:4].hex()}")

    data, rate = sf.read(io.BytesIO(raw), dtype="int16", always_2d=True)
    print(f"libsndfile 解码：{len(data)} 采样 × {data.shape[1]}ch @{rate}Hz，"
          f"{len(data)/rate:.3f}s，{len(raw)*8/(len(data)/rate)/1000:.0f} kbps")

    exp = expected_pcm()
    ok = True

    if rate != RATE:
        print(f"[FAIL] 采样率 {rate} != {RATE}")
        ok = False
    if data.shape[1] != 2:
        print(f"[FAIL] 声道数 {data.shape[1]} != 2")
        ok = False
    dur_ok = abs(len(data) / rate - SECONDS) < 0.15
    print(f"[{'PASS' if dur_ok else 'FAIL'}] 时长 {len(data)/rate:.3f}s（源 {SECONDS}s）")
    ok &= dur_ok

    # 对齐后计算相关性（MP3 编码器固有延迟）
    a = exp.astype(np.float64)
    b = data.astype(np.float64)
    win = min(len(a), len(b), 20000)
    best_lag, best_corr = 0, -2.0
    for lag in range(-2500, 2501):
        if lag >= 0:
            x, y = a[lag:lag + win], b[:win]
        else:
            x, y = a[:win], b[-lag:-lag + win]
        if len(x) < 2000 or len(x) != len(y):
            continue
        c = float(np.corrcoef(x.ravel(), y.ravel())[0, 1])
        if c > best_corr:
            best_corr, best_lag = c, lag

    corr_ok = best_corr > 0.95
    print(f"[{'PASS' if corr_ok else 'FAIL'}] 波形相关性 {best_corr:.5f}（对齐滞后 {best_lag} 采样）")
    ok &= corr_ok

    rms_src = float(np.sqrt((a ** 2).mean()))
    rms_out = float(np.sqrt((b ** 2).mean()))
    vol_ok = abs(rms_src - rms_out) / rms_src < 0.15
    print(f"[{'PASS' if vol_ok else 'FAIL'}] 响度保持：源 RMS {rms_src:.0f} → 转码后 {rms_out:.0f}")
    ok &= vol_ok

    print()
    print("RESULT:", "ALL PASS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/tc-dump.html"))
