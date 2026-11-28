'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Terminal } = require('@xterm/xterm');
const { attach } = require('./terminal/command-marks.js');
const { shellArguments } = require('./terminal/shell-startup.cjs');
const { createPtyService, forkService } = require('./terminal/service.cjs');

const osc = (number, data) => '\x1b]' + number + ';' + data + '\x07';
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));

test('command output selection follows xterm OSC parsing, wrapped rows, trimmed history and alternate buffers', async t => {
  const terminal = new Terminal({ allowProposedApi: true, rows: 3, cols: 12, scrollback: 6 });
  const marks = attach(terminal);
  t.after(() => { marks.dispose(); terminal.dispose(); });
  let selection;
  terminal.select = (x, y, length) => { selection = { x, y, length }; };
  await write(terminal, osc(133, 'A') + '$ ' + osc(133, 'B') + 'cmd\r\n');
  await write(terminal, '\x1b]13');
  await write(terminal, '3;C\x1b\\abcdefghijklmno' + osc(133, 'D;0') + '\r\n');
  assert.ok(marks.selectOutput());
  assert.deepEqual(selection, { x: 0, y: 1, length: 15 });
  terminal.resize(9, 3);
  assert.ok(marks.selectOutput());
  assert.equal(selection.length, 15);
  await write(terminal, osc(1337, 'SetMark'));
  assert.ok(marks.previous());
  assert.ok(marks.previous());
  assert.equal(marks.previous(), false);
  assert.ok(marks.next());
  await write(terminal, '\x1b[?1049h' + osc(1337, 'SetMark'));
  assert.equal(marks.add(), false);
  assert.equal(marks.selectOutput(), false);
  await write(terminal, '\x1b[?1049l' + '\r\n'.repeat(15));
  assert.equal(marks.previous(), false);
  assert.equal(marks.selectOutput(), false);
});

test('aborted commands and unknown iTerm2 OSCs do not create marks or ranges', async t => {
  const terminal = new Terminal({ allowProposedApi: true });
  const marks = attach(terminal);
  t.after(() => { marks.dispose(); terminal.dispose(); });
  let fellThrough = 0;
  // A lower-priority OSC handler is left available for other features (e.g. images).
  const check = new Terminal({ allowProposedApi: true });
  check.parser.registerOscHandler(1337, () => { fellThrough++; return true; });
  const other = attach(check);
  await write(check, osc(1337, 'File=unknown') + osc(1337, 'SetMark'));
  assert.equal(fellThrough, 1);
  other.dispose();
  check.dispose();
  await write(terminal, osc(133, 'A') + '$ ' + osc(133, 'B') + osc(133, 'D;130'));
  assert.equal(marks.previous(), false);
  assert.equal(marks.selectOutput(), false);
  assert.ok(marks.add());
  assert.ok(marks.previous());
});

test('prompt-only shells keep earlier prompts without claiming to know command output', async t => {
  const terminal = new Terminal({ allowProposedApi: true });
  const marks = attach(terminal);
  t.after(() => { marks.dispose(); terminal.dispose(); });
  const prompt = osc(133, 'A') + '> ' + osc(133, 'B');
  await write(terminal, prompt + 'one\r\n' + prompt + 'two\r\n' + prompt);
  assert.equal(marks.selectOutput(), false);
  for (let step = 0; step < 3; step++) assert.ok(marks.previous());
  assert.equal(marks.previous(), false);
});

