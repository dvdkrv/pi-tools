import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const root = new URL('../', import.meta.url).pathname;
const { loadWorkConfig } = await jiti.import(`${root}src/work/config.ts`);
const { JiraClient, fetchJira } = await jiti.import(`${root}src/work/connectors/jira.ts`);
const { fetchGithub, defaultGhRunner } = await jiti.import(`${root}src/work/connectors/github.ts`);
const { commandSecretReader } = await jiti.import(`${root}src/work/secrets.ts`);

// Read-only: runs connector queries and prints counts. Never opens or writes the work database.
const { config, warnings } = loadWorkConfig();
for (const warning of warnings) console.warn(warning);
const now = new Date();
const results = [];
if (config.jira) {
  const client = new JiraClient(config.jira, { fetch: (url, init) => fetch(url, init), readSecret: commandSecretReader });
  results.push(...await fetchJira(client, [], now));
}
if (config.github.accounts.length > 0) results.push(...await fetchGithub(config.github.accounts, defaultGhRunner, [], now));
if (results.length === 0) console.warn('No connectors configured');
for (const result of results) {
  console.log(`${result.connector} ${result.query}: ${result.status} complete=${result.complete} observations=${result.observations.length}${result.error ? ` error=${result.error}` : ''}`);
}
process.exitCode = results.length > 0 && results.every((result) => result.status === 'ok') ? 0 : 1;
