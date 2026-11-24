// Connect one more Zernio-managed Instagram account to OpenReply as its own workspace,
// with a copy of one campaign from an existing workspace and its own link destination.
// Idempotent: a second run finds the workspace it made and only checks it.
//
// Run inside the web container (cwd /app, so `@/…` imports resolve), key from the environment:
//   docker cp deploy/alfred/tools openreply-web-1:/app/tmp-tools
//   nbsecret run ZERNIO_API_KEY_SYSTEMS -- docker exec -e ZERNIO_API_KEY_SYSTEMS openreply-web-1 \
//     npx tsx /app/tmp-tools/add-zernio-workspace.ts --key-env ZERNIO_API_KEY_SYSTEMS \
//       --profile <zernio profile id> --account <zernio account id> --sample-rule <automation id> \
//       --workspace-name <name> --url <destination url> [--dry] [--overwrite-rule]
//
// Never prints keys or secrets: only ids, urls and names.
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@/app/generated/prisma/client';
import { prisma } from '@/lib/db/client';
import { getBaseUrl } from '@/lib/env';
import { decryptToken, encryptToken } from '@/lib/meta/oauth';
import { generateReportShareSlug } from '@/lib/reports/share';
import { TRACKED_LINK_ORDER } from '@/lib/tracking/link-order';
import { generateTrackedLinkSlug } from '@/lib/tracking/server';
import { zernioRequest } from '@/lib/zernio/client';
import { ensureWebhook, listInstagramAccounts, listProfiles, webhookUrl } from '@/lib/zernio/manage-remote';
import { buildRuleCopy, copiedFields, planRuleCopy, type RuleRow } from './automation-copy';

const REQUIRED_EVENTS = ['comment.received', 'message.received', 'message.read'];

function parseArgs(argv: string[]) {
  const flags = new Set(['--dry', '--overwrite-rule']);
  const values = new Map<string, string>();
  const on = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].indexOf('=');
    const name = eq < 0 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq < 0 ? undefined : argv[i].slice(eq + 1);
    if (flags.has(name)) { on.add(name); continue; }
    const value = inline ?? argv[++i];
    if (!name.startsWith('--') || value === undefined) throw new Error(`Bad argument: ${argv[i]}`);
    values.set(name, value);
  }
  const need = (name: string) => {
    const v = values.get(name);
    if (!v) throw new Error(`Missing ${name}`);
    return v;
  };
  return {
    dry: on.has('--dry'),
    overwriteRule: on.has('--overwrite-rule'),
    keyEnv: need('--key-env'),
    profileId: need('--profile'),
    accountId: need('--account'),
    sampleRuleId: need('--sample-rule'),
    workspaceName: need('--workspace-name'),
    destinationUrl: need('--url'),
  };
}

/** md5 of everything the sample workspace holds that this script could touch (rows incl. timestamps; secrets stay inside the hash). */
async function fingerprint(workspaceId: string) {
  const [automations, links, accounts, connection] = await Promise.all([
    prisma.automation.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
    prisma.trackedLink.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
    prisma.instagramAccount.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
    prisma.zernioConnection.findUnique({ where: { workspaceId } }),
  ]);
  const md5 = (value: unknown) => createHash('md5').update(JSON.stringify(value)).digest('hex');
  return { automation: md5(automations), trackedLink: md5(links), instagramAccount: md5(accounts), zernioConnection: md5(connection), counts: `${automations.length}/${links.length}/${accounts.length}/${connection ? 1 : 0}` };
}

async function loadRules(workspaceId: string, instagramAccountId: string) {
  return prisma.automation.findMany({
    where: { workspaceId, instagramAccountId },
    include: { trackedLinks: { orderBy: TRACKED_LINK_ORDER } },
  }) as unknown as Promise<Array<RuleRow & { id: string }>>;
}

