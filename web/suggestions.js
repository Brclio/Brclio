/* Brclio shared suggestions · © 2026 Brclio · CC BY-NC-SA 4.0 */
(() => {
  'use strict';
  const root = document.getElementById('view-suggestions');
  if (!root || window.AndroidBridge?.postMessage) return;

  const base = '/api/account/suggestions';
  const request = (path, method = 'GET', body) =>
    window.BrclioHost.accountRequest({ path, method, ...(body === undefined ? {} : { body }) });
  // The desktop account bridge shares eight request slots with login, votes and comments.
  // Keep discussion reads bounded even when every card on a page is expanded.
  let availableDetailReads = 3;
  const waitingDetailReads = [];
  async function scheduleDetailRead(read) {
    if (availableDetailReads) availableDetailReads--;
    else await new Promise(resolve => waitingDetailReads.push(resolve));
    try { return await read(); }
    finally {
      const next = waitingDetailReads.shift();
      if (next) next();
      else availableDetailReads++;
    }
  }
  const pagePath = (path, cursor) => cursor ? path + '?cursor=' + encodeURIComponent(cursor) : path;
  const formatTime = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  function dateText(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : formatTime.format(date);
  }
  function notice(node, message = '', error = false) {
    node.textContent = message;
    node.hidden = !message;
    node.classList.toggle('sg-error', error);
  }
  function errorText(error) {
    return String(error?.message || '请求失败，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  // The shell and all account requests are lazy. Visiting the other tools does not load the square.
  let active = false, sessionVersion = 0, summaryVersion = 0, owner, refreshBoard;
  let workspace, loginPanel, sessionStatus, sessionRetry;
  function prepare() {
    if (workspace) return;
    root.innerHTML = `
      <div class="page-heading">
        <span class="tool-icon" aria-hidden="true"><svg class="icon"><use href="#i-discussion"/></svg></span>
        <div><h1 id="suggestions-heading">功能建议广场</h1><p>在这里提出新功能，看看其他用户的评分和讨论。</p></div>
      </div>
      <p class="sg-status" role="status" data-session-status></p>
      <button type="button" class="button button-outline" data-session-retry hidden>重试连接</button>
      <div class="sg-welcome" data-login-panel hidden>
        <div><h2>登录后加入广场</h2><p>所有登录用户都可以查看建议、给建议打分和留言。</p></div>
        <button type="button" class="button button-primary">登录账号</button>
      </div>
      <div data-workspace hidden></div>`;
    workspace = root.querySelector('[data-workspace]');
    loginPanel = root.querySelector('[data-login-panel]');
    sessionStatus = root.querySelector('[data-session-status]');
    sessionRetry = root.querySelector('[data-session-retry]');
    loginPanel.querySelector('button').onclick = () => document.getElementById('account-button')?.click();
    sessionRetry.onclick = checkSession;
  }
  function setOwner(id, refresh = false) {
    if (owner !== id) {
      owner = id;
      workspace.replaceChildren();
      refreshBoard = id ? mountBoard(id) : null;
    } else if (refresh && id) void refreshBoard();
    notice(sessionStatus);
    sessionRetry.hidden = true;
    loginPanel.hidden = Boolean(id);
    workspace.hidden = !id;
  }
  async function checkSession() {
    const version = ++sessionVersion;
    workspace.hidden = loginPanel.hidden = sessionRetry.hidden = true;
    notice(sessionStatus, '正在读取账号…');
    try {
      const session = await request('/api/account/session');
      if (version === sessionVersion) setOwner(session.user?.id || null, true);
    } catch (error) {
      if (version !== sessionVersion) return;
      notice(sessionStatus, errorText(error), true);
      sessionRetry.hidden = false;
    }
  }
  window.addEventListener('brclio:view', event => {
    active = event.detail?.name === 'suggestions';
    if (active) { prepare(); void checkSession(); }
    else sessionVersion++;
  });
  window.addEventListener('brclio:account-state', event => {
    const id = event.detail?.userId || null;
    if (!workspace || id === owner) return;
    sessionVersion++;
    if (active) setOwner(id);
    else { owner = undefined; refreshBoard = null; workspace.replaceChildren(); }
  });

  function mountBoard(userId) {
    const board = document.createElement('div');
    board.innerHTML = `
      <div class="sg-toolbar">
        <h2>全部建议</h2><span class="sg-order">最新发布</span>
        <button class="text-button" data-refresh type="button">刷新</button>
        <button class="button button-primary" data-compose type="button" aria-expanded="false" aria-controls="suggestions-form">写建议</button>
      </div>
      <form class="sg-form sg-composer" id="suggestions-form" hidden>
        <h2>写建议</h2>
        <div class="sg-fields">
          <label>建议名称<input name="title" maxlength="100" required placeholder="用一句话概括你想要的功能"></label>
          <label>类别（选填）<input name="category" maxlength="40" placeholder="如：复制路径、界面体验"></label>
        </div>
        <label>描述<textarea name="description" rows="4" maxlength="3000" required placeholder="你在什么场景下需要它？希望怎样使用？"></textarea></label>
        <div class="sg-actions"><button type="submit" class="button button-primary">发布建议</button>
          <button type="button" class="text-button" data-cancel>收起</button></div>
        <p class="sg-status" role="status" hidden></p>
      </form>
      <p class="sg-status" role="status" data-published hidden></p>
      <div class="sg-list" aria-label="功能建议"></div>
      <p class="sg-status" role="status" data-list-status hidden></p>
      <button class="button button-outline sg-more" type="button" data-more hidden>加载更多建议</button>`;
    workspace.append(board);
    const find = selector => board.querySelector(selector);
    const form = find('form'), compose = find('[data-compose]'), refresh = find('[data-refresh]');
    const list = find('.sg-list'), more = find('[data-more]'), listStatus = find('[data-list-status]');
    const cards = new Map();
    let cursor = null, listing = false, posting = false, postId;
    function controls() {
      refresh.disabled = more.disabled = listing || posting;
      form.querySelector('button[type=submit]').disabled = listing || posting;
      compose.disabled = posting;
      for (const field of form.querySelectorAll('input,textarea,[data-cancel]')) field.disabled = posting;
    }
    function toggleForm(open) {
      form.hidden = !open;
      compose.setAttribute('aria-expanded', String(open));
      if (open) { form.elements.title.focus(); notice(find('[data-published]')); }
      else compose.focus();
    }
    compose.onclick = () => toggleForm(form.hidden);
    find('[data-cancel]').onclick = () => toggleForm(false);
    form.oninput = () => { postId = undefined; notice(form.querySelector('[role=status]')); };

    function cardFor(item, version = summaryVersion) {
      let card = cards.get(item.id);
      if (!card) {
        card = makeCard(item, userId);
        cards.set(item.id, card);
      } else card.updateFromList(item, version);
      return card;
    }
    async function loadList(append = false) {
      if (listing || posting) return;
      listing = true; controls();
      const version = summaryVersion;
      notice(listStatus, '正在加载建议…');
      try {
        const result = await request(pagePath(base, append && cursor));
        if (!board.isConnected) return;
        if (!append) {
          const ids = new Set(result.items.map(item => item.id));
          for (const [id, card] of cards) if (!ids.has(id) && !card.hasDraft()) cards.delete(id);
        }
        const pageCards = result.items.map(item => cardFor(item, version));
        if (append) {
          for (const card of pageCards) {
            if (!list.contains(card.node)) { list.append(card.node); card.refreshDiscussion(); }
          }
        } else {
          list.replaceChildren(...pageCards.map(card => card.node));
          for (const card of pageCards) card.refreshDiscussion();
        }
        cursor = result.nextCursor;
        more.hidden = !cursor;
        notice(listStatus, list.childElementCount ? '' : '还没有功能建议。点击「写建议」，发布第一个想法。');
      } catch (error) { notice(listStatus, errorText(error) + ' 可再次加载或刷新。', true); }
      finally { listing = false; controls(); }
    }
    refresh.onclick = () => loadList();
    more.onclick = () => loadList(true);
    form.onsubmit = async event => {
      event.preventDefault();
      if (posting || listing) return;
      const { title, category, description } = form.elements;
      const status = form.querySelector('[role=status]');
      if (!title.value.trim() || !description.value.trim()) {
        notice(status, '请填写建议名称和描述。', true); return;
      }
      posting = true; controls(); notice(status, '正在发布…');
      try {
        postId ||= crypto.randomUUID();
        const result = await request(base, 'POST', { expectedUserId: userId, requestId: postId,
          title: title.value.trim(), category: category.value.trim(), description: description.value.trim() });
        if (!board.isConnected) return;
        list.prepend(cardFor(result.suggestion).node);
        postId = undefined; form.reset(); form.hidden = true;
        compose.setAttribute('aria-expanded', 'false');
        notice(status); notice(listStatus); notice(find('[data-published]'), '建议已发布。');
      } catch (error) { notice(status, errorText(error), true); }
      finally { posting = false; controls(); if (board.isConnected && form.hidden) compose.focus(); }
    };
    void loadList();
    return loadList;
  }

  function makeCard(initial, userId) {
    const node = document.createElement('article');
    node.className = 'sg-card';
    node.innerHTML = `
      <header class="sg-card-head"><div><div class="sg-title"><h3></h3><span class="sg-category" hidden></span></div>
        <p class="sg-byline"></p></div>
        <div class="sg-score"><strong></strong><small></small></div></header>
      <p class="sg-description"></p>
      <button type="button" class="text-button sg-toggle" aria-expanded="false"></button>
      <section class="sg-discussion" aria-label="评分与讨论" hidden>
        <p class="sg-status" data-detail-status role="status" hidden></p>
        <button type="button" class="button button-outline" data-retry hidden>重试加载</button>
        <div data-detail hidden>
          <fieldset class="sg-rating"><legend>我的评分</legend>
            <div class="sg-rating-row"><div class="sg-stars" role="radiogroup" aria-label="我的评分"></div><span class="sg-value"></span></div>
          </fieldset>
          <p class="sg-status" data-rating-status role="status" hidden></p>
          <h4 class="sg-discussion-title">评论</h4>
          <form class="sg-form sg-comment-form">
            <label>写评论<textarea name="comment" rows="2" maxlength="1000" required placeholder="说说你的看法…"></textarea></label>
            <div><button type="submit" class="button button-outline">发表评论</button></div>
            <p class="sg-status" role="status" hidden></p>
          </form>
          <ol class="sg-comments" aria-label="评论列表"></ol>
          <p class="sg-status" data-comments-status role="status" hidden></p>
          <button class="text-button" type="button" data-more-comments hidden>加载更多评论</button>
        </div>
      </section>`;
    const find = selector => node.querySelector(selector);
    const path = base + '/' + encodeURIComponent(initial.id);
    const toggle = find('.sg-toggle'), discussion = find('.sg-discussion'), detail = find('[data-detail]');
    const retry = find('[data-retry]'), more = find('[data-more-comments]'), comments = find('.sg-comments');
    const form = find('form'), rating = find('fieldset'), stars = find('.sg-stars');
    const commentIds = new Set();
    let cursor = null, loading = false, writing = false, refreshPending = false, commentId, myRating = null, count;
    let version = 0;
    const starNodes = [];
    function paint(value) {
      starNodes.forEach((star, i) => {
        star.dataset.fill = value >= i + 1 ? 'full' : value === i + 0.5 ? 'half' : 'empty';
      });
      find('.sg-value').textContent = value ? value + ' 星' : '尚未评分';
    }
    function setRating(value) {
      myRating = value;
      for (const radio of stars.querySelectorAll('input')) radio.checked = Number(radio.value) === value;
      paint(value);
    }
    function updateSummary(item) {
      version = ++summaryVersion;
      find('h3').textContent = item.title;
      const category = find('.sg-category');
      category.textContent = item.category || ''; category.hidden = !item.category;
      find('.sg-byline').textContent = [item.author, dateText(item.createdAt)].filter(Boolean).join(' · ');
      find('.sg-description').textContent = item.description;
      find('.sg-score strong').textContent = item.ratingCount ? Number(item.averageRating.toFixed(2)) + ' / 5' : '暂无评分';
      find('.sg-score small').textContent = item.ratingCount + ' 人评分';
      count = item.commentCount;
      toggle.textContent = discussion.hidden ? '评分与讨论（' + count + '）' : '收起讨论';
    }
    function controls() {
      rating.disabled = loading || writing;
      form.elements.comment.disabled = writing;
      form.querySelector('button').disabled = loading || writing;
      more.disabled = loading || writing;
    }
    function refreshDiscussion() {
      if (!active || discussion.hidden || !node.isConnected) return;
      if (loading || writing) refreshPending = true;
      else void loadDetail();
    }
    function finishAction() {
      controls();
      if (refreshPending && !loading && !writing) {
        refreshPending = false;
        if (node.isConnected) refreshDiscussion();
      }
    }
    async function saveRating(value) {
      if (writing || loading) return;
      writing = true; controls(); paint(value);
      const status = find('[data-rating-status]');
      notice(status, '正在保存评分…');
      try {
        const result = await request(path + '/rating', 'PUT', { rating: value, expectedUserId: userId });
        if (!node.isConnected) return;
        updateSummary(result.suggestion); setRating(result.suggestion.myRating);
        notice(status, '评分已保存。');
      } catch (error) { setRating(myRating); notice(status, errorText(error), true); }
      finally {
        writing = false; finishAction();
        if (node.isConnected && !discussion.hidden && !root.hidden && document.activeElement === document.body) {
          stars.querySelector('input[value="' + value + '"]').focus({ preventScroll: true });
        }
      }
    }
    function makeStars() {
      for (let i = 1; i <= 5; i++) {
        const star = element('span', 'sg-star', '');
        starNodes.push(star); stars.append(star);
        for (const value of [i - 0.5, i]) {
          const radio = document.createElement('input');
          radio.type = 'radio'; radio.name = 'suggestion-rating-' + initial.id; radio.value = String(value);
          radio.setAttribute('aria-label', value + ' 星'); radio.title = value + ' 星';
          radio.onpointerenter = event => { if (!writing && event.pointerType === 'mouse') paint(value); };
          radio.onchange = () => { if (radio.checked) void saveRating(value); };
          star.append(radio);
        }
      }
      stars.onpointerleave = () => { if (!writing) paint(myRating); };
    }
    function addComment(item, prepend = false) {
      if (commentIds.has(item.id)) return;
      commentIds.add(item.id);
      const entry = document.createElement('li');
      entry.append(element('p', 'sg-comment-author', [item.author, dateText(item.createdAt)].filter(Boolean).join(' · ')),
        element('p', 'sg-comment-text', item.text));
      if (prepend) comments.prepend(entry);
      else comments.append(entry);
    }
    async function loadDetail(append = false) {
      if (loading || writing) return;
      loading = true; controls(); retry.hidden = true;
      const readVersion = version, session = sessionVersion;
      const current = () => active && session === sessionVersion && node.isConnected && !discussion.hidden;
      const status = find(append ? '[data-comments-status]' : '[data-detail-status]');
      notice(status, '正在加载讨论…');
      try {
        const result = await scheduleDetailRead(() => current() ? request(pagePath(path, append && cursor)) : null);
        if (!result || !current()) return;
        if (!append) {
          if (!starNodes.length) makeStars();
          setRating(result.suggestion.myRating);
          if (version === readVersion) updateSummary(result.suggestion);
          comments.replaceChildren(); commentIds.clear(); detail.hidden = false;
        }
        result.comments.forEach(item => addComment(item));
        cursor = result.nextCursor; more.hidden = !cursor;
        notice(status); notice(find('[data-comments-status]'), commentIds.size ? '' : '还没有评论。');
      } catch (error) { notice(status, errorText(error), true); retry.hidden = append; }
      finally { loading = false; finishAction(); }
    }
    toggle.onclick = () => {
      discussion.hidden = !discussion.hidden;
      toggle.setAttribute('aria-expanded', String(!discussion.hidden));
      toggle.textContent = discussion.hidden ? '评分与讨论（' + count + '）' : '收起讨论';
      refreshDiscussion();
    };
    retry.onclick = () => loadDetail();
    more.onclick = () => loadDetail(true);
    form.oninput = () => { commentId = undefined; notice(form.querySelector('[role=status]')); };
    form.onsubmit = async event => {
      event.preventDefault();
      if (writing || loading) return;
      const text = form.elements.comment.value.trim(), status = form.querySelector('[role=status]');
      if (!text) { notice(status, '请填写评论内容。', true); return; }
      writing = true; controls(); notice(status, '正在发表…');
      try {
        commentId ||= crypto.randomUUID();
        const result = await request(path + '/comments', 'POST', { requestId: commentId, expectedUserId: userId, text });
        if (!node.isConnected) return;
        addComment(result.comment, true); updateSummary(result.suggestion); setRating(result.suggestion.myRating);
        commentId = undefined; form.reset();
        notice(status, '评论已发表。'); notice(find('[data-comments-status]'));
      } catch (error) { notice(status, errorText(error), true); }
      finally { writing = false; finishAction(); }
    };
    updateSummary(initial);
    return {
      node, refreshDiscussion, hasDraft: () => writing || Boolean(form.elements.comment.value),
      updateFromList(item, started) { if (version <= started) updateSummary(item); }
    };
  }
})();
