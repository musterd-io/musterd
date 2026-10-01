// Edit this page in the browser and save it back to its own file.
//
//   E        toggle edit mode (text on the page, plus the speaker notes on a deck)
//   ⌘S / ^S  save: the first time, pick this same .html file; after that it saves straight back
//
// Saving needs Chrome or Edge (the File System Access API). It never rewrites the whole page: it
// re-reads the file from disk, replaces only the text of the elements you edited, and writes it
// back, so the git diff is just your edit and a teammate's change made meanwhile survives. An edit
// it cannot place exactly once (the text changed on disk underneath you, or it is ambiguous) is
// refused and named, never guessed.
(() => {
  const TEXT = 'h1,h2,h3,p,li,small,b,big,span.num,span.big,span.t,.num > span,.legend span,td,th,blockquote';
  // generated at runtime by the page's own script: never editable, never saved
  const SKIP = '.mcap,#road,#mgraph,#menu,#notes,nav,.picker,.nav,#ed-bar,#qr';
  const GEN = '[data-gen],[data-ico] > .ico';
  const deck = !!document.querySelector('.slide');
  const rootSel = deck ? '.slide' : 'main';

  // the editable leaves, in document order, computed the same way on the live page and on the
  // pristine copy parsed from disk, so an index means the same element in both
  function leaves(doc) {
    const out = [];
    doc.querySelectorAll(rootSel).forEach((root) =>
      root.querySelectorAll(TEXT).forEach((el) => {
        if (el.closest(SKIP)) return;
        const up = el.parentElement && el.parentElement.closest(TEXT);
        if (up && root.contains(up)) return; // an editable ancestor already covers it
        out.push(el);
      }),
    );
    return out;
  }
  const asides = (doc) => [...doc.querySelectorAll('.slide')].map((s) => s.querySelector(':scope > aside'));

  function clean(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll(GEN).forEach((g) => g.remove());
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

  let on = false;
  let list = [];
  const dirty = new Map(); // key -> {tag, base, get()}

  const css = document.createElement('style');
  css.textContent = `
    html.editing .slide.on .frag,html.editing .slide.on .vcard,html.editing .slide.on .stat,html.editing .slide.on .vcard li{opacity:1!important;transform:none!important;animation:none!important}
    html.editing [data-ed]{outline:1px dashed rgba(225,173,1,.55);outline-offset:3px;cursor:text}
    html.editing [data-ed]:focus{outline:2px solid #E1AD01;background:rgba(225,173,1,.08)}
    html.editing #notes{display:block!important;outline:2px dashed #E1AD01;cursor:text}
    #ed-bar{position:fixed;left:16px;top:14px;z-index:99;display:none;gap:10px;align-items:center;font:600 13px/1.2 ui-monospace,Menlo,monospace;background:#18181B;color:#FAFAFA;border-radius:999px;padding:8px 14px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
    html.editing #ed-bar,#ed-bar.flash{display:flex}
    #ed-bar i{font-style:normal;color:#E1AD01}
    #ed-bar button{font:inherit;background:#E1AD01;color:#18181B;border:0;border-radius:999px;padding:4px 10px;cursor:pointer}`;
  document.head.appendChild(css);
  const bar = document.createElement('div');
  bar.id = 'ed-bar';
  bar.innerHTML = '<span>Editing</span><i id="ed-n">no changes</i><button id="ed-save">Save ⌘S</button><button id="ed-x">Done E</button>';
  document.body.appendChild(bar);
  const count = bar.querySelector('#ed-n');
  const say = (t) => {
    count.textContent = t;
  };
  const refreshCount = () => say(dirty.size ? `${dirty.size} unsaved` : 'no changes');

  function setOn(v) {
    on = v;
    document.documentElement.classList.toggle('editing', on);
    if (on) list = leaves(document);
    list.forEach((el, i) => {
      if (on) {
        el.setAttribute('contenteditable', 'true');
        el.setAttribute('data-ed', i);
        el.spellcheck = true;
      } else {
        el.removeAttribute('contenteditable');
        el.removeAttribute('data-ed');
      }
    });
    const notes = document.getElementById('notes');
    if (notes) {
      if (on) notes.setAttribute('contenteditable', 'plaintext-only');
      else notes.removeAttribute('contenteditable');
    }
    refreshCount();
  }

  // remember each element's text as it was before its first edit
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-ed]');
    if (on && el && !el.__base) el.__base = clean(el);
  });
  document.addEventListener('input', (e) => {
    if (!on) return;
    const el = e.target.closest && e.target.closest('[data-ed]');
    if (el) {
      const i = +el.getAttribute('data-ed');
      dirty.set('t' + i, { kind: 'text', i, tag: el.tagName.toLowerCase(), base: el.__base, get: () => tidy(clean(el)) });
      el.__base = el.__base || clean(el);
    } else if (e.target.id === 'notes') {
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
  // paste plain text only; Enter is a line break, never a new block
  document.addEventListener('paste', (e) => {
    if (!on || !e.target.closest || !e.target.closest('[data-ed]')) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  // the page's own keys and clicks drive the slides; while typing they must not
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
      if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setOn(!on);
      }
    },
    true,
  );
  addEventListener(
    'click',
    (e) => {
      if (!on) return;
      if (e.target.closest('#ed-bar,.picker,.nav')) return;
      e.stopImmediatePropagation(); // a click places the caret; it does not advance the slide
    },
    true,
  );
  bar.querySelector('#ed-save').addEventListener('click', () => save());
  bar.querySelector('#ed-x').addEventListener('click', () => setOn(false));

  // ---- saving ----------------------------------------------------------------------------------
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
      const ok = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' || (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
      if (ok) return handle;
    }
    const name = decodeURIComponent(location.pathname.split('/').pop() || 'page.html');
    say(`pick ${name} to save into`);
    const [h] = await window.showOpenFilePicker({
      types: [{ description: 'This page', accept: { 'text/html': ['.html'] } }],
      excludeAcceptAllOption: false,
    });
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('write permission refused');
    if (h.name !== name) throw new Error(`that is ${h.name}; pick ${name}`);
    handle = h;
    try {
      await idb('readwrite', (s) => s.put(h, key));
    } catch {}
    return h;
  }

  // the whole save, minus the disk: given the file's current text, return the patched text and
  // what could not be placed. Exposed so it can be tested without a file picker.
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
      const target = d.kind === 'text' ? pristine[d.i] : notes[d.i];
      const label = d.kind === 'text' ? `“${(d.base || '').replace(/<[^>]+>/g, '').slice(0, 40)}”` : `the notes on slide ${d.i + 1}`;
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
        refused.push(`${label} could not be placed exactly once`);
        continue;
      }
      const p = at[nth] + 1;
      out = out.slice(0, p) + now + out.slice(p + d.base.length);
      done.push(k);
    }
    return { out, done, refused };
  }

  async function save() {
    if (!dirty.size) return say('nothing to save');
    if (!window.showOpenFilePicker) return say('saving needs Chrome or Edge');
    try {
      const h = await getHandle();
      const src = await (await h.getFile()).text();
      const { out, done, refused } = patch(src);
      if (out !== src) {
        const w = await h.createWritable();
        await w.write(out);
        await w.close();
      }
      for (const k of done) {
        const d = dirty.get(k);
        const now = d.get();
        if (d.kind === 'text') list[d.i].__base = now;
        else document.querySelectorAll('.slide')[d.i].querySelector(':scope > aside').__base = now;
        dirty.delete(k);
      }
      say(refused.length ? `saved ${done.length}; not saved: ${refused.join('; ')}` : `saved ${done.length} to ${h.name}`);
      if (refused.length) console.warn('[editor] not saved:', refused);
    } catch (err) {
      if (err && err.name === 'AbortError') return refreshCount();
      say(`save failed: ${err.message || err}`);
      console.error('[editor]', err);
    }
  }

  window.__pageEditor = { leaves, patch, setOn, dirty };
})();