async function remoteWebhooks(apiKey: string) {
  const data = await zernioRequest<{ webhooks: Array<{ _id: string; url: string; events?: string[]; isActive?: boolean }> }>({ apiKey, path: '/webhooks/settings' });
  return data.webhooks.map(w => ({ id: w._id, url: w.url, events: w.events ?? [], isActive: w.isActive }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env[args.keyEnv];
  if (!apiKey) throw new Error(`Environment variable ${args.keyEnv} is empty or missing`);
  const log = (line: string) => console.log(args.dry ? `[dry] ${line}` : line);
  const baseUrl = getBaseUrl();

  // 1. Zernio side: the profile and the account must exist under this key.
  const profile = (await listProfiles(apiKey)).find(p => p.id === args.profileId);
  if (!profile) throw new Error(`Profile ${args.profileId} is not visible with ${args.keyEnv}`);
  const account = (await listInstagramAccounts({ apiKey, profileId: args.profileId })).find(a => a.id === args.accountId);
  if (!account) throw new Error(`Instagram account ${args.accountId} is not in profile ${args.profileId}`);
  console.log(`zernio: profile ${profile.id} "${profile.name}", account ${account.id} @${account.username} (instagramId ${account.instagramId})`);

  // 2. Sample rule, its workspace, and the "before" fingerprint of that workspace.
  const sample = (await prisma.automation.findUnique({
    where: { id: args.sampleRuleId },
    include: { trackedLinks: { orderBy: TRACKED_LINK_ORDER } },
  })) as unknown as (RuleRow & { id: string; workspaceId: string }) | null;
  if (!sample) throw new Error(`Sample rule ${args.sampleRuleId} not found`);
  const sampleWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: sample.workspaceId } });
  const before = await fingerprint(sampleWorkspace.id);
  console.log(`sample: rule ${sample.id} "${sample.name}" in workspace ${sampleWorkspace.id} (owner ${sampleWorkspace.ownerId}), rows ${before.counts}`);

  // 3. Find the workspace this script made earlier: by Zernio profile, or by the Zernio account.
  const [byProfile, byAccount, byInstagramId] = await Promise.all([
    prisma.zernioConnection.findFirst({ where: { profileId: args.profileId } }),
    prisma.instagramAccount.findFirst({ where: { zernioAccountId: args.accountId } }),
    prisma.instagramAccount.findUnique({ where: { instagramId: account.instagramId } }),
  ]);
  const found = new Set([byProfile?.workspaceId, byAccount?.workspaceId, byInstagramId?.workspaceId].filter((v): v is string => Boolean(v)));
  if (found.size > 1) throw new Error(`Profile/account point to different workspaces (${[...found].join(', ')}); resolve by hand`);
  let workspaceId = [...found][0] ?? null;
  if (workspaceId === sampleWorkspace.id) throw new Error('The profile/account already belong to the sample workspace; refusing to continue');

  // 4. Workspace, owner membership, Zernio connection, Instagram account.
  if (!workspaceId) {
    log(`CREATE workspace "${args.workspaceName}" owner ${sampleWorkspace.ownerId} (OWNER member), zernio connection (profile ${args.profileId}, key and fresh webhook secret encrypted), instagram account @${account.username}`);
    if (!args.dry) {
      workspaceId = await prisma.$transaction(async tx => {
        const created = await tx.workspace.create({ data: { name: args.workspaceName, ownerId: sampleWorkspace.ownerId } });
        await tx.workspaceMember.create({ data: { workspaceId: created.id, userId: sampleWorkspace.ownerId, role: 'OWNER' } });
        await tx.zernioConnection.create({ data: {
          workspaceId: created.id, profileId: args.profileId,
          apiKey: encryptToken(apiKey), webhookSecret: encryptToken(randomBytes(32).toString('hex')),
        } });
        await tx.instagramAccount.create({ data: {
          workspaceId: created.id, instagramId: account.instagramId, username: account.username, name: account.name,
          provider: 'ZERNIO', zernioAccountId: account.id, accessToken: '', webhookSubscribed: true,
        } });
        return created.id;
      });
      console.log(`created workspace ${workspaceId}`);
    }
  } else {
    console.log(`found workspace ${workspaceId}; checking it`);
    await reconcileExisting({ workspaceId, ownerId: sampleWorkspace.ownerId, apiKey, profileId: args.profileId, account, log, dry: args.dry });
  }

  // 5. Webhook in Zernio (needs the workspace id, so it comes after the rows exist).
  const target = webhookUrl({ baseUrl, workspaceId: workspaceId ?? 'NEW_WORKSPACE_ID' });
  const hooks = await remoteWebhooks(apiKey);
  const ours = hooks.filter(h => h.url === target);
  console.log(`zernio webhooks under this key: ${hooks.length}; for ${target}: ${ours.length}`);
  const connection = workspaceId ? await prisma.zernioConnection.findUnique({ where: { workspaceId } }) : null;
  if (workspaceId && connection) {
    log(`ENSURE webhook ${target} events ${REQUIRED_EVENTS.join(',')} isActive true (id now ${connection.webhookId ?? 'none'})`);
    if (!args.dry) {
      const webhookId = await ensureWebhook({ apiKey, workspaceId, secret: decryptToken(connection.webhookSecret), baseUrl, webhookId: connection.webhookId });
      if (webhookId !== connection.webhookId) await prisma.zernioConnection.update({ where: { workspaceId }, data: { webhookId } });
      const allAfter = await remoteWebhooks(apiKey);
      const after = allAfter.filter(h => h.url === target);
      console.log(`zernio webhooks under this key after ensure: ${allAfter.length}`);
      if (allAfter.length > 1) console.warn(`WARN: ${allAfter.length} webhooks under this key, expected exactly 1; the others are not ours: ${allAfter.filter(h => h.url !== target).map(h => `${h.id} ${h.url}`).join('; ')}`);
      const good = after.length === 1 && after[0].isActive === true && REQUIRED_EVENTS.every(e => after[0].events.includes(e));
      console.log(`webhook ${webhookId}: urls matching ${after.length}, active ${after[0]?.isActive}, events ${after[0]?.events.join(',')} -> ${good ? 'OK' : 'NOT OK'}`);
      if (!good) throw new Error('Webhook state in Zernio does not match the expected one');
    }
  } else {
    log(`ENSURE webhook ${target} events ${REQUIRED_EVENTS.join(',')} isActive true`);
  }

  // 6. The rule copy and its link.
  const instagramAccount = workspaceId
    ? await prisma.instagramAccount.findFirst({ where: { workspaceId, zernioAccountId: account.id } })
    : null;
  const existing = workspaceId && instagramAccount ? await loadRules(workspaceId, instagramAccount.id) : [];
  const plan = planRuleCopy({ sample, existing, destinationUrl: args.destinationUrl });
  if (plan.action === 'create') {
    log(`CREATE rule "${sample.name}" (all fields of ${sample.id} except ids/dates; new report slug) + 1 tracked link -> ${args.destinationUrl}`);
    if (!args.dry && workspaceId && instagramAccount) {
      const copy = buildRuleCopy({ sample, destinationUrl: args.destinationUrl, generateRuleSlug: generateReportShareSlug, generateLinkSlug: generateTrackedLinkSlug });
      const created = await prisma.automation.create({
        data: {
          ...(copy.fields as Prisma.AutomationUncheckedCreateInput),
          workspaceId, instagramAccountId: instagramAccount.id, reportShareSlug: copy.reportShareSlug,
          trackedLinks: { create: [{ workspaceId, ...copy.link }] },
        },
        include: { trackedLinks: true },
      });
      console.log(`created rule ${created.id}, link slug ${created.trackedLinks[0].slug}`);
    }
  } else if (plan.action === 'in-sync') {
    console.log(`rule ${plan.id}: in sync with the sample, nothing to do`);
  } else if (args.overwriteRule) {
    log(`OVERWRITE rule ${plan.id} to match the sample (differs: ${plan.diffs.join(', ')})`);
    if (!args.dry) {
      const links = existing.find(r => r.id === plan.id)!.trackedLinks as unknown as Array<{ id: string }>;
      const wanted = { label: sample.trackedLinks[0].label, destinationUrl: args.destinationUrl, position: 0 };
      await prisma.$transaction(async tx => {
        await tx.automation.update({ where: { id: plan.id }, data: copiedFields(sample) as Prisma.AutomationUncheckedUpdateInput });
        if (links.length === 1) {
          // Keep the slug: links already sent in DMs point at it.
          await tx.trackedLink.update({ where: { id: links[0].id }, data: wanted });
        } else {
          await tx.trackedLink.deleteMany({ where: { automationId: plan.id } });
          await tx.trackedLink.create({ data: { workspaceId: workspaceId!, automationId: plan.id, slug: generateTrackedLinkSlug(), ...wanted } });
        }
      });
      console.log(`overwrote rule ${plan.id} (had ${links.length} link(s); ${links.length === 1 ? 'link slug kept' : 'link recreated with a new slug'})`);
    }
  } else {
    console.log(`rule ${plan.id} DIVERGES from the sample: ${plan.diffs.join(', ')}`);
    console.log('  nothing was changed; rerun with --overwrite-rule to make it match');
    process.exitCode = 2;
  }

  // 7. Final report: the sample workspace must be byte-for-byte what it was.
  const after = await fingerprint(sampleWorkspace.id);
  const same = (Object.keys(before) as Array<keyof typeof before>).every(k => before[k] === after[k]);
  console.log(`sample workspace ${sampleWorkspace.id}: ${same ? 'UNCHANGED' : 'CHANGED (!)'}`);
  console.log(`  md5 automation ${after.automation} trackedLink ${after.trackedLink} instagramAccount ${after.instagramAccount} zernioConnection ${after.zernioConnection}`);
  if (!same) process.exitCode = 3;
  await prisma.$disconnect();
}

