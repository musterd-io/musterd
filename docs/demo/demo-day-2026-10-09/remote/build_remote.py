#!/usr/bin/env python3
"""Build dist/demo-remote.html: one artifact page that is the deck (#deck, the laptop) or the phone
controller (#remote, the phone), talking over the artifact `room` capability. Inputs: ../deck.html
(with its logos, office still and the web fonts) and ./runofshow.html. Output: ./dist/demo-remote.html."""
import base64, json, pathlib, re

HERE = pathlib.Path(__file__).resolve().parent
DD = HERE.parent  # docs/demo/demo-day-2026-10-09: deck.html, logos/, office-still.png
FONTS = HERE.parents[3] / 'packages/web/src/styles/fonts'

MIME = {'.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2'}


def data_uri(p: pathlib.Path) -> str:
    return 'data:%s;base64,%s' % (MIME[p.suffix], base64.b64encode(p.read_bytes()).decode())


deck = (DD / 'deck.html').read_text()
ros = (HERE / 'runofshow.html').read_text()

# ------------------------------------------------------------------ deck payload
d_css = re.search(r'<style>([\s\S]*?)</style>\s*<style id="deck-layout">', deck).group(1)
d_font = re.search(r'<link rel="stylesheet" href="(https://fonts\.googleapis\.com[^"]+)"', deck).group(1)
marker = '<style id="deck-layout"></style>'
d_body = deck[deck.index(marker) + len(marker): deck.index('<script>')]
d_script = deck[deck.index('<script>') + 8: deck.index('</script>')]

d_css = re.sub(r'url\(\.\./\.\./\.\./packages/web/src/styles/fonts/([\w.-]+)\)',
               lambda m: 'url(%s)' % data_uri(FONTS / m.group(1)), d_css)


def inline_src(m):
    rel = m.group(1)
    if rel.startswith(('http', 'data:', '#')):
        return m.group(0)
    if not (DD / rel).exists():  # avatar.jpg is kept out of git; the slide hides a missing image
        return m.group(0)
    return 'src="%s"' % data_uri(DD / rel)


d_body = re.sub(r'src="([^"]+\.(?:svg|png|jpg))"', inline_src, d_body)
assert 'logos/' not in d_body and 'office-still' not in d_body, 'an asset path was left un-inlined'

old = "history.replaceState(null, '', '#' + (i + 1));"
assert d_script.count(old) == 1
d_script = d_script.replace(old, 'window.__deckChanged && window.__deckChanged(i + 1, n);')
tail = '  go(i);\n})();'
assert d_script.rstrip().endswith(tail)
k = d_script.rstrip().rfind(tail)
d_script = (d_script[:k] +
            '  window.__deck = { go, next, prev, refresh, slides, n, get i() { return i; } };\n' + tail + '\n')

DECK_REMOTE = r'''
(function () {
  if (!window.claude || !claude.use) return;
  claude.use('room').then(function (room) {
    if (!room) return;
    var D = window.__deck;
    if (!D) return;
    function state() { room.emit('state', { slide: D.i + 1, total: D.n }).catch(function () {}); }
    window.__deckChanged = function () { state(); };
    room.on('nav', function (m) {
      if (m.sameTab) return;
      var d = m.data || {};
      if (d.a === 'next') D.next();
      else if (d.a === 'prev') D.prev();
      else if (d.a === 'goto') {
        var k = (d.slide | 0) - 1;
        if (k >= 0 && k < D.n) {
          D.go(k);
          if (d.reveal) {
            D.slides[k].querySelectorAll('.frag').forEach(function (x) { x.classList.add('shown'); });
            D.refresh(D.slides[k]);
          }
        }
      } else if (d.a === 'hello') state();
    }, function () {});
    room.onPeers(function (c) { if (c.joined.length) state(); }, function () {});
    setInterval(state, 4000);
    state();
  }).catch(function () {});
})();
'''

titles = re.findall(r'<section class="slide[^"]*"[^>]*data-title="([^"]*)"', deck)
assert len(titles) == 15, titles

