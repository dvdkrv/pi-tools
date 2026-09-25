import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { WorkStore } = await jiti.import(new URL('../../../src/work/store.ts', import.meta.url).pathname);
const [path, count] = process.argv.slice(2);
const store = WorkStore.open(path);
for (let i = 0; i < Number(count); i++) {
  store.addItem({ project: 'misc', title: `writer ${process.pid} item ${i}`, origin: 'manual' }, 'user');
}
store.close();
