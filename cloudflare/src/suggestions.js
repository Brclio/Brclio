import {digest} from './accounts-crypto.js';
import {uuidPattern} from './feedback-store.js';
import {json, rateLimit, readJSON} from './http.js';
import {commentPagePath, createSuggestionStore, headPath, indexPath, topicDirectory} from './suggestion-store.js';

export const suggestionPrefix = '/api/account/suggestions';
// At the maximum text lengths both responses fit the desktop bridge's 128 KiB limit.
const topicsPerPage = 10, commentsPerPage = 20;
const maxPage = 99999999;

class SuggestionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function textField(value, limit, label, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) {
    throw new SuggestionError(label + '格式无效或超过 ' + limit + ' 字');
  }
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!optional && !text) throw new SuggestionError('请填写' + label);
  return text;
}
function requestId(input) {
  if (typeof input.requestId !== 'string' || !uuidPattern.test(input.requestId)) throw new SuggestionError('提交编号无效');
  return input.requestId;
}
function authorName(profile) {
  for (const value of [profile.nickname, profile.username]) {
    if (typeof value !== 'string' || value.length > 80) continue;
    const name = value.trim();
    if (name && !/[\p{Cc}\p{Zl}\p{Zp}\ud800-\udfff]/u.test(name) && !/[^\s@]+@[^\s@]+/.test(name.normalize('NFKC'))) return name;
  }
  return 'Brclio 用户';
}
function pageNumber(value) { return Number.isInteger(value) && value > 0 && value <= maxPage; }
function parseCursor(url) {
  const values = url.searchParams.getAll('cursor');
  if (!values.length) return null;
  if (values.length !== 1 || !/^[1-9][0-9]{0,7}$/.test(values[0])) throw new SuggestionError('分页参数无效');
  return Number(values[0]);
}
function total(head) {
  if (head === null) return 0;
  if (!Number.isSafeInteger(head.count) || head.count < 1) throw new Error('Invalid suggestion count');
  return head.count;
}
async function listPage(state, count, size, pathFor, cursor) {
  const last = Math.ceil(count / size);
  if (!last && cursor === null) return {items: [], nextCursor: null};
  const number = cursor ?? last;
  if (number > last) throw new SuggestionError('此分页不存在', 404);
  const page = await state.read(pathFor(number));
  if (!Array.isArray(page?.items) || page.items.length !== Math.min(size, count - size * (number - 1))) throw new Error('Invalid suggestion page');
  return {items: page.items, nextCursor: number > 1 ? number - 1 : null};
}
async function appendItem(tx, count, size, pathFor, item) {
  const number = Math.floor(count / size) + 1;
  if (!pageNumber(number)) throw new Error('Suggestion index full');
  const path = pathFor(number), existing = await tx.read(path);
  const offset = count % size;
  if (offset === 0 ? existing !== null : !Array.isArray(existing?.items) || existing.items.length !== offset) throw new Error('Invalid suggestion page');
  tx.write(path, {version: 1, items: [item, ...(existing?.items || [])]});
  return number;
}
async function locateTopic(state, id, location) {
  if (!location) throw new SuggestionError('未找到这条建议', 404);
  if (!pageNumber(location.page)) throw new Error('Invalid suggestion location');
  const path = indexPath(location.page), page = await state.read(path);
  const topic = page?.items.find(item => item.id === id);
  if (!topic) throw new Error('Missing indexed suggestion');
  return {topic, page, path};
}
function publicTopic(topic) {
  const {id, title, category, description, author, createdAt, ratingCount, commentCount} = topic;
  return {id, title, category, description, author, createdAt, ratingCount, commentCount,
    averageRating: ratingCount ? topic.ratingUnits / (ratingCount * 2) : null};
}
const votePath = (directory, member) => directory + '/ratings/' + member + '.json';
async function personalTopic(state, topic, directory, member) {
  const vote = await state.read(votePath(directory, member));
  return {...publicTopic(topic), myRating: vote?.rating ?? null};
}
async function listTopics(store, cursor) {
  const state = await store.snapshot();
  const page = await listPage(state, total(await state.read(headPath)), topicsPerPage, indexPath, cursor);
  return {items: page.items.map(publicTopic), nextCursor: page.nextCursor};
}
async function detail(store, id, directory, member, cursor) {
  const state = await store.snapshot();
  const {topic} = await locateTopic(state, id, await state.read(directory + '/location.json'));
  const [suggestion, comments] = await Promise.all([
    personalTopic(state, topic, directory, member),
    listPage(state, topic.commentCount, commentsPerPage, page => commentPagePath(directory, page), cursor)
  ]);
  return {suggestion, comments: comments.items, nextCursor: comments.nextCursor};
}
async function createTopic(store, input, member, author) {
  const id = requestId(input), directory = topicDirectory(id), locationPath = directory + '/location.json';
  const title = textField(input.title, 100, '建议名称'), category = textField(input.category, 40, '类别', true);
  const description = textField(input.description, 3000, '描述');
  const createdAt = new Date().toISOString();
  return store.transaction(async tx => {
    const location = await tx.read(locationPath);
    if (location) {
      const {topic} = await locateTopic(tx, id, location);
      if (topic.member !== member || topic.title !== title || topic.category !== category || topic.description !== description) throw new SuggestionError('提交编号已使用', 409);
      return {suggestion: await personalTopic(tx, topic, directory, member)};
    }
    const topic = {id, title, category, description, member, author, createdAt, ratingCount: 0, ratingUnits: 0, commentCount: 0};
    const count = total(await tx.read(headPath));
    const page = await appendItem(tx, count, topicsPerPage, indexPath, topic);
    tx.write(locationPath, {version: 1, page});
    tx.write(headPath, {version: 1, count: count + 1});
    return {suggestion: {...publicTopic(topic), myRating: null}};
  });
}
async function rateTopic(store, id, directory, member, rating) {
  if (typeof rating !== 'number' || !Number.isInteger(rating * 2) || rating < 0.5 || rating > 5) throw new SuggestionError('请按半星选择 0.5 至 5 星');
  return store.transaction(async tx => {
    const {topic, path, page} = await locateTopic(tx, id, await tx.read(directory + '/location.json'));
    const vote = votePath(directory, member), previous = await tx.read(vote);
    if (previous?.rating !== rating) {
      topic.ratingUnits += (rating - (previous?.rating || 0)) * 2;
      if (!previous) topic.ratingCount++;
      tx.write(vote, {version: 1, rating});
      tx.write(path, page);
    }
    return {suggestion: {...publicTopic(topic), myRating: rating}};
  });
}
async function addComment(store, id, directory, input, member, author) {
  const commentId = requestId(input), text = textField(input.text, 1000, '评论');
  const receiptPath = directory + '/comments/by-id/' + commentId + '.json';
  const comment = {id: commentId, author, text, createdAt: new Date().toISOString()};
  return store.transaction(async tx => {
    const {topic, path, page} = await locateTopic(tx, id, await tx.read(directory + '/location.json'));
    const receipt = await tx.read(receiptPath);
    if (receipt) {
      if (!pageNumber(receipt.page)) throw new Error('Invalid comment location');
      const comments = await tx.read(commentPagePath(directory, receipt.page));
      const stored = comments?.items.find(item => item.id === commentId);
      if (!stored) throw new Error('Missing indexed comment');
      if (receipt.member !== member || stored.text !== text) throw new SuggestionError('提交编号已使用', 409);
      return {suggestion: await personalTopic(tx, topic, directory, member), comment: stored};
    }
    const number = await appendItem(tx, topic.commentCount, commentsPerPage, n => commentPagePath(directory, n), comment);
    topic.commentCount++;
    tx.write(path, page);
    tx.write(receiptPath, {version: 1, page: number, member});
    return {suggestion: await personalTopic(tx, topic, directory, member), comment};
  });
}

