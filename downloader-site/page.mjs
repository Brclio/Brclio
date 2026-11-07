// Layout and color palette adapted from the Brclio Design System App template (CC BY-NC-SA 4.0).
function cards(doc) {
  if (!doc) return '<p class="error">暂时无法读取便捷版发布信息，请稍后刷新。</p>';
  return '<div class="files">' + doc.assets.map(file =>
    '<article class="file" id="' + file.id + '"><h3>' + file.label + '</h3><p>' + (file.size/1e6).toFixed(2) + ' MB · ' + (file.id.startsWith('mac') ? 'DMG' : 'EXE') + '</p>' +
    '<a class="download" href="/downloader/lite/' + file.id + '">下载便捷版 <span aria-hidden="true">↓</span></a>' +
    '<details><summary>SHA-256</summary><code>' + file.sha256 + '</code></details></article>').join('') + '</div>';
}
export function renderPage(lite,full) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brclio 下载器 · 官方下载</title>
<style>
:root{--cream:#fefcf6;--ink:#1a1a2e;--blue:#2364a8;--yellow:#f4d758;--line:#d9d5c7;--muted:#535363}
*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}::selection{background:var(--yellow)}
header,main,footer{max-width:940px;margin:auto;padding:0 clamp(20px,5vw,52px)}header{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-top:14px;padding-bottom:14px}header a{color:var(--ink);text-decoration:none;font:italic 700 29px Georgia,serif}header span{color:var(--muted);font-size:14px}
main{padding-top:clamp(28px,6vw,60px)}h1,h2{font-family:Georgia,"Songti SC",SimSun,serif}h1{font-size:clamp(32px,5.8vw,48px);line-height:1.25;margin:0 0 13px}h2{font-size:24px;margin:0}p{margin:0 0 14px}.lead{max-width:42em;color:var(--muted)}section{margin:34px 0}.head{display:flex;align-items:baseline;gap:12px}.head span{font-size:14px;color:var(--muted)}.files{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px;margin:12px 0 16px}
.file{min-width:0;border:1px solid var(--line);border-radius:8px;padding:18px 16px;background:#fffcf5}.file h3{font-size:18px;line-height:1.45;margin:0}.file p,details,.hint{font-size:14px;color:var(--muted)}.file .download{display:inline-flex;gap:18px;align-items:center;padding:7px 13px;color:white;background:var(--blue);border-radius:5px;text-decoration:none;font-weight:600}.download:hover{background:#174a80}.download:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #997000;outline-offset:3px}details{margin-top:14px}summary{cursor:pointer}code{display:block;font:12px/1.6 ui-monospace,monospace;overflow-wrap:anywhere;margin-top:6px}.preferred{outline:2px solid var(--blue);outline-offset:-1px}.hint{margin-top:8px}.full{border-top:1px solid var(--line);padding-top:22px}.full p{color:var(--muted);margin-top:6px}.full nav{display:flex;flex-wrap:wrap;gap:18px}a{color:var(--blue)}.error{color:#943448}footer{padding-top:16px;padding-bottom:26px;color:var(--muted);font-size:13px}footer a{color:inherit}
</style>
<header><a href="/">Brclio.</a><span>官方下载</span></header><main><h1>Brclio 下载器</h1>
<p class="lead">没有 VPN？先从本站下载便捷版。打开后，它会选择可用线路，下载、校验并安装最新版 Brclio。</p>
<section><div class="head"><h2>便捷版</h2>${lite ? '<span>v'+lite.version+'</span>' : ''}</div>
${cards(lite)}
<p class="hint" id="hint">Mac 需要 macOS 13 或更新版本，在「关于本机」查看芯片。Windows x64 直接运行 EXE。</p>
</section>
<section class="full"><div class="head"><h2>完整版</h2>${full ? '<span>v'+full.version+'</span>' : ''}</div>
<p>如需独立桌面窗口，可从 GitHub 下载完整版。</p>
${full ? '<nav aria-label="完整版安装包">'+full.assets.map(f=>'<a href="/downloader/full/'+f.id+'">'+f.label+'</a>').join('')+'</nav>' : '<p class="error">暂时无法读取完整版发布信息，请稍后刷新。</p>'}
</section></main><footer>© Brclio · 页面设计采用 <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a></footer>
<script>
(async()=>{try{
 const ua=navigator.userAgentData;
 const platform=ua?.platform||navigator.platform||'';
 if(ua?.mobile || /iPhone|iPad|Android/i.test(navigator.userAgent))return;
 const hint=document.getElementById('hint');
 let id;
 if(/Mac|Win/i.test(platform)){
   const info=ua?.getHighEntropyValues?await ua.getHighEntropyValues(['architecture','bitness']):{};
   if(/Mac/i.test(platform) && info.architecture==='arm')id='mac-arm64';
   else if(/Mac/i.test(platform) && info.architecture==='x86')id='mac-x64';
   else if(/Win/i.test(platform) && ((info.architecture==='x86' && info.bitness==='64') || (!info.architecture && /Win64.*x64|WOW64/i.test(navigator.userAgent))))id='windows-x64';
 }
 const card=id&&document.getElementById(id);
 if(card){card.classList.add('preferred');hint.textContent='当前浏览器报告的平台为 '+card.querySelector('h3').textContent+'。'+hint.textContent}
}catch{}})();
</script></html>`;
}
