import { createJiti } from 'jiti';
const { connectBackend } = await createJiti(import.meta.url).import('../../../src/messaging/nats-backend.ts');
let backend;
process.on('message', async value => {
  try {
    if (value.action === 'reserve') {
      const batch = await backend.reserve(); process.send(batch.length ? { attemptId: batch[0].attemptId } : {});
    } else if (value.action === 'send') {
      const message = await backend.send({ toPeerId: value.toPeerId, text: 'one handoff' }, value.key); process.send({ messageId: message.id });
    } else {
      backend = await connectBackend(value.config); const peer = await backend.join(value.g, { sessionId: `child-${value.i}`, displayName: `Child ${value.i}` }); process.send(peer);
    }
  } catch (error) { process.send({ error: String(error) }); }
});