test('local integration launch preserves default startup, shell path quoting, and unsupported shell arguments', t => {
  const env = { ZDOTDIR: "/tmp/user's startup", PROMPT_COMMAND: 'remember_exit "$?"' };
  const off = { ...env };
  assert.deepEqual(shellArguments('/bin/zsh', 'darwin', false, off), ['-l']);
  assert.deepEqual(off, env);
  const original = { ...env };
  assert.deepEqual(shellArguments('/bin/zsh', 'darwin', true, original), ['-l']);
  assert.equal(original.BRCLIO_ORIGINAL_ZDOTDIR, env.ZDOTDIR);
  assert.ok(original.ZDOTDIR.endsWith(path.join('shell-integration', 'zsh')));
  const bash = { ...env };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "a'b"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const asar = path.join(folder, 'app.asar', 'desktop', 'terminal');
  const unpacked = path.join(folder, 'app.asar.unpacked', 'desktop', 'terminal');
  assert.deepEqual(shellArguments('/bin/zsh', 'darwin', true, off, asar), ['-l']);
  assert.deepEqual(off, env);
  fs.cpSync(path.join(__dirname, 'terminal', 'shell-integration'), path.join(unpacked, 'shell-integration'), { recursive: true });
  assert.deepEqual(shellArguments('/bin/bash', 'darwin', true, bash, asar), ['-l']);
  assert.match(bash.PROMPT_COMMAND, /a'\\''b/);
  assert.match(bash.PROMPT_COMMAND, /app\.asar\.unpacked/);
  assert.ok(bash.PROMPT_COMMAND.endsWith('\n' + env.PROMPT_COMMAND));
  const args = shellArguments('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32', true, {}, asar);
  assert.deepEqual(args.slice(0, 2), ['-NoExit', '-Command']);
  assert.match(args[2], /a''b/);
  assert.deepEqual(shellArguments('/bin/fish', 'darwin', true, {}), ['-l']);
  const cmd = { PROMPT: '$P--$G' };
  assert.deepEqual(shellArguments('C:\\Windows\\System32\\cmd.exe', 'win32', true, cmd), []);
  assert.ok(cmd.PROMPT.includes('$P--$G'));
});

test('opt-in zsh loads original login files, brackets command output and preserves the exit status seen by the next command', {
  skip: process.platform !== 'darwin', timeout: 12000,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "brclio-zsh' space "));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const files = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'];
  files.forEach((file, i) => fs.writeFileSync(path.join(home, file), 'ORDER+=' + i + '\n'));
  fs.appendFileSync(path.join(home, '.zshrc'), "PROMPT='Custom%? > '\nHISTFILE=/dev/null\n");
  const before = files.map(file => fs.readFileSync(path.join(home, file), 'utf8'));
  const id = randomUUID();
  let output = '', phase = 0, done, fail;
  const ended = new Promise((resolve, reject) => { done = resolve; fail = reject; });
  const sessions = createPtyService({ home,
    launch: dir => forkService(dir, { ...process.env, ZDOTDIR: home }),
    send(channel, event) {
      if (channel === 'exit') { done(event.exitCode); return; }
      output += event.data;
      sessions.ack(id, event.data.length);
      if (!phase && output.includes(osc(133, 'B'))) {
        phase++;
        sessions.write(id, "sh -c 'exit 23'\r").catch(fail);
      } else if (phase === 1 && output.includes(osc(133, 'D;23'))) {
        phase++;
        sessions.write(id, "printf 'PROFILE=%s STATUS=%d\\n' \"$ORDER\" \"$?\"; exit 19\r").catch(fail);
      }
    },
  });
  t.after(() => sessions.closeAll());
  await sessions.create({ id, profile: 'zsh', shellIntegration: true });
  assert.equal(await ended, 19);
  assert.ok(output.includes('Custom23 > '));
  assert.ok(output.includes(osc(133, 'C') + 'PROFILE=0123 STATUS=23'));
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(home, file), 'utf8')), before);
});

test('Bash loads its login profile and passes the same status to its prompt hook and next command', {
  skip: process.platform === 'win32' || !fs.existsSync('/bin/bash'), timeout: 12000,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "brclio-bash' space "));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.bash_profile');
  const profile = "FROM_PROFILE=yes\nPS1='MyPrompt> '\n";
  fs.writeFileSync(file, profile);
  const id = randomUUID();
  let output = '', phase = 0, done, fail;
  const ended = new Promise((resolve, reject) => { done = resolve; fail = reject; });
  const sessions = createPtyService({ home,
    launch: dir => forkService(dir, { ...process.env, HOME: home, HISTFILE: '/dev/null',
      PROMPT_COMMAND: 'printf "CUSTOM=%d " "$?"' }),
    send(channel, event) {
      if (channel === 'exit') { done(event.exitCode); return; }
      output += event.data;
      sessions.ack(id, event.data.length);
      if (!phase && output.includes(osc(133, 'B'))) {
        phase++;
        sessions.write(id, "sh -c 'exit 23'\r").catch(fail);
      } else if (phase === 1 && output.indexOf(osc(133, 'B')) !== output.lastIndexOf(osc(133, 'B'))) {
        // Readline can enable bracketed paste between PROMPT_COMMAND and PS1.
        // Wait for the next complete prompt independently of its display bytes.
        phase++;
        sessions.write(id, "printf 'PROFILE=%s STATUS=%d\\n' \"$FROM_PROFILE\" \"$?\"; exit 19\r").catch(fail);
      }
    },
  });
  t.after(() => sessions.closeAll());
  await sessions.create({ id, profile: 'bash', shellIntegration: true });
  assert.equal(await ended, 19);
  assert.ok(output.includes('CUSTOM=23 '), 'Existing prompt hook received the command exit status');
  assert.ok(output.includes('MyPrompt> '), 'Original login profile prompt remained active');
  assert.ok(output.includes('PROFILE=yes STATUS=23'));
  assert.equal(fs.readFileSync(file, 'utf8'), profile);
});

