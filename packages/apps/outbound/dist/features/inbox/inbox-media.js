// inbox-media.js — image previews for the unified Outbox inbox (outbox redesign D-04).
//
//   <ThumbStrip>       ≤3 thumbnails + "+N" on a queue row
//   <Lightbox>         full-size viewer; ←/→/Esc; reorder / remove when editable
//   <MediaEditor>      attached-media tiles: drag to reorder, ×, attach by URL
//   <PlatformPreview>  what LinkedIn / X / Bluesky / Instagram / Facebook will
//                      actually render — their image grids, crops, truncation,
//                      carousel dots, thread chains and first comment.
//
// Remote images need `img-src https:` in the manifest CSP (decision D-09);
// every <img> degrades to a labelled "can't load" tile instead of a broken icon.

import { html, cn, Icon, useState, useEffect, useRef, useCallback } from '../../lib/ui.js';
import { BrandIcon } from '../../lib/brand-icons.js';
import { PLATFORM_LABEL, PLATFORM_CAPS, PLATFORM_MAX_IMAGES, textForPlatform } from '../../lib/inbox-model.js';
import { openLink } from '../../lib/bridge.js';

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// ── Img with an honest failure state ─────────────────────────────────────────

export function Img({ src, alt = '', className = '', onClick, fit = 'cover', title }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return html`<div class=${cn('ibx-img-fail', className)} title=${src} onClick=${onClick}>
      <${Icon} name="image-off" size=${16} /><span>${hostOf(src) || 'image'} · can't load</span>
    </div>`;
  }
  return html`<img class=${className} src=${src} alt=${alt} title=${title} loading="lazy" decoding="async"
    referrerpolicy="no-referrer" style=${{ objectFit: fit }} onError=${() => setFailed(true)} onClick=${onClick} />`;
}

// ── Row thumbnail strip ──────────────────────────────────────────────────────

export function ThumbStrip({ images, max = 3, onOpen }) {
  if (!images?.length) return null;
  const shown = images.slice(0, max);
  const more = images.length - shown.length;
  return html`<div class="ibx-thumbs" aria-label=${`${images.length} image${images.length === 1 ? '' : 's'}`}>
    ${shown.map((u, i) => html`
      <button key=${u} type="button" class="ibx-thumb" title="Preview image"
        onClick=${(e) => { e.stopPropagation(); onOpen?.(i); }}>
        <${Img} src=${u} />
        ${i === shown.length - 1 && more > 0 ? html`<span class="ibx-thumb-more">+${more}</span>` : null}
      </button>`)}
  </div>`;
}

// ── Lightbox ─────────────────────────────────────────────────────────────────

export function Lightbox({ images, index = 0, onClose, editable = false, onChange, caption }) {
  const [i, setI] = useState(index);
  const n = images.length;
  useEffect(() => setI((v) => Math.min(Math.max(0, v), Math.max(0, n - 1))), [n]);
  const go = useCallback((d) => setI((v) => (n ? (v + d + n) % n : 0)), [n]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [go, onClose]);
  if (!n) return null;
  const src = images[i];
  const move = (d) => {
    const j = i + d;
    if (j < 0 || j >= n) return;
    const next = images.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange?.(next);
    setI(j);
  };
  const remove = () => {
    const next = images.filter((_, k) => k !== i);
    onChange?.(next);
    if (!next.length) onClose();
  };
  return html`
    <div class="ibx-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick=${onClose}>
      <div class="ibx-lb-stage" onClick=${(e) => e.stopPropagation()}>
        <${Img} src=${src} className="ibx-lb-img" fit="contain" alt=${`Image ${i + 1} of ${n}`} />
        ${n > 1 ? html`
          <button type="button" class="ibx-lb-nav is-prev" aria-label="Previous image" onClick=${() => go(-1)}><${Icon} name="chevron-left" size=${20} /></button>
          <button type="button" class="ibx-lb-nav is-next" aria-label="Next image" onClick=${() => go(1)}><${Icon} name="chevron-right" size=${20} /></button>
        ` : null}
      </div>
      <div class="ibx-lb-bar" onClick=${(e) => e.stopPropagation()}>
        <span class="ibx-lb-count">${i + 1} / ${n}</span>
        <span class="ibx-lb-src" title=${src}>${caption ?? hostOf(src)}</span>
        <span class="ibx-spacer"></span>
        ${editable ? html`
          <button type="button" class="ibx-btn" disabled=${i === 0} onClick=${() => move(-1)} title="Move earlier">← Move</button>
          <button type="button" class="ibx-btn" disabled=${i === n - 1} onClick=${() => move(1)} title="Move later">Move →</button>
          <button type="button" class="ibx-btn is-danger" onClick=${remove}><${Icon} name="trash" size=${13} /> Remove</button>
        ` : null}
        <button type="button" class="ibx-btn" onClick=${() => openLink(src).catch(() => window.open(src, '_blank', 'noopener'))}><${Icon} name="external-link" size=${13} /> Open</button>
        <button type="button" class="ibx-btn" onClick=${onClose} aria-label="Close preview"><${Icon} name="x" size=${14} /></button>
      </div>
      ${n > 1 ? html`
        <div class="ibx-lb-film" onClick=${(e) => e.stopPropagation()}>
          ${images.map((u, k) => html`<button key=${u} type="button" class=${cn('ibx-lb-film-item', { 'is-on': k === i })} onClick=${() => setI(k)}><${Img} src=${u} /></button>`)}
        </div>` : null}
    </div>`;
}