# ------------------------------------------------------------------ remote (phone) payload
r_css = re.search(r'<style>([\s\S]*?)</style>', ros).group(1)
r_body = ros[ros.index('</style>') + len('</style>'): ros.index('<script>')]
r_body = re.sub(r'<link[^>]*>', '', r_body)
r_script = ros[ros.index('<script>') + 8: ros.index('</script>')]

# 1) a deck pill in the top row
old = '<div class="dots" id="dots" aria-hidden="true"></div>'
assert r_body.count(old) == 1
r_body = r_body.replace(
    old, old + '\n    <button class="sm" id="deckpill" type="button" data-sheet="deck">Deck · –</button>')
r_css += '''
#deckpill{font-family:var(--mono);font-size:13px;padding:8px 10px;white-space:nowrap}
#deckpill.ok{border-color:var(--gold)}
#deckpill.off{color:var(--mut)}
#deckpill.skew{background:var(--gold-bg);border-color:var(--gold)}
.dots{display:none}
.deckbtns{display:grid;grid-template-columns:1fr 2fr;gap:10px}
.deckbtns button{min-height:64px;border-radius:14px;border:1px solid var(--line);background:var(--panel);font-size:20px;font-weight:800}
.deckbtns .gold{background:var(--gold);border-color:var(--gold);color:#16161A}
.decklist{display:flex;flex-direction:column;gap:8px}
.decklist button{display:flex;gap:10px;align-items:center;text-align:left;min-height:46px;padding:8px 12px;border:1px solid var(--line);background:var(--panel);border-radius:12px;font-size:16px;font-weight:700}
.decklist button em{font-style:normal;font-family:var(--mono);color:var(--mut);min-width:26px}
.decklist button.cur{border-color:var(--gold);background:var(--gold-bg)}
'''

# 2) the big Next / Back are the DECK's own next / prev (exactly a click or an arrow key);
#    the script cards move with their own small row, so nothing jumps.
old = "document.getElementById('next').addEventListener('click',function(){step(1)});"
assert r_script.count(old) == 1
r_script = r_script.replace(old, "document.getElementById('next').addEventListener('click',function(){sendNav({a:'next'})});\n"
                            "  document.getElementById('snext').addEventListener('click',function(){step(1)});")
old = "document.getElementById('back').addEventListener('click',function(){step(-1)});"
assert r_script.count(old) == 1
r_script = r_script.replace(old, "document.getElementById('back').addEventListener('click',function(){sendNav({a:'prev'})});\n"
                            "  document.getElementById('sback').addEventListener('click',function(){step(-1)});")
old = "document.getElementById('back').disabled=i===0;"
assert r_script.count(old) == 1
r_script = r_script.replace(old, "document.getElementById('sback').disabled=i===0;document.getElementById('snext').disabled=i===cards.length-1;"
                            "document.getElementById('spos').textContent='Script '+(i+1)+' of '+cards.length;")
old = "document.getElementById('next').textContent=i===cards.length-1?'Done':'Next';"
assert r_script.count(old) == 1
r_script = r_script.replace(old, "")

# bottom nav labels + the script row
old = '<button type="button" id="back">Back</button>'
assert r_body.count(old) == 1
r_body = r_body.replace(old, '<button type="button" id="back">◀ Slide</button>')
old = '<button type="button" id="next" class="next">Next</button>'
assert r_body.count(old) == 1
r_body = r_body.replace(old, '<button type="button" id="next" class="next">Slide ▶</button>')
old = '<div class="chips">'
assert r_body.count(old) == 1
r_body = r_body.replace(old, '<div class="script"><button type="button" id="sback" aria-label="Previous script card">‹</button>'
                        '<span id="spos"></span><button type="button" id="snext" aria-label="Next script card">›</button></div>\n  ' + old)
r_css += """
.app{grid-template-rows:auto 1fr auto auto auto}
.script{display:grid;grid-template-columns:56px 1fr 56px;align-items:center;text-align:center;gap:8px}
.script button{min-height:44px;border-radius:12px;border:1px solid var(--line);background:var(--panel);font-size:24px;font-weight:800}
.script button:disabled{opacity:.35}
#spos{font-family:var(--mono);font-size:14px;color:var(--mut)}
"""

# 3) the deck sheet
deck_list = ''.join('<button type="button" data-goto="%d"><em>%d</em>%s</button>' % (k + 1, k + 1, t.replace('&', '&amp;'))
                    for k, t in enumerate(titles))
