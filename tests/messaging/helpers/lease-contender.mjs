import { createJiti } from 'jiti';

const { connectBackend } = await createJiti(import.meta.url).import('../../../src/messaging/nats-backend.ts');
let backend;
let group;
let reservations = [];

async function handle(request) {
  switch (request.action) {
    case 'init': {
      group = request.group;
      backend = await connectBackend(request.config);
      return backend.join(group, { sessionId: request.sessionId, displayName: request.displayName });
    }
    case 'heartbeat':
      await backend.heartbeat(); return undefined;
    case 'rename':
      await backend.heartbeat('old-process-role'); return undefined;
    case 'send':
      return backend.send({ kind: 'notice', toPeerId: request.toPeerId, text: 'forbidden old-process send' }, 'old-process-send');
    case 'reserve':
      reservations = await backend.reserve();
      return { messageIds: reservations.map(item => item.message.id) };
    case 'observe':
      await backend.observe(reservations); return undefined;
    case 'suspend': {
      // Keep the stale local handle so the next independent fencing assertion
      // exercises the same old lease after suspend rejects.
      const participant = backend.participant; const consumer = backend.consumer;
      try { await backend.suspend(); }
      catch (error) { backend.participant = participant; backend.consumer = consumer; throw error; }
      return undefined;
    }
    case 'leave':
      await backend.leave(); return undefined;
    case 'close':
      await backend?.close(); return undefined;
    default:
      throw new Error(`Unknown contender action: ${request.action}`);
  }
}

process.on('message', async request => {
  try {
    const value = await handle(request);
    process.send?.({ requestId: request.requestId, ok: true, ...(value === undefined ? {} : { value }) });
  } catch (error) {
    process.send?.({ requestId: request.requestId, ok: false, code: error?.code, error: error instanceof Error ? error.message : String(error) });
  }
});
