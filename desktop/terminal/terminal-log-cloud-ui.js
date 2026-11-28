'use strict';
window.BrclioCloudLogs = (() => {
  const make = (tag,text,attrs = {}) => Object.assign(document.createElement(tag), {textContent:text}, attrs);
  const button = (text,fn) => {
    const b = make('button',text,{type:'button'}); b.onclick = fn; return b;
  };
  const field = (text,node) => { const label = make('label',text + ' '); label.append(node); return label; };
  let dialog;
  async function open(local) {
    if (dialog) { dialog.focus(); return; }
    const api = window.brclioTerminal;
    const view = dialog = make('dialog','',{className:'local-logs',ariaLabel:'云端日志副本'});
    const row = (...children) => { const box = make('div','',{className:'log-row'}); box.append(...children); return box; };
    const status = make('p','',{role:'status'});
    const scopeSelect = make('select','',{ariaLabel:'日志访问范围'});
    scopeSelect.add(new Option('仅我的 Brclio 账号',''));
    const entries = make('select','',{size:5,ariaLabel:'云端日志'});
    const host = make('select','',{ariaLabel:'筛选日志主机'}), member = make('select','',{ariaLabel:'筛选记录者'});
    const text = make('textarea','',{readOnly:true,ariaLabel:'解密的日志内容',spellcheck:false});
    const marks = make('select','',{ariaLabel:'云端日志书签'});
    function bookmarks(items = []) {
      marks.replaceChildren(new Option('跳到书签',''),...items.map(item => new Option(item.label,String(item.offset))));
      marks.disabled=!items.length;
    }
    marks.onchange=() => {
      if (marks.value==='') return;
      const at=Math.min(text.value.length,Number(marks.value));
      text.focus(); text.setSelectionRange(at,Math.min(at+1,text.value.length));
      text.scrollTop=(text.value.slice(0,at).split('\n').length-1)*parseFloat(getComputedStyle(text).lineHeight);
    };
    const password = make('input','',{type:'password',autocomplete:'off',maxLength:128,placeholder:'独立口令，至少 12 字',ariaLabel:'日志口令'});
    const days = make('select','',{ariaLabel:'副本可访问期限'});
    const durations = [1,7,30,90,365];
    days.replaceChildren(...durations.map(n => new Option(n + ' 天',String(n)))); days.value='7';
    let state = null, busy = false, scope = null, scopes = [];
    const now = () => dialog === view && view.open;
    function perform(fn) { return async () => {
      if (busy || !now()) return;
      busy = true; body.inert = true; status.textContent='';
      try { await fn(); }
      catch(error) { if (now()) status.textContent=String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /,''); }
      finally { busy=false; body.inert=false; }
    }; }
    const call = (op,p = {}) => api.cloudLogs(op,{scope,...p});
    const update = () => {
      const previous = entries.value;
      const items = (state?.entries || []).filter(item => (!host.value || (item.host || '@local') === host.value) && (!member.value || item.authorId === member.value));
      entries.replaceChildren(...items.map(item => new Option(item.name + ' · ' + (item.host || '本机') + ' · ' + item.authorName, item.id)));
      if (items.some(item => item.id === previous)) entries.value = previous;
      else if (items.length) entries.selectedIndex=0;
      const selected = state?.entries.find(item => item.id === entries.value);
      read.disabled = !selected;
      remove.disabled = !selected || !(state.role === 'owner' || selected.authorId === state.userId);
      publish.disabled = !local || !state || state.role === 'reader' || (!!scope && !local.host);
      details.textContent=selected ? '可访问至 ' + new Date(selected.expiresAt).toLocaleString() : '';
      text.value=''; bookmarks(); confirmRemove.hidden=true;
    };
    function filters(select,all,items) {
      const previous = select.value;
      select.replaceChildren(new Option(all,''),...Array.from(new Map(items)).map(([id,label]) => new Option(label,id)));
      select.value = [...select.options].some(o=>o.value===previous) ? previous : '';
    }
    const teamNote = make('p','',{hidden:true});
    const management = make('details','',{hidden:true});
    const maximum = make('select','',{ariaLabel:'新副本留存上限'});
    maximum.replaceChildren(...durations.map(n => new Option(n + ' 天',String(n))));
    const events = make('ol','',{ariaLabel:'取回记录',className:'log-audit'});
    const applyPolicy = button('保存新副本留存上限',perform(async () => {
      const result=await call('policy',{revision:state.revision,days:Number(maximum.value)});
      if (now()) { showState(result); status.textContent='已应用至之后发布的副本。'; }
    }));
    const audit = button('读取最近 64 条取回记录',perform(async () => {
      events.replaceChildren();
      const result=await call('audit');
      if (!now()) return;
      events.replaceChildren(...result.events.map(entry=>make('li',new Date(entry.time).toLocaleString() + ' · ' +
        entry.actor + ' · 取回加密副本 · ' + entry.id)));
      if (!result.events.length) status.textContent='此主机库暂无取回记录。';
    }));
    management.append(make('summary','管理团队日志'),row(field('新副本留存上限',maximum),applyPolicy),audit,events);
    function showState(result) {
      state=result;
      const limit=state?.maximumDays ?? 365;
      teamNote.hidden=!scope;
      teamNote.textContent=scope ? '新副本最长保留 ' + limit + ' 天。取回密文时记录账号、副本编号和时间，库主可查看。' : '';
      management.hidden=!scope || state?.role !== 'owner';
      if (management.hidden) management.open=false;
      maximum.value=String(limit);
      for (const option of days.options) option.disabled=Number(option.value)>limit;
      if (Number(days.value)>limit) days.value=String(limit);
      events.replaceChildren();
      const records=state?.entries || [];
      filters(host,'全部主机',records.map(e=>[e.host || '@local',e.host || '本机']));
      filters(member,'所有记录者',records.map(e=>[e.authorId,e.authorName]));
      update();
    }
    async function refresh() {
      showState(null);
      const result = await call('list');
      if (now()) showState(result);
    }
    const details = make('p','');
    const read = button('解密查看',perform(async () => {
      const secret = password.value; password.value='';
      const result = await call('read',{id:entries.value,password:secret});
      if (now()) { text.value=result.record.text; bookmarks(result.record.bookmarks); }
    }));
    const remove = button('删除此云端副本',() => { confirmRemove.hidden=false; });
    const confirmRemove = row(make('span','删除后，当前云端清单会移除这份副本。'),
      button('取消',() => { confirmRemove.hidden=true; }),
      button('确认删除',perform(async () => { const result=await call('remove',{id:entries.value,revision:state.revision}); if (now()) showState(result); })));
    confirmRemove.hidden=true;
    const publish = button('上传所选本机日志…',perform(async () => {
      const secret=password.value; password.value='';
      const result=await call('publish',{localId:local.id,revision:state.revision,days:Number(days.value),password:secret});
      if (!result.canceled && now()) showState(result);
      if (now()) status.textContent=result.canceled ? '已取消。' : '加密副本已上传。';
    }));
    const body=make('section','');
    body.append(field('访问范围',scopeSelect),teamNote,management,row(host,member,button('刷新',perform(refresh))),entries,details,
      field('口令',password),row(read,remove),confirmRemove,marks,text);
    if (local) body.append(make('p','已选择已停止的日志「' + local.name + '」。云端可见名称、主机和记录者，正文与书签需口令解密。'),
      row(field('可访问期限',days),publish));
    body.append(make('small','删除或到期后服务停止提供副本。Git 历史可能保留密文，已下载的副本由接收者保管。'));
    view.append(row(make('h2','云端日志副本'),button('关闭',() => view.close())),body,status);
    entries.onchange=host.onchange=member.onchange=update;
    scopeSelect.onchange=perform(async () => {
      password.value=''; scope=scopeSelect.value ? scopes[Number(scopeSelect.value)] : null;
      await refresh();
    });
    const onAccount = () => view.close();
    window.addEventListener('brclio-terminal-account-changed',onAccount);
    view.addEventListener('close',() => {
      window.removeEventListener('brclio-terminal-account-changed',onAccount);
      password.value=''; text.value=''; dialog=null; view.remove();
    },{once:true});
    document.body.append(view); view.showModal();
    await perform(async () => {
      await refresh();
      const response=await api.sharedVault('list');
      if (!now()) return;
      for (const v of response.vaults.filter(v=>v.state==='active')) {
        const index=scopes.push({ownerId:v.ownerId,vaultId:v.vaultId})-1;
        scopeSelect.add(new Option('共享主机库 · ' + v.name + ' · ' + v.ownerName,String(index)));
      }
    })();
  }
  return {open};
})();
