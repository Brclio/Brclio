'use strict';

(() => {
  function mount(pane,ref,start) {
    const storage = window.BrclioConnection.store(localStorage);
    const owner = window.BrclioTerminalPartitions.owner;
    const box = document.createElement('section');
    box.className = 'pending-layout-host';
    box.setAttribute('aria-label','待连接的布局主机');
    box.innerHTML = `<p data-dest="name"></p><p data-dest="address"></p><label data-dest="picker">重新选择本机主机
      <select aria-label="重新选择本机主机"></select></label><p data-dest="message" role="status"></p>
      <button data-dest="connect" type="button"></button><button data-dest="local" type="button">在此打开本地 Shell</button>`;
    pane.node.append(box);
    const field = id => box.querySelector('[data-dest="' + id + '"]');
    const picker = box.querySelector('select'), connect = field('connect');
    let selected = ref.name, revision = 0, displayed, reviewed, dead = false;
    const sameUser = () => !dead && window.BrclioTerminalPartitions.ready && window.BrclioTerminalPartitions.owner === owner;
    function read() {
      const item = storage.all().find(h => h.name === selected);
      return item ? storage.resolve(item) : null;
    }
    async function refresh() {
      const current = ++revision;
      displayed = undefined; reviewed = undefined; connect.disabled = true; connect.textContent = '连接此窗格';
      const hosts = storage.all(), found = hosts.some(h => h.name === ref.name);
      field('picker').hidden = found && selected === ref.name;
      if (!field('picker').hidden) {
        picker.replaceChildren(new Option('选择主机',''),...hosts.map(h => new Option(h.name,h.name)));
        picker.value = selected;
      }
      const target = read();
      field('name').textContent = ref.protocol.toUpperCase() + ' · ' + (selected || ref.name);
      field('address').textContent = '';
      if (!sameUser()) {field('message').textContent = '登录账号已变化，请重新打开布局。';return;}
      if (!target) {field('message').textContent = '已保存的主机已删除或更名。可以重新选择本机主机。';return;}
      const next = await window.BrclioArrangements.reference(selected,ref.protocol,target);
      if (current !== revision || !sameUser()) return;
      field('address').textContent = '用户名 ' + (target.user || 'SSH 配置') + ' · 地址 ' + target.host + ' · 端口 ' + (target.port || 'SSH 配置（通常为 22）');
      displayed = {ref:next,stamp:JSON.stringify(target)};
      const changed = next.name !== ref.name || next.fingerprint !== ref.fingerprint;
      field('message').textContent = changed ? '主机或连接设置已变更，请核对当前目标。' : '点击后建立此连接。';
      connect.textContent = changed ? '核对连接目标' : '连接此窗格'; connect.disabled = false;
    }
    const fail = error => {if (!dead) field('message').textContent = error.message;};
    const update = () => refresh().catch(fail);
    picker.onchange = () => {selected = picker.value;update();};
    connect.onclick = () => {
      try {
        const target = sameUser() && read();
        if (!displayed || !target || JSON.stringify(target) !== displayed.stamp) {update();return;}
        const changed = displayed.ref.name !== ref.name || displayed.ref.fingerprint !== ref.fingerprint;
        if (changed && reviewed !== displayed.stamp) {
          reviewed = displayed.stamp; connect.textContent = '确认连接此目标';
          field('message').textContent = '请确认上方目标后再连接。';return;
        }
        start({profile:ref.protocol,connection:target,cwd:null,shellIntegration:false},displayed.ref);
      } catch (error) {fail(error);}
    };
    field('local').onclick = () => {if (sameUser()) start({profile:'default',cwd:null,shellIntegration:true});};
    window.addEventListener('brclio-terminal-library-changed',update);
    window.addEventListener('brclio-terminal-account-changed',update);
    update();
    return {dispose() {dead=true; window.removeEventListener('brclio-terminal-library-changed',update);
      window.removeEventListener('brclio-terminal-account-changed',update);box.remove();}};
  }
  window.BrclioArrangementHost = {mount};
})();
