'use strict';

window.BrclioTabGroups = function installTabGroups({ tabs, activeTab, selectTab, clearSelection }) {
  const byId = id => document.getElementById(id);
  const groupName = byId('group-name');
  const groupList = byId('group-list');
  const hiddenList = byId('hidden-tabs');
  const visibleTabs = () => [...tabs.values()].filter(tab => !tab.header.hidden);

  function render() {
    const current = activeTab();
    const groups = [...new Set([...tabs.values()].map(tab => tab.group).filter(Boolean))];
    const chosen = groupList.value;
    groupList.replaceChildren(...groups.map(name => new Option(name, name)));
    if (groups.includes(chosen)) groupList.value = chosen;
    else if (current?.group) groupList.value = current.group;
    groupName.value = current?.group || '';
    byId('group-set').disabled = byId('tab-hide').disabled = !current;
    byId('group-hide').disabled = byId('group-show').disabled = !groups.length;
    hiddenList.replaceChildren(...[...tabs.values()].filter(tab => tab.header.hidden)
      .map(tab => new Option(tab.name.textContent, String(tab.number))));
    byId('tab-show').disabled = !hiddenList.options.length;
  }

  function hide(targets) {
    for (const tab of targets) tab.header.hidden = true;
    if (activeTab()?.header.hidden) {
      const next = visibleTabs()[0];
      if (next) selectTab(next, false);
      else clearSelection();
    }
    render();
  }

  byId('group-set').onclick = () => {
    const tab = activeTab();
    if (!tab) return;
    tab.group = groupName.value.trim().slice(0, 64);
    tab.header.dataset.group = tab.group;
    render();
    groupList.value = tab.group;
  };
  byId('tab-hide').onclick = () => { if (activeTab()) hide([activeTab()]); };
  byId('group-hide').onclick = () => hide([...tabs.values()].filter(tab => tab.group && tab.group === groupList.value));
  byId('group-show').onclick = () => {
    const members = [...tabs.values()].filter(tab => tab.group === groupList.value);
    for (const tab of members) tab.header.hidden = false;
    if (members.length) selectTab(members[0], false);
    render();
  };
  byId('tab-show').onclick = () => {
    const tab = tabs.get(Number(hiddenList.value));
    if (tab) { byId('actions-dialog').close(); selectTab(tab); }
    render();
  };
  byId('empty-recall').onclick = () => {
    byId('terminal-actions').click();
    byId('actions-filter').value = '隐藏标签';
    byId('actions-filter').dispatchEvent(new Event('input'));
    hiddenList.focus();
  };
  return { render, visibleTabs };
};
