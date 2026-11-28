'use strict';

(() => {
  function visibleFrame(terminal) {
    const buffer = terminal.buffer.active, lines = [];
    for (let y = 0; y < terminal.rows; y++) {
      const line = buffer.getLine(buffer.baseY + y);
      let text = '';
      for (let x = 0; line && x < terminal.cols; x++) {
        const cell = line.getCell(x);
        if (cell?.getWidth()) text += cell.isInvisible() ? ' '.repeat(cell.getWidth()) : cell.getChars() || ' ';
      }
      lines.push(text.trimEnd());
    }
    return lines.join('\n').trimEnd().replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,'').slice(-8192);
  }
  const api = window.brclioTerminal;
  const dialog = document.createElement('dialog');
  dialog.className = 'connection-sheet'; dialog.id = 'live-view-dialog';
  dialog.setAttribute('aria-labelledby','live-heading');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="live-heading">实时观看</h2><button data-live="close">关闭</button></div>
    <section data-live="setup"><h3>分享当前窗格</h3><p data-live="pane"></p>
    <p>双方同意后，成员将看到这个窗格随后显示的文字，包括回显的命令。会话最长三分钟。</p>
    <label>我的共享主机库<select data-live="vault"></select></label>
    <label>受邀成员<select data-live="member"></select></label><button data-live="invite">邀请观看此窗格</button>
    <h3>接受邀请</h3><label>观看邀请码<input data-live="join-code" maxlength="240" autocomplete="off"></label>
    <button data-live="join">同意观看</button></section>
    <section data-live="session" hidden><p data-live="note"></p><label data-live="code-row">本次邀请码<input data-live="code" readonly></label>
    <div data-live="propose" hidden><label>给主持人的单行草稿<input data-live="draft" maxlength="512" autocomplete="off"></label><button data-live="send-draft">发送草稿</button></div>
    <div data-live="review" hidden><label>成员提交的草稿<input data-live="review-text" maxlength="512" autocomplete="off"></label><button data-live="accept-draft">填入当前窗格</button><button data-live="dismiss-draft">忽略</button></div>
    <pre data-live="output" aria-label="共享窗格文字"></pre><button data-live="stop">结束实时观看</button></section>
    <p role="status"></p>`;
  document.body.append(dialog);
  const field = key => dialog.querySelector('[data-live="' + key + '"]');
  const status = dialog.querySelector('[role=status]');
  let activePane, pasteOnly, current, shadow, timer, generation = 0, lastFrame, dirty, chosenPane;
  const indicator = document.createElement('button');
  indicator.hidden = true; indicator.textContent = '实时观看中'; indicator.onclick = () => dialog.showModal();
  document.getElementById('connection-center').after(indicator);
  function clear() {
    generation++; clearInterval(timer); timer = undefined; shadow?.dispose(); shadow = undefined;
    current = undefined; lastFrame = ''; dirty = false; indicator.hidden = true; indicator.textContent = '实时观看中';
    field('propose').hidden = field('review').hidden = true;
    for (const key of ['join-code','code','draft','review-text']) field(key).value = '';
    field('output').textContent = ''; field('note').textContent = ''; field('session').hidden = true;
    field('setup').hidden = true; field('member').replaceChildren(); field('vault').replaceChildren();
  }
  const report = error => {status.textContent = error.message;};
  async function stop() { clear(); await api.liveView('stop'); }
  function fields(role) {
    current = role;
    field('session').hidden = false; field('setup').hidden = true;
    field('code-row').hidden = role !== 'owner'; indicator.hidden = false;
  }
  api.onLiveView(event => {
    if (event.state === 'ended') {clear(); status.textContent = '观看已结束。';return;}
    if (event.state === 'frame' && current === 'viewer') {field('output').textContent = event.text;return;}
    if (event.state === 'draft' && current === 'owner' && chosenPane === activePane() && chosenPane?.id === event.pane) {
      field('review-text').value = event.text; field('review').hidden = false;
      indicator.textContent = '成员提交了草稿'; return;
    }
    if (event.state !== 'ready') return;
    field('propose').hidden = event.role !== 'viewer';
    fields(event.role);
    field('note').textContent = event.role === 'owner' ? '成员已同意，正在分享所选窗格。' : '已连接，等待窗格产生新文字。';
    if (event.role !== 'owner') return;
    if (!chosenPane || chosenPane !== activePane() || event.pane !== chosenPane.id) {stop().catch(report);return;}
    // Start with a new empty emulator, never the real pane's existing buffer.
    // Only future PTY output is parsed. Input, title/clipboard OSC messages,
    // hidden cells, history and the real pane's data handlers are excluded.
    shadow = new Terminal({cols:chosenPane.terminal.cols,rows:chosenPane.terminal.rows,scrollback:0,allowProposedApi:true});
    timer = setInterval(() => {
      if (!shadow || !dirty) return;
      dirty = false;
      const text = visibleFrame(shadow);
      if (text !== lastFrame) {
        lastFrame = text;
        api.liveView('frame',{pane:chosenPane.id,text}).catch(report);
      }
    },2500);
  });
  field('send-draft').onclick = async () => {
    try { await api.liveView('draft',{text:field('draft').value}); field('draft').value = ''; status.textContent = '草稿已提交给主持人审阅。'; }
    catch (error) {report(error);}
  };
  function dismissDraft() { field('review-text').value = ''; field('review').hidden = true; indicator.textContent = '实时观看中'; }
  field('dismiss-draft').onclick = dismissDraft;
  field('accept-draft').onclick = () => {
    const text = field('review-text').value;
    if (current !== 'owner' || chosenPane !== activePane() || chosenPane?.state !== 'running' || !text.trim() || /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/u.test(text)) return;
    // Only the owner's deliberate action pastes text. The viewer cannot send terminal input or Return.
    pasteOnly(chosenPane,text); dismissDraft(); dialog.close(); chosenPane.terminal.focus();
  };
  field('close').onclick = () => dialog.close();
  field('stop').onclick = () => stop().catch(report);
  async function members() {
    const epoch = ++generation;
    const vaultId = field('vault').value;
    field('member').replaceChildren(); field('invite').disabled = true;
    if (!vaultId) return;
    const ref = {ownerId:window.BrclioTerminalPartitions.owner,vaultId};
    const {vault} = await api.sharedVault('open',ref);
    if (epoch !== generation || !dialog.open) return;
    for (const member of vault.members.filter(m => m.state === 'active')) field('member').add(new Option(member.username,member.id));
    field('invite').disabled = !chosenPane || !field('member').value;
  }
  field('vault').onchange = () => members().catch(report);
  async function connect(role) {
    const args = {};
    if (role === 'owner') {
      if (!chosenPane || activePane() !== chosenPane) throw new Error('请选择活动窗格后重新打开。');
      Object.assign(args,{ownerId:window.BrclioTerminalPartitions.owner,vaultId:field('vault').value,
        viewerId:field('member').value,pane:chosenPane.id});
    } else {
      const [ownerId,vaultId,code,...extra] = field('join-code').value.trim().split('.');
      if (!ownerId || !vaultId || !code || extra.length) throw new Error('请输入完整的邀请码。');
      Object.assign(args,{ownerId,vaultId,code});
    }
    fields(role);
    status.textContent = '';
    field('note').textContent = role === 'owner' ? '请将邀请码交给选定成员。' : '正在连接所选窗格。';
    try { const response = await api.liveView(role === 'owner' ? 'create' : 'join',args);
      if (role === 'owner' && current === 'owner') field('code').value = response.code;
    } catch (error) {clear(); status.textContent = error.message;}
  }
  field('invite').onclick = () => connect('owner').catch(report); field('join').onclick = () => connect('viewer').catch(report);
  window.addEventListener('brclio-terminal-account-changed',() => {if (dialog.open) dialog.close();clear();});
  window.BrclioLiveView = {
    bind(getActive, paste) {
      activePane = getActive; pasteOnly = paste;
      api.liveView('available').then(available => {document.querySelector('[data-center="liveView"]').hidden = !available;}).catch(() => {});
    },
    async open() {
      dialog.showModal();
      if (current) return;
      clear(); status.textContent = '';
      try {
        if (!await api.liveView('available')) {status.textContent = '此测试环境尚未启用实时观看服务。';return;}
        chosenPane = activePane();
        if (chosenPane?.state !== 'running') chosenPane = undefined;
        field('pane').textContent = chosenPane ? '窗格 · ' + chosenPane.caption.textContent : '请先打开一个终端窗格。';
        field('setup').hidden = false;
        const epoch = generation;
        const {vaults} = await api.sharedVault('list');
        if (epoch !== generation || !dialog.open) return;
        for (const vault of vaults.filter(v => v.role === 'owner')) field('vault').add(new Option(vault.name,vault.vaultId));
        await members();
      } catch (error) {report(error);}
    },
    output(pane,data) {
      if (shadow && pane === chosenPane) {
        if (activePane() !== pane) {stop().catch(report);return;}
        if (shadow.cols !== pane.terminal.cols || shadow.rows !== pane.terminal.rows) shadow.resize(pane.terminal.cols,pane.terminal.rows);
        const target = shadow;
        target.write(data,() => {if (shadow === target) dirty = true;});
      }
    },
    selection(pane) {if (current === 'owner' && chosenPane !== pane) stop().catch(report);},
  };
})();
