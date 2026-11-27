export async function githubIdentity(code, verifier, redirectUri, env, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(15000);
  const exchange = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'manual', signal,
    headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code, code_verifier: verifier, redirect_uri: redirectUri
    })
  });
  if (!exchange.ok) {
    await exchange.body?.cancel();
    throw new Error('GitHub authorization failed');
  }
  const token = await exchange.json();
  if (token?.token_type?.toLowerCase() !== 'bearer' || typeof token.access_token !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/.test(token.access_token)) throw new Error('Invalid GitHub authorization');

  async function read(path) {
    const response = await fetchImpl('https://api.github.com' + path, {
      redirect: 'manual', signal, headers: {
        Authorization: 'Bearer ' + token.access_token, Accept: 'application/vnd.github+json',
        'User-Agent': 'Brclio-Accounts', 'X-GitHub-Api-Version': '2026-03-10'
      }
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('GitHub account details unavailable');
    }
    return response.json();
  }

  const profile = await read('/user');
  if (!Number.isSafeInteger(profile?.id) || profile.id <= 0) throw new Error('Invalid GitHub account ID');
  // Even a public profile email lacks verification metadata. Use the email API for linking.
  for (let page = 1; ; page++) {
    const emails = await read('/user/emails?per_page=100&page=' + page);
    if (!Array.isArray(emails)) throw new Error('Invalid GitHub email response');
    const primary = emails.find(item => item?.primary === true);
    if (primary?.verified === true && typeof primary.email === 'string' && primary.email.trim()) {
      return {
        sub: String(profile.id), email: primary.email.trim().toLowerCase(),
        picture: typeof profile.avatar_url === 'string' && profile.avatar_url.startsWith('https://') ? profile.avatar_url : null
      };
    }
    if (primary || emails.length < 100) throw new Error('GitHub requires a verified primary email');
  }
}
