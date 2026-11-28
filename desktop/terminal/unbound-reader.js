'use strict';

(() => {
  const library = window.BrclioTerminalPartitions;
  const claimKey = 'brclio.terminal.unbound-claim.v1';
  // Only this inert page is created in the guest session. A pending move stays
  // reserved to its confirmed recipient if the application or account switches mid-copy.
  const canRead = owner => /^[a-f0-9]{64}$/.test(owner) && [null, owner].includes(localStorage.getItem(claimKey));
  window.BrclioUnboundReader = Object.freeze({
    available(owner) { return canRead(owner) && library.hasUnbound(); },
    claim(owner) {
      if (!canRead(owner) || !library.hasUnbound()) throw new Error('没有可移入当前账号的本机资料。');
      const snapshot = library.snapshotUnbound();
      localStorage.setItem(claimKey, owner);
      return snapshot;
    },
    commit(owner, snapshot) {
      if (localStorage.getItem(claimKey) !== owner) throw new Error('本机迁移归属已变化。');
      if (!library.clearUnboundIfMatches(snapshot)) return false;
      localStorage.removeItem(claimKey);
      return true;
    },
    release(owner) {
      if (localStorage.getItem(claimKey) === owner) localStorage.removeItem(claimKey);
    },
  });
})();
