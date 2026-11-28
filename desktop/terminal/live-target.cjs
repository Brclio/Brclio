'use strict';
// An installed beta can only send account authentication to Brclio's existing
// account origin. Only the opaque room ticket can use the isolated test loopback socket.
function liveTarget() {
  if (process.env.BRCLIO_TERMINAL_LIVE_BETA !== '1') return null;
  const port = process.env.BRCLIO_TERMINAL_LIVE_TEST_PORT;
  if (port && process.env.BRCLIO_USER_DATA && !require('electron').app?.isPackaged &&
      /^\d{1,5}$/.test(port) && +port > 0 && +port <= 65535) return 'http://127.0.0.1:' + port;
  return 'https://tools.brclio.com';
}
module.exports = {liveTarget};
