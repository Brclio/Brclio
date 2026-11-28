'use strict';
const {liveTarget} = require('./live-target.cjs');
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
const userId = value => typeof value === 'string' && /^[a-z\d-]{1,128}$/i.test(value);
function registerLiveView({handle,accountRequest,scope,localUser,paneTarget,send,target = liveTarget,Socket = require('ws')}) {
  let current;
  function stop() {
    const state = current;
    if (!state) return;
    current = undefined; clearTimeout(state.timer);
    state.socket?.terminate();
    send('live-view-state',{state:'ended'});
  }
  function currentUser(state) {
    return current === state && scope() === state.scope && !state.scope.temporary;
  }
  handle('live-view',async (action,input={}) => {
    if (action === 'available') return Boolean(target());
    if (action === 'stop') {stop();return;}
    if (action === 'frame') {
      const state = current;
      if (state?.role !== 'owner' || !currentUser(state) || !state.ready || input.pane !== state.pane ||
          state.paneRef !== paneTarget(input.pane) || Date.now() >= state.expires) {stop();return;}
      if (typeof input.text !== 'string' || input.text.length > 8192 ||
          /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(input.text)) throw new Error('可见文本格式无效。');
      if (state.socket.bufferedAmount < 16384) state.socket.send(input.text);
      return;
    }
    const origin = target(), owner = scope();
    if (!origin || !owner?.userId || owner.temporary || owner.userId !== (await localUser())?.id || owner !== scope())
      throw new Error('当前账号或测试服务无法使用实时观看。');
    if (current || !['create','join'].includes(action)) throw new Error('请先结束当前观看会话。');
    if (!userId(input.ownerId) || !uuid(input.vaultId)) throw new Error('邀请格式无效。');
    const state = {scope:owner,role:action === 'create' ? 'owner' : 'viewer'};
    const body = {action,expectedUserId:owner.userId,ownerId:input.ownerId,vaultId:input.vaultId};
    if (action === 'create') {
      if (owner.userId !== input.ownerId || !userId(input.viewerId) || !(state.paneRef=paneTarget(input.pane))) throw new Error('请明确选择活动窗格和已接受邀请的成员。');
      state.pane = input.pane;
      body.viewerId = input.viewerId;
    } else {
      if (!/^[a-z\d_-]{32}$/i.test(input.code)) throw new Error('邀请格式无效。');
      body.code = input.code;
    }
    current = state;
    try {
      const response = await accountRequest({path:'/api/account/apps/terminal/live-view',method:'POST',body});
      if (!currentUser(state) || response.userId !== owner.userId || response.role !== state.role || response.ownerId !== body.ownerId ||
          response.vaultId !== body.vaultId || !/^[a-z\d_-]{43}$/i.test(response.ticket) || !Number.isSafeInteger(response.expires) ||
          response.expires <= Date.now() || response.expires > Date.now()+190000) throw new Error('临时会话已经失效。');
      state.expires = response.expires;
      const url = new URL('/terminal-live-socket/' + body.ownerId + '/' + body.vaultId,origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new Socket(url,{headers:{Authorization:'Bearer ' + response.ticket},handshakeTimeout:10000,
        followRedirects:false,perMessageDeflate:false,maxPayload:48*1024});
      state.socket = socket;
      const close = () => {if (current === state) stop();};
      socket.on('close',close); socket.on('error',close);
      socket.on('message',(bytes,binary) => {
        if (!currentUser(state) || binary || Date.now() >= state.expires) {close();return;}
        let payload;
        try {payload = JSON.parse(bytes.toString('utf8'));} catch {close();return;}
        if (!state.ready && payload?.ready === true) {
          state.ready = true;
          send('live-view-state',{state:'ready',role:state.role,pane:state.pane});
        } else if (state.role === 'viewer' && state.ready && typeof payload?.text === 'string' && payload.text.length <= 8192)
          send('live-view-state',{state:'frame',text:payload.text});
        else close();
      });
      state.timer = setTimeout(close,state.expires-Date.now()); state.timer.unref();
      await new Promise((resolve,reject) => {socket.once('open',resolve); socket.once('close',() => reject(new Error('观看通道已关闭。')));
        socket.once('error',() => reject(new Error('无法连接测试观看服务。')));});
      if (!currentUser(state)) throw new Error('观看会话已关闭。');
      return {role:state.role,expires:state.expires,
        ...(state.role === 'owner' ? {code:[body.ownerId,body.vaultId,response.code].join('.')} : {})};
    } catch (error) {if (state === current) stop();throw error;}
  });
  return {stop, paneExited(id) { if (current?.pane === id) stop(); }};
}
module.exports = {registerLiveView};
