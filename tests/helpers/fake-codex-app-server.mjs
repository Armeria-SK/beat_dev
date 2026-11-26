// AR-4 のにせの Codex app-server。1 行 1 JSON の JSON-RPC を標準入出力で話す小さな node のスクリプト（本物の Codex は起こさない）。
// 使い方: node fake-codex-app-server.mjs [--log <file>] [--scenario <name>] [--account chatgpt|apiKey|none] [--readiness ready|updateRequired|notConfigured|none]
//          [--platform windows|linux] [--version 0.172.0] [--eff-approval <値>] [--eff-reviewer <値>] [--eff-sandbox <モード>] [--eff-network true] [--resume-fails] [--hang-initialize]
//          [--provider <名前>] [--omit-provider] [--omit-effective] [--active-profile] [--resume-other] [--turn-error]
// --log: 受け取った行（in）と、求めへの返事（answer）と、起動した pid を 1 行 1 JSON で残す。試験が「beat が何を送ったか」を見るのに使う
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : fallback; };
const flag = name => argv.includes(`--${name}`);
const scenario = opt('scenario', 'text');
const logFile = opt('log');
const note = (record) => { if (logFile) appendFileSync(logFile, `${JSON.stringify(record)}\n`); };
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => out({ method, params });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
note({ dir: 'pid', pid: process.pid });

const answers = new Map();
const waiters = new Map();
const waitAnswer = id => (answers.has(id) ? Promise.resolve(answers.get(id)) : new Promise(resolve => waiters.set(id, resolve)));
let interruptWaiter;

const sandboxOf = mode => {
  const network = opt('eff-network') === 'true';
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: network };
  if (mode === 'workspace-write') return { type: 'workspaceWrite', writableRoots: [], networkAccess: network, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { type: 'dangerFullAccess' };
};
const model = (id, extra = {}) => ({ id, model: id, upgrade: null, displayName: `Name ${id}`, description: 'd', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'low', isDefault: false, ...extra });
// thread/start・thread/resume の返り。--omit-effective は「いま効いている設定」を返さない、--provider は会話の行き先（既定 openai）、--omit-provider は行き先を返さない、--active-profile は名前つきの許可の組が効いている
const threadReply = (params, threadId) => ({
  thread: { id: threadId }, model: 'gpt-fake',
  modelProvider: flag('omit-provider') ? undefined : opt('provider', 'openai'),
  ...(flag('omit-effective') ? {} : { approvalPolicy: opt('eff-approval', params.approvalPolicy), approvalsReviewer: opt('eff-reviewer', params.approvalsReviewer), sandbox: sandboxOf(opt('eff-sandbox', params.sandbox)) }),
  activePermissionProfile: flag('active-profile') ? { id: 'full-access', extends: null } : null,
});
const item = (type, id, extra = {}) => ({ type, id, ...extra });
let THREAD = 'thr-1';
const TURN = 'turn-1';
const started = it => notify('item/started', { item: it, threadId: THREAD, turnId: TURN, startedAtMs: 1 });
const completed = it => notify('item/completed', { item: it, threadId: THREAD, turnId: TURN, completedAtMs: 2 });
const finish = (status = 'completed', error = null) => notify('turn/completed', { threadId: THREAD, turn: { id: TURN, items: [], status, error } });
const commandRequest = (id, itemId, extra = {}) => out({ id, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: THREAD, turnId: TURN, itemId, startedAtMs: 1, environmentId: null, command: 'ls -la', cwd: 'D:\\work', commandActions: [{ type: 'listFiles', command: 'ls -la', path: null }], proposedExecpolicyAmendment: ['ls'], ...extra } });