// ── Media editor (attached images) ───────────────────────────────────────────

export function MediaEditor({ images, onChange, readOnly = false, platforms = [], label = 'Images', onOpen, max }) {
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState(null);
  const dragFrom = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  const limits = platforms.filter((p) => PLATFORM_MAX_IMAGES[p] && images.length > PLATFORM_MAX_IMAGES[p]);

  const attach = () => {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) { setErr('Use an http(s) image URL'); return; }
    if (images.includes(u)) { setErr('Already attached'); return; }
    if (max && images.length >= max) { setErr(`At most ${max} image${max === 1 ? '' : 's'} here`); return; }
    onChange([...images, u]);
    setUrl(''); setErr(null); setAdding(false);
  };
  const drop = (to) => {
    const from = dragFrom.current;
    dragFrom.current = null; setDragOver(null);
    if (from == null || from === to) return;
    const next = images.slice();
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onChange(next);
  };

  return html`
    <section class="ibx-media">
      <div class="ibx-section-head">
        <${Icon} name="image" size=${13} /><span>${label}</span>
        <span class="ibx-muted">${images.length || 'none'}${images.length > 1 ? ' · drag to reorder' : ''}</span>
        <span class="ibx-spacer"></span>
        ${max ? html`<span class="ibx-muted">max ${max}</span>` : null}
        ${readOnly || (max && images.length >= max) ? null : html`<button type="button" class="ibx-btn is-ghost" onClick=${() => setAdding((a) => !a)}><${Icon} name="plus" size=${13} /> Attach URL</button>`}
      </div>
      ${images.length ? html`
        <div class="ibx-media-grid">
          ${images.map((u, i) => html`
            <div key=${u}
              class=${cn('ibx-media-tile', { 'is-drop': dragOver === i })}
              draggable=${!readOnly}
              onDragStart=${(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver=${(e) => { if (dragFrom.current != null) { e.preventDefault(); setDragOver(i); } }}
              onDragLeave=${() => setDragOver((v) => (v === i ? null : v))}
              onDrop=${(e) => { e.preventDefault(); drop(i); }}>
              <button type="button" class="ibx-media-open" onClick=${() => onOpen?.(i)} title="Preview"><${Img} src=${u} /></button>
              <span class="ibx-media-idx">${i + 1}</span>
              ${readOnly ? null : html`
                <div class="ibx-media-tools">
                  <span class="ibx-media-grip" title="Drag to reorder"><${Icon} name="grip-vertical" size=${12} /></span>
                  <button type="button" disabled=${i === 0} title="Move earlier" aria-label="Move earlier" onClick=${() => { const n = images.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n); }}><${Icon} name="chevron-left" size=${12} /></button>
                  <button type="button" disabled=${i === images.length - 1} title="Move later" aria-label="Move later" onClick=${() => { const n = images.slice(); [n[i + 1], n[i]] = [n[i], n[i + 1]]; onChange(n); }}><${Icon} name="chevron-right" size=${12} /></button>
                  <button type="button" class="is-danger" title="Remove" aria-label="Remove image" onClick=${() => onChange(images.filter((_, k) => k !== i))}><${Icon} name="x" size=${12} /></button>
                </div>`}
            </div>`)}
        </div>` : html`<div class="ibx-media-empty"><${Icon} name="image" size=${16} /> No images attached${readOnly ? '' : ' — attach one by URL'}</div>`}
      ${adding && !readOnly ? html`
        <div class="ibx-media-attach">
          <input type="url" placeholder="https://cdn.example.com/image.jpg" value=${url} autoFocus
            onInput=${(e) => { setUrl(e.target.value); setErr(null); }}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); attach(); } if (e.key === 'Escape') setAdding(false); }} />
          <button type="button" class="ibx-btn is-primary" disabled=${!url.trim()} onClick=${attach}>Attach</button>
          <button type="button" class="ibx-btn" onClick=${() => { setAdding(false); setErr(null); }}>Cancel</button>
          ${url.trim() && /^https?:\/\//i.test(url.trim()) ? html`<div class="ibx-media-attach-pv"><${Img} src=${url.trim()} /></div>` : null}
          ${err ? html`<div class="ibx-field-err">${err}</div>` : null}
        </div>` : null}
      ${limits.length ? html`<div class="ibx-warn-line"><${Icon} name="alert-triangle" size=${12} /> ${limits.map((p) => `${PLATFORM_LABEL[p]} takes at most ${PLATFORM_MAX_IMAGES[p]}`).join(' · ')}</div>` : null}
    </section>`;
}

