'use strict';

const http = require('node:http');
const {randomBytes, timingSafeEqual} = require('node:crypto');

function bridge(dispatch) {
  let server, token, timer;
  const sockets = new Set();
  function stop() {
    clearTimeout(timer);
    const previous = server;
    server = null; token = null;
    for (const socket of sockets) socket.destroy();
    previous?.close();
  }
  function state() {
    const address = server?.address();
    return address ? {url:'http://127.0.0.1:' + address.port,token} : null;
  }
  async function start() {
    if (server) return state();
    token = randomBytes(32).toString('base64url');
    const listener = http.createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:10000}, async (req,res) => {
      const reply = (status,body) => {
        if (res.destroyed || res.headersSent) return;
        res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Connection':'close','X-Content-Type-Options':'nosniff'});
        res.end(JSON.stringify(body));
      };
      const current = state();
      if (!current || req.headers.host !== new URL(current.url).host || req.headers.origin || req.headers['sec-fetch-site']) return reply(403,{error:'forbidden'});
      const presented = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
      if (presented.length !== expected.length || !timingSafeEqual(presented,expected)) return reply(401,{error:'unauthorized'});
      try {
        let op, name;
        if (req.url === '/v1/inventory' && req.method === 'GET') op = 'inventory';
        else {
          const match = /^\/v1\/(host|group)\/([^/?#]{1,768})\/?$/.exec(req.url);
          if (!match) return reply(404,{error:'unknown route'});
          name = decodeURIComponent(match[2]);
          if (!name.trim() || /[\x00-\x1f\x7f]/u.test(name) || name.length > 120) return reply(400,{error:'invalid name'});
          if (req.method === 'POST') op = match[1] === 'host' ? 'create-host' : 'create-group';
          else if (req.method === 'DELETE' && match[1] === 'host') op = 'remove-host';
          else return reply(405,{error:'method not allowed'});
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8192) return reply(413,{error:'request too large'});
          chunks.push(chunk);
        }
        let body = {};
        if (size) {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') return reply(415,{error:'expected JSON'});
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400,{error:'invalid JSON object'});
        if (server !== listener) return reply(410,{error:'bridge closed'});
        const result = await dispatch({op,name,body});
        reply(result.status,result.data);
      } catch { reply(400,{error:'invalid or expired request'}); }
    });
    server = listener; listener.maxConnections = 4; listener.setTimeout(10000,socket => socket.destroy());
    listener.on('connection',socket => { sockets.add(socket); socket.on('close',() => sockets.delete(socket)); });
    try {
      await new Promise((resolve,reject) => { listener.once('error',reject); listener.listen(0,'127.0.0.1',resolve); });
      if (server !== listener) { listener.close(); return null; }
      timer = setTimeout(stop,15*60*1000); timer.unref();
      return state();
    } catch (error) { stop(); throw error; }
  }
  return {start,stop,state};
}

function register({handle,send,available}) {
  let pending;
  const service = bridge(message => new Promise((resolve,reject) => {
    if (!available() || pending) return resolve({status:409,data:{error:'terminal unavailable or busy'}});
    const id = randomBytes(16).toString('hex');
    const timer = setTimeout(() => { pending = null; reject(new Error('request expired')); },3000);
    pending = {id,resolve:result => { clearTimeout(timer); pending = null; resolve(result); }};
    send('inventory-request',{id,...message});
  }));
  function stop() {
    service.stop();
    pending?.resolve({status:410,data:{error:'bridge closed'}});
  }
  handle('inventory-bridge', (op,payload) => {
    if (op === 'start') return service.start();
    if (op === 'stop') { stop(); return null; }
    if (op === 'status') return service.state();
    if (op === 'reply' && pending && payload?.id === pending.id && [200,201,204,400,404,409].includes(payload.status)) {
      pending.resolve({status:payload.status,data:payload.data}); return;
    }
    throw new Error('主机 API 请求已结束。');
  });
  return {stop};
}
module.exports = {bridge,register};
