import type { AutocompleteItem } from '@earendil-works/pi-tui';

const commands: readonly AutocompleteItem[] = [
  { value: 'status', label: 'status', description: 'Show peers, pending messages, and shared allowance (default)' },
  { value: 'join ', label: 'join [group]', description: 'Choose/create a group and confirm participation; does not arm it' },
  { value: 'leave', label: 'leave', description: 'Leave this session’s group; admitted messages cannot be recalled' },
  { value: 'arm ', label: 'arm [1–100]', description: 'Confirm a NEW shared allowance; default 12, replaces unused credits' },
  { value: 'pause', label: 'pause', description: 'Stop new group admissions; already admitted messages may still appear' },
  { value: 'send', label: 'send', description: 'Pick a peer and compose a queued message' },
  { value: 'inbox', label: 'inbox', description: 'Inspect messages, cancel queued work, or dismiss uncertain attempts' },
  { value: 'revoke', label: 'revoke', description: 'Disable an old peer’s participation without killing its process' },
  { value: 'prune', label: 'prune', description: 'Preview cleanup of eligible terminal history and inactive records' },
];

/** Native command arguments replace the entire argument prefix, not just its last word. */
export function completeMessages(prefix: string, groupLabels: readonly string[] = []): AutocompleteItem[] | null {
  const text = prefix.trimStart();
  let items: AutocompleteItem[] = [];
  if (!/\s/.test(text)) {
    items = commands.filter(item => item.value.trim().startsWith(text)).map(item => ({ ...item }));
  } else {
    const match = /^(join|arm)\s+(\S*)$/.exec(text);
    if (!match) return null;
    const [, command, argument] = match;
    if (command === 'join') {
      items = [...new Set(groupLabels)]
        .filter(label => typeof label === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(label))
        .sort().slice(0, 32).filter(label => label.startsWith(argument))
        .map(label => ({ value: `join ${label}`, label, description: 'Known group; participation still requires confirmation' }));
    } else {
      const limits = [1, 2, 12];
      const value = Number(argument);
      if (/^[1-9]\d{0,2}$/.test(argument) && value <= 100 && !limits.includes(value)) limits.push(value);
      items = limits.filter(limit => String(limit).startsWith(argument)).map(limit => ({
        value: `arm ${limit}`, label: String(limit),
        description: `${limit === 12 ? 'Default: ' : ''}${limit} shared admission${limit === 1 ? '' : 's'}; confirm a new round (1–100)`,
      }));
    }
  }
  return items.length ? items : null;
}