// ── Per-platform image grids ─────────────────────────────────────────────────

function Grid({ images, layout, onOpen, max }) {
  const list = images.slice(0, max);
  const extra = images.length - list.length;
  const n = list.length;
  if (!n) return null;
  return html`<div class=${cn('ibx-pv-grid', `is-${layout}`, `n-${Math.min(n, 5)}`)}>
    ${list.map((u, i) => html`
      <button key=${u} type="button" class="ibx-pv-cell" onClick=${() => onOpen?.(i)}>
        <${Img} src=${u} />
        ${i === n - 1 && extra > 0 ? html`<span class="ibx-pv-more">+${extra}</span>` : null}
      </button>`)}
  </div>`;
}

function Carousel({ images, onOpen }) {
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [images.length]);
  if (!images.length) {
    return html`<div class="ibx-pv-ig-empty"><${Icon} name="image-off" size=${18} /><span>Instagram can't post without an image</span></div>`;
  }
  return html`<div class="ibx-pv-ig">
    <button type="button" class="ibx-pv-ig-frame" onClick=${() => onOpen?.(i)}><${Img} src=${images[i]} /></button>
    ${images.length > 1 ? html`
      <span class="ibx-pv-ig-count">${i + 1}/${images.length}</span>
      ${i > 0 ? html`<button type="button" class="ibx-pv-ig-arrow is-prev" aria-label="Previous" onClick=${() => setI(i - 1)}><${Icon} name="chevron-left" size=${14} /></button>` : null}
      ${i < images.length - 1 ? html`<button type="button" class="ibx-pv-ig-arrow is-next" aria-label="Next" onClick=${() => setI(i + 1)}><${Icon} name="chevron-right" size=${14} /></button>` : null}
      <div class="ibx-pv-ig-dots">${images.map((_, k) => html`<span key=${k} class=${cn({ 'is-on': k === i })}></span>`)}</div>
    ` : null}
  </div>`;
}

function Truncated({ text, at, more = '…see more' }) {
  const [open, setOpen] = useState(false);
  if (!at || text.length <= at || open) return html`<span>${text}</span>`;
  return html`<span>${text.slice(0, at).trimEnd()}<button type="button" class="ibx-pv-more-link" onClick=${() => setOpen(true)}>${more}</button></span>`;
}

function LinkCard({ text }) {
  const m = String(text).match(/https?:\/\/[^\s)]+|\b[a-z0-9-]+\.(?:io|com|co|ng|org|net|dev)\/[^\s)]*/i);
  if (!m) return null;
  const u = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
  return html`<div class="ibx-pv-link"><${Icon} name="link" size=${12} /><span>${hostOf(u)}</span><span class="ibx-muted">link card unfurls on post</span></div>`;
}

/** Account identity per platform — item.handles wins, then the Royalti defaults. */
const DEFAULT_HANDLES = {
  linkedin: { name: 'Royalti.io', sub: 'Company page' },
  x: { name: 'Royalti', sub: '@royalti' },
  bluesky: { name: 'Royalti', sub: '@royalti.io' },
  instagram: { name: 'royalti.io', sub: '' },
  facebook: { name: 'Royalti', sub: 'Page' },
};

