import {officialTarget} from './protocol.js';
import {githubInstallationToken} from './github-app.js';

export const latestReleaseURL = 'https://api.github.com/repos/Brclio/Brclio/releases/latest';
const repositoryURL = 'https://github.com/Brclio/Brclio';
const platforms = [
  ['mac-arm64', 'mac-arm64.dmg'],
  ['mac-x64', 'mac-x64.dmg'],
  ['windows-x64', 'windows-x64.exe'],
  ['android', 'android.apk']
];
const failureCodes = new Set(['release_upstream_status', 'release_upstream_rate_limited', 'release_empty_body',
  'release_fetch_timeout', 'release_fetch_failed', 'release_auth_unavailable', 'release_body_read_failed', 'release_invalid_json',
  'release_too_large', 'invalid_release', 'invalid_asset', 'invalid_manifest', 'duplicate_asset', 'missing_installers']);
function failure(code, upstreamStatus) {
  return Object.assign(new Error(code.startsWith('release_upstream_') ? 'release_unavailable' : code),
    {code, ...(Number.isInteger(upstreamStatus) ? {upstreamStatus} : {})});
}
// Never log upstream bodies, headers, URLs, credentials or exception messages.
export function releaseFailureDetails(error) {
  const code = failureCodes.has(error?.code) ? error.code : 'release_unknown';
  const status = error?.upstreamStatus;
  return {code, ...(['release_upstream_status', 'release_upstream_rate_limited'].includes(code)
    && Number.isInteger(status) && status >= 100 && status <= 599 ? {upstreamStatus: status} : {})};
}

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

export async function readReleaseDocument(response) {
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    const limited = response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
    throw failure(limited ? 'release_upstream_rate_limited' : 'release_upstream_status', response.status);
  }
  if (!response.body) throw failure('release_empty_body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 1024 * 1024) throw failure('release_too_large');
      text += decoder.decode(item.value, {stream: true});
    }
    let metadata;
    try { metadata = JSON.parse(text + decoder.decode()); }
    catch { throw failure('release_invalid_json'); }
    try { return {metadata, summary: releaseSummary(metadata)}; }
    catch (error) { throw failure(failureCodes.has(error?.message) ? error.message : 'invalid_release'); }
  } catch (error) {
    if (failureCodes.has(error?.code)) throw error;
    throw failure('release_body_read_failed');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readReleaseResponse(response) {
  return (await readReleaseDocument(response)).summary;
}

let releaseCache;
export function clearReleaseCache() { releaseCache = undefined; }
export async function getOfficialRelease(env, fetchImpl = fetch, tokenProvider = githubInstallationToken) {
  if (releaseCache?.expires > Date.now()) return releaseCache.value;
  const headers = {Accept: 'application/vnd.github+json', 'User-Agent': 'Brclio-Client-Services', 'X-GitHub-Api-Version': '2022-11-28'};
  if (['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_PROGRAM_DATA_REPOSITORY']
    .every(name => typeof env?.[name] === 'string' && env[name].length > 0)) {
    // Reuse the existing program-repository scope only for this fixed public
    // GitHub GET. Never fall back to the account repository or forward redirects.
    try { headers.Authorization = 'Bearer ' + await tokenProvider(env, env.GITHUB_PROGRAM_DATA_REPOSITORY, fetchImpl); }
    catch { throw failure('release_auth_unavailable'); }
  }
  let response;
  try {
    response = await fetchImpl(latestReleaseURL, {redirect: 'manual', signal: AbortSignal.timeout(5000), headers});
  } catch (error) {
    throw failure(['TimeoutError', 'AbortError'].includes(error?.name) ? 'release_fetch_timeout' : 'release_fetch_failed');
  }
  const value = await readReleaseDocument(response);
  releaseCache = {expires: Date.now() + 60000, value};
  return value;
}
