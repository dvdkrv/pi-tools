process.once('message', ({ delayMs, fail }) => {
  setTimeout(() => {
    if (fail) {
      console.error('planned contender failure');
      process.exitCode = 1;
      process.disconnect();
      return;
    }
    process.send?.({ state: 'running', authorityId: 'test-authority' }, () => process.disconnect());
  }, delayMs);
});
