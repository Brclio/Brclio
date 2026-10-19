/* Shared browser, desktop and Android accounts. © 2026 Brclio · CC BY-NC-SA 4.0 */
(() => {
  'use strict';
  const host = window.BrclioHost;
  const page = document.querySelector('[data-account-page]');
  const trigger = document.getElementById('account-button');
  if (!page && !trigger) return;
  const deviceId = page ? new URLSearchParams(location.search).get('device') || '' : '';
  const state = { user: null, csrf: '', googleEnabled: false, tab: 'login', busy: false, googlePending: false, cloud: null, cloudLoaded: false, cooldown: 0, deviceApproved: false };
  const portableKeys = ['pathMode', 'quoteMode', 'separator', 'trailingSlash', 'joinWith'];
  const defaults = { pathMode: 'absolute', quoteMode: 'none', separator: 'native', trailingSlash: false, joinWith: 'newline' };
  const root = document.createElement('div');
  root.className = 'account-root';
  root.innerHTML = `
    <div class="account-heading"><div><span class="account-eyebrow">MAKE YOURSELF AT HOME</span><h2 id="account-title">你的 Brclio 账号</h2></div>${page ? '' : '<button class="account-close" type="button" aria-label="关闭账号窗口">×</button>'}</div>
    <p class="account-message" id="account-message" role="status" aria-live="polite" hidden></p>
    <section class="account-device" id="account-device" hidden aria-labelledby="account-device-title"><strong id="account-device-title">登录 Brclio 客户端</strong><p id="account-device-detail">请先登录账号，再确认将当前账号用于刚刚发起登录的客户端。</p><button class="account-button" id="account-device-approve" type="button" hidden>使用此账号登录客户端</button></section>
    <div id="account-anonymous">
      <div class="account-tabs" role="tablist" aria-label="登录或注册"><button type="button" role="tab" id="account-login-tab" aria-controls="account-login-panel" aria-selected="true" data-account-tab="login">登录</button><button type="button" role="tab" id="account-register-tab" aria-controls="account-register-panel" aria-selected="false" tabindex="-1" data-account-tab="register">注册新账号</button></div>
      <section id="account-login-panel" role="tabpanel" aria-labelledby="account-login-tab"><form class="account-form" id="account-login-form">
        <div class="account-field"><label for="account-identifier">账号或邮箱</label><input class="account-input" id="account-identifier" name="username" autocomplete="username" placeholder="输入账号或邮箱地址" maxlength="254" required autocapitalize="none" spellcheck="false"></div>
        <div class="account-field"><label for="account-login-password">密码</label><input class="account-input" id="account-login-password" name="password" type="password" autocomplete="current-password" placeholder="输入你的密码" maxlength="128" required></div>
        <button class="account-button" type="submit">登录账号</button>
      </form></section>
      <section id="account-register-panel" role="tabpanel" aria-labelledby="account-register-tab" hidden><form class="account-form" id="account-register-form">
        <div class="account-field"><label for="account-username">账号</label><input class="account-input" id="account-username" name="username" autocomplete="username" placeholder="为自己起一个账号名" minlength="3" maxlength="32" pattern="[\\p{L}\\p{N}][\\p{L}\\p{N}_.\\-]{2,31}" title="3–32 位字符，以文字或数字开头，可包含下划线、点或短横线" required autocapitalize="none" spellcheck="false"><small>3–32 位字符，以文字或数字开头，可含 _ . -</small></div>
        <div class="account-field"><label for="account-email">邮箱</label><input class="account-input" id="account-email" name="email" type="email" autocomplete="email" placeholder="用来接收注册验证码" maxlength="254" required autocapitalize="none" spellcheck="false"></div>
        <div class="account-field"><label for="account-code">邮箱验证码</label><div class="account-code-row"><input class="account-input" id="account-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" pattern="[0-9]{6}" maxlength="6" minlength="6" required><button class="account-button account-button-secondary account-button-small" id="account-send-code" type="button">获取验证码</button></div></div>
        <div class="account-field"><label for="account-register-password">设置密码</label><input class="account-input" id="account-register-password" name="password" type="password" autocomplete="new-password" placeholder="8–128 位字符" minlength="8" maxlength="128" required><small>建议使用不同于其他网站的密码。</small></div>
        <button class="account-button" type="submit">注册并登录</button>
      </form></section>
      <div class="account-divider" id="account-google-divider">或使用 Google 账号</div><button class="account-button account-google" id="account-google" type="button" disabled><span class="account-google-mark" aria-hidden="true">G</span><span>使用 Google 继续</span></button><button class="account-cancel" id="account-cancel-google" type="button" hidden>取消浏览器登录</button>
      <p class="account-footnote">复制路径无需登录。登录后，可将复制格式偏好保存到你的专属用户目录，并在其他设备手动应用。</p>
    </div>
    <section id="account-signed-in" hidden aria-label="当前账号与云端偏好">
      <div class="account-profile"><span class="account-avatar" id="account-avatar" aria-hidden="true"></span><div class="account-identity"><strong id="account-profile-name"></strong><p id="account-profile-email"></p></div><button id="account-logout" type="button">退出登录</button></div>
      <div class="account-sync-heading"><h3>我的复制偏好</h3><span class="account-cloud-state" id="account-cloud-state">尚未同步</span></div>
      <p class="account-note">保存在私有仓库的个人目录中。仅同步路径类型、引号、分隔符和多选格式；基准文件夹、文件路径及设备设置留在本机。</p>
      <div class="account-sync-actions" id="account-local-sync" hidden><button class="account-button" id="account-upload" type="button">上传本机偏好</button><button class="account-button account-button-secondary" id="account-apply" type="button">应用云端偏好</button></div>
      <form class="account-form account-cloud-form" id="account-cloud-form" hidden>
        <div class="account-field"><label for="account-pref-pathMode">路径类型</label><select class="account-select" id="account-pref-pathMode" name="pathMode"><option value="absolute">绝对路径</option><option value="relative">相对路径</option></select><small>相对路径的基准文件夹需在每台设备中单独设置。</small></div>
        <div class="account-field"><label for="account-pref-quoteMode">路径引号</label><select class="account-select" id="account-pref-quoteMode" name="quoteMode"><option value="none">不加引号</option><option value="double">双引号</option><option value="single">单引号</option><option value="auto">有空格时加双引号</option></select></div>
        <div class="account-field"><label for="account-pref-separator">路径分隔符</label><select class="account-select" id="account-pref-separator" name="separator"><option value="native">系统默认</option><option value="forward">正斜线 /</option><option value="backward">反斜线 \\</option></select></div>
        <div class="account-field"><label for="account-pref-joinWith">多选路径的连接方式</label><select class="account-select" id="account-pref-joinWith" name="joinWith"><option value="newline">每条路径一行</option><option value="space">用空格连接</option><option value="comma">用逗号连接</option></select></div>
        <label class="account-check"><input type="checkbox" id="account-pref-trailingSlash" name="trailingSlash">文件夹末尾保留分隔符</label>
        <button class="account-button" type="submit">保存云端偏好</button>
      </form>
      <p class="account-sync-time" id="account-sync-time"></p><div class="account-sync-actions"><button class="account-button account-button-secondary account-button-small" id="account-refresh" type="button">刷新账号与云端数据</button></div>
    </section>`;
  let dialog;
  if (page) page.replaceChildren(root);
  else {
    dialog = document.createElement('dialog');
    dialog.id = 'account-dialog'; dialog.className = 'account-dialog'; dialog.setAttribute('aria-labelledby', 'account-title');
    dialog.append(root); document.body.append(dialog);
  }
  const $ = id => root.querySelector('#account-' + id);
  const localPreferences = () => window.BrclioPreferences;
  const portable = source => Object.fromEntries(portableKeys.filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));

  async function request(path, method = 'GET', body) {
    let result;
    if (host?.accountRequest) result = await host.accountRequest({ path, method, ...(body === undefined ? {} : { body }) });
    else {
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(state.csrf && method !== 'GET' ? { 'X-CSRF-Token': state.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      try { result = await response.json(); } catch { throw new Error('账号服务暂不可用，请稍后重试。'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('账号服务响应无效，请稍后重试。');
      if (!response.ok) { const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || '操作未完成，请稍后重试。'); error.status = response.status; throw error; }
    }
    if (result && Object.hasOwn(result, 'csrf')) state.csrf = typeof result.csrf === 'string' ? result.csrf : '';
    return result;
  }
  function message(text = '', error = false) {
    $('message').textContent = text;
    $('message').hidden = !text;
    $('message').dataset.error = String(error);
  }
  function render() {
    const signedIn = Boolean(state.user);
    $('anonymous').hidden = signedIn;
    $('signed-in').hidden = !signedIn;
    for (const tab of root.querySelectorAll('[data-account-tab]')) {
      const selected = tab.dataset.accountTab === state.tab;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    $('login-panel').hidden = state.tab !== 'login'; $('register-panel').hidden = state.tab !== 'register';
    for (const button of root.querySelectorAll('button')) button.disabled = state.busy;
    $('cancel-google').hidden = !state.googlePending; $('cancel-google').disabled = false;
    $('google').disabled = state.busy || !state.googleEnabled;
    $('google').hidden = !state.googleEnabled;
    $('google-divider').hidden = !state.googleEnabled;
    $('send-code').disabled = state.busy || state.cooldown > 0;
    $('send-code').textContent = state.cooldown > 0 ? `${state.cooldown} 秒后重发` : '获取验证码';
    root.setAttribute('aria-busy', String(state.busy));
    if (trigger) {
      trigger.querySelector('span').textContent = state.user?.username || (signedIn ? '我的账号' : '登录 / 注册');
      trigger.setAttribute('aria-label', signedIn ? `打开账号：${state.user.username || state.user.email}` : '登录或注册账号');
    }
    if (signedIn) {
      const name = state.user.username || state.user.email || 'Brclio 用户';
      $('profile-name').textContent = name; $('profile-email').textContent = state.user.email || '';
      $('avatar').textContent = Array.from(name)[0].toUpperCase();
      const local = Boolean(localPreferences());
      $('local-sync').hidden = !local; $('cloud-form').hidden = local;
      const hasCloudPreferences = Object.keys(portable(state.cloud?.preferences)).length > 0;
      $('apply').disabled = state.busy || !hasCloudPreferences;
      $('cloud-state').textContent = !state.cloudLoaded ? '尚未读取' : hasCloudPreferences ? '已保存到账号' : '尚无云端偏好';
      const updated = hasCloudPreferences ? state.cloud?.updatedAt : null;
      const date = updated ? new Date(updated) : null;
      $('sync-time').textContent = date && !Number.isNaN(date.getTime()) ? `云端保存时间：${date.toLocaleString('zh-CN')}` : state.cloudLoaded ? '点击保存或上传，将偏好带到其他设备。' : '';
    }
    $('device').hidden = !deviceId;
    $('device-approve').hidden = !signedIn || state.deviceApproved;
    if (state.deviceApproved) $('device-detail').textContent = '已确认客户端登录。请返回 Brclio 客户端，你现在可以关闭此页面。';
    else if (signedIn) $('device-detail').textContent = `将使用 ${state.user.username || state.user.email} 登录刚刚发起请求的 Brclio 客户端。`;
  }
  async function run(action) {
    if (state.busy) return;
    state.busy = true; render(); message();
    try { await action(); }
    catch (error) {
      if (state.user) { try { await refreshSession(false); } catch {} }
      message(error?.message || '操作未完成，请重试。', true);
    }
    finally { state.busy = false; render(); }
  }
  function setCloudFields() {
    const preferences = { ...defaults, ...portable(state.cloud?.preferences) };
    for (const key of portableKeys) {
      const input = $('pref-' + key);
      if (key === 'trailingSlash') input.checked = preferences[key]; else input.value = preferences[key];
    }
  }
  async function loadCloud() {
    const expectedId = state.user?.id;
    if (!expectedId) throw new Error('请先登录账号。');
    const cloud = await request('/api/account/data');
    if (state.user?.id !== expectedId || cloud.userId !== expectedId) {
      state.cloud = null; state.cloudLoaded = false;
      throw new Error('账号状态已变化，请确认当前账号后重试。');
    }
    state.cloud = cloud; state.cloudLoaded = true; setCloudFields();
  }
  async function refreshSession(load = true) {
    const session = await request('/api/account/session');
    const previousId = state.user?.id;
    state.user = session.user || null; state.googleEnabled = Boolean(session.googleEnabled);
    if (!state.user || state.user.id !== previousId) { state.cloud = null; state.cloudLoaded = false; setCloudFields(); }
    render();
    if (state.user && load) { await loadCloud(); render(); }
    return session;
  }
  async function ensureCurrentUser() {
    const expectedId = state.user?.id;
    await refreshSession(false);
    if (!expectedId || state.user?.id !== expectedId) {
      if (state.user) await loadCloud();
      throw new Error('账号状态已变化，请确认当前账号后重试。');
    }
  }
  async function afterSignIn() {
    $('login-password').value = ''; $('register-password').value = ''; $('code').value = '';
    await refreshSession(); message(deviceId ? '登录成功，请确认下方的客户端登录。' : '登录成功，你可以管理自己的云端偏好了。');
  }
  for (const tab of root.querySelectorAll('[data-account-tab]')) {
    tab.addEventListener('click', () => { if (!state.busy) { state.tab = tab.dataset.accountTab; render(); message(); } });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || state.busy) return;
      event.preventDefault(); state.tab = event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' : state.tab === 'login' ? 'register' : 'login';
      render(); $(state.tab + '-tab').focus(); message();
    });
  }
  $('login-form').addEventListener('submit', event => {
    event.preventDefault(); void run(async () => { await request('/api/account/login', 'POST', { identifier: $('identifier').value.trim(), password: $('login-password').value }); await afterSignIn(); });
  });
  $('register-form').addEventListener('submit', event => {
    event.preventDefault(); void run(async () => { await request('/api/account/register', 'POST', { username: $('username').value.trim(), email: $('email').value.trim(), code: $('code').value.trim(), password: $('register-password').value }); await afterSignIn(); });
  });
  $('send-code').addEventListener('click', () => {
    if (!$('email').reportValidity()) return;
    void run(async () => {
      const result = await request('/api/account/code', 'POST', { email: $('email').value.trim() });
      message(result.message || '若该邮箱可以注册，验证码已发送，请查看收件箱或垃圾邮件文件夹。'); state.cooldown = 60;
      const timer = setInterval(() => { state.cooldown = Math.max(0, state.cooldown - 1); render(); if (!state.cooldown) clearInterval(timer); }, 1000);
      $('code').focus();
    });
  });
  $('google').addEventListener('click', () => { void run(async () => {
    if (host?.accountGoogle) {
      state.googlePending = true; render(); message('请在系统浏览器中完成登录，完成后回到这里。');
      try { const result = await host.accountGoogle(); if (!result?.redirecting) await afterSignIn(); } finally { state.googlePending = false; }
    } else location.assign('/api/account/google/start' + (deviceId ? '?device=' + encodeURIComponent(deviceId) : ''));
  }); });
  $('cancel-google').addEventListener('click', () => { void host?.accountCancelGoogle?.(); });
  $('logout').addEventListener('click', () => { void run(async () => {
    await ensureCurrentUser();
    await request('/api/account/logout', 'POST', {}); state.user = null; state.cloud = null; state.cloudLoaded = false;
    await refreshSession(false); message('已退出登录。');
  }); });
  $('refresh').addEventListener('click', () => { void run(async () => { await refreshSession(); message('账号与云端偏好已刷新。'); }); });
  $('upload').addEventListener('click', () => { void run(async () => {
    await ensureCurrentUser();
    const preferences = portable(await localPreferences().read());
    state.cloud = await request('/api/account/data', 'PUT', { preferences }); state.cloudLoaded = true;
    if (!state.cloud?.preferences) await loadCloud();
    message('本机的复制格式已保存到你的账号。');
  }); });
  $('apply').addEventListener('click', () => { void run(async () => {
    await ensureCurrentUser();
    await loadCloud();
    if (!Object.keys(portable(state.cloud?.preferences)).length) throw new Error('账号中还没有复制偏好，请先在任一设备上传。');
    await localPreferences().apply(portable(state.cloud.preferences)); message('已应用云端偏好，之后复制将使用这些格式。');
  }); });
  $('cloud-form').addEventListener('submit', event => { event.preventDefault(); void run(async () => {
    await ensureCurrentUser();
    const preferences = Object.fromEntries(portableKeys.map(key => [key, key === 'trailingSlash' ? $('pref-' + key).checked : $('pref-' + key).value]));
    state.cloud = await request('/api/account/data', 'PUT', { preferences }); state.cloudLoaded = true;
    if (!state.cloud?.preferences) await loadCloud();
    message('云端偏好已保存。在客户端登录后，可以手动应用。');
  }); });
  $('device-approve').addEventListener('click', () => { void run(async () => {
    await ensureCurrentUser();
    await request('/api/account/device/approve', 'POST', { id: deviceId }); state.deviceApproved = true; message('客户端登录已确认。');
  }); });
  if (dialog) {
    trigger.addEventListener('click', () => {
      if (!dialog.open) dialog.showModal();
      void run(async () => { await refreshSession(); });
    });
    root.querySelector('.account-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
    dialog.addEventListener('close', () => { $('login-password').value = ''; $('register-password').value = ''; });
  }
  render();
  if (page) void run(async () => { await refreshSession(); if (new URLSearchParams(location.search).has('error')) message('Google 登录未完成，请重试或使用账号和密码登录。', true); });
  else if (window.brclio || window.AndroidBridge) void refreshSession(false).catch(() => {});
})();
