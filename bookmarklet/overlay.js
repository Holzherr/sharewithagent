/*!
 * ShareWithAgent — bookmarklet overlay
 *
 * Live-DOM annotation overlay injected directly into the host page.
 * Unlike the CLI/extension (which snapshot the page into a sandboxed iframe),
 * a bookmarklet only ever runs inside the host page's own JS context — there
 * is no way to sandbox it in an iframe — so this variant annotates the live
 * page DOM in place. Standalone vanilla JS, no build step, no dependencies,
 * everything inlined in this one file.
 *
 * NOTE: strict-CSP sites (script-src restricted) will block the bookmarklet's
 * injected <script src> tag from loading at all. Those users need the
 * ShareWithAgent browser extension instead, which does not rely on injecting
 * a remote script and works regardless of the page's CSP.
 */
(function () {
  'use strict';

  if (window.__swabLoaded) { return; }
  window.__swabLoaded = true;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  var STORAGE_KEY = 'swab.name';
  var state = {
    tool: 'select', // 'select' | 'pin'
    name: '',
    annotations: [],
    nextN: 1,
    expandedId: null,
    railOpen: false,
    pinCounter: 0
  };

  var root, bar, pill, rail, toast;
  var composer = null; // active composer popover element
  var pendingSelectionRange = null; // Range captured for an in-progress text annotation
  var pendingMark = null; // <mark> element for an in-progress text annotation

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') e.className = attrs[k];
        else if (k === 'html') e.innerHTML = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
          e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else {
          e.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      children.forEach(function (c) {
        if (c == null) return;
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else e.appendChild(c);
      });
    }
    return e;
  }

  function isInsideSwabUI(node) {
    if (!node) return false;
    if (node.nodeType === 3) node = node.parentNode;
    while (node) {
      if (node.id === 'swab-root') return true;
      node = node.parentNode;
    }
    return false;
  }

  function clamp(str, n) {
    if (str == null) return '';
    str = String(str);
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('swab-toast-show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      toast.classList.remove('swab-toast-show');
    }, 1800);
  }

  // ---------------------------------------------------------------------
  // Selector builder
  // ---------------------------------------------------------------------
  function buildSelector(element) {
    if (!(element instanceof Element)) return '';
    if (element.id) {
      return '#' + cssEscape(element.id);
    }
    var parts = [];
    var node = element;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        part = '#' + cssEscape(node.id);
        parts.unshift(part);
        break;
      }
      var parent = node.parentNode;
      if (parent && parent.nodeType === 1) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (siblings.length > 1) {
          var idx = Array.prototype.indexOf.call(siblings, node) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(part);
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([ #.;?%&,+*~':"!^$\[\]()=>|\/@])/g, '\\$1');
  }

  // ---------------------------------------------------------------------
  // Anchor capture
  // ---------------------------------------------------------------------
  function cleanElementHtml(element) {
    var clone = element.cloneNode(true);
    var junk = clone.querySelectorAll('mark.swab-hl, .swab-pin, [class*="swab-"], [id^="swab-"]');
    junk.forEach ? junk.forEach(unwrapOrRemove) : Array.prototype.forEach.call(junk, unwrapOrRemove);
    // Also strip swab attributes from the clone root itself, if any leaked.
    if (clone.classList) {
      Array.prototype.slice.call(clone.classList).forEach(function (c) {
        if (c.indexOf('swab-') === 0) clone.classList.remove(c);
      });
    }
    return clamp(clone.outerHTML, 400);
  }

  function unwrapOrRemove(node) {
    if (node.tagName === 'MARK' && node.classList.contains('swab-hl')) {
      var parent = node.parentNode;
      if (!parent) return;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
    } else if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
  }

  function captureAnchor(element, selectedText) {
    var rect = element.getBoundingClientRect();
    var cs = window.getComputedStyle(element);
    var anchor = {
      selector: buildSelector(element),
      boundingBox: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      elementHtml: cleanElementHtml(element),
      text: clamp((element.textContent || '').trim(), 120),
      computedStyles: {
        display: cs.display,
        padding: cs.padding,
        margin: cs.margin,
        color: cs.color,
        'background-color': cs.backgroundColor,
        'font-size': cs.fontSize
      }
    };
    if (typeof selectedText === 'string') {
      anchor.selectedText = clamp(selectedText, 400);
    }
    return anchor;
  }

  // ---------------------------------------------------------------------
  // Annotation store
  // ---------------------------------------------------------------------
  function addAnnotation(partial) {
    var ann = {
      id: uid(),
      n: state.nextN++,
      comment: partial.comment,
      status: 'saved',
      type: partial.type,
      author: state.name,
      replies: [],
      anchor: partial.anchor
    };
    ann._markEl = partial.markEl || null; // internal ref, not part of exported shape
    ann._pinEl = partial.pinEl || null;
    state.annotations.push(ann);
    renderRail();
    updateCounts();
    return ann;
  }

  function deleteAnnotation(id) {
    var idx = state.annotations.findIndex(function (a) { return a.id === id; });
    if (idx === -1) return;
    var ann = state.annotations[idx];
    if (ann._markEl && ann._markEl.parentNode) {
      var p = ann._markEl.parentNode;
      while (ann._markEl.firstChild) p.insertBefore(ann._markEl.firstChild, ann._markEl);
      p.removeChild(ann._markEl);
      p.normalize();
    }
    if (ann._pinEl && ann._pinEl.parentNode) {
      ann._pinEl.parentNode.removeChild(ann._pinEl);
    }
    state.annotations.splice(idx, 1);
    if (state.expandedId === id) state.expandedId = null;
    renderRail();
    updateCounts();
  }

  function getAnnotation(id) {
    return state.annotations.filter(function (a) { return a.id === id; })[0];
  }

  // ---------------------------------------------------------------------
  // Identity pill
  // ---------------------------------------------------------------------
  function loadName() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch (e) { return ''; }
  }

  function saveName(name) {
    try { localStorage.setItem(STORAGE_KEY, name); } catch (e) {}
  }

  function renderPill(editing) {
    pill.innerHTML = '';
    if (!state.name && !editing) editing = true;

    if (editing) {
      var input = el('input', {
        class: 'swab-pill-input',
        type: 'text',
        placeholder: 'Your name',
        value: state.name || ''
      });
      var saveBtn = el('button', { class: 'swab-pill-save', text: 'Save', type: 'button' });

      function commit() {
        var v = input.value.trim();
        if (!v) { shakePill(); return; }
        state.name = v;
        saveName(v);
        renderPill(false);
      }
      function cancel() {
        renderPill(false);
      }

      saveBtn.addEventListener('click', commit);
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });

      pill.appendChild(el('span', { class: 'swab-pill-icon', text: '🖊' }));
      pill.appendChild(input);
      pill.appendChild(saveBtn);
      pill.classList.add('swab-pill-editing');
      setTimeout(function () { input.focus(); if (state.name) input.select(); }, 0);
    } else {
      pill.classList.remove('swab-pill-editing');
      var label = el('span', { class: 'swab-pill-label' }, [
        'Commenting as ',
        el('b', { text: state.name }),
        ' '
      ]);
      var pencil = el('span', { class: 'swab-pill-pencil', text: '✎' });
      pill.appendChild(label);
      pill.appendChild(pencil);
      pill.addEventListener('click', onPillClick);
    }
  }

  function onPillClick(e) {
    e.stopPropagation();
    pill.removeEventListener('click', onPillClick);
    renderPill(true);
  }

  function focusNameEntry() {
    renderPill(true);
  }

  function shakePill() {
    pill.classList.remove('swab-shake');
    // force reflow to restart animation
    void pill.offsetWidth;
    pill.classList.add('swab-shake');
    var input = pill.querySelector('.swab-pill-input');
    if (input) input.focus();
  }

  function requireName() {
    if (state.name && state.name.trim()) return true;
    focusNameEntry();
    setTimeout(shakePill, 0);
    return false;
  }

  // ---------------------------------------------------------------------
  // Bottom bar
  // ---------------------------------------------------------------------
  function renderBar() {
    bar.innerHTML = '';

    var toolWrap = el('div', { class: 'swab-tools' });
    var selectBtn = el('button', {
      class: 'swab-tool-btn' + (state.tool === 'select' ? ' swab-active' : ''),
      type: 'button',
      title: 'Select tool'
    }, ['✒️ Select']);
    var pinBtn = el('button', {
      class: 'swab-tool-btn' + (state.tool === 'pin' ? ' swab-active' : ''),
      type: 'button',
      title: 'Pin tool'
    }, ['📌 Pin']);

    selectBtn.addEventListener('click', function () { setTool('select'); });
    pinBtn.addEventListener('click', function () { setTool('pin'); });

    toolWrap.appendChild(selectBtn);
    toolWrap.appendChild(pinBtn);

    var sep1 = el('div', { class: 'swab-bar-sep' });

    var commentsBtn = el('button', {
      class: 'swab-comments-btn' + (state.railOpen ? ' swab-active' : ''),
      type: 'button',
      title: 'Toggle comments'
    }, ['💬 ', el('span', { class: 'swab-count', id: 'swab-bar-count', text: String(state.annotations.length) })]);
    commentsBtn.addEventListener('click', function () { toggleRail(); });

    var sep2 = el('div', { class: 'swab-bar-sep' });

    var shareWrap = el('div', { class: 'swab-share-wrap' });
    var shareBtn = el('button', { class: 'swab-share-btn', type: 'button' }, ['Share']);
    shareBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleShareMenu(shareWrap);
    });
    shareWrap.appendChild(shareBtn);

    bar.appendChild(toolWrap);
    bar.appendChild(sep1);
    bar.appendChild(commentsBtn);
    bar.appendChild(sep2);
    bar.appendChild(shareWrap);
  }

  function setTool(tool) {
    state.tool = tool;
    renderBar();
  }

  function updateCounts() {
    var n = state.annotations.length;
    var barCount = document.getElementById('swab-bar-count');
    if (barCount) barCount.textContent = String(n);
    var railCount = document.getElementById('swab-rail-count');
    if (railCount) railCount.textContent = String(n);
  }

  // ---------------------------------------------------------------------
  // Share menu
  // ---------------------------------------------------------------------
  function toggleShareMenu(shareWrap) {
    var existing = shareWrap.querySelector('.swab-share-menu');
    if (existing) { existing.remove(); return; }
    closeAllShareMenus();

    var menu = el('div', { class: 'swab-share-menu' });
    var opt1 = el('button', { class: 'swab-share-opt', type: 'button' }, ['📋 Copy Markdown']);
    var opt2 = el('button', { class: 'swab-share-opt', type: 'button' }, ['⬇ Download JSON']);
    var opt3 = el('button', { class: 'swab-share-opt', type: 'button' }, ['🔗 Copy link']);

    opt1.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(buildMarkdown());
      showToast('Markdown copied to clipboard');
      menu.remove();
    });
    opt2.addEventListener('click', function (e) {
      e.stopPropagation();
      downloadJson();
      menu.remove();
    });
    opt3.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(location.href);
      showToast('Link copied — comments travel via the Markdown/JSON export, not the link');
      menu.remove();
    });

    menu.appendChild(opt1);
    menu.appendChild(opt2);
    menu.appendChild(opt3);
    shareWrap.appendChild(menu);
  }

  function closeAllShareMenus() {
    var menus = root.querySelectorAll('.swab-share-menu');
    menus.forEach ? menus.forEach(function (m) { m.remove(); }) : Array.prototype.forEach.call(menus, function (m) { m.remove(); });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  function truncateForMd(s, n) {
    if (s == null) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function buildMarkdown() {
    var url = location.href;
    var n = state.annotations.length;
    var lines = [];
    lines.push('# ShareWithAgent feedback — ' + url + ' (' + n + ' items)');
    lines.push('');
    lines.push('_Each item: **author:** "comment" → the page element it refers to (CSS selector into the page DOM)._');
    lines.push('');
    state.annotations.forEach(function (a, i) {
      lines.push((i + 1) + '. **' + a.author + ':** "' + a.comment + '"');
      if (a.type === 'text') {
        lines.push('   → selected "' + truncateForMd(a.anchor.selectedText, 80) + '" in `' + a.anchor.selector + '`');
      } else {
        lines.push('   → `' + a.anchor.selector + '` — "' + a.anchor.text + '"');
      }
      (a.replies || []).forEach(function (r) {
        lines.push('   ↳ **' + r.author + ':** ' + r.text);
      });
    });
    lines.push('');
    lines.push('_Full anchors (bounding box, computed styles, element HTML) are in the JSON export._');
    return lines.join('\n');
  }

  function downloadJson() {
    var payload = {
      tool: 'ShareWithAgent',
      url: location.href,
      viewport: 'live',
      annotations: state.annotations.map(exportAnnotation)
    };
    var json = JSON.stringify(payload, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'sharewithagent-feedback.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportAnnotation(a) {
    return {
      id: a.id,
      n: a.n,
      comment: a.comment,
      status: a.status,
      type: a.type,
      author: a.author,
      replies: a.replies,
      anchor: a.anchor
    };
  }

  // ---------------------------------------------------------------------
  // Composer popover (shared by Select + Pin tools)
  // ---------------------------------------------------------------------
  function closeComposer(opts) {
    opts = opts || {};
    if (!composer) return;
    if (opts.cancelled && pendingMark) {
      unwrapOrRemove(pendingMark);
      pendingMark.parentNode && pendingMark.parentNode.normalize && pendingMark.parentNode.normalize();
    }
    if (opts.cancelled && pendingPinEl) {
      pendingPinEl.parentNode && pendingPinEl.parentNode.removeChild(pendingPinEl);
    }
    composer.remove();
    composer = null;
    pendingSelectionRange = null;
    pendingMark = null;
    pendingPinEl = null;
    pendingTargetEl = null;
  }

  var pendingPinEl = null;
  var pendingTargetEl = null;
  var pendingType = null;
  var pendingSelectedText = null;

  function openComposer(anchorRect, opts) {
    closeComposer({ cancelled: false });
    pendingType = opts.type;
    pendingTargetEl = opts.targetEl;
    pendingSelectedText = opts.selectedText;
    pendingMark = opts.markEl || null;
    pendingPinEl = opts.pinEl || null;

    composer = el('div', { class: 'swab-composer' });
    var closeBtn = el('button', { class: 'swab-composer-close', type: 'button', title: 'Close (Esc)' }, ['✕']);
    var textarea = el('textarea', { class: 'swab-composer-textarea', placeholder: 'Leave a comment…' });
    var footer = el('div', { class: 'swab-composer-footer' });
    var saveBtn = el('button', { class: 'swab-composer-save', type: 'button' }, ['Comment ⌘↵']);

    footer.appendChild(saveBtn);
    composer.appendChild(closeBtn);
    composer.appendChild(textarea);
    composer.appendChild(footer);
    root.appendChild(composer);

    positionComposer(composer, anchorRect);

    closeBtn.addEventListener('click', function () { closeComposer({ cancelled: true }); });
    saveBtn.addEventListener('click', function () { commitComposer(textarea.value); });
    textarea.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        commitComposer(textarea.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeComposer({ cancelled: true });
      }
    });

    setTimeout(function () { textarea.focus(); }, 0);
  }

  function positionComposer(node, rect) {
    var margin = 10;
    var width = 320;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    var top = rect.bottom + margin;
    // If it would overflow bottom, place above.
    var estHeight = 150;
    if (top + estHeight > vh - margin) {
      top = Math.max(margin, rect.top - estHeight - margin);
    }
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    node.style.width = width + 'px';
  }

  function commitComposer(text) {
    text = (text || '').trim();
    if (!text) { closeComposer({ cancelled: true }); return; }
    if (!requireName()) { return; } // keep composer open; guard rail

    var anchor = captureAnchor(pendingTargetEl, pendingType === 'text' ? pendingSelectedText : undefined);
    var ann = addAnnotation({
      type: pendingType,
      comment: text,
      anchor: anchor,
      markEl: pendingMark,
      pinEl: pendingPinEl
    });

    if (pendingMark) {
      pendingMark.dataset.swabId = ann.id;
      pendingMark.addEventListener('click', function (e) {
        e.stopPropagation();
        focusAnnotation(ann.id);
      });
    }
    if (pendingPinEl) {
      pendingPinEl.dataset.swabId = ann.id;
      pendingPinEl.textContent = String(ann.n);
      pendingPinEl.addEventListener('click', function (e) {
        e.stopPropagation();
        focusAnnotation(ann.id);
      });
    }

    // Detach refs so closeComposer's cancel-path doesn't remove them.
    pendingMark = null;
    pendingPinEl = null;
    composer.remove();
    composer = null;
    pendingSelectionRange = null;
    pendingTargetEl = null;

    if (!state.railOpen) toggleRail();
    state.expandedId = ann.id;
    renderRail();
  }

  // ---------------------------------------------------------------------
  // Select tool
  // ---------------------------------------------------------------------
  function handleMouseUp(e) {
    if (isInsideSwabUI(e.target)) return;
    if (state.tool !== 'select') return;
    if (composer) return; // one composer at a time

    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      var text = sel.toString();
      if (!text || !text.trim()) return;

      var range = sel.getRangeAt(0);
      if (isInsideSwabUI(range.commonAncestorContainer)) return;

      var targetEl = range.commonAncestorContainer;
      if (targetEl.nodeType === 3) targetEl = targetEl.parentElement;
      if (!targetEl) return;

      var mark;
      try {
        mark = document.createElement('mark');
        mark.className = 'swab-hl';
        range.surroundContents(mark);
      } catch (err) {
        // Range spans multiple elements; surroundContents fails. Fallback:
        // extract + wrap contents (works for most simple multi-node selections).
        try {
          mark = document.createElement('mark');
          mark.className = 'swab-hl';
          mark.appendChild(range.extractContents());
          range.insertNode(mark);
        } catch (err2) {
          return; // give up gracefully
        }
      }

      sel.removeAllRanges();
      var rect = mark.getBoundingClientRect();

      openComposer(rect, {
        type: 'text',
        targetEl: targetEl.nodeType === 1 ? targetEl : mark,
        selectedText: text,
        markEl: mark
      });
    }, 0);
  }

  // ---------------------------------------------------------------------
  // Pin tool
  // ---------------------------------------------------------------------
  function handleClick(e) {
    if (isInsideSwabUI(e.target)) return;
    // Clicking an existing mark or pin is cross-linking, not a new annotation —
    // let it bubble to the mark/pin's own click listener (focusAnnotation) even
    // when the Pin tool is active.
    if (e.target.closest && e.target.closest('mark.swab-hl, .swab-pin')) return;
    if (state.tool !== 'pin') return;
    if (composer) return;

    e.preventDefault();
    e.stopPropagation();

    var targetEl = e.target;
    var x = e.clientX;
    var y = e.clientY;

    var pinEl = el('div', { class: 'swab-pin' });
    pinEl.style.left = (x + window.scrollX) + 'px';
    pinEl.style.top = (y + window.scrollY) + 'px';
    pinEl.textContent = '•';
    root.appendChild(pinEl);

    var rect = { left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
    openComposer(rect, {
      type: 'pin',
      targetEl: targetEl,
      pinEl: pinEl
    });
  }

  // ---------------------------------------------------------------------
  // Rail
  // ---------------------------------------------------------------------
  function toggleRail() {
    state.railOpen = !state.railOpen;
    rail.classList.toggle('swab-rail-open', state.railOpen);
    renderBar();
  }

  function openRail() {
    if (!state.railOpen) toggleRail();
  }

  function renderRail() {
    rail.innerHTML = '';
    var header = el('div', { class: 'swab-rail-header' }, [
      el('span', { text: 'Comments' }),
      el('span', { class: 'swab-count', id: 'swab-rail-count', text: String(state.annotations.length) }),
      el('button', { class: 'swab-rail-close', type: 'button', title: 'Close' }, ['✕'])
    ]);
    header.querySelector('.swab-rail-close').addEventListener('click', function () { toggleRail(); });
    rail.appendChild(header);

    var list = el('div', { class: 'swab-rail-list' });
    if (state.annotations.length === 0) {
      list.appendChild(el('div', { class: 'swab-rail-empty', text: 'No comments yet. Pick a tool and click or select text on the page.' }));
    } else {
      state.annotations.forEach(function (a) {
        list.appendChild(renderCard(a));
      });
    }
    rail.appendChild(list);
  }

  function renderCard(a) {
    var expanded = state.expandedId === a.id;
    var card = el('div', {
      class: 'swab-card' + (expanded ? ' swab-card-expanded' : ''),
      'data-swab-id': a.id
    });

    var replyCount = (a.replies || []).length;
    var summary = el('div', { class: 'swab-card-summary' }, [
      el('span', { class: 'swab-card-n', text: '①'.charCodeAt ? numCircle(a.n) : String(a.n) }),
      el('span', { class: 'swab-card-author', text: a.author + ' · ' }),
      el('span', { class: 'swab-card-comment', text: '"' + clamp(a.comment, 60) + '"' }),
      replyCount ? el('span', { class: 'swab-card-replies', text: ' · ' + replyCount + '↵' }) : null
    ]);
    summary.addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.expandedId === a.id) {
        state.expandedId = null;
      } else {
        state.expandedId = a.id;
        scrollToAnnotation(a.id);
      }
      renderRail();
    });
    card.appendChild(summary);

    if (expanded) {
      card.appendChild(renderCardBody(a));
    }
    return card;
  }

  function numCircle(n) {
    var circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    if (n >= 1 && n <= 10) return circled[n - 1];
    return '(' + n + ')';
  }

  function renderCardBody(a) {
    var body = el('div', { class: 'swab-card-body' });

    var anchorInfo = el('div', { class: 'swab-card-anchor' });
    if (a.type === 'text') {
      anchorInfo.appendChild(el('div', { class: 'swab-card-quote', text: '“' + a.anchor.selectedText + '”' }));
    }
    anchorInfo.appendChild(el('code', { class: 'swab-card-selector', text: a.anchor.selector }));
    body.appendChild(anchorInfo);

    body.appendChild(el('div', { class: 'swab-card-fulltext', text: a.comment }));

    if (a.replies && a.replies.length) {
      var repliesWrap = el('div', { class: 'swab-card-replies-list' });
      a.replies.forEach(function (r) {
        repliesWrap.appendChild(el('div', { class: 'swab-reply' }, [
          el('b', { text: r.author + ': ' }),
          r.text
        ]));
      });
      body.appendChild(repliesWrap);
    }

    var replyRow = el('div', { class: 'swab-reply-row' });
    var replyInput = el('input', { class: 'swab-reply-input', type: 'text', placeholder: 'Reply…' });
    var replyBtn = el('button', { class: 'swab-reply-btn', type: 'button' }, ['Reply']);
    function submitReply() {
      var v = replyInput.value.trim();
      if (!v) return;
      if (!requireName()) return;
      a.replies.push({ author: state.name, text: v, ts: Date.now() });
      renderRail();
    }
    replyBtn.addEventListener('click', function (e) { e.stopPropagation(); submitReply(); });
    replyInput.addEventListener('click', function (e) { e.stopPropagation(); });
    replyInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); submitReply(); }
    });
    replyRow.appendChild(replyInput);
    replyRow.appendChild(replyBtn);
    body.appendChild(replyRow);

    var actions = el('div', { class: 'swab-card-actions' });
    var dots = el('button', { class: 'swab-card-dots', type: 'button' }, ['⋯']);
    var menu = el('div', { class: 'swab-card-menu' });
    var copyOpt = el('button', { class: 'swab-card-menu-opt', type: 'button', text: 'Copy text' });
    var delOpt = el('button', { class: 'swab-card-menu-opt swab-danger', type: 'button', text: 'Delete' });
    copyOpt.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(a.comment);
      showToast('Comment text copied');
      menu.classList.remove('swab-menu-open');
    });
    delOpt.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteAnnotation(a.id);
    });
    menu.appendChild(copyOpt);
    menu.appendChild(delOpt);

    dots.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasOpen = menu.classList.contains('swab-menu-open');
      closeAllCardMenus();
      if (!wasOpen) menu.classList.add('swab-menu-open');
    });

    actions.appendChild(dots);
    actions.appendChild(menu);
    body.appendChild(actions);

    return body;
  }

  function closeAllCardMenus() {
    var menus = rail.querySelectorAll('.swab-card-menu');
    Array.prototype.forEach.call(menus, function (m) { m.classList.remove('swab-menu-open'); });
  }

  // ---------------------------------------------------------------------
  // Cross-linking
  // ---------------------------------------------------------------------
  function focusAnnotation(id) {
    openRail();
    state.expandedId = id;
    renderRail();
    var card = rail.querySelector('[data-swab-id="' + id + '"]');
    if (card) card.scrollIntoView({ block: 'nearest' });
  }

  function scrollToAnnotation(id) {
    var a = getAnnotation(id);
    if (!a) return;
    var node = a._markEl || a._pinEl;
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('swab-flash');
    setTimeout(function () { node.classList.remove('swab-flash'); }, 1200);
  }

  // ---------------------------------------------------------------------
  // Global listeners
  // ---------------------------------------------------------------------
  function handleGlobalKeydown(e) {
    if (e.key === 'Escape') {
      if (composer) {
        closeComposer({ cancelled: true });
      }
    }
  }

  function handleGlobalClick(e) {
    if (!isInsideSwabUI(e.target)) {
      closeAllShareMenus();
    } else {
      if (!e.target.closest('.swab-share-wrap')) closeAllShareMenus();
      if (!e.target.closest('.swab-card-actions')) closeAllCardMenus();
    }
  }

  // ---------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------
  function injectStyles() {
    var css = ''
      + '#swab-root, #swab-root * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }'
      + '#swab-root { position: fixed; inset: 0; width: 0; height: 0; z-index: 2147483000; pointer-events: none; }'
      + '#swab-root .swab-interactive { pointer-events: auto; }'
      + '.swab-bar { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; background: #1c1c1e; color: #fff; padding: 8px; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: auto; z-index: 2147483005; }'
      + '.swab-tools { display: flex; gap: 4px; }'
      + '.swab-tool-btn, .swab-comments-btn, .swab-share-btn { background: transparent; border: none; color: #e8e8ea; font-size: 13px; padding: 8px 12px; border-radius: 9px; cursor: pointer; display: flex; align-items: center; gap: 6px; white-space: nowrap; }'
      + '.swab-tool-btn:hover, .swab-comments-btn:hover, .swab-share-btn:hover { background: rgba(255,255,255,.1); }'
      + '.swab-tool-btn.swab-active, .swab-comments-btn.swab-active { background: #ffffff; color: #1c1c1e; }'
      + '.swab-share-btn { background: #4f7cff; color: #fff; font-weight: 600; }'
      + '.swab-share-btn:hover { background: #3f68e0; }'
      + '.swab-bar-sep { width: 1px; height: 20px; background: rgba(255,255,255,.15); }'
      + '.swab-count { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; font-size: 11px; border-radius: 8px; background: rgba(255,255,255,.18); }'
      + '.swab-tool-btn.swab-active .swab-count, .swab-comments-btn.swab-active .swab-count { background: rgba(0,0,0,.12); }'
      + '.swab-share-wrap { position: relative; }'
      + '.swab-share-menu { position: absolute; bottom: calc(100% + 8px); right: 0; background: #fff; color: #1c1c1e; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.25); overflow: hidden; min-width: 190px; }'
      + '.swab-share-opt { display: block; width: 100%; text-align: left; background: none; border: none; padding: 10px 14px; font-size: 13px; cursor: pointer; color: #1c1c1e; }'
      + '.swab-share-opt:hover { background: #f2f2f5; }'
      + '.swab-pill { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #1c1c1e; color: #fff; padding: 8px 14px; border-radius: 999px; font-size: 13px; display: flex; align-items: center; gap: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.3); pointer-events: auto; z-index: 2147483005; cursor: pointer; }'
      + '.swab-pill.swab-pill-editing { cursor: default; padding: 6px 8px 6px 12px; }'
      + '.swab-pill-icon { font-size: 13px; }'
      + '.swab-pill-input { background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.25); color: #fff; border-radius: 999px; padding: 5px 10px; font-size: 13px; width: 130px; outline: none; }'
      + '.swab-pill-input::placeholder { color: rgba(255,255,255,.55); }'
      + '.swab-pill-save { background: #4f7cff; color: #fff; border: none; border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }'
      + '.swab-pill-save:hover { background: #3f68e0; }'
      + '.swab-pill-pencil { opacity: .75; }'
      + '.swab-pill.swab-shake { animation: swab-shake .4s; }'
      + '@keyframes swab-shake { 10%,90%{transform:translateX(-51%);} 20%,80%{transform:translateX(-48%);} 30%,50%,70%{transform:translateX(-54%);} 40%,60%{transform:translateX(-46%);} }'
      + '.swab-composer { position: fixed; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.3); padding: 10px; pointer-events: auto; z-index: 2147483010; }'
      + '.swab-composer-close { position: absolute; top: 6px; right: 6px; background: none; border: none; cursor: pointer; font-size: 12px; color: #888; width: 22px; height: 22px; border-radius: 6px; }'
      + '.swab-composer-close:hover { background: #f2f2f5; }'
      + '.swab-composer-textarea { width: 100%; min-height: 64px; border: 1px solid #e2e2e6; border-radius: 8px; padding: 8px; font-size: 13px; resize: vertical; outline: none; margin-top: 14px; font-family: inherit; }'
      + '.swab-composer-textarea:focus { border-color: #4f7cff; }'
      + '.swab-composer-footer { display: flex; justify-content: flex-end; margin-top: 8px; }'
      + '.swab-composer-save { background: #4f7cff; color: #fff; border: none; border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }'
      + '.swab-composer-save:hover { background: #3f68e0; }'
      + '.swab-rail { position: fixed; top: 0; right: -360px; width: 340px; height: 100%; background: #fff; box-shadow: -8px 0 30px rgba(0,0,0,.15); transition: right .22s ease; pointer-events: auto; z-index: 2147483004; display: flex; flex-direction: column; }'
      + '.swab-rail.swab-rail-open { right: 0; }'
      + '.swab-rail-header { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid #eee; font-weight: 600; font-size: 14px; }'
      + '.swab-rail-header .swab-count { background: #eef1ff; color: #4f7cff; }'
      + '.swab-rail-close { margin-left: auto; background: none; border: none; cursor: pointer; font-size: 13px; color: #888; width: 24px; height: 24px; border-radius: 6px; }'
      + '.swab-rail-close:hover { background: #f2f2f5; }'
      + '.swab-rail-list { overflow-y: auto; flex: 1; padding: 8px; }'
      + '.swab-rail-empty { padding: 24px 12px; text-align: center; color: #999; font-size: 13px; }'
      + '.swab-card { border: 1px solid #ececef; border-radius: 10px; margin-bottom: 8px; overflow: hidden; }'
      + '.swab-card-summary { display: flex; align-items: baseline; gap: 4px; padding: 10px 12px; cursor: pointer; font-size: 13px; flex-wrap: wrap; }'
      + '.swab-card-summary:hover { background: #f8f8fa; }'
      + '.swab-card-n { font-weight: 700; margin-right: 2px; }'
      + '.swab-card-author { font-weight: 600; color: #333; }'
      + '.swab-card-comment { color: #555; overflow: hidden; text-overflow: ellipsis; }'
      + '.swab-card-replies { color: #999; font-size: 12px; }'
      + '.swab-card-expanded { border-color: #4f7cff; }'
      + '.swab-card-body { padding: 0 12px 12px; font-size: 13px; }'
      + '.swab-card-anchor { margin-bottom: 8px; }'
      + '.swab-card-quote { font-style: italic; color: #666; margin-bottom: 4px; }'
      + '.swab-card-selector { display: block; background: #f5f5f7; padding: 4px 6px; border-radius: 6px; font-size: 11px; color: #4f7cff; overflow-x: auto; white-space: nowrap; }'
      + '.swab-card-fulltext { white-space: pre-wrap; color: #222; margin-bottom: 8px; }'
      + '.swab-card-replies-list { border-top: 1px dashed #eee; padding-top: 6px; margin-bottom: 8px; }'
      + '.swab-reply { font-size: 12px; color: #444; margin-bottom: 4px; }'
      + '.swab-reply-row { display: flex; gap: 6px; margin-bottom: 8px; }'
      + '.swab-reply-input { flex: 1; border: 1px solid #e2e2e6; border-radius: 6px; padding: 6px 8px; font-size: 12px; outline: none; }'
      + '.swab-reply-input:focus { border-color: #4f7cff; }'
      + '.swab-reply-btn { background: #f2f2f5; border: none; border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; }'
      + '.swab-reply-btn:hover { background: #e6e6ea; }'
      + '.swab-card-actions { position: relative; display: flex; justify-content: flex-end; }'
      + '.swab-card-dots { background: none; border: none; cursor: pointer; font-size: 14px; color: #888; padding: 4px 8px; border-radius: 6px; }'
      + '.swab-card-dots:hover { background: #f2f2f5; }'
      + '.swab-card-menu { display: none; position: absolute; bottom: calc(100% + 4px); right: 0; background: #fff; border: 1px solid #ececef; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); overflow: hidden; min-width: 120px; }'
      + '.swab-card-menu.swab-menu-open { display: block; }'
      + '.swab-card-menu-opt { display: block; width: 100%; text-align: left; background: none; border: none; padding: 8px 12px; font-size: 12px; cursor: pointer; color: #222; }'
      + '.swab-card-menu-opt:hover { background: #f8f8fa; }'
      + '.swab-card-menu-opt.swab-danger { color: #d33; }'
      + 'mark.swab-hl { background: #ffe9a8; color: inherit; border-radius: 2px; cursor: pointer; padding: 0 1px; }'
      + 'mark.swab-hl.swab-flash { animation: swab-flash-anim 1.2s ease; }'
      + '.swab-pin { position: absolute; width: 22px; height: 22px; margin-left: -11px; margin-top: -11px; background: #ff4d4f; color: #fff; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.35); z-index: 2147483003; pointer-events: auto; }'
      + '.swab-pin span, .swab-pin { transform: rotate(-45deg); }'
      + '.swab-pin.swab-flash { animation: swab-flash-anim 1.2s ease; }'
      + '@keyframes swab-flash-anim { 0%,100% { box-shadow: 0 0 0 0 rgba(79,124,255,0); } 20%,60% { box-shadow: 0 0 0 6px rgba(79,124,255,.45); } }'
      + '.swab-toast { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%) translateY(8px); background: #1c1c1e; color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 12px; opacity: 0; pointer-events: none; transition: opacity .18s ease, transform .18s ease; z-index: 2147483010; max-width: 320px; text-align: center; }'
      + '.swab-toast.swab-toast-show { opacity: 1; transform: translateX(-50%) translateY(0); }';

    var styleEl = document.createElement('style');
    styleEl.id = 'swab-styles';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    injectStyles();

    root = el('div', { id: 'swab-root' });
    document.body.appendChild(root);

    bar = el('div', { class: 'swab-bar swab-interactive', id: 'swab-bar' });
    pill = el('div', { class: 'swab-pill swab-interactive', id: 'swab-pill' });
    rail = el('div', { class: 'swab-rail swab-interactive', id: 'swab-rail' });
    toast = el('div', { class: 'swab-toast', id: 'swab-toast' });

    root.appendChild(bar);
    root.appendChild(pill);
    root.appendChild(rail);
    root.appendChild(toast);

    state.name = loadName();
    renderPill(false);
    renderBar();
    renderRail();

    document.addEventListener('mouseup', handleMouseUp, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('click', handleGlobalClick, true);
    document.addEventListener('keydown', handleGlobalKeydown, true);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  // ---------------------------------------------------------------------
  // Testability hook
  // ---------------------------------------------------------------------
  window.__swab = {
    get annotations() {
      return state.annotations.map(exportAnnotation);
    },
    toMarkdown: function () {
      return buildMarkdown();
    }
  };
})();
