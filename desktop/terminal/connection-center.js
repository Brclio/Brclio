'use strict';

window.BrclioConnectionCenter = { bind({ api, newTab }) {
  const $ = id => document.getElementById(id);
  const center = $('connection-dialog'), devices = $('device-dialog'), kind = $('device-kind');
  $('connection-center').onclick = () => center.showModal();
  $('connection-close').onclick = () => center.close();
  $('device-close').onclick = () => devices.close();
  const open = {
    hosts: () => window.BrclioRemoteConnections.open(),
    files: () => window.BrclioRemoteConnections.open('files'),
    forward: () => window.BrclioForwardControls.open(),
    logs: () => window.BrclioLocalLogs.open(),
    trust: () => window.BrclioKnownHosts.open(),
    commands: () => window.BrclioCommandLibrary.open(),
    importHosts: () => window.BrclioHostImportDialog.open(),
    identities: () => window.BrclioIdentityControls.open(),
    sync: () => window.BrclioTerminalSync.open(),
    sharing: () => window.BrclioSharedVaults.open(),
    devices: () => { devices.showModal(); showProtocol(); },
    passwords: () => {
      $('terminal-actions').click();
      $('vault-controls').open = true;
      $('vault-controls').scrollIntoView({block:'start'});
    },
  };
  for (const button of center.querySelectorAll('[data-center]')) {
    button.onclick = () => { center.close(); open[button.dataset.center](); };
  }
  async function refresh() {
    const field = $('serial-device');
    const previous = field.value;
    try {
      const ports = await api.serialPorts();
      field.replaceChildren(...ports.map(port => new Option(port, port)));
      if (ports.includes(previous)) field.value = previous;
      if (kind.value === 'serial') {
        $('device-feedback').textContent = ports.length ? '' : '未找到串口设备。接入设备后可刷新。';
        $('device-connect').disabled = !ports.length;
      }
    } catch (error) {
      if (kind.value === 'serial') { $('device-feedback').textContent = error.message; $('device-connect').disabled = true; }
    }
  }
  function showProtocol() {
    const serial = kind.value === 'serial', mosh = kind.value === 'mosh';
    $('serial-fields').hidden = $('serial-fields').disabled = !serial;
    $('network-fields').hidden = $('device-host').disabled = $('device-port').disabled = serial;
    $('device-user-row').hidden = $('device-user').disabled = !mosh;
    $('device-port').placeholder = mosh ? 'SSH 配置或 22' : '23';
    $('device-feedback').textContent = '';
    $('device-help').textContent = serial ? '' : mosh ?
      (api.platform === 'win32' ? '需要默认 WSL 发行版中的 mosh 和远端 mosh-server。' : '需要本机 mosh 和远端 mosh-server。') :
      'Telnet 以明文传输输入和输出。';
    $('device-connect').disabled = serial;
    if (serial) void refresh();
  }
  kind.onchange = showProtocol;
  $('serial-refresh').onclick = refresh;
  $('device-form').onsubmit = event => {
    event.preventDefault();
    try {
      const profile = kind.value;
      const connection = profile === 'serial' ? {device:$('serial-device').value, baudRate:$('serial-baud').valueAsNumber,
        dataBits:Number($('serial-bits').value), stopBits:Number($('serial-stop').value), parity:$('serial-parity').value,
        rtscts:$('serial-flow').checked} : window.BrclioConnection.endpoint({
          host:$('device-host').value, port:$('device-port').value, user:profile === 'mosh' ? $('device-user').value : '',
        });
      devices.close();
      newTab(kind.selectedOptions[0].text + ' · ' + (connection.host || connection.device), {profile, connection, shellIntegration:false});
    } catch (error) { $('device-feedback').textContent = error.message; }
  };
} };
