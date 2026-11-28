'use strict';
const route = '/api/account/apps/terminal/shared-vaults';
function registerSharedVault({handle, accountRequest, localUser, scope}) {
  handle('shared-vault', async (action, payload = {}) => {
    const original = scope();
    if (!original?.userId || original.temporary) throw new Error('请先登录 Brclio，再进入共享主机库。');
    if (original.userId !== (await localUser())?.id || original !== scope()) throw new Error('登录账号已变化，请重新打开终端。');
    const response = await accountRequest({path:route, method:'POST', body:{...payload, action, expectedUserId:original.userId}});
    if (response.userId !== original.userId || original !== scope() || (await localUser())?.id !== original.userId || original !== scope())
      throw new Error('登录账号已变化，请重新打开终端。');
    return response;
  });
}
module.exports = {registerSharedVault};
