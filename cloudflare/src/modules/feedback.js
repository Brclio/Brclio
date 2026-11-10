import {json, readJSON, rateLimit} from '../http.js';
import {boundedText, FeedbackInputError, submissionInput} from '../feedback-input.js';
import {createFeedbackStore, indexHeadPath, indexPagePath, pageSize, historySize, reportDirectory, historyPath, uuidPattern} from '../feedback-store.js';

export const metadata = Object.freeze({
  id: 'feedback', name: '问题反馈', description: '查看用户提交的软件问题、七天诊断日志与处理记录。', status: 'implemented'
});
const statuses = new Set(['open', 'in_progress', 'resolved', 'closed']);
const bodyLimit = 1024 * 1024;

function storage(env, dependencies) {
  return dependencies.feedbackStore || createFeedbackStore(env, dependencies.feedbackFetchImpl || dependencies.fetchImpl);
}
function summary(report) {
  const {id, title, category, status, createdAt, updatedAt, platform, appVersion, revision, logCount} = report;
  return {id, title, category, status, createdAt, updatedAt, platform, appVersion, revision, logCount};
}
function pageNumber(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 99999999;
}
function pageParameter(value) {
  if (!/^[1-9][0-9]{0,7}$/.test(value || '')) throw new FeedbackInputError('分页参数无效');
  return Number(value);
}
function issue(message, status) { throw new FeedbackInputError(message, status); }
function errorResponse(error) {
  if (error instanceof FeedbackInputError) return json({error: error.message}, error.status);
  return json({error: '反馈仓库暂不可用，请稍后重试。管理员可检查日志仓库是否为私有、是否已初始化并已授予 GitHub App 读写权限。'}, 503);
}
async function jsonBody(request, maxBytes) {
  try { return await readJSON(request, maxBytes); }
  catch (error) {
    if (error instanceof RangeError) issue('反馈请求超过大小上限', 413);
    issue('请求内容必须是有效 JSON', 400);
  }
}
function existingPage(page) {
  if (!Array.isArray(page?.items) || page.items.length < 1 || page.items.length > pageSize) throw new Error('Damaged feedback index');
  return page;
}
async function appendToIndex(tx, report) {
  const head = await tx.read(indexHeadPath);
  if (head && !pageNumber(head.page)) throw new Error('Damaged feedback index head');
  let number = head?.page || 1;
  let page = head ? existingPage(await tx.read(indexPagePath(number))) : null;
  if (page?.items.length === pageSize) { number++; page = null; }
  if (!pageNumber(number)) throw new Error('Feedback index full');
  if (!page) {
    if (await tx.read(indexPagePath(number))) throw new Error('Feedback index page occupied');
    page = {version: 1, items: []};
    tx.write(indexHeadPath, {version: 1, page: number});
  }
  page.items.unshift(summary(report));
  tx.write(indexPagePath(number), page);
  return number;
}

// Called after account session, same-origin and CSRF validation. Identity comes
// exclusively from the server's signed account session.
export async function submitFeedback(request, env, session, dependencies = {}) {
  if (request.method !== 'POST') return json({error: '只支持 POST 请求'}, 405, {Allow: 'POST'});
  try {
    if (!await rateLimit(env, 'ACCOUNT_AUTH_LIMITER', 'feedback:' + session.id, 10)) return json({error: '反馈过于频繁，请一分钟后重试'}, 429, {'Retry-After': '60'});
    const now = Date.now();
    const {logs, ...input} = submissionInput(await jsonBody(request, bodyLimit), now);
    const directory = reportDirectory(input.id);
    const days = new Map();
    for (const entry of logs) {
      const day = entry.time.slice(0, 10);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(entry);
    }
    const createdAt = new Date(now).toISOString();
    const result = await storage(env, dependencies).transaction(async tx => {
      const path = directory + '/report.json', stored = await tx.read(path);
      if (stored) {
        // A retry returns the original snapshot, even if new diagnostic entries
        // appeared since the first click or the administrator has processed it.
        if (stored.userId !== session.id || stored.title !== input.title || stored.description !== input.description || stored.category !== input.category) {
          issue('反馈编号已使用，请为新的反馈生成新编号', 409);
        }
        return {id: stored.id, status: stored.status, createdAt: stored.createdAt};
      }
      const report = {version: 1, ...input, userId: session.id, createdAt, updatedAt: createdAt, status: 'open', revision: 0,
        logDays: [...days.keys()], logCount: logs.length, repositoryPath: directory};
      report.indexPage = await appendToIndex(tx, report);
      tx.write(path, report);
      tx.write(historyPath(directory, 1), {version: 1, entries: [{at: createdAt, status: 'open', note: '', actor: 'reporter'}]});
      for (const [day, entries] of days) tx.write(directory + '/logs/' + day + '.json', {version: 1, entries});
      return {id: report.id, status: report.status, createdAt};
    });
    return json(result);
  } catch (error) { return errorResponse(error); }
}

