import { createJiti } from 'jiti';

const { ensureBroker } = await createJiti(import.meta.url).import('../../../src/messaging/broker-lifecycle.ts');

process.once('message', async options => {
  try {
    const result = await ensureBroker(options);
    process.send?.({ state: result.state, authorityId: result.config.authorityId }, () => process.disconnect());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    process.disconnect();
  }
});
