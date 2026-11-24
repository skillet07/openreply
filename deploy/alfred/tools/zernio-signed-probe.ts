// End-to-end probe of one workspace's Zernio webhook, without a public comment and without any DM.
//
//   default mode: POST a synthetic, correctly signed `comment.received` (text with no code word) to the
//                 public webhook URL -> expect 200; then the same body with a wrong signature -> expect 401.
//   --match "<text>": in this process only (no queue, no HTTP, no sending) run the app's keyword matching of
//                 <text> against the workspace's rules and print which rule fires.
//
// Run inside the web container (see add-zernio-workspace.ts for the copy step):
//   docker exec openreply-web-1 npx tsx /app/tmp-tools/zernio-signed-probe.ts --workspace <id> [--public-url <base>] [--text <text>]
//   docker exec openreply-web-1 npx tsx /app/tmp-tools/zernio-signed-probe.ts --workspace <id> --match "задача"
//
// Synthetic ids carry the prefix `openreply-probe-` and never exist on Instagram. Secrets are never printed.
import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { getBaseUrl } from '@/lib/env';
import { decryptToken } from '@/lib/meta/oauth';
import { getDMQueue, getRedisConnection } from '@/lib/queue/client';
import { webhookUrl } from '@/lib/zernio/manage-remote';
import { probeVerdict } from './probe-verdict';
import { matchRules, type MatchableRule } from './rule-match';

const PROBE_MEDIA_ID = 'openreply-probe-media';
const DEFAULT_TEXT = 'openreply probe: no code word in this text';
const JOB_WAIT_MS = 30_000;

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : argv[i + 1];
}

async function loadWorkspace(workspaceId: string) {
  const account = await prisma.instagramAccount.findFirst({ where: { workspaceId, provider: 'ZERNIO' } });
  if (!account?.zernioAccountId) throw new Error(`Workspace ${workspaceId} has no Zernio instagram account`);
  const rules = await prisma.automation.findMany({ where: { workspaceId, instagramAccountId: account.id }, orderBy: { createdAt: 'asc' } });
  return { account: { ...account, zernioAccountId: account.zernioAccountId }, rules: rules as unknown as Array<MatchableRule> };
}

async function runMatch(workspaceId: string, text: string) {
  const { account, rules } = await loadWorkspace(workspaceId);
  const results = matchRules({ rules, text, mediaId: PROBE_MEDIA_ID });
  console.log(`match: workspace ${workspaceId}, account @${account.username}, ${rules.length} rule(s), text ${JSON.stringify(text)}`);
  for (const r of results) {
    console.log(`  ${r.matched ? 'FIRES   ' : r.considered ? 'no match' : 'skipped '} ${r.id} "${r.name}"${r.matchedKeyword ? ` (keyword ${JSON.stringify(r.matchedKeyword)})` : ''}`);
  }
  const fired = results.filter(r => r.matched);
  console.log(fired.length ? `RESULT: ${fired.length} rule(s) fire: ${fired.map(r => `"${r.name}"`).join(', ')}` : 'RESULT: no rule fires');
  return fired.length;
}

async function post(url: string, body: string, signature: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zernio-signature': signature },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: (await response.text()).slice(0, 200) };
}

async function waitForJob(jobId: string): Promise<string> {
  const queue = getDMQueue();
  const deadline = Date.now() + JOB_WAIT_MS;
  let state = 'missing';
  for (;;) {
    const job = await queue.getJob(jobId);
    state = job ? await job.getState() : 'missing';
    if (state === 'completed' || state === 'failed' || Date.now() >= deadline) return state;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function runSignedProbe(workspaceId: string, publicBase: string, text: string) {
  const connection = await prisma.zernioConnection.findUnique({ where: { workspaceId } });
  if (!connection?.webhookId) throw new Error(`Workspace ${workspaceId} has no webhook configured`);
  const { account, rules } = await loadWorkspace(workspaceId);

  // The probe text must not fire any rule, or the worker would answer a person that does not exist.
  const firing = matchRules({ rules, text, mediaId: PROBE_MEDIA_ID }).filter(r => r.matched);
  if (firing.length) throw new Error(`Probe text would fire rule(s) ${firing.map(r => `"${r.name}"`).join(', ')}; pick other --text`);

  const tag = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const commentId = `openreply-probe-comment-${tag}`;
  const body = JSON.stringify({
    id: `openreply-probe-event-${tag}`,
    event: 'comment.received',
    account: { id: account.zernioAccountId, platform: 'instagram' },
    comment: {
      id: commentId, platformPostId: PROBE_MEDIA_ID, text,
      author: { id: `openreply-probe-user-${tag}`, username: `openreply_probe_${tag.replace(/\W/g, '_')}` },
    },
  });
  const url = webhookUrl({ baseUrl: publicBase, workspaceId });
  const good = createHmac('sha256', decryptToken(connection.webhookSecret)).update(body).digest('hex');
  const bad = createHmac('sha256', randomBytes(32).toString('hex')).update(body).digest('hex');

  console.log(`probe: POST ${url} (account @${account.username}, comment ${commentId})`);
  const ok = await post(url, body, good);
  console.log(`  signed with the workspace secret -> HTTP ${ok.status} ${ok.body}  (expected 200)`);
  const denied = await post(url, body, bad);
  console.log(`  signed with a wrong secret       -> HTTP ${denied.status} ${denied.body}  (expected 401)`);

  // The accepted event must be stored for this workspace, no DM may exist for the synthetic comment,
  // and the worker must have finished the queued job (same jobId as lib/queue/process-webhook.ts).
  // A rejected request queued nothing, so there is nothing to wait for.
  const jobState = ok.status === 200 ? await waitForJob(`comment_${account.instagramId}_${commentId}`) : 'not queued';
  const events = await prisma.webhookEvent.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 20 });
  const stored = events.find(e => JSON.stringify(e.payload).includes(commentId));
  const dms = await prisma.dmLog.count({ where: { workspaceId, commentId } });
  console.log(`  stored webhook event: ${stored ? `${stored.id} status ${stored.status}` : 'NOT FOUND'}; DM log rows for the synthetic comment: ${dms}  (expected 0)`);
  console.log(`  queue job state: ${jobState}  (expected completed, waited up to ${JOB_WAIT_MS / 1000}s)`);

  const verdict = probeVerdict({ signedStatus: ok.status, wrongSignatureStatus: denied.status, storedEvent: Boolean(stored), dmRows: dms, jobState });
  for (const failure of verdict.failures) console.log(`  FAILED: ${failure}`);
  console.log(verdict.pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  return verdict.pass;
}

async function main() {
  const workspaceId = arg('--workspace');
  if (!workspaceId) throw new Error('Missing --workspace <id>');
  const matchText = arg('--match');
  const pass = matchText !== undefined
    ? (await runMatch(workspaceId, matchText)) > 0
    : await runSignedProbe(workspaceId, arg('--public-url') ?? getBaseUrl(), arg('--text') ?? DEFAULT_TEXT);
  await prisma.$disconnect();
  if (matchText === undefined) {
    await getDMQueue().close();
    await getRedisConnection().quit();
  }
  if (!pass) process.exitCode = 1;
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