/** Checks an existing workspace against the expected state; fixes only what is missing and safe (the webhook is handled by the caller). */
async function reconcileExisting({ workspaceId, ownerId, apiKey, profileId, account, log, dry }: {
  workspaceId: string; ownerId: string; apiKey: string; profileId: string;
  account: { id: string; instagramId: string; username: string; name: string | null };
  log: (line: string) => void; dry: boolean;
}) {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (workspace.ownerId !== ownerId) throw new Error(`Workspace ${workspaceId} has another owner (${workspace.ownerId}); resolve by hand`);
  const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: ownerId } } });
  if (!member) {
    log(`CREATE OWNER membership of ${ownerId} in ${workspaceId}`);
    if (!dry) await prisma.workspaceMember.create({ data: { workspaceId, userId: ownerId, role: 'OWNER' } });
  } else if (member.role !== 'OWNER') {
    console.log(`  membership role is ${member.role}, expected OWNER (not changed)`);
  }
  const connection = await prisma.zernioConnection.findUnique({ where: { workspaceId } });
  if (!connection) {
    log(`CREATE zernio connection for ${workspaceId}`);
    if (!dry) await prisma.zernioConnection.create({ data: { workspaceId, profileId, apiKey: encryptToken(apiKey), webhookSecret: encryptToken(randomBytes(32).toString('hex')) } });
  } else {
    if (connection.profileId !== profileId) console.log(`  connection profile ${connection.profileId} differs from ${profileId} (not changed)`);
    if (decryptToken(connection.apiKey) !== apiKey) throw new Error(`Workspace ${workspaceId} stores another Zernio key than the one in the environment; the worker would use the stored one. Resolve by hand`);
  }
  const stored = await prisma.instagramAccount.findUnique({ where: { instagramId: account.instagramId } });
  if (!stored) {
    log(`CREATE instagram account @${account.username} in ${workspaceId}`);
    if (!dry) await prisma.instagramAccount.create({ data: { workspaceId, instagramId: account.instagramId, username: account.username, name: account.name, provider: 'ZERNIO', zernioAccountId: account.id, accessToken: '', webhookSubscribed: true } });
  } else {
    const problems = [
      stored.workspaceId !== workspaceId && 'workspaceId', stored.provider !== 'ZERNIO' && 'provider',
      stored.zernioAccountId !== account.id && 'zernioAccountId', !stored.webhookSubscribed && 'webhookSubscribed',
    ].filter(Boolean);
    if (problems.length) throw new Error(`Instagram account ${stored.id} differs from expected: ${problems.join(', ')}; resolve by hand`);
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
