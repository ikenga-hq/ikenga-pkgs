# Vendored fonts

All three families are under the SIL Open Font License 1.1. The licence text ships next to the
files (`OFL-*.txt`, copied unchanged from each package). None of them has a Reserved Font
Name. The files are the unmodified Latin-subset woff2 builds from Fontsource, taken from the
npm registry on 2026-11-09 with `npm pack @fontsource/<family>`.

| family | package | version | tarball sha256 | used for |
|---|---|---|---|---|
| Inter | `@fontsource/inter` | 5.3.0 | `02034af8d41dcc67ac8eab88f642e129bb8a2e8922abf30229c32725f54d8fd6` | body, labels, names |
| Newsreader | `@fontsource/newsreader` | 5.3.0 | `7f1d2c554aeecf94161c07b45dc99fcea400b2f1293605e27df5d0e64856a024` | display numbers and serif lines |
| JetBrains Mono | `@fontsource/jetbrains-mono` | 5.3.0 | `1bbea47d1387406da5b6ccc4184cc61eae6851cc0db5c1d9bbd088ea9daa0b4a` | kicker labels |

Files (sha256, then name; `engines/hyperframes/blocks.test.ts` checks these):

```
8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc  inter-latin-400-normal.woff2
f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f  inter-latin-500-normal.woff2
f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a  inter-latin-600-normal.woff2
6f56409fd3d64bb85f7d070bce20749db2d66b6d63cec586cc22d1c761be2491  inter-latin-700-normal.woff2
14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb  jetbrains-mono-latin-400-normal.woff2
400c6bfda18d5d14acad1c15d6dcb9f8e13c015e7286317e0b9a482539bef147  jetbrains-mono-latin-600-normal.woff2
e66067814f1c672d33a457e4f4d102c818b481420e2234cf685ebdbf2f443904  newsreader-latin-400-normal.woff2
05c91a26d19a61eafe7ce8e0b77eff3fd279ce994dc89f432f4cd06784935e84  newsreader-latin-600-normal.woff2
8b5c3b65cbda1d79ed371d23df3ef1fe194e590558965cf9942042441480ec61  newsreader-latin-700-normal.woff2
```

Notes:

- **Latin only.** Text outside the basic Latin range falls back to another font, so preview
  and render may no longer match for it. Add the matching Fontsource subset before using
  other scripts.
- **Why Newsreader and not Source Serif 4.** Source Serif 4 was the first choice. Its OFL
  carries the Reserved Font Name "Source", and Fontsource's copy of its licence lacks the
  copyright line. Newsreader has neither problem.
- **HyperFrames bundles Inter and JetBrains Mono by name too.** When a composition declares
  its own `@font-face` for a family, HyperFrames 0.9.19 uses that face and fetches nothing:
  the G-01 run printed `Fonts: 5 loaded` with no Google Fonts requests. Every block declares
  every face it uses, so renders never depend on the network or on the machine's installed
  fonts.
