import { randomUUID } from 'node:crypto';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { GroupRef, MessagingBackend, Peer } from './contracts.ts';
import { fail, peerPresence, safeText } from './policy.ts';
import { peerLabel } from './identity.ts';

export interface HumanControls {
  backend: MessagingBackend;
  selected?: GroupRef;
  select(ref: GroupRef): void;
  groupsListed(groups: readonly GroupRef[]): void;
  joined(ref: GroupRef): void;
  leave(): Promise<void>;
  guard(): void;
}
export async function handleMessages(args: string, ctx: ExtensionCommandContext, controls: HumanControls): Promise<void> {
  const [command = 'status', argument, ...extra] = args.trim().split(/\s+/).filter(Boolean);
  if (extra.length || (argument && !['join', 'arm'].includes(command))) fail('validation', 'Usage: /messages status|join [group]|leave|arm [1–100]|pause|send|routes|inbox|prune|revoke');
  const b = controls.backend;
  const ask = async <T>(value: Promise<T>): Promise<T> => { const result = await value; controls.guard(); return result; };
  async function selectGroup(create = false): Promise<GroupRef | undefined> {
    const groups = await b.listGroups();
    controls.groupsListed(groups);
    if (command !== 'join' && controls.selected) {
      const selected = groups.find(g => g.id === controls.selected!.id && g.authorityId === controls.selected!.authorityId);
      if (!selected) fail('missing', 'Selected group no longer exists; explicitly select or join another group');
      return selected;
    }
    let label = command === 'join' ? argument : undefined;
    if (!label) label = await ask(ctx.ui.select('Messaging group', [...groups.map(g => g.label), ...(create ? ['+ Create group'] : [])]));
    if (label === '+ Create group') label = await ask(ctx.ui.input('New group label', 'lowercase-letters-and-hyphens'));
    if (!label) return undefined;
    let group = groups.find(g => g.label === label);
    if (!group && create && await ask(ctx.ui.confirm('Create messaging group?', `${label}: new groups start paused with no allowance.`))) group = await b.createGroup(label);
    if (!group) fail('missing', 'Group not found');
    controls.select(group); return group;
  }
  async function compose(group: GroupRef, initial = ''): Promise<void> {
    const peer = b.peer;
    if (!peer || peer.groupId !== group.id) fail('participation', 'Join this group before sending');
    const peers = (await b.peers(group)).filter(p => p.active && p.id !== peer.id);
    const labels = peers.map((p, i) => { const presence = peerPresence(p); return `${i + 1}. ${peerLabel(p)}${presence === 'online' ? '' : ` (${presence})`}`; });
    const choice = await ask(ctx.ui.select('Send to peer', labels));
    if (!choice) return;
    const kindChoice = await ask(ctx.ui.select('Message kind', ['Notice — replies forbidden', 'Request — exactly one reply']));
    if (!kindChoice) return;
    const kind = kindChoice.startsWith('Notice') ? 'notice' : 'request';
    const text = await ask(ctx.ui.editor('Peer message (submit to queue; Escape cancels)', initial));
    if (text === undefined || !text.trim()) return;
    const sent = await b.send({ kind, toPeerId: peers[labels.indexOf(choice)].id, text }, randomUUID());
    ctx.ui.notify(`Queued ${sent.id}; this is not a delivery receipt.`, 'info');
  }
  if (command === 'leave') { await controls.leave(); controls.guard(); ctx.ui.notify('Left messaging. Already admitted messages cannot be recalled.', 'info'); return; }
  const group = await selectGroup(command === 'join'); if (!group) return;
  if (command === 'join') {
    if (!ctx.sessionManager.getSessionFile()) fail('participation', 'Joining requires a saved Pi session, not ephemeral mode');
    const sessionId = ctx.sessionManager.getSessionId(); const current = b.peer;
    if (current) {
      if (current.groupId === group.id && current.sessionId === sessionId) {
        ctx.ui.notify(`Already joined ${group.label} as ${peerLabel(current)}.`, 'info'); return;
      }
      fail('participation', 'Leave the current group first');
    }
    const summary = await b.getGroupSummary(group); if (!summary) fail('missing', 'Group no longer exists');
    const members = (await b.peers(group)).filter(peer => peer.active);
    const sameSession = members.filter(peer => peer.sessionId === sessionId);
    const online = sameSession.find(peer => peerPresence(peer) === 'online');
    if (online) fail('participation', `This Pi session already has an online messaging peer (${peerLabel(online)}). Return to it or explicitly revoke it before resuming elsewhere.`);
    const candidates = members.filter(peer => ['stale', 'suspended'].includes(peerPresence(peer)));
    const unresolved = new Map<string, number>();
    if (candidates.length) {
      for (const message of await b.listMessages(group)) {
        if (message.state === 'queued' || message.state === 'attempted') unresolved.set(message.recipientPeerId, (unresolved.get(message.recipientPeerId) ?? 0) + 1);
      }
    }
    let candidate: Peer | undefined = candidates[0];
    if (candidates.length > 1 || candidates.some(peer => peer.sessionId !== sessionId)) {
      const labels = candidates.map((peer, index) => {
        const presence = peerPresence(peer); const age = Math.max(0, Math.round((Date.now() - peer.lastSeen) / 1000));
        return `${index + 1}. ${peerLabel(peer)} — ${presence}, ${age}s since heartbeat, ${unresolved.get(peer.id) ?? 0} unresolved`;
      });
      const createLabel = '+ Create new participation';
      const choice = await ask(ctx.ui.select('Resume messaging participation', [...labels, createLabel]));
      if (!choice) return;
      if (choice === createLabel) candidate = undefined;
      else { const index = labels.indexOf(choice); if (index < 0) fail('validation', 'Invalid resume selection'); candidate = candidates[index]; }
    }
    if (candidate) {
      const presence = peerPresence(candidate); const count = unresolved.get(candidate.id) ?? 0; const takeover = candidate.sessionId !== sessionId;
      const title = takeover ? 'Take over messaging participation?' : 'Resume messaging participation?';
      const detail = `${group.label}: preserve ${peerLabel(candidate)}, its routing ID and inbox (${presence}; ${count} unresolved). ${takeover ? 'The old session lease will be fenced. Takeover' : 'Resume'} grants no allowance.`;
      if (!await ask(ctx.ui.confirm(title, detail))) return;
      const attached = takeover ? await b.takeover(group, candidate.id, sessionId) : await b.resume(group, candidate.id, sessionId);
      controls.joined(group); ctx.ui.notify(`${takeover ? 'Took over' : 'Resumed'} ${group.label} as ${peerLabel(attached)}. Existing routing and inbox were preserved.`, 'info'); return;
    }
    if (!await ask(ctx.ui.confirm('Join messaging group?', `${group.label}: ${summary.mode}, ${summary.remaining} admissions remaining. Default name: ${safeText(sessionId)}; the agent can choose its role name during normal work. When armed, peers may wake this session when idle; incoming messages wait for busy work to finish. Joining does not grant allowance.`))) return;
    await b.join(group, { sessionId, displayName: sessionId });
    controls.joined(group); ctx.ui.notify(`Joined ${group.label} as ${peerLabel({ sessionId, displayName: sessionId })}. Use /messages arm to explicitly grant automatic work.`, 'info');
  } else if (command === 'arm') {
    const limit = argument === undefined ? 12 : Number(argument);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation', 'Allowance must be an integer from 1 to 100');
    const summary = await b.getGroupSummary(group); if (!summary) fail('missing', 'Group no longer exists');
    const names = (await b.peers(group)).filter(p => p.active).map(peer => `${peerLabel(peer)} (${peerPresence(peer)})`).join(', ') || '(no active peers)';
    if (await ask(ctx.ui.confirm('Arm a NEW messaging round?', `${group.label}: ${limit} shared admissions, replacing unused allowance. ${summary.pendingCount} pending/uncertain messages. Peers: ${names}. Automatic model turns spend tokens. Old attempts are never replayed.`))) await b.arm(group, limit);
  } else if (command === 'pause') {
    await b.pause(group); ctx.ui.notify('Paused new admissions. Already admitted Pi messages may still appear.', 'info');
  } else if (command === 'send') {
    await compose(group);
  } else if (command === 'routes') {
    const peers = await b.peers(group); const names = new Map(peers.map(peer => [peer.id, peerLabel(peer)]));
    const routes = await b.routes(group);
    const labels = routes.map((route, index) => `${index + 1}. ${names.get(route.fromPeerId) ?? route.fromPeerId.slice(0, 8)} → ${names.get(route.toPeerId) ?? route.toPeerId.slice(0, 8)}: ${route.mode}`);
    const choice = await ask(ctx.ui.select('Messaging route', [...labels, 'Close']));
    if (!choice || choice === 'Close') return;
    const route = routes[labels.indexOf(choice)]; if (!route) fail('validation', 'Invalid route selection');
    const action = await ask(ctx.ui.select('Route action', ['Open direction', 'Close direction', 'Cancel']));
    if (!action || action === 'Cancel') return;
    const mode = action.startsWith('Open') ? 'open' : 'closed';
    let recover = false;
    if (route.mode === 'reply-only') {
      recover = await ask(ctx.ui.confirm('Recover and replace reply-only route?', 'Marks the open request unanswered and releases only its unused reply reservation. Spent credits are not refunded.'));
      if (!recover) return;
    } else if (!await ask(ctx.ui.confirm(`${mode === 'open' ? 'Open' : 'Close'} this messaging direction?`, 'This changes initiation permission only and grants no allowance.'))) return;
    await b.setRoute(group, route.fromPeerId, route.toPeerId, mode, recover);
    ctx.ui.notify(`Route ${mode}. No allowance was granted.`, 'info');
  } else if (command === 'inbox') {
    let offset = 0;
    while (true) {
      const messages = await b.listMessages(group); const page = messages.slice(offset, offset + 20);
      const labels = page.map(m => `#${m.sequence} ${m.state} ${m.senderName} → ${m.recipientPeerId.slice(0, 8)} (${m.id})`);
      const options = [...labels, ...(offset + 20 < messages.length ? ['Older'] : []), ...(offset ? ['Newer'] : []), 'Close'];
      const choice = await ask(ctx.ui.select(`Inbox: ${group.label} (UI only)`, options));
      if (!choice || choice === 'Close') return;
      if (choice === 'Older') { offset += 20; continue; }
      if (choice === 'Newer') { offset = Math.max(0, offset - 20); continue; }
      const message = page[labels.indexOf(choice)];
      const action = await ask(ctx.ui.select(`${message.id}: ${message.state}`, ['View body', ...(message.state === 'queued' ? ['Cancel queued message'] : []), ...(message.state === 'attempted' ? ['Dismiss uncertain attempt'] : []), 'Compose new message', 'Back']));
      if (action === 'View body' || action === 'Compose new message') {
        const body = await b.readBody(group, message.id);
        if (action === 'View body') await ask(ctx.ui.editor('Inspect message — edits discarded, never sent to the model', safeText(body?.text ?? '[Body unavailable: publication may not have completed. The queued reservation can be canceled.]')));
        else if (body) await compose(group, body.text);
      } else if (action === 'Cancel queued message' || action === 'Dismiss uncertain attempt') {
        const warning = action.startsWith('Cancel')
          ? 'Canceling releases this queued reservation. It does not recall anything already admitted to Pi.'
          : 'Dismissing unblocks the participants but does not refund the spent allowance or recall anything admitted to Pi.';
        if (await ask(ctx.ui.confirm(action, warning))) await b.resolveMessage(group, message.id, action.startsWith('Cancel') ? 'canceled' : 'dismissed');
      }
    }
  } else if (command === 'prune') {
    const ids = await b.prune(group);
    if (await ask(ctx.ui.confirm('Prune terminal messaging history?', `${ids.length} eligible terminal messages from inactive senders. Unreferenced inactive peers and an empty inactive group can also be removed. Pending/uncertain work and live-sender deduplication are preserved.`))) {
      const removed = await b.prune(group, true); ctx.ui.notify(`Pruned ${removed.length} terminal messages.`, 'info');
    }
  } else if (command === 'revoke') {
    const peers = (await b.peers(group)).filter(p => p.active); const labels = peers.map((p, i) => `${i + 1}. ${peerLabel(p)} (${peerPresence(p)})`);
    const choice = await ask(ctx.ui.select('Revoke participation', labels));
    if (choice && await ask(ctx.ui.confirm('Revoke this peer?', 'Stops future admissions; does not kill a process or recall prior messages.'))) await b.revoke(group, peers[labels.indexOf(choice)].id);
  } else if (command === 'status') {
    const summary = await b.getGroupSummary(group);
    const peers = (await b.peers(group)).filter(peer => peer.active);
    ctx.ui.notify(safeText(`${group.label}: ${summary?.mode ?? 'missing'}, ${summary?.remaining ?? 0} admissions remaining; ${summary?.pendingCount ?? 0} pending/uncertain.\n${peers.map((p, i) => `${i + 1}. ${peerLabel(p)}: ${peerPresence(p)}`).join('\n')}`), 'info');
  } else fail('validation', 'Unknown /messages command. Use status, join, leave, arm, pause, send, routes, inbox, prune, or revoke.');
}
