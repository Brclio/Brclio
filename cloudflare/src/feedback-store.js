import {createPrivateRecordStore} from './account-store.js';

export const feedbackRepository = 'BrclioData/BrclioLogData';
export const indexHeadPath = 'feedback/v1/index/head.json';
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const pageSize = 40;
export const historySize = 50;

export function reportDirectory(id) {
  if (!uuidPattern.test(id)) throw new Error('Invalid report ID');
  return `feedback/v1/reports/${id.slice(0, 2)}/${id}`;
}
export const indexPagePath = page => `feedback/v1/index/${String(page).padStart(8, '0')}.json`;
export const historyPath = (directory, page) => `${directory}/history/${String(page).padStart(6, '0')}.json`;

function validateFeedbackPath(path) {
  if (path === indexHeadPath || /^feedback\/v1\/index\/[0-9]{8}\.json$/.test(path)) return;
  const match = /^feedback\/v1\/reports\/([0-9a-f]{2})\/([0-9a-f-]{36})\/(report\.json|logs\/\d{4}-\d{2}-\d{2}\.json|history\/[0-9]{6}\.json)$/.exec(path);
  if (!match || !uuidPattern.test(match[2]) || !match[2].startsWith(match[1])) throw new Error('Invalid feedback record path');
}

export function createFeedbackStore(env, fetchImpl = fetch, tokenProvider) {
  return createPrivateRecordStore(env, {
    repo: feedbackRepository, validatePath: validateFeedbackPath, manifestPath: indexHeadPath,
    // A full seven-day window can span eight UTC days. Two CAS attempts leave
    // room for account authentication and both scoped token exchanges on Free.
    commitMessage: 'Update Brclio feedback records', cacheMetadata: false, maxAttempts: 2,
    attachmentPath: path => path.includes('/logs/')
  }, fetchImpl, tokenProvider);
}