// Feedback never has an anonymous listing or detail route.
export function handlePublic() { return null; }

async function listReports(store, cursor) {
  const state = await store.snapshot(), head = await state.read(indexHeadPath);
  if (!head) return {items: [], nextCursor: null};
  if (!pageNumber(head.page)) throw new Error('Damaged feedback index');
  const number = cursor === null ? head.page : pageParameter(cursor);
  if (number > head.page) issue('反馈列表分页不存在', 404);
  const page = existingPage(await state.read(indexPagePath(number)));
  return {items: page.items, nextCursor: number > 1 ? number - 1 : null};
}
async function getReport(state, directory) {
  const report = await state.read(directory + '/report.json');
  if (!report) issue('未找到这条反馈', 404);
  return report;
}
async function historyPage(state, directory, page) {
  const record = await state.read(historyPath(directory, page));
  if (!Array.isArray(record?.entries) || !record.entries.length || record.entries.length > historySize) throw new Error('Damaged feedback history');
  return record;
}
async function detail(store, directory, historyCursor) {
  const state = await store.snapshot(), report = await getReport(state, directory);
  const historyHead = Math.floor(report.revision / historySize) + 1;
  const page = historyCursor === null ? historyHead : pageParameter(historyCursor);
  if (page > historyHead) issue('处理记录分页不存在', 404);
  const [history, byDay] = await Promise.all([
    historyPage(state, directory, page),
    Promise.all(report.logDays.map(async day => {
      const record = await state.read(directory + '/logs/' + day + '.json');
      if (!Array.isArray(record?.entries)) throw new Error('Missing diagnostic attachment');
      return record.entries;
    }))
  ]);
  return {report, logs: byDay.flat(), history: history.entries, nextHistoryCursor: page > 1 ? page - 1 : null};
}
async function updateReport(request, store, directory) {
  const input = await jsonBody(request);
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0 || !statuses.has(input.status)) issue('处理状态或记录版本无效', 400);
  const note = boundedText(input.note, 2000, '处理说明', true);
  const at = new Date().toISOString();
  return store.transaction(async tx => {
    const report = await getReport(tx, directory);
    if (report.revision !== input.revision) issue('这条反馈已被更新，请刷新详情后重新处理', 409);
    if (input.status === report.status && !note) return {report};
    report.status = input.status; report.updatedAt = at; report.revision++;
    const number = Math.floor(report.revision / historySize) + 1;
    const history = report.revision % historySize === 0 ? {version: 1, entries: []} : await historyPage(tx, directory, number);
    history.entries.push({at, status: report.status, note, actor: 'admin'});
    const index = existingPage(await tx.read(indexPagePath(report.indexPage)));
    const i = index.items.findIndex(item => item.id === report.id);
    if (i < 0) throw new Error('Feedback missing from index');
    index.items[i] = summary(report);
    tx.write(indexPagePath(report.indexPage), index);
    tx.write(historyPath(directory, number), history);
    tx.write(directory + '/report.json', report);
    return {report};
  });
}

export async function handleAdmin(request, env, session, dependencies = {}) {
  const url = new URL(request.url), prefix = '/api/admin/feedback';
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return null;
  try {
    const store = storage(env, dependencies);
    if (url.pathname === prefix) {
      if (request.method !== 'GET') return json({error: '只支持 GET 请求'}, 405, {Allow: 'GET'});
      return json(await listReports(store, url.searchParams.get('cursor')));
    }
    const id = url.pathname.slice(prefix.length + 1);
    if (!uuidPattern.test(id)) issue('反馈编号无效', 404);
    const directory = reportDirectory(id);
    if (request.method === 'GET') return json(await detail(store, directory, url.searchParams.get('historyCursor')));
    if (request.method === 'PUT') return json(await updateReport(request, store, directory));
    return json({error: '只支持 GET 和 PUT 请求'}, 405, {Allow: 'GET, PUT'});
  } catch (error) { return errorResponse(error); }
}