export function PlatformPreview({ platform, body, images, thread = [], firstComment, handles, onOpen, excluded }) {
  const id = { ...DEFAULT_HANDLES[platform], ...(handles?.[platform] ?? {}) };
  const text = textForPlatform(body);
  const cap = PLATFORM_CAPS[platform];
  const over = cap ? text.length - cap : 0;
  const head = html`
    <div class="ibx-pv-head">
      <span class="ibx-pv-avatar" data-brand=${platform}><${BrandIcon} name=${platform} size=${12} /></span>
      <span class="ibx-pv-id"><b>${id.name}</b>${id.sub ? html`<span>${id.sub}</span>` : null}</span>
      <span class="ibx-spacer"></span>
      <span class=${cn('ibx-pv-cap', { 'is-bad': over > 0, 'is-warn': over <= 0 && cap && text.length > cap * 0.9 })}>${text.length}${cap ? ` / ${cap}` : ''}</span>
    </div>`;

  let content;
  if (over > 0) {
    content = html`<div class="ibx-pv-blocked"><${Icon} name="alert-triangle" size=${13} /> ${PLATFORM_LABEL[platform]} cuts off at ${cap} characters — this is ${over} over. Shorten it in the editor (edit just this platform), or exclude ${PLATFORM_LABEL[platform]}.</div>`;
  } else if (platform === 'instagram') {
    content = html`
      <${Carousel} images=${images} onOpen=${onOpen} />
      <div class="ibx-pv-ig-actions">♡ <span>💬</span> <span>↗</span></div>
      <div class="ibx-pv-text"><b>${id.name}</b> <${Truncated} text=${text} at=${125} more="… more" /></div>`;
  } else {
    const layout = platform === 'linkedin' || platform === 'facebook' ? 'feed' : 'tile';
    const max = platform === 'linkedin' ? 4 : platform === 'facebook' ? 5 : 4;
    const at = platform === 'linkedin' ? 210 : platform === 'facebook' ? 480 : 0;
    content = html`
      <div class="ibx-pv-text"><${Truncated} text=${text} at=${at} /></div>
      ${images.length ? html`<${Grid} images=${images} layout=${layout} max=${max} onOpen=${onOpen} />` : html`<${LinkCard} text=${text} />`}`;
  }

  const threadPosts = (platform === 'x' || platform === 'bluesky') ? thread.filter((t) => t.text || t.images.length) : [];

  return html`
    <article class=${cn('ibx-pv', `is-${platform}`, { 'is-excluded': excluded })} aria-label=${`${PLATFORM_LABEL[platform]} preview`}>
      ${excluded ? html`<div class="ibx-pv-excluded">Excluded — won't post to ${PLATFORM_LABEL[platform]}</div>` : null}
      ${head}
      ${content}
      ${threadPosts.length ? html`
        <div class="ibx-pv-thread">
          ${threadPosts.map((t, k) => html`
            <div key=${k} class="ibx-pv-thread-post">
              <span class="ibx-pv-thread-rail"></span>
              <div>
                <div class="ibx-pv-thread-n">${k + 2}/${threadPosts.length + 1}</div>
                <div class="ibx-pv-text">${t.text}</div>
                ${t.images.length ? html`<${Grid} images=${t.images} layout="tile" max=${4} />` : null}
                ${cap && t.text.length > cap ? html`<div class="ibx-warn-line">${t.text.length - cap} over cap</div>` : null}
              </div>
            </div>`)}
        </div>` : null}
      ${firstComment && (platform === 'linkedin' || platform === 'instagram' || platform === 'facebook') ? html`
        <div class="ibx-pv-comment"><${Icon} name="message-square" size=${12} /><span><b>First comment</b> ${firstComment}</span></div>` : null}
    </article>`;
}

/** Email / newsletter inline images, rendered as a reviewable strip (they live in the body). */
export function InlineImages({ images, onOpen }) {
  if (!images?.length) return null;
  return html`<section class="ibx-media">
    <div class="ibx-section-head"><${Icon} name="image" size=${13} /><span>Images in body</span><span class="ibx-muted">${images.length} · edit them in the body</span></div>
    <div class="ibx-media-grid is-compact">
      ${images.map((u, i) => html`<div key=${u} class="ibx-media-tile"><button type="button" class="ibx-media-open" onClick=${() => onOpen?.(i)}><${Img} src=${u} /></button><span class="ibx-media-idx">${i + 1}</span></div>`)}
    </div>
  </section>`;
}
