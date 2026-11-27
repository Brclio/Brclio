import {createPrivateRecordStore} from './account-store.js';
import {feedbackRepository, uuidPattern} from './feedback-store.js';

const root = 'suggestions/v1';
export const headPath = root + '/index/head.json';
export const indexPath = page => root + '/index/' + page + '.json';
export const topicDirectory = id => root + '/topics/' + id.slice(0, 2) + '/' + id;
export const commentPagePath = (directory, page) => directory + '/comments/' + page + '.json';

function validatePath(path) {
  if (path === headPath || /^suggestions\/v1\/index\/[1-9][0-9]{0,7}\.json$/.test(path)) return;
  const topic = /^suggestions\/v1\/topics\/([a-f0-9]{2})\/([a-f0-9-]{36})\/(.+)$/.exec(path);
  if (topic && uuidPattern.test(topic[2]) && topic[2].startsWith(topic[1])) {
    const file = topic[3];
    if (file === 'location.json' || /^ratings\/[A-Za-z0-9_-]{43}\.json$/.test(file) || /^comments\/[1-9][0-9]{0,7}\.json$/.test(file)) return;
    const receipt = /^comments\/by-id\/([a-f0-9-]{36})\.json$/.exec(file);
    if (receipt && uuidPattern.test(receipt[1])) return;
  }
  throw new Error('Invalid suggestion record path');
}

export function createSuggestionStore(env, fetchImpl = fetch, tokenProvider) {
  return createPrivateRecordStore(env, {
    repo: feedbackRepository, validatePath, manifestPath: headPath, cacheMetadata: false,
    maxAttempts: 3, commitMessage: 'Update Brclio feature suggestions'
  }, fetchImpl, tokenProvider);
}
