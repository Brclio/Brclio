import {officialTarget} from './protocol.js';

export const latestReleaseURL = 'https://api.github.com/repos/Brclio/Brclio/releases/latest';
const repositoryURL = 'https://github.com/Brclio/Brclio';
const platforms = [
  ['mac-arm64', 'mac-arm64.dmg'],
  ['mac-x64', 'mac-x64.dmg'],
  ['windows-x64', 'windows-x64.exe'],
  ['android', 'android.apk']
];

// Return only stable, official download metadata. Never forward arbitrary release fields.
export function releaseSummary(release) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(release?.tag_name || '');
  if (!match || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets) || release.assets.length > 128) throw new Error('invalid_release');
  const tag = release.tag_name, version = match.slice(1).join('.');
  const releaseURL = `${repositoryURL}/releases/tag/${tag}`;
  const published = new Date(release.published_at);
  if (release.html_url !== releaseURL || typeof release.published_at !== 'string' || !Number.isFinite(published.getTime())) throw new Error('invalid_release');
  const downloadBase = `${repositoryURL}/releases/download/${tag}/`;
  function assetURL(asset, limit) {
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit || typeof asset.name !== 'string') throw new Error('invalid_asset');
    const url = officialTarget(asset.browser_download_url);
    if (url.href !== downloadBase + encodeURIComponent(asset.name)) throw new Error('invalid_asset');
    return url.href;
  }
  const manifests = release.assets.filter(asset => asset?.name === 'SHA256SUMS.txt');
  if (manifests.length !== 1) throw new Error('invalid_manifest');
  const checksumURL = assetURL(manifests[0], 64 * 1024);
  const assets = [];
  for (const [platform, suffix] of platforms) {
    const name = `Brclio-${version}-${suffix}`;
    const matches = release.assets.filter(asset => asset?.name === name);
    if (matches.length > 1) throw new Error('duplicate_asset');
    if (matches.length) assets.push({name, size: matches[0].size, platform, url: assetURL(matches[0], 4 * 1024 * 1024 * 1024), checksumURL});
  }
  if (!assets.length) throw new Error('missing_installers');
  return {version, tag, publishedAt: published.toISOString(), releaseURL, assets};
}

export async function readReleaseResponse(response) {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('release_unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('release_too_large');
      text += decoder.decode(item.value, {stream: true});
    }
    return releaseSummary(JSON.parse(text + decoder.decode()));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