async function play() {
  notify('turn/started', { threadId: THREAD, turn: { id: TURN, items: [], status: 'inProgress', error: null } });
  notify('thread/tokenUsage/updated', { threadId: THREAD, turnId: TURN, tokenUsage: {} });
  switch (scenario) {
    case 'text':
      notify('configWarning', { summary: 'a warning‮ with sk-ant-abcdefgh12345678 in it', details: null });
      notify('something/new', { threadId: THREAD, x: 1 });
      notify('windows/worldWritableWarning', { threadId: THREAD, samplePaths: ['D:/open-folder'], extraCount: 2, failedScan: false });
      started(item('agentMessage', 'a1', { text: '' }));
      notify('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'a1', delta: 'Hel' });
      notify('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'a1', delta: 'lo' });
      completed(item('agentMessage', 'a1', { text: 'Hello' }));
      started(item('agentMessage', 'a2', { text: '' }));
      completed(item('agentMessage', 'a2', { text: 'Second without deltas' }));
      notify('turn/completed', { threadId: 'other-thread', turn: { id: 'x', items: [], status: 'failed', error: { message: 'not ours' } } });
      finish();
      break;
    case 'tools':
      started(item('commandExecution', 'c1', { command: 'echo hi', cwd: 'D:\\work', status: 'inProgress', commandActions: [] }));
      completed(item('commandExecution', 'c1', { command: 'echo hi', cwd: 'D:\\work', status: 'completed', aggregatedOutput: `hi sk-ant-abcdefgh12345678 ${'x'.repeat(120_000)}`, exitCode: 0 }));
      started(item('fileChange', 'f1', { status: 'inProgress', changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@' }] }));
      completed(item('fileChange', 'f1', { status: 'declined', changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@' }] }));
      started(item('reasoning', 'r1', { summary: [], content: [] }));
      started(item('brandNewItemType', 'z1'));
      finish();
      break;
    case 'command-approval': {
      started(item('commandExecution', 'c1', { command: 'ls -la', cwd: 'D:\\work', status: 'inProgress', commandActions: [] }));
      commandRequest(100, 'c1');
      const answer = await waitAnswer(100);
      completed(item('commandExecution', 'c1', { command: 'ls -la', cwd: 'D:\\work', status: answer?.result?.decision === 'decline' ? 'declined' : 'completed', aggregatedOutput: 'ok' }));
      finish();
      break;
    }
    case 'two-approvals': {
      commandRequest(101, 'c1', { command: 'one' });
      commandRequest(102, 'c2', { command: 'two' });
      await Promise.all([waitAnswer(101), waitAnswer(102)]);
      finish();
      break;
    }
    case 'file-approval': {
      started(item('fileChange', 'f1', { status: 'inProgress', changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: 'src/b.ts' }, diff: '@@' }, { path: 'src/new.ts', kind: { type: 'add' }, diff: '+x' }] }));
      out({ id: 110, method: 'item/fileChange/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: 'f1', startedAtMs: 1, reason: 'needs write', grantRoot: 'D:\\work' } });
      out({ id: 111, method: 'item/fileChange/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: 'ghost', startedAtMs: 1 } });
      await Promise.all([waitAnswer(110), waitAnswer(111)]);
      finish();
      break;
    }
    case 'patch-updated': {
      const change = path => ({ path, kind: { type: 'update', move_path: null }, diff: '@@' });
      started(item('fileChange', 'f1', { status: 'inProgress', changes: [change('src/a.ts')] }));
      notify('item/fileChange/patchUpdated', { threadId: THREAD, turnId: TURN, itemId: 'f1', changes: [change('src/a.ts'), change('src/b.ts')] });
      out({ id: 160, method: 'item/fileChange/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: 'f1', startedAtMs: 1, reason: null, grantRoot: null } });
      await waitAnswer(160);
      finish();
      break;
    }
    case 'odd-method': {
      out({ id: 170, method: `odd/sk-ant-abcdefgh12345678\n[INFO] forged line \u0007${'y'.repeat(300)}`, params: {} });
      await waitAnswer(170);
      finish();
      break;
    }
    case 'permissions': {
      out({ id: 120, method: 'item/permissions/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: 'p1', environmentId: null, startedAtMs: 1, cwd: 'D:\\work', reason: 'needs network', permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['D:\\other'] } } } });
      await waitAnswer(120);
      finish();
      break;
    }
    case 'network-and-stdin': {
      commandRequest(130, 'c1', { networkApprovalContext: { host: 'example.com', protocol: 'https' } });
      commandRequest(131, 'c2', { kind: 'writeStdin' });
      await Promise.all([waitAnswer(130), waitAnswer(131)]);
      finish();
      break;
    }
    case 'unanswerable': {
      out({ id: 140, method: 'item/tool/requestUserInput', params: { threadId: THREAD, turnId: TURN, itemId: 'q1', questions: [], isBlocking: true, autoResolutionMs: null } });
      out({ id: 141, method: 'mcpServer/elicitation/request', params: { threadId: THREAD, turnId: TURN, serverName: 's', environmentId: null, mode: 'form', _meta: null, message: 'm', requestedSchema: {} } });
      out({ id: 142, method: 'item/tool/call', params: { threadId: THREAD, turnId: TURN, callId: 'x', tool: 't', arguments: {} } });
      out({ id: 143, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' } });
      commandRequest(144, 'c9', { kind: 'humanCommand' });
      out({ id: 145, method: 'some/brand-new/request', params: {} });
      commandRequest(146, 'c10', { itemId: undefined });
      await Promise.all([140, 141, 142, 143, 144, 145, 146].map(waitAnswer));
      finish();
      break;
    }
    case 'failed-auth':
      notify('error', { error: { message: 'retrying', codexErrorInfo: null, additionalDetails: null }, willRetry: true, threadId: THREAD, turnId: TURN });
      finish('failed', { message: '401 Unauthorized Bearer abcdefghijklmnopqrstuvwxyz0123456789', codexErrorInfo: 'unauthorized', additionalDetails: null });
      break;
    case 'failed-rate': finish('failed', { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }); break;
    case 'failed-plain': finish('failed', { message: 'boom', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 500 } }, additionalDetails: null }); break;
    case 'crash':
      started(item('agentMessage', 'a1', { text: '' }));
      notify('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'a1', delta: 'partial' });
      await sleep(50);
      process.stderr.write('fatal: codex exploded sk-ant-abcdefgh12345678\n');
      process.exit(3);
      break;
    case 'hang': await new Promise(resolve => { interruptWaiter = resolve; }); finish('interrupted'); break;
    case 'hang-approval': {
      commandRequest(150, 'c1');
      await new Promise(resolve => { interruptWaiter = resolve; });
      finish('interrupted');
      break;
    }
    case 'approval-after-interrupt': {
      await new Promise(resolve => { interruptWaiter = resolve; });
      commandRequest(180, 'c1');
      await waitAnswer(180);
      finish('interrupted');
      break;
    }
    case 'ignore-interrupt': await new Promise(() => {}); break;
    default: break;
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', async line => {
  const message = JSON.parse(line);
  note({ dir: 'in', message });
  if (message.method === undefined && message.id !== undefined) {
    answers.set(message.id, message);
    note({ dir: 'answer', id: message.id, message });
    waiters.get(message.id)?.(message);
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return;
  const reply = result => out({ id, result });
  switch (method) {
    case 'initialize':
      if (flag('hang-initialize')) return;
      reply({ userAgent: `beat/${opt('version', '0.172.0')} (fake)`, codexHome: 'C:\\fake-home', platformFamily: opt('platform', 'windows') === 'windows' ? 'windows' : 'unix', platformOs: opt('platform', 'windows') });
      break;
    case 'account/read': {
      const account = opt('account', 'chatgpt');
      if (account === 'none') reply({ account: null, userId: null, requiresOpenaiAuth: true });
      else if (account === 'apiKey') reply({ account: { type: 'apiKey' }, userId: null, requiresOpenaiAuth: true });
      else reply({ account: { type: 'chatgpt', email: 'secret-person@example.com', planType: 'plus', workspaceName: null }, userId: 'user-secret-id', requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: 'acct-secret' } });
      break;
    }
    case 'windowsSandbox/readiness': reply({ status: opt('readiness', 'ready') }); break;
    case 'model/list':
      if (params.cursor === undefined) reply({ data: [model('m-one', { isDefault: true }), model('m-hidden', { hidden: true }), model('m-one')], nextCursor: 'page2' });
      else reply({ data: [model('m-two', { supportedReasoningEfforts: [] })], nextCursor: null });
      break;
    case 'thread/start':
      reply(threadReply(params, THREAD));
      break;
    case 'thread/resume':
      if (flag('resume-fails')) { out({ id, error: { code: -32600, message: 'no rollout found for thread id sk-ant-abcdefgh12345678' } }); break; }
      THREAD = params.threadId;
      reply(threadReply(params, flag('resume-other') ? 'thr-other' : params.threadId));
      break;
    case 'turn/start':
      if (flag('turn-error')) { out({ id, error: { code: -32000, message: 'turn refused, token sk-ant-abcdefgh12345678' } }); break; }
      reply({ turn: { id: TURN, items: [], status: 'inProgress', error: null } });
      play().catch(() => process.exit(9));
      break;
    case 'turn/interrupt':
      if (scenario === 'ignore-interrupt') { out({ id, error: { code: -32000, message: 'cannot interrupt' } }); break; }
      reply({});
      interruptWaiter?.();
      break;
    default: out({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
reader.on('close', () => process.exit(0));
