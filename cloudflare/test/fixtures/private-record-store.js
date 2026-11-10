import assert from 'node:assert/strict';
import {createAccountStore} from '../../src/account-store.js';
import {createFeedbackStore, feedbackRepository} from '../../src/feedback-store.js';

let fixtureId = 0;
export const encode = content => ({encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64')});
export function repositoryFixture(initial = {}, intercept, kind = "account") {
  let head = 'commit-0', sequence = 0;
  const first = new Map(Object.entries(initial).map(([path, value]) => [path, typeof value === 'string' ? value : JSON.stringify(value)]));
  const trees = new Map([['tree-0', first]]), commits = new Map([['commit-0', {tree: {sha: 'tree-0'}, parents: []}]]);
  const calls = [], updates = [], env = {GITHUB_DATA_REPOSITORY: 'fixture/account-store-' + (++fixtureId), GITHUB_PROGRAM_DATA_REPOSITORY: 'fixture/program-data-must-not-be-used'};
  const repository = kind === 'feedback' ? feedbackRepository : env.GITHUB_DATA_REPOSITORY;
  const current = () => trees.get(commits.get(head).tree.sha);
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), prefix = '/repos/' + repository;
    assert.ok(parsed.pathname === prefix || parsed.pathname.startsWith(prefix + '/'), 'all reads and writes stay in the selected repository');
    const path = parsed.pathname.slice(prefix.length);
    const body = options.body && JSON.parse(options.body), call = {path, method: options.method, body, ref: parsed.searchParams.get('ref'), accept: options.headers.Accept};
    calls.push(call);
    const intercepted = await intercept?.(call);
    if (intercepted) return intercepted;
    if (!path) return Response.json({private: true, default_branch: 'main'});
    if (path === '/git/ref/heads/main') return Response.json({object: {sha: head}});
    if (path.startsWith('/contents/')) {
      const content = trees.get(commits.get(call.ref).tree.sha).get(path.slice('/contents/'.length));
      return content === undefined ? new Response(null, {status: 404}) : Response.json(encode(content));
    }
    if (path.startsWith('/git/commits/')) return Response.json(commits.get(path.slice('/git/commits/'.length)));
    if (path === '/git/trees') {
      const next = new Map(trees.get(body.base_tree)), sha = 'tree-' + (++sequence);
      for (const entry of body.tree) {
        assert.equal(entry.mode, '100644'); assert.equal(entry.type, 'blob');
        next.set(entry.path, entry.content);
      }
      trees.set(sha, next); return Response.json({sha});
    }
    if (path === '/git/commits') {
      const sha = 'commit-' + (++sequence);
      commits.set(sha, {...body, tree: {sha: body.tree}}); return Response.json({sha});
    }
    if (path === '/git/refs/heads/main') {
      assert.equal(body.force, false, 'ref updates must never force overwrite another application');
      if (commits.get(body.sha).parents[0] !== head) return new Response(null, {status: 422});
      head = body.sha; updates.push(new Map(current())); return Response.json({object: {sha: head}});
    }
    throw new Error('Unexpected repository request: ' + path);
  };
  const tokenProvider = async (received, scope, transport) => { assert.equal(received, env); assert.equal(scope, repository); assert.equal(transport, fetchImpl); return 'fixture-installation-token'; };
  const factory = kind === 'feedback' ? createFeedbackStore : createAccountStore;
  return {store: factory(env, fetchImpl, tokenProvider), calls, updates, current, read: path => JSON.parse(current().get(path))};
}
