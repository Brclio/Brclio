'use strict';
const {expect}=require('@playwright/test');
const assert=require('node:assert/strict');
async function verifyCloudCopy(app,term,local) {
  await app.evaluate(({net,dialog})=>{
    let entry,blob,revision=0,teamRevision=0,maximumDays=30;
    const teams=[
      {state:'active',vaultId:'05f01538-337c-4f52-957a-e6fa9d5b3521',ownerId:'fixture-log-user',role:'owner',name:'Owned',ownerName:'Fixture'},
      {state:'active',vaultId:'9f2f7a9f-4b23-47df-a79d-da42ff16c323',ownerId:'other-fixture',role:'reader',name:'Read only',ownerName:'Other'}];
    const response=value=>new Response(JSON.stringify({userId:'fixture-log-user',...value}),{headers:{'Content-Type':'application/json'}});
    net.fetch=async (address,options)=>{
      const request=JSON.parse(options.body || '{}');
      if (!String(address).includes('/api/account/apps/terminal/')) throw new Error('offline');
      if (String(address).endsWith('/shared-vaults')) return response({vaults:teams});
      if (!String(address).endsWith('/log-copies')) throw new Error('unexpected route');
      if (request.expectedUserId!=='fixture-log-user' || JSON.stringify(request).includes('BRCLIO-LOG-OUTPUT') ||
          JSON.stringify(request).includes('fixture test passphrase')) throw new Error('Cloud request included private material or wrong audience');
      if (request.scope) {
        const team=teams.find(team=>team.vaultId===request.scope.vaultId && team.ownerId===request.scope.ownerId);
        if (!team) throw new Error('Wrong team');
        const result=()=>response({role:team.role,revision:teamRevision,entries:[],maximumDays});
        if (request.action==='list') return result();
        if (team.role!=='owner') throw new Error('Reader attempted owner-only action');
        if (request.action==='policy' && request.revision===teamRevision) {
          teamRevision++;maximumDays=request.days;return result();
        }
        if (request.action==='audit') return response({events:[{actor:'fixture-team-reader',event:'read-copy',
          id:'622a503d-b7d8-4788-8ab9-7f81b62df220',time:Date.now()}]});
        throw new Error('Unexpected team operation');
      }
      if (request.action==='list') return response({role:'owner',revision,entries:entry?[entry]:[]});
      if (request.action==='publish' && request.revision===revision && request.blob?.version===1) {
        entry={id:request.id,name:request.name,host:request.host,authorId:'fixture-log-user',authorName:'Fixture',publishedAt:Date.now(),expiresAt:Date.now()+86400000};
        blob=request.blob;revision++;
        return response({role:'owner',revision,entries:[entry]});
      }
      if (request.action==='read' && entry?.id===request.id) return response({entry,blob});
      if (request.action==='remove' && entry?.id===request.id && request.revision===revision) {
        entry=null;blob=null;revision++;return response({revision,entries:[],role:'owner'});
      }
      throw new Error('unexpected mutation');
    };
    dialog.showMessageBox=async (_,options)=>{
      if (!options.message?.includes('fixture recording') || options.defaultId!==0) throw new Error('Consent prompt missing');
      return {response:1};
    };
  });
  await local.getByRole('button',{name:'云端日志副本'}).click();
  const dialog=term.getByRole('dialog',{name:'云端日志副本'});
  const password=dialog.locator('input[type=password]'), output=dialog.getByRole('textbox',{name:'解密的日志内容'});
  await password.fill('fixture test passphrase');
  await dialog.getByRole('button',{name:'上传所选本机日志…'}).click();
  await expect(dialog.getByRole('status')).toHaveText('加密副本已上传。');
  await expect(output).toHaveValue('');
  await expect(password).toHaveValue('');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await local.getByRole('button',{name:'云端日志副本'}).click();
  await password.fill('fixture test passphrase');
  await dialog.getByRole('button',{name:'解密查看'}).click();
  await expect(output).toHaveValue(/BRCLIO-LOG-OUTPUT/);
  await dialog.getByRole('combobox',{name:'云端日志书签'}).selectOption({label:'Command output'});
  assert.ok(await output.evaluate(el=>el.selectionStart>0));
  await dialog.getByRole('button',{name:'删除此云端副本'}).click();
  await dialog.getByRole('button',{name:'确认删除'}).click();
  await expect(dialog.getByRole('listbox',{name:'云端日志'}).locator('option')).toHaveCount(0);
  const scope=dialog.getByRole('combobox',{name:'日志访问范围'}), disclosure=dialog.locator('details');
  const ttl=dialog.getByRole('combobox',{name:'副本可访问期限'}), audit=dialog.getByRole('list',{name:'取回记录'});
  await scope.selectOption({label:'共享主机库 · Owned · Fixture'});
  await expect(disclosure).toBeVisible();
  await disclosure.locator('summary').click();
  await expect(ttl.locator('option[value="90"]')).toHaveJSProperty('disabled',true);
  await dialog.getByRole('combobox',{name:'新副本留存上限'}).selectOption('1');
  await dialog.getByRole('button',{name:'保存新副本留存上限'}).click();
  await expect(dialog.getByRole('status')).toHaveText('已应用至之后发布的副本。');
  await expect(ttl).toHaveValue('1');
  await expect(ttl.locator('option[value="7"]')).toHaveJSProperty('disabled',true);
  await dialog.getByRole('button',{name:'读取最近 64 条取回记录'}).click();
  await expect(audit).toContainText('fixture-team-reader · 取回加密副本 · 622a503d-b7d8-4788-8ab9-7f81b62df220');
  await scope.selectOption({label:'共享主机库 · Read only · Other'});
  await expect(disclosure).toBeHidden();
  await expect(disclosure.locator('li')).toHaveCount(0);
  await expect(dialog.getByText(/取回密文时记录账号/)).toBeVisible();
  await scope.selectOption({label:'仅我的 Brclio 账号'});
  await expect(dialog.getByText(/取回密文时记录账号/)).toHaveCount(0);
  await expect(ttl.locator('option[value="365"]')).toHaveJSProperty('disabled',false);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(local.getByRole('textbox',{name:'日志内容'})).toHaveValue(/BRCLIO-LOG-OUTPUT/);
}
module.exports={verifyCloudCopy};
