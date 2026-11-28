'use strict';
const {expect}=require('@playwright/test');
const assert=require('node:assert/strict');
async function verifyCloudCopy(app,term,local) {
  await app.evaluate(({net,dialog})=>{
    let entry,blob,revision=0;
    const response=value=>new Response(JSON.stringify({userId:'fixture-log-user',...value}),{headers:{'Content-Type':'application/json'}});
    net.fetch=async (address,options)=>{
      const request=JSON.parse(options.body || '{}');
      if (!String(address).includes('/api/account/apps/terminal/')) throw new Error('offline');
      if (String(address).endsWith('/shared-vaults')) return response({vaults:[]});
      if (!String(address).endsWith('/log-copies')) throw new Error('unexpected route');
      if (request.expectedUserId!=='fixture-log-user' || request.scope!==null || JSON.stringify(request).includes('BRCLIO-LOG-OUTPUT') ||
          JSON.stringify(request).includes('fixture test passphrase')) throw new Error('Cloud request included private material or wrong audience');
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
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(local.getByRole('textbox',{name:'日志内容'})).toHaveValue(/BRCLIO-LOG-OUTPUT/);
}
module.exports={verifyCloudCopy};