test('Windows PowerShell wraps an existing prompt and reader, keeps native exit status and emits command boundaries', {
  skip: process.platform !== 'win32',
}, () => {
  const { spawnSync } = require('node:child_process');
  const filename = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const startup = shellArguments(filename, 'win32', true, {});
  assert.deepEqual(startup.slice(0, 2), ['-NoExit', '-Command']);
  const result = spawnSync(filename, ['-NoProfile', '-NonInteractive', '-Command', [
    'function global:prompt { "CustomPrompt>" }',
    'function global:PSConsoleHostReadLine { "my command" }',
    startup[2],
    '[Console]::Write((prompt))',
    '[Console]::Write((PSConsoleHostReadLine))',
    'cmd.exe /d /c exit 23',
    '[Console]::Write((prompt))',
    '[Console]::Write(("NativeExit=" + $LASTEXITCODE))',
    'exit 19',
  ].join('\n')], { encoding: 'utf8', timeout: 12000 });
  assert.equal(result.status, 19, result.stderr);
  assert.ok(result.stdout.includes(osc(133, 'A') + 'CustomPrompt>' + osc(133, 'B')), result.stdout);
  assert.ok(result.stdout.includes(osc(133, 'C') + 'my command'), result.stdout);
  assert.ok(result.stdout.includes(osc(133, 'D;1')), result.stdout);
  assert.ok(result.stdout.includes('NativeExit=23'), result.stdout);
});

test('opt-in command search captures visible shell input between B and C across wraps without recording interactive prompts or output', async t => {
  const terminal = new Terminal({ allowProposedApi:true, cols:12, rows:8 });
  const commands = [];
  let enabled = false;
  const marks = attach(terminal,undefined,{ enabled:() => enabled, add:text => commands.push(text) });
  t.after(() => { marks.dispose(); terminal.dispose(); });
  const prompt = osc(133,'A') + '$ ' + osc(133,'B');
  const run = input => prompt + input + '\r\n' + osc(133,'C') + 'Password: \r\noutput\r\n' + osc(133,'D;0');
  await write(terminal,run('before'));
  enabled = true;
  await write(terminal,run('echo example command'));
  await write(terminal,prompt + 'aborted\r\n' + osc(133,'D;130'));
  assert.deepEqual(commands,['echo example command']);
});

test('prompt completion reads only the live visible prefix at the end of a marked command', async t => {
  const terminal = new Terminal({allowProposedApi:true,cols:12,rows:8});
  const marks = attach(terminal,undefined,{enabled:() => false, suggestions:() => true});
  t.after(() => { marks.dispose(); terminal.dispose(); });
  assert.equal(marks.inputPrefix(),undefined);
  await write(terminal,osc(133,'A') + '$ ' + osc(133,'B') + 'git st');
  assert.equal(marks.inputPrefix(),'git st');
  await write(terminal,'\x1b[D');
  assert.equal(marks.inputPrefix(),undefined);
  await write(terminal,'\x1b[C\r\n' + osc(133,'C') + 'Password: ');
  assert.equal(marks.inputPrefix(),undefined);
});

test('a line editor can erase the accepted visible line before preexec without recording concealed text or abandoned input', async t => {
  const terminal = new Terminal({allowProposedApi:true, cols:30, rows:8});
  const commands = [];
  const marks = attach(terminal,undefined,{enabled:() => true,add:value => commands.push(value)});
  t.after(() => { marks.dispose(); terminal.dispose(); });
  const prompt = osc(133,'A') + '$ ' + osc(133,'B');
  await write(terminal,prompt + 'pwd');
  marks.acceptVisibleInput();
  await write(terminal,'\r\x1b[2K\r\n' + osc(133,'C') + osc(133,'D;0'));
  await write(terminal,prompt + '\x1b[8mhidden value\x1b[0m');
  assert.equal(marks.inputPrefix(),undefined);
  marks.acceptVisibleInput();
  await write(terminal,'\r\n' + osc(133,'C') + osc(133,'D;0'));
  await write(terminal,prompt + 'never submitted');
  marks.acceptVisibleInput();
  await write(terminal,'\r\n' + osc(133,'D;130'));
  assert.deepEqual(commands,['pwd']);
});

test('legacy Bash records an echoed submission only when the next prompt reports an executed command', async t => {
  const terminal = new Terminal({allowProposedApi:true,cols:40,rows:12});
  const saved = [], marks = attach(terminal,undefined,{enabled:() => true,add:line => saved.push(line)});
  t.after(() => {marks.dispose();terminal.dispose();});
  const prompt = n => osc(133,'A') + '$ ' + osc(1337,'BrclioBashCommand=' + n) + osc(133,'B');
  await write(terminal,prompt(1) + 'pwd'); marks.acceptVisibleInput();
  assert.deepEqual(saved,[]);
  await write(terminal,'\r\n/tmp\r\n' + prompt(2));
  await write(terminal,'canceled'); marks.acceptVisibleInput();
  await write(terminal,'\r\n' + prompt(2));
  await write(terminal,'compound'); marks.acceptVisibleInput();
  await write(terminal,'\r\n> ' + osc(1337,'BrclioBashContinuation') + 'continuation'); marks.acceptVisibleInput();
  await write(terminal,'\r\n' + prompt(3));
  await write(terminal,'\x1b[8mconcealed\x1b[0m'); marks.acceptVisibleInput();
  await write(terminal,'\r\n' + prompt(4));
  await write(terminal,'read reply'); marks.acceptVisibleInput();
  await write(terminal,'\r\n' + 'visible reply'); marks.acceptVisibleInput();
  await write(terminal,'\r\n' + prompt(5));
  assert.deepEqual(saved,['pwd','read reply']);
});