export async function handleSuggestions(request, env, session, dependencies) {
  try {
    const url = new URL(request.url), suffix = url.pathname.slice(suggestionPrefix.length);
    const match = /^\/([0-9a-f-]{36})(?:\/(rating|comments))?$/.exec(suffix);
    if (suffix && (!match || !uuidPattern.test(match[1]))) throw new SuggestionError('未找到建议页面', 404);
    const id = match?.[1], action = match?.[2];
    const methods = !id ? ['GET', 'POST'] : !action ? ['GET'] : action === 'rating' ? ['PUT'] : ['POST'];
    if (!methods.includes(request.method)) return json({error: '不支持的请求方法'}, 405, {Allow: methods.join(', ')});
    if ([...url.searchParams.keys()].some(key => request.method !== 'GET' || key !== 'cursor')) throw new SuggestionError('查询参数无效');
    const store = dependencies.suggestionStore || createSuggestionStore(env, dependencies.suggestionFetchImpl || dependencies.fetchImpl);
    const directory = id && topicDirectory(id);
    if (request.method === 'GET') {
      const cursor = parseCursor(url);
      return json(id ? await detail(store, id, directory, await digest(session.id), cursor) : await listTopics(store, cursor));
    }
    let input;
    try { input = await readJSON(request, 32768); }
    catch (error) { throw new SuggestionError('请求格式或大小无效', error instanceof RangeError ? 413 : 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SuggestionError('请求格式无效');
    if (input.expectedUserId !== undefined && input.expectedUserId !== session.id) throw new SuggestionError('当前账号已变更，请重新打开建议广场', 409);
    if (!await rateLimit(env, 'ACCOUNT_AUTH_LIMITER', 'suggestions:' + session.id, 10)) return json({error: '操作过于频繁，请稍后重试'}, 429, {'Retry-After': '60'});
    const member = await digest(session.id), author = authorName(session.profile);
    if (!id) return json(await createTopic(store, input, member, author));
    if (action === 'rating') return json(await rateTopic(store, id, directory, member, input.rating));
    return json(await addComment(store, id, directory, input, member, author));
  } catch (error) {
    if (error instanceof SuggestionError) return json({error: error.message}, error.status);
    return json({error: '建议广场暂不可用，请稍后重试'}, 503);
  }
}
