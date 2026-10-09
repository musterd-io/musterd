// Edit this page in the browser and save it back to its own file.
//
//   E        toggle edit mode: every text on the page becomes editable
//   M        (in edit mode) toggle move mode: drag anything to reposition it, Option-drag moves its
//            parent block, double-click puts it back
//   ⌘S / ^S  save straight back to this file
//
// Open the page through serve.mjs (`node docs/demo/multiplayer-ai-2026-10-01/serve.mjs`) and a save
// goes straight to disk, in any browser. Opened as a plain file instead, the browser will not let
// a page write to disk on its own: the first save asks you to pick this same file (Chrome/Edge
// only), later saves reuse it. Either way it never rewrites the whole page: it re-reads the file,
// replaces only the text you changed (and the one layout block, if you moved something), and writes
// it back, so the git diff is just your edit and a teammate's change made meanwhile survives. An
// edit it cannot place exactly once is refused and named, never guessed.
(() => {
  const TEXT = 'h1,h2,h3,h4,p,li,small,b,big,td,th,blockquote';
  // never editable as page text: runtime-generated regions are handled as data (below), the rest is chrome
  const SKIP = '.mcap h3,.mcap ul,.mcap .how,.mcap .stepn,#road,#mgraph,#menu,#notes,#pv,nav,.picker,.nav,#ed-bar,#qr,script,style,svg,aside,template';
  // runtime-generated regions whose text comes from string literals in the page's own script
  const GENROOTS = '#road,.mcap h3,.mcap ul,.mcap .how,#mgraph';
  const GEN = '[data-gen],[data-ico] > .ico';
  const deckEl = document.querySelector('.deck');
  const rootSel = deckEl ? '.slide' : 'main';

  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const qualifies = (el) => !el.closest(SKIP) && (el.matches(TEXT) || ownText(el));
  // the editable leaves, in document order, computed the same way on the live page and on the
  // pristine copy parsed from disk, so an index means the same element in both
  function leaves(doc) {
    const out = [];
    doc.querySelectorAll(rootSel).forEach((root) =>
      root.querySelectorAll('*').forEach((el) => {
        if (!qualifies(el)) return;
        for (let up = el.parentElement; up && up !== root; up = up.parentElement) if (qualifies(up)) return;
        out.push(el);
      }),
    );
    return out;
  }
  // generated text: live page only
  function genLeaves() {
    const out = [];
    const ok = (el) =>
      !el.closest('svg') && !el.matches('.stepn,.ico,.ico *,.av,.me') && !el.querySelector('.ico,svg') && (el.matches(TEXT) || ownText(el));
    document.querySelectorAll(GENROOTS).forEach((root) =>
      root.querySelectorAll('*').forEach((el) => {
        if (!ok(el)) return;
        for (let up = el.parentElement; up && up !== root; up = up.parentElement) if (ok(up)) return;
        out.push(el);
      }),
    );
    return out;
  }
  const asides = (doc) => [...doc.querySelectorAll('.slide')].map((s) => s.querySelector(':scope > aside'));

  function clean(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll(GEN).forEach((g) => g.remove());
    c.querySelectorAll('[contenteditable],[data-ed]').forEach((g) => (g.removeAttribute('contenteditable'), g.removeAttribute('data-ed')));
    return c.innerHTML;
  }
  function tidy(html) {
    return html
      .replace(/&nbsp;/g, ' ')
      .replace(/<div>/g, '<br>')
      .replace(/<\/div>/g, '')
      .replace(/(<br>)+$/, '');
  }
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const jsq = (t) => "'" + t.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

  let on = false;
  let moving = false;
  let list = [];
  let gen = [];
  const dirty = new Map(); // key -> {kind, i, tag, base, get()}

  // ---- chrome -----------------------------------------------------------------------------------
  const css = document.createElement('style');
  css.textContent = `
    html.editing [data-ed]{outline:1px dashed rgba(225,173,1,.55);outline-offset:3px;cursor:text}
    html.editing [data-ed]:focus{outline:2px solid #E1AD01;background:rgba(225,173,1,.08)}
    html.editing.ed-notes #notes{display:block!important;outline:2px dashed #E1AD01;cursor:text}
    html.moving [data-ed]{outline:none}
    html.moving .slide.on *,html.moving main *{cursor:grab!important}
    html.moving .ed-hover{outline:2px solid #7C5CFF!important;outline-offset:2px}
    html.moving .ed-drag{outline:2px solid #E1AD01!important;cursor:grabbing!important}
    #ed-bar{position:fixed;left:16px;top:14px;z-index:99;display:none;gap:8px;align-items:center;font:600 13px/1.2 ui-monospace,Menlo,monospace;background:#18181B;color:#FAFAFA;border-radius:999px;padding:7px 12px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
    html.editing #ed-bar{display:flex}
    #ed-bar i{font-style:normal;color:#E1AD01;max-width:46vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #ed-bar button{font:inherit;background:#3F3F46;color:#FAFAFA;border:0;border-radius:999px;padding:4px 10px;cursor:pointer}
    #ed-bar button.hot{background:#E1AD01;color:#18181B}`;
  document.head.appendChild(css);
  const presenter = document.documentElement.classList.contains('presenter');
  const bar = document.createElement('div');
  bar.id = 'ed-bar';
  bar.innerHTML =
    '<span id="ed-mode">Text</span><i id="ed-n">no changes</i>' +
    '<button id="ed-move" title="M">Move M</button>' +
    (document.getElementById('notes') && !presenter ? '<button id="ed-notes">Notes ▸</button>' : '') +
    '<button id="ed-save" class="hot">Save ⌘S</button><button id="ed-x">Done E</button>';
  document.body.appendChild(bar);
  const count = bar.querySelector('#ed-n');
  const say = (t) => {
    count.textContent = t;
  };
  let layoutDirty = false;
  const refreshCount = () => say(dirty.size || layoutDirty ? `${dirty.size + (layoutDirty ? 1 : 0)} unsaved` : 'no changes');

  // the notes editor: the presenter window's notes panel, else the deck's notes drawer
  const notesEl = () => (presenter ? document.getElementById('pvbody') : document.getElementById('notes'));

  // in edit mode the current slide shows every step, so nothing hidden is out of reach
  function revealCurrent() {
    if (!on) return;
    const s = document.querySelector('.slide.on');
    if (s) s.querySelectorAll('.frag:not(.shown)').forEach((f) => f.classList.add('shown'));
  }

  function mark() {
    document.querySelectorAll('[data-ed]').forEach((el) => {
      el.removeAttribute('contenteditable');
      el.removeAttribute('data-ed');
    });
    list = leaves(document);
    gen = genLeaves();
    if (!on) return;
    list.forEach((el, i) => {
      el.setAttribute('data-ed', 't' + i);
      if (!moving) el.setAttribute('contenteditable', 'true');
    });
    gen.forEach((el, i) => {
      el.setAttribute('data-ed', 'g' + i);
      if (!moving) el.setAttribute('contenteditable', 'true');
    });
  }
  function notesEditable() {
    const n = notesEl();
    if (!n) return;
    if (on && !moving) n.setAttribute('contenteditable', 'plaintext-only');
    else n.removeAttribute('contenteditable');
  }
  function setOn(v) {
    on = v;
    if (!on) setMoving(false);
    document.documentElement.classList.toggle('editing', on);
    revealCurrent();
    mark();
    notesEditable();
    refreshCount();
  }
  function setMoving(v) {
    moving = v && on;
    document.documentElement.classList.toggle('moving', moving);
    bar.querySelector('#ed-mode').textContent = moving ? 'Move' : 'Text';
    bar.querySelector('#ed-move').classList.toggle('hot', moving);
    document.querySelectorAll('.ed-hover').forEach((x) => x.classList.remove('ed-hover'));
    if (on) mark();
    notesEditable();
  }
  // a new slide while editing: reveal it and mark its text
  const afterNav = () => {
    if (on) setTimeout(() => (revealCurrent(), mark()), 0);
  };

  // ---- text edits ---------------------------------------------------------------------------------
  // remember each element's text as it was before its first edit
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-ed]');
    if (on && el && el.__base === undefined) el.__base = clean(el);
  });
  document.addEventListener('input', (e) => {
    if (!on) return;
    const el = e.target.closest && e.target.closest('[data-ed]');
    if (el) {
      const id = el.getAttribute('data-ed');
      const i = +id.slice(1);
      if (el.__base === undefined) el.__base = clean(el);
      if (id[0] === 't') {
        dirty.set(id, { kind: 'text', i, tag: el.tagName.toLowerCase(), base: el.__base, get: () => tidy(clean(el)) });
      } else {
        // generated text: its source is a string literal in the page's script; keep the live data in step
        const now = tidy(clean(el));
        const prev = el.__last ?? el.__base;
        dirty.set('g:' + el.__base, { kind: 'js', i, base: el.__base, get: () => tidy(clean(el)) });
        const S = window.__session;
        if (S) {
          const swap = (v) => (v === prev ? now : v);
          S.forEach((n) => Object.keys(n).forEach((k) => (n[k] = Array.isArray(n[k]) ? n[k].map(swap) : swap(n[k]))));
        }
        el.__last = now;
      }
    } else if (e.target === notesEl()) {
      const slides = [...document.querySelectorAll('.slide')];
      const s = slides.findIndex((x) => x.classList.contains('on'));
      const a = s >= 0 && slides[s].querySelector(':scope > aside');
      if (!a) return;
      if (a.__base === undefined) a.__base = esc(a.textContent);
      a.textContent = e.target.innerText;
      dirty.set('n' + s, { kind: 'note', i: s, tag: 'aside', base: a.__base, get: () => esc(a.textContent) });
    }
    refreshCount();
  });
  // paste plain text only
  document.addEventListener('paste', (e) => {
    if (!on || !e.target.closest || !e.target.closest('[data-ed]')) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  // ---- moving -------------------------------------------------------------------------------------
  // offsets live in one <style id="deck-layout"> block in the file, one rule per moved element,
  // keyed by its structural path. On the deck the units are relative to the deck (cqw/cqh), so a
  // move holds at any screen size and in the presenter window.
  const layout = new Map(); // selector -> [x, y]
  const unitX = deckEl ? 'cqw' : 'px';
  const unitY = deckEl ? 'cqh' : 'px';
  let layoutStyle = document.getElementById('deck-layout');
  if (layoutStyle) {
    for (const m of layoutStyle.textContent.matchAll(/^(.+?)\{translate:\s*([-\d.]+)(?:cqw|px)\s+([-\d.]+)(?:cqh|px)\s*!important\}$/gm))
      layout.set(m[1].trim(), [+m[2], +m[3]]);
  } else {
    layoutStyle = document.createElement('style');
    layoutStyle.id = 'deck-layout';
    document.head.appendChild(layoutStyle);
  }
  const layoutText = () =>
    '\n' + [...layout].map(([k, [x, y]]) => `${k}{translate:${x}${unitX} ${y}${unitY} !important}`).join('\n') + '\n';
  const applyLayout = () => (layoutStyle.textContent = layoutText());

  function pathOf(el) {
    const parts = [];
    for (let n = el; n; n = n.parentElement) {
      if (n.id && !n.id.startsWith('ed-')) {
        parts.unshift('#' + CSS.escape(n.id));
        break;
      }
      if (n.tagName === 'SECTION' && n.parentElement && n.parentElement.classList.contains('deck')) {
        parts.unshift(`.deck > section:nth-of-type(${[...n.parentElement.children].filter((c) => c.tagName === 'SECTION').indexOf(n) + 1})`);
        break;
      }
      if (n.tagName === 'MAIN') {
        parts.unshift('main');
        break;
      }
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${[...n.parentElement.children].indexOf(n) + 1})`);
    }
    return parts.join(' > ');
  }
  function movable(t, up) {
    if (!t.closest) return null;
    let el = t.closest('.slide.on *, main *');
    if (!el || el.closest('#ed-bar,.picker,.nav,#pv')) return null;
    if (el.closest('svg') && !el.matches('svg')) el = el.closest('svg');
    for (let k = 0; k < up && el.parentElement && !el.parentElement.matches('.slide,main'); k++) el = el.parentElement;
    return el;
  }
  let drag = null;
  let hover = null;
  addEventListener(
    'pointermove',
    (e) => {
      if (!moving) return;
      if (drag) {
        const r = deckEl ? deckEl.getBoundingClientRect() : null;
        const dx = r ? ((e.clientX - drag.x) / r.width) * 100 : e.clientX - drag.x;
        const dy = r ? ((e.clientY - drag.y) / r.height) * 100 : e.clientY - drag.y;
        layout.set(drag.sel, [+(drag.ox + dx).toFixed(2), +(drag.oy + dy).toFixed(2)]);
        applyLayout();
        layoutDirty = true;
        refreshCount();
        return;
      }
      const el = movable(e.target, e.altKey ? 1 : 0);
      if (el !== hover) {
        if (hover) hover.classList.remove('ed-hover');
        hover = el;
        if (hover) hover.classList.add('ed-hover');
      }
    },
    true,
  );
  addEventListener(
    'pointerdown',
    (e) => {
      if (!moving || e.button !== 0) return;
      const el = movable(e.target, e.altKey ? 1 : 0);
      if (!el) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const sel = pathOf(el);
      const [ox, oy] = layout.get(sel) || [0, 0];
      drag = { el, sel, x: e.clientX, y: e.clientY, ox, oy };
      el.classList.add('ed-drag');
    },
    true,
  );
  addEventListener(
    'pointerup',
    () => {
      if (!drag) return;
      drag.el.classList.remove('ed-drag');
      drag = null;
    },
    true,
  );
  addEventListener(
    'dblclick',
    (e) => {
      if (!moving) return;
      const el = movable(e.target, e.altKey ? 1 : 0);
      if (!el) return;
      e.preventDefault();
      if (layout.delete(pathOf(el))) {
        applyLayout();
        layoutDirty = true;
        refreshCount();
      }
    },
    true,
  );

  // ---- keys and clicks ----------------------------------------------------------------------------
  // the page's own keys and clicks drive the slides; while editing they must not
  addEventListener(
    'keydown',
    (e) => {
      const typing = e.target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopImmediatePropagation();
        save();
        return;
      }
      if (typing) {
        e.stopImmediatePropagation();
        if (e.key === 'Enter' && e.target.closest('[data-ed]')) {
          e.preventDefault();
          document.execCommand('insertLineBreak');
        }
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setOn(!on);
      } else if (on && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setMoving(!moving);
      } else if (on && /Arrow|Page|Home|End| /.test(e.key)) afterNav();
    },
    true,
  );
  addEventListener(
    'click',
    (e) => {
      if (!on) return;
      if (e.target.closest('#ed-bar,#pvh,#pvreset')) return;
      if (e.target.closest('.picker,.nav')) return afterNav();
      e.stopImmediatePropagation(); // a click places the caret or ends a drag; it never advances the slide
    },
    true,
  );
  bar.querySelector('#ed-save').addEventListener('click', () => save());
  bar.querySelector('#ed-x').addEventListener('click', () => setOn(false));
  bar.querySelector('#ed-move').addEventListener('click', () => setMoving(!moving));
  const nb = bar.querySelector('#ed-notes');
  if (nb)
    nb.addEventListener('click', () => {
      const open = document.documentElement.classList.toggle('ed-notes');
      nb.textContent = open ? 'Notes ▾' : 'Notes ▸';
    });

  // ---- saving -------------------------------------------------------------------------------------
  const DB = 'musterd-page-editor';
  function idb(mode, fn) {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('handles');
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction('handles', mode);
        const q = fn(tx.objectStore('handles'));
        tx.oncomplete = () => res(q && q.result);
        tx.onerror = () => rej(tx.error);
      };
    });
  }
  const key = location.pathname;
  let handle = null;
  async function getHandle() {
    if (!handle) {
      try {
        handle = await idb('readonly', (s) => s.get(key));
      } catch {}
    }
    if (handle) {
      const ok =
        (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' ||
        (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
      if (ok) return handle;
    }
    const name = decodeURIComponent(location.pathname.split('/').pop() || 'page.html');
    say(`pick ${name} to save into`);
    const [h] = await window.showOpenFilePicker({ types: [{ description: 'This page', accept: { 'text/html': ['.html'] } }] });
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('write permission refused');
    if (h.name !== name) throw new Error(`that is ${h.name}; pick ${name}`);
    handle = h;
    try {
      await idb('readwrite', (s) => s.put(h, key));
    } catch {}
    return h;
  }

  // the whole save, minus the disk: given the file's current text, return the patched text and
  // what could not be placed. Exposed so it can be tested without a disk.
  function patch(src) {
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const pristine = leaves(doc);
    const notes = asides(doc);
    let out = src;
    const done = [];
    const refused = [];
    for (const [k, d] of dirty) {
      const now = d.get();
      if (now === d.base) {
        done.push(k);
        continue;
      }
      const label = d.kind === 'note' ? `the notes on slide ${d.i + 1}` : `“${(d.base || '').replace(/<[^>]+>/g, '').slice(0, 40)}”`;
      if (d.kind === 'js') {
        const parts = out.split(jsq(d.base));
        if (parts.length < 2) {
          refused.push(`${label} was not found in the page's script`);
          continue;
        }
        out = parts.join(jsq(now));
        done.push(k);
        continue;
      }
      const target = d.kind === 'text' ? pristine[d.i] : notes[d.i];
      if (!target || target.innerHTML !== d.base) {
        refused.push(`${label} changed on disk since you started`);
        continue;
      }
      const same = [...doc.getElementsByTagName(d.tag)].filter((x) => x.innerHTML === d.base);
      const nth = same.indexOf(target);
      const needle = '>' + d.base + '</' + d.tag + '>';
      const at = [];
      for (let p = out.indexOf(needle); p !== -1; p = out.indexOf(needle, p + 1)) at.push(p);
      if (nth < 0 || at.length !== same.length) {
        refused.push(`${label} could not be placed exactly once (text beside an inline icon cannot be saved yet)`);
        continue;
      }
      const p = at[nth] + 1;
      out = out.slice(0, p) + now + out.slice(p + d.base.length);
      done.push(k);
    }
    let layoutSaved = false;
    if (layoutDirty) {
      const m = out.match(/(<style id="deck-layout">)([\s\S]*?)(<\/style>)/);
      if (m) {
        out = out.replace(m[0], () => m[1] + layoutText() + m[3]);
        layoutSaved = true;
      } else refused.push('positions: this file has no <style id="deck-layout"> block');
    }
    return { out, done, refused, layoutSaved };
  }

  // served by serve.mjs: read and write the file over HTTP, no picker. Any other server answers
  // the save with something other than 204, and we fall back to the picker.
  const served = location.protocol.startsWith('http');
  const viaServer = {
    name: decodeURIComponent(location.pathname.split('/').pop()),
    read: async () => {
      const r = await fetch(location.pathname, { cache: 'no-store' });
      if (!r.ok) throw new Error(`could not re-read the file (${r.status})`);
      return r.text();
    },
    write: async (text) => {
      const r = await fetch('/__save?path=' + encodeURIComponent(location.pathname), {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8', 'x-page-editor': '1' },
        body: text,
      });
      if (r.status !== 204) throw new Error(`this server cannot save (${r.status}); run serve.mjs`);
    },
  };
  async function viaPicker() {
    if (!window.showOpenFilePicker) throw new Error('open the page through serve.mjs, or use Chrome or Edge');
    const h = await getHandle();
    return {
      name: h.name,
      read: async () => (await h.getFile()).text(),
      write: async (text) => {
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
      },
    };
  }

  async function save() {
    if (!dirty.size && !layoutDirty) return say('nothing to save');
    say('saving…');
    try {
      const io = served ? viaServer : await viaPicker();
      const src = await io.read();
      const { out, done, refused, layoutSaved } = patch(src);
      if (out !== src) await io.write(out);
      for (const k of done) {
        const d = dirty.get(k);
        const now = d.get();
        if (d.kind === 'text') list[d.i].__base = now;
        else if (d.kind === 'js') gen.forEach((g) => g.__base === d.base && ((g.__base = now), (g.__last = undefined)));
        else document.querySelectorAll('.slide')[d.i].querySelector(':scope > aside').__base = now;
        dirty.delete(k);
      }
      if (layoutSaved) layoutDirty = false;
      const n = done.length + (layoutSaved ? 1 : 0);
      say(refused.length ? `saved ${n}; not saved: ${refused.join('; ')}` : `saved ${n} to ${io.name}`);
      if (refused.length) console.warn('[editor] not saved:', refused);
    } catch (err) {
      if (err && err.name === 'AbortError') return refreshCount();
      say(`save failed: ${err.message || err}`);
      console.error('[editor]', err);
    }
  }

  window.__pageEditor = { leaves, genLeaves, patch, setOn, setMoving, dirty, layout, pathOf };
})();
