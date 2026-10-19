const encoder = new TextEncoder();
const base64UTF8 = value => btoa(String.fromCharCode(...encoder.encode(value)));

// Import lazily so account/unit tests do not need the Workers socket module.
export async function sendRegistrationCode(env, email, code, {connectImpl} = {}) {
  if (!env.SMTP_EMAIL || !env.SMTP_APP_PASSWORD) throw new Error('Verification email unavailable');
  const connect = connectImpl || (await import('cloudflare:sockets')).connect;
  const socket = connect({hostname: 'smtp.gmail.com', port: 465}, {secureTransport: 'on'});
  const writer = socket.writable.getWriter(), reader = socket.readable.getReader();
  let buffer = '';
  async function readResponse(expected) {
    let final;
    while (!final) {
      const end = buffer.indexOf('\r\n');
      if (end < 0) {
        let timeout;
        try {
          const next = await Promise.race([reader.read(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SMTP timeout')), 10000); })]);
          if (next.done) throw new Error('SMTP connection ended');
          buffer += new TextDecoder().decode(next.value);
          if (buffer.length > 32768) throw new Error('SMTP response too large');
        } finally { clearTimeout(timeout); }
        continue;
      }
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!/^\d{3}[- ]/.test(line)) throw new Error('SMTP response invalid');
      if (line[3] === ' ') final = Number(line.slice(0, 3));
    }
    if (!expected.includes(final)) throw new Error('Verification email could not be sent');
  }
  async function command(text, expected) { await writer.write(encoder.encode(text + '\r\n')); await readResponse(expected); }
  let operationTimeout;
  try {
    await Promise.race([(async () => {
    await socket.opened;
    await readResponse([220]);
    await command('EHLO tools.brclio.com', [250]);
    await command('AUTH PLAIN ' + btoa('\0' + env.SMTP_EMAIL + '\0' + env.SMTP_APP_PASSWORD.replace(/\s/g, '')), [235]);
    await command(`MAIL FROM:<${env.SMTP_EMAIL}>`, [250]);
    await command(`RCPT TO:<${email}>`, [250, 251]);
    await command('DATA', [354]);
    const body = `你的 Brclio 注册验证码：${code}\n\n验证码 10 分钟内有效。请勿将验证码提供给他人。\n如非本人操作，请忽略此邮件。`;
    const lines = [
      `From: Brclio <${env.SMTP_EMAIL}>`, `To: <${email}>`,
      'Subject: =?UTF-8?B?' + base64UTF8('Brclio 注册验证码') + '?=',
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
      `Message-ID: <${crypto.randomUUID()}@tools.brclio.com>`, `Date: ${new Date().toUTCString()}`, '',
      base64UTF8(body).match(/.{1,76}/g).join('\r\n'), '.'
    ];
    await command(lines.join('\r\n'), [250]);
    // Gmail accepted the message at the final 250; QUIT failure cannot undo it.
    try { await command('QUIT', [221]); } catch {}
    })(), new Promise((_, reject) => { operationTimeout = setTimeout(() => reject(new Error('Verification email timed out')), 20000); })]);
  } finally {
    clearTimeout(operationTimeout);
    await Promise.allSettled([reader.cancel(), socket.close()]);
    try { writer.releaseLock(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}
