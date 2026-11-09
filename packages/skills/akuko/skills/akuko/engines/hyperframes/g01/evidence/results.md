# G-01 run — PASS

G-01 set passes; negative controls all three fail (caught).
Bar: frame PSNR ≥ 35 dB, and in every text region ink IoU ≥ 0.95 and max |Δ luma| ≤ 96, every pair.

### G-01 — compliant composition · HyperFrames snapshot vs HyperFrames PNG render

Expected: **pass** · Result: **pass** · previews in `g01/preview-hf`

| t (s) | frame | expected counter / caption | frame PSNR (dB) | counter ink IoU / max Δluma (region PSNR) | caption ink IoU / max Δluma (region PSNR) | pair |
|---|---|---|---|---|---|---|
| 0.5 | 15 | 6 / 1 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (61.64 dB) | pass |
| 1.5 | 45 | 19 / 1 | 46.34 | 1.000 / 0 (inf dB) | 1.000 / 1 (77.46 dB) | pass |
| 3.0 | 90 | 20 / 2 | 44.17 | 1.000 / 0 (inf dB) | 0.968 / 66 (36.11 dB) | pass |
| 4.5 | 135 | 20 / 3 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (66.18 dB) | pass |
| 5.9 | 177 | 20 / 3 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (77.46 dB) | pass |

### NC-1 — spike's onUpdate-only counter · hand-rolled tl.seek(t) preview vs HyperFrames render

Expected: **fail** · Result: **fail** · previews in `nc-onupdate/preview-handrolled`

| t (s) | frame | expected counter / caption | frame PSNR (dB) | counter ink IoU / max Δluma (region PSNR) | caption ink IoU / max Δluma (region PSNR) | pair |
|---|---|---|---|---|---|---|
| 0.5 | 15 | 6 / 1 | 31.76 | 0.533 / 190 (19.75 dB) | 1.000 / 1 (61.66 dB) | **fail**: frame PSNR 31.76 < 35 dB; counter ink IoU 0.533 < 0.95; counter max Δluma 190 > 96 |
| 1.5 | 45 | 19 / 1 | 25.27 | 0.164 / 215 (13.20 dB) | 0.983 / 1 (68.71 dB) | **fail**: frame PSNR 25.27 < 35 dB; counter ink IoU 0.164 < 0.95; counter max Δluma 215 > 96 |
| 3.0 | 90 | 20 / 2 | 25.44 | 0.242 / 215 (13.40 dB) | 0.979 / 1 (67.49 dB) | **fail**: frame PSNR 25.44 < 35 dB; counter ink IoU 0.242 < 0.95; counter max Δluma 215 > 96 |
| 4.5 | 135 | 20 / 3 | 25.44 | 0.242 / 215 (13.40 dB) | 1.000 / 1 (66.22 dB) | **fail**: frame PSNR 25.44 < 35 dB; counter ink IoU 0.242 < 0.95; counter max Δluma 215 > 96 |
| 5.9 | 177 | 20 / 3 | 25.44 | 0.242 / 215 (13.40 dB) | 0.980 / 1 (67.64 dB) | **fail**: frame PSNR 25.44 < 35 dB; counter ink IoU 0.242 < 0.95; counter max Δluma 215 > 96 |

### NC-2 — compliant composition, vendored fonts blocked · hand-rolled preview vs HyperFrames render

Expected: **fail** · Result: **fail** · previews in `g01/preview-handrolled-nofonts`

| t (s) | frame | expected counter / caption | frame PSNR (dB) | counter ink IoU / max Δluma (region PSNR) | caption ink IoU / max Δluma (region PSNR) | pair |
|---|---|---|---|---|---|---|
| 0.5 | 15 | 6 / 1 | 28.58 | 0.314 / 189 (18.25 dB) | 0.256 / 212 (17.89 dB) | **fail**: frame PSNR 28.58 < 35 dB; counter ink IoU 0.314 < 0.95; counter max Δluma 189 > 96; caption ink IoU 0.256 < 0.95; caption max Δluma 212 > 96 |
| 1.5 | 45 | 19 / 1 | 24.91 | 0.272 / 215 (14.06 dB) | 0.257 / 215 (17.75 dB) | **fail**: frame PSNR 24.91 < 35 dB; counter ink IoU 0.272 < 0.95; counter max Δluma 215 > 96; caption ink IoU 0.257 < 0.95; caption max Δluma 215 > 96 |
| 3.0 | 90 | 20 / 2 | 23.80 | 0.230 / 215 (12.81 dB) | 0.244 / 215 (16.68 dB) | **fail**: frame PSNR 23.80 < 35 dB; counter ink IoU 0.230 < 0.95; counter max Δluma 215 > 96; caption ink IoU 0.244 < 0.95; caption max Δluma 215 > 96 |
| 4.5 | 135 | 20 / 3 | 23.83 | 0.230 / 215 (12.81 dB) | 0.223 / 210 (16.89 dB) | **fail**: frame PSNR 23.83 < 35 dB; counter ink IoU 0.230 < 0.95; counter max Δluma 215 > 96; caption ink IoU 0.223 < 0.95; caption max Δluma 210 > 96 |
| 5.9 | 177 | 20 / 3 | 23.80 | 0.230 / 215 (12.81 dB) | 0.236 / 215 (16.68 dB) | **fail**: frame PSNR 23.80 < 35 dB; counter ink IoU 0.230 < 0.95; counter max Δluma 215 > 96; caption ink IoU 0.236 < 0.95; caption max Δluma 215 > 96 |

