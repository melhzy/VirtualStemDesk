/* Virtual Stem Desk: interface languages. Apache-2.0 licence.
   The app is written in English. A language file gives translations keyed by the English text, plus patterns for
   messages that contain numbers or names. This script translates text as it appears on the page, so the app's own
   code needs no changes when a language is added: copy lang/zh-CN.js, translate, and list the file in index.html. */
(function () {
  'use strict';
  var LANGS = window.VSD_LANG = window.VSD_LANG || {}, cur = 'en', ATTRS = ['title', 'aria-label', 'placeholder'];
  var SKIP = '.plate, #sections, .mk, #paper, #selTag, #selName, #waveName, script, style';   // names that belong to the song are never translated
  function tr(s) {
    var L = LANGS[cur]; if (!L || !s) return s; var lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0], core = s.trim(); if (!core || !/[A-Za-z]/.test(core)) return s;
    if (Object.prototype.hasOwnProperty.call(L.exact, core)) return lead + L.exact[core] + tail;
    for (var i = 0; i < L.patterns.length; i++) { var p = L.patterns[i]; if (p[0].test(core)) return lead + core.replace(p[0], typeof p[1] === 'function' ? function () { return p[1].apply(null, arguments); } : p[1]) + tail; }
    return s;
  }
  function skipped(node) { var e = node.nodeType === 1 ? node : node.parentElement; return !e || !!e.closest(SKIP); }
  function doText(n) {
    if (n.__tr != null && n.nodeValue === n.__tr) return;            // our own write
    n.__en = n.nodeValue; if (skipped(n)) { n.__tr = null; return; }
    var t = tr(n.__en); n.__tr = t; if (t !== n.nodeValue) n.nodeValue = t;
  }
  function doAttrs(e) {
    for (var i = 0; i < ATTRS.length; i++) { var a = ATTRS[i]; if (!e.hasAttribute(a)) continue; var v = e.getAttribute(a), st = e.__attr || (e.__attr = {});
      if (st[a] && st[a].tr === v) continue; st[a] = { en: v, tr: null }; if (skipped(e) && !e.matches('.plate')) continue; var t = tr(v); st[a].tr = t; if (t !== v) e.setAttribute(a, t); }
  }
  function walk(root) {
    if (root.nodeType === 3) { doText(root); return; } if (root.nodeType !== 1) return; doAttrs(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT), n; while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  function retranslate() {            // language changed: go back to the English kept on each node and translate again
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) { if (n.__en != null) { n.__tr = null; n.nodeValue = n.__en; } doText(n); }
      else { if (n.__attr) for (var a in n.__attr) { n.setAttribute(a, n.__attr[a].en); } n.__attr = null; doAttrs(n); }
    }
    var t = document.title; document.title = t;
  }
  var mo = new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) { var m = list[i];
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else for (var k = 0; k < m.addedNodes.length; k++) walk(m.addedNodes[k]); }
  });
  function setLang(code) {
    cur = LANGS[code] ? code : 'en'; document.documentElement.lang = cur; try { localStorage.setItem('vsd2:lang', cur); } catch (e) {}
    var sel = document.getElementById('langSel'); if (sel) sel.value = cur; retranslate();
  }
  function start() {
    var sel = document.getElementById('langSel');
    if (sel) { Object.keys(LANGS).forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = LANGS[c].name; o.setAttribute('lang', c); sel.appendChild(o); }); sel.onchange = function () { setLang(sel.value); }; }
    var want = null; try { want = localStorage.getItem('vsd2:lang'); } catch (e) {}
    if (!want) { var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en'; want = Object.keys(LANGS).filter(function (c) { return nav.toLowerCase() === c.toLowerCase(); })[0] || Object.keys(LANGS).filter(function (c) { return nav.slice(0, 2).toLowerCase() === c.slice(0, 2).toLowerCase(); })[0] || 'en'; }
    cur = LANGS[want] ? want : 'en'; document.documentElement.lang = cur; if (sel) sel.value = cur;
    walk(document.body); mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  window.VSD_I18N = { setLang: setLang, tr: tr, lang: function () { return cur; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