deck_html = ('<div class="deckbtns"><button type="button" data-a="prev">Back</button>'
             '<button type="button" class="gold" data-a="next">Next</button></div>'
             '<div id="decknote" style="color:var(--mut);font-size:14px">Same as pressing the arrow keys on the laptop.</div>'
             '<div class="decklist">' + deck_list + '</div>')
js_deck_html = deck_html.replace('\\', '\\\\').replace("'", "\\'")
old = "    qa:{t:'If they ask',"
assert r_script.count(old) == 1
r_script = r_script.replace(old, "    deck:{t:'Deck',h:'" + js_deck_html + "'},\n" + old)

# 4) bind the deck sheet's buttons after the sheet body is filled
old = "      [].slice.call(body.querySelectorAll('.cpbtn')).forEach(function(cp){"
assert r_script.count(old) == 1
r_script = r_script.replace(old, r'''      [].slice.call(body.querySelectorAll('[data-a],[data-goto]')).forEach(function(b){
        b.addEventListener('click',function(){if(b.dataset.a)sendNav({a:b.dataset.a});else sendNav({a:'goto',slide:+b.dataset.goto,reveal:false})});
      });
      markDeck();
''' + old)

# 5) the room: send, and show the deck's reported slide
room_js = r'''
  var room=null, deckSlide=0, deckAt=0, DECKN=15;
  function sendNav(d){if(room)room.emit('nav',d).catch(function(){})}
  function markDeck(){
    var pill=document.getElementById('deckpill');
    var live=deckAt&&(Date.now()-deckAt<10000);
    if(pill){
      pill.textContent=live?('Deck · '+deckSlide+'/'+DECKN):'Deck · offline';
      pill.className='sm'+(live?' ok':' off');
    }
    [].slice.call(document.querySelectorAll('.decklist button')).forEach(function(b){b.classList.toggle('cur',live&&+b.dataset.goto===deckSlide)});
  }
  setInterval(markDeck,2000);
  if(window.claude&&claude.use){
    claude.use('room').then(function(r){
      if(!r)return;
      room=r;
      r.on('state',function(m){
        if(m.sameTab||!m.data)return;
        deckSlide=+m.data.slide||0;DECKN=+m.data.total||15;deckAt=Date.now();markDeck();
      },function(){});
      r.onPeers(function(c){if(c.joined.length)sendNav({a:'hello'})},function(){});
      sendNav({a:'hello'});
      setInterval(function(){sendNav({a:'hello'})},5000);
    }).catch(function(){});
  }
  markDeck();
'''
tail = '  draw();\n})();'
assert r_script.rstrip().endswith(tail)
k = r_script.rstrip().rfind(tail)
r_script = r_script[:k] + room_js + tail + '\n'

# ------------------------------------------------------------------ the page
def js(o):
    return json.dumps(o).replace('</', '<\\/')


page = '''<title>Demo Day Remote</title>
<style>html,body{height:100%;margin:0;background:#101013}</style>
<script>
(function () {
  var DECK = __DECK__;
  var REMOTE = __REMOTE__;
  var h = location.hash.slice(1);
  var mode = (h === 'deck' || h === 'remote') ? h : (matchMedia('(pointer:coarse)').matches ? 'remote' : 'deck');
  var P = mode === 'deck' ? DECK : REMOTE;
  var st = document.createElement('style'); st.textContent = P.css; document.head.appendChild(st);
  if (P.font) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = P.font; document.head.appendChild(l); }
  document.body.innerHTML = P.body;
  P.scripts.forEach(function (code) { var s = document.createElement('script'); s.textContent = code; document.body.appendChild(s); });
})();
</script>
'''
page = page.replace('__DECK__', js({'css': d_css, 'font': d_font, 'body': d_body, 'scripts': [d_script, DECK_REMOTE]}))
page = page.replace('__REMOTE__', js({'css': r_css, 'font': None, 'body': r_body, 'scripts': [r_script]}))

OUT = HERE / 'dist'
OUT.mkdir(exist_ok=True)
(OUT / 'demo-remote.html').write_text(page)
print('wrote dist/demo-remote.html', len(page), 'bytes')