### NC-3 — one-character caption change ("Step 3" chip at 3.0 s) · HyperFrames snapshot vs the genuine HyperFrames render

Expected: **fail** · Result: **fail** · previews in `nc-chip/preview-hf`

| t (s) | frame | expected counter / caption | frame PSNR (dB) | counter ink IoU / max Δluma (region PSNR) | caption ink IoU / max Δluma (region PSNR) | pair |
|---|---|---|---|---|---|---|
| 0.5 | 15 | 6 / 1 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (61.64 dB) | pass |
| 1.5 | 45 | 19 / 1 | 46.34 | 1.000 / 0 (inf dB) | 1.000 / 1 (77.46 dB) | pass |
| 3.0 | 90 | 20 / 2 | 44.02 | 1.000 / 0 (inf dB) | 0.956 / 123 (35.18 dB) | **fail**: caption max Δluma 123 > 96 |
| 4.5 | 135 | 20 / 3 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (66.18 dB) | pass |
| 5.9 | 177 | 20 / 3 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (77.46 dB) | pass |

### I-1 — spike's onUpdate-only counter · HyperFrames snapshot vs HyperFrames render

Expected: **info** · Result: **pass** · previews in `nc-onupdate/preview-hf`

| t (s) | frame | expected counter / caption | frame PSNR (dB) | counter ink IoU / max Δluma (region PSNR) | caption ink IoU / max Δluma (region PSNR) | pair |
|---|---|---|---|---|---|---|
| 0.5 | 15 | 6 / 1 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (61.64 dB) | pass |
| 1.5 | 45 | 19 / 1 | 46.34 | 1.000 / 0 (inf dB) | 1.000 / 1 (77.46 dB) | pass |
| 3.0 | 90 | 20 / 2 | 44.17 | 1.000 / 0 (inf dB) | 0.968 / 66 (36.11 dB) | pass |
| 4.5 | 135 | 20 / 3 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (66.18 dB) | pass |
| 5.9 | 177 | 20 / 3 | 48.52 | 1.000 / 0 (inf dB) | 1.000 / 1 (77.46 dB) | pass |

### I-2 — compliant composition · hand-rolled tl.seek(t) preview (fonts loaded) vs HyperFrames render

Expected: **info** · Result: **pass** · previews in `g01/preview-handrolled`

| t (s) | frame | expected counter / caption | frame PSNR (dB) | counter ink IoU / max Δluma (region PSNR) | caption ink IoU / max Δluma (region PSNR) | pair |
|---|---|---|---|---|---|---|
| 0.5 | 15 | 6 / 1 | 48.34 | 1.000 / 1 (68.50 dB) | 1.000 / 1 (61.66 dB) | pass |
| 1.5 | 45 | 19 / 1 | 46.55 | 0.999 / 13 (55.88 dB) | 0.983 / 1 (68.71 dB) | pass |
| 3.0 | 90 | 20 / 2 | 44.92 | 0.999 / 13 (55.88 dB) | 0.979 / 1 (67.49 dB) | pass |
| 4.5 | 135 | 20 / 3 | 44.95 | 0.999 / 13 (55.88 dB) | 1.000 / 1 (66.22 dB) | pass |
| 5.9 | 177 | 20 / 3 | 44.96 | 0.999 / 13 (55.88 dB) | 0.980 / 1 (67.64 dB) | pass |

### I-3 — sensitivity · HyperFrames snapshot at t vs the render frame one step later (t + 1/30 s)

Expected: **info** · Result: **fail** · previews in `g01/preview-hf`

| t (s) | frame | expected counter / caption | frame PSNR (dB) | counter ink IoU / max Δluma (region PSNR) | caption ink IoU / max Δluma (region PSNR) | pair |
|---|---|---|---|---|---|---|
| 0.5 | 15 | 6 / 1 | 28.34 | 0.142 / 199 (16.41 dB) | 0.995 / 3 (56.37 dB) | **fail**: frame PSNR 28.34 < 35 dB; counter ink IoU 0.142 < 0.95; counter max Δluma 199 > 96 |
| 1.5 | 45 | 19 / 1 | 46.13 | 1.000 / 0 (inf dB) | 1.000 / 1 (77.46 dB) | pass |
| 3.0 | 90 | 20 / 2 | 44.05 | 1.000 / 0 (inf dB) | 0.968 / 66 (36.11 dB) | pass |
| 4.5 | 135 | 20 / 3 | 48.15 | 1.000 / 0 (inf dB) | 0.994 / 5 (52.28 dB) | pass |
| 5.9 | 177 | 20 / 3 | 48.14 | 1.000 / 0 (inf dB) | 1.000 / 1 (77.46 dB) | pass |
