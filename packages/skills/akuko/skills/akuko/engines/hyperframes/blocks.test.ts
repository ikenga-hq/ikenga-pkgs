// WP-11 — static rules every block must keep (blocks/README.md). HyperFrames' own lint/check
// run outside CI (verify-blocks.ts); these catch drift in CI without Chrome.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLOCKS, GSAP_URL, fontFiles, hostHtml, inlineMotion } from './blocks.ts';

const here = dirname(fileURLToPath(import.meta.url));
const blocksDir = join(here, '..', '..', 'blocks');
const read = (p: string) => readFileSync(join(blocksDir, p), 'utf8');
const vocabulary = JSON.parse(read('vocabulary.json')) as Record<string, { ease: string; duration: number; scale?: number }>;

describe('motion vocabulary', () => {
  it('has exactly settle, snap and bloom with the spike §7 values', () => {
    assert.deepEqual(vocabulary, {
      settle: { ease: 'back.out(1.5)', duration: 0.9 },
      snap: { ease: 'power3.out', duration: 0.3 },
      bloom: { ease: 'sine.inOut', duration: 0.2, scale: 1.06 },
    });
  });
});

describe('block files', () => {
  it('the block list matches blocks/compositions/', () => {
    const files = readdirSync(join(blocksDir, 'compositions')).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();
    assert.deepEqual(files, [...BLOCKS].sort());
  });

  for (const id of BLOCKS) {
    describe(id, () => {
      const html = read(`compositions/${id}.html`);
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

      it('is a HyperFrames scene: everything inside <template>, root #root with its composition id', () => {
        const body = html.replace(/<!--[\s\S]*?-->/g, '').trim();
        assert.ok(body.startsWith('<template>') && body.endsWith('</template>'), 'only a <template> outside comments');
        assert.match(html, new RegExp(`<div\\s+id="root"\\s+data-composition-id="${id}"`));
        assert.match(html, /#root \{/);
      });

      it('registers its timeline under its own id, once, paused', () => {
        assert.equal([...script.matchAll(/window\.__timelines\["([^"]+)"\]\s*=/g)].map((m) => m[1]).join(), id);
        assert.match(script, /gsap\.timeline\(\{ paused: true \}\)/);
      });

      it('declares its variables as valid JSON', () => {
        const raw = /data-composition-variables='([^']+)'/.exec(html)?.[1];
        assert.ok(raw, 'has data-composition-variables');
        const vars = JSON.parse(raw) as { id: string; type: string; default: unknown }[];
        assert.ok(vars.length > 0);
        for (const v of vars) assert.ok(['string', 'number', 'color', 'boolean', 'enum'].includes(v.type), `${v.id}: ${v.type}`);
        for (const m of html.matchAll(/data-var-text="([^"]+)"/g)) assert.ok(vars.some((v) => v.id === m[1]), `data-var-text="${m[1]}" is declared`);
      });

      it('carries the motion vocabulary verbatim', () => {
        assert.deepEqual(inlineMotion(html), vocabulary);
      });

      it('uses only vendored fonts, never a font service', () => {
        assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|@import/);
        for (const f of fontFiles(html)) assert.ok(existsSync(join(blocksDir, 'fonts', f)), `${f} is in blocks/fonts`);
        const families = new Set([...html.matchAll(/font-family:\s*"([^"]+)"/g)].map((m) => m[1]));
        const declared = new Set([...html.matchAll(/@font-face \{ font-family: "([^"]+)"/g)].map((m) => m[1]));
        for (const f of families) assert.ok(declared.has(f), `${f} has an @font-face in this block`);
      });

      it('keeps state a pure function of time (HyperFrames contract + R5-5)', () => {
        assert.doesNotMatch(script, /Date\.now|Math\.random|setTimeout|setInterval|requestAnimationFrame|fetch\(|repeat:\s*-1|\.play\(\)/);
        assert.doesNotMatch(script, /\btl\.from\(/, 'scenes use fromTo, never from');
        assert.doesNotMatch(script, /onUpdate|onComplete|onStart/, 'no state set only in a callback');
        assert.doesNotMatch(script, /offsetWidth|offsetHeight|getBoundingClientRect/, 'no geometry from measured text');
      });
    });
  }
});

describe('showcase (blocks/index.html)', () => {
  const html = read('index.html');
  it('mounts every block once with matching host id, composition id and src', () => {
    for (const id of BLOCKS) {
      assert.match(html, new RegExp(`<div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html"`));
    }
  });
  it('loads GSAP from the URL HyperFrames serves from its own vendored copy', () => {
    assert.ok(html.includes(`<script src="${GSAP_URL}">`));
  });
});

describe('hostHtml', () => {
  it('mounts one block for a slot, with optional per-mount values', () => {
    const h = hostHtml('stat', { duration: 4, values: { value: 42, unit: "it's" } });
    assert.match(h, /data-composition-src="compositions\/stat\.html" data-start="0" data-duration="4"/);
    assert.match(h, /data-variable-values='\{"value":42,"unit":"it&#39;s"\}'/);
    assert.ok(h.includes(GSAP_URL));
    assert.throws(() => hostHtml('stat', { duration: 0 }), RangeError);
  });
});

describe('vendored fonts', () => {
  const readme = read('fonts/README.md');
  const woff2 = readdirSync(join(blocksDir, 'fonts')).filter((f) => f.endsWith('.woff2'));
  it('every woff2 is listed in fonts/README.md with its sha256', () => {
    for (const f of woff2) {
      const sum = createHash('sha256').update(readFileSync(join(blocksDir, 'fonts', f))).digest('hex');
      assert.ok(readme.includes(`${sum}  ${f}`), `${f} ${sum}`);
    }
  });
  it('ships the OFL text for each family', () => {
    for (const lic of ['OFL-Inter.txt', 'OFL-Newsreader.txt', 'OFL-JetBrainsMono.txt']) {
      assert.match(read(`fonts/${lic}`), /SIL Open Font License, Version 1\.1/);
    }
  });
});
