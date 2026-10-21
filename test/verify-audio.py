"""
用 libsndfile（第三方解码器）校验 test/codec-check.js 生成的文件。

FLAC：解码后应与原始 PCM 逐样本完全一致（无损）。
MP3：有损，校验采样数、声道、采样率以及整体波形相关性。
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

OUT = os.path.join(os.environ.get("TEMP", "/tmp"), "ncm-codec")
cases = json.load(open(os.path.join(OUT, "cases.json"), encoding="utf-8"))

failed = 0

for c in cases:
    name = c["name"]
    raw_path = os.path.join(OUT, name + ".raw")
    expect = np.fromfile(raw_path, dtype="<i2").reshape(-1, c["ch"])

    # ---- FLAC 无损比对 ----
    flac_path = os.path.join(OUT, name + ".flac")
    if os.path.exists(flac_path):
        data, rate = sf.read(flac_path, dtype="int16", always_2d=True)
        ok_rate = rate == c["rate"]
        ok_shape = data.shape == expect.shape
        ok_data = ok_shape and np.array_equal(data, expect)
        status = "PASS" if (ok_rate and ok_shape and ok_data) else "FAIL"
        if status == "FAIL":
            failed += 1
            detail = ""
            if ok_shape and not ok_data:
                diff = np.argwhere(data != expect)
                detail = f"，首个差异样本 {diff[0].tolist()}" if len(diff) else ""
            print(f"[{status}] FLAC {name}: rate={rate} shape={data.shape} 期望 {expect.shape}{detail}")
        else:
            ratio = os.path.getsize(flac_path) / (expect.size * 2) * 100
            print(f"[{status}] FLAC {name}: {data.shape[0]} 采样 × {c['ch']}ch @{rate}Hz 逐样本一致，体积 {ratio:.1f}%")
    else:
        print(f"[SKIP] FLAC {name}")

    # ---- MP3 有损比对 ----
    mp3_path = os.path.join(OUT, name + ".mp3")
    if os.path.exists(mp3_path):
        try:
            data, rate = sf.read(mp3_path, dtype="int16", always_2d=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] MP3 {name}: 无法解码 {exc}")
            failed += 1
            continue
        n_ok = abs(len(data) - len(expect)) <= c["rate"] * 0.06   # 允许首尾各 ~30ms 编码延迟
        ch_ok = data.shape[1] == c["ch"]
        rate_ok = rate == c["rate"]

        # MP3 编解码器有固有延迟，先对齐再比较波形
        a = expect.astype(np.float64)
        b = data.astype(np.float64)
        win = min(len(a), len(b), 20000)
        best_lag, best_corr = 0, -2.0
        for lag in range(-3000, 3001, 1):
            if lag >= 0:
                x, y = a[lag:lag + win], b[:win]
            else:
                x, y = a[:win], b[-lag:-lag + win]
            if len(x) < 1000 or len(y) < 1000 or len(x) != len(y):
                continue
            corr = float(np.corrcoef(x.ravel(), y.ravel())[0, 1])
            if corr > best_corr:
                best_corr, best_lag = corr, lag

        ok = n_ok and ch_ok and rate_ok and best_corr > 0.98
        if not ok:
            failed += 1
        print(f"[{'PASS' if ok else 'FAIL'}] MP3  {name}: {len(data)} 采样（源 {len(expect)}）@{rate}Hz "
              f"{data.shape[1]}ch，对齐滞后 {best_lag}，波形相关 {best_corr:.5f}，"
              f"体积 {os.path.getsize(mp3_path)/1024:.0f} KB")
    else:
        print(f"[SKIP] MP3  {name}")

print()
print("RESULT:", "ALL PASS" if failed == 0 else f"{failed} FAILED")
sys.exit(0 if failed == 0 else 1)
