// Shared key table. tests/work/keymap.test.mjs runs every entry through the keymap with the dashboard options;
// tests/work/triage-ui.test.mjs runs NAVIGATION through the /triage list.
// `list` is the selected row after the keys, on a 20-row list with a 10-row page, starting at row 5.
export const NAVIGATION = [
  { name: 'j moves down', keys: ['j'], action: { type: 'move', move: 'down' }, list: 6 },
  { name: 'the down arrow is an alias for j', keys: ['\x1b[B'], action: { type: 'move', move: 'down' }, list: 6 },
  { name: 'k moves up', keys: ['k'], action: { type: 'move', move: 'up' }, list: 4 },
  { name: 'the up arrow is an alias for k', keys: ['\x1b[A'], action: { type: 'move', move: 'up' }, list: 4 },
  { name: 'gg goes to the first row', keys: ['g', 'g'], action: { type: 'move', move: 'top' }, list: 0 },
  { name: 'G goes to the last row', keys: ['G'], action: { type: 'move', move: 'bottom' }, list: 19 },
  { name: 'Ctrl-d moves half a page down', keys: ['\x04'], action: { type: 'move', move: 'half-down' }, list: 10 },
  { name: 'Ctrl-u moves half a page up', keys: ['\x15'], action: { type: 'move', move: 'half-up' }, list: 0 },
  { name: 'g then j drops the pending g and moves down', keys: ['g', 'j'], action: { type: 'move', move: 'down' }, list: 6 },
];

export const DASHBOARD = [
  { name: 'Tab goes to the next section', keys: ['\t'], action: { type: 'move', move: 'next-section' } },
  { name: '] goes to the next section', keys: [']'], action: { type: 'move', move: 'next-section' } },
  { name: 'Shift-Tab goes to the previous section', keys: ['\x1b[Z'], action: { type: 'move', move: 'prev-section' } },
  { name: '[ goes to the previous section', keys: ['['], action: { type: 'move', move: 'prev-section' } },
  { name: 'Enter activates the row', keys: ['\r'], action: { type: 'enter' } },
  { name: 'a first g is pending', keys: ['g'], action: { type: 'pending' } },
  { name: '/ starts a filter and typing extends it', keys: ['/', 'a', 'p'], action: { type: 'filter', text: 'ap', editing: true } },
  { name: 'Backspace edits the filter', keys: ['/', 'a', 'p', '\x7f'], action: { type: 'filter', text: 'a', editing: true } },
  { name: 'filter typing takes j and k as text', keys: ['/', 'j', 'k'], action: { type: 'filter', text: 'jk', editing: true } },
  { name: 'Enter keeps the filter and stops typing', keys: ['/', 'a', '\r'], action: { type: 'filter', text: 'a', editing: false } },
  { name: 'n goes to the next match', keys: ['/', 'a', '\r', 'n'], action: { type: 'match', direction: 1 } },
  { name: 'N goes to the previous match', keys: ['/', 'a', '\r', 'N'], action: { type: 'match', direction: -1 } },
  { name: 'Esc while typing clears the filter', keys: ['/', 'a', '\x1b'], action: { type: 'filter', text: '', editing: false } },
  { name: 'Esc clears a kept filter before it closes anything', keys: ['/', 'a', '\r', '\x1b'], action: { type: 'filter', text: '', editing: false } },
  { name: 'Esc closes', keys: ['\x1b'], action: { type: 'close' } },
  { name: 'q closes', keys: ['q'], action: { type: 'close' } },
  { name: 'n without a filter does nothing', keys: ['n'], action: { type: 'none' } },
  { name: 'L is an action', keys: ['L'], action: { type: 'action', key: 'L' } },
  { name: '? is an action', keys: ['?'], action: { type: 'action', key: '?' } },
  { name: 'D asks for confirmation', keys: ['D'], action: { type: 'confirming', key: 'D' } },
  { name: 'D then y is confirmed', keys: ['D', 'y'], action: { type: 'confirmed', key: 'D' } },
  { name: 'D then any other key is cancelled', keys: ['D', 'n'], action: { type: 'cancelled', key: 'D' } },
  { name: 'x then y is confirmed', keys: ['x', 'y'], action: { type: 'confirmed', key: 'x' } },
];

export const DASHBOARD_OPTIONS = { actions: ['L', 'c', 'x', 'D', 'R', '?'], confirm: ['x', 'D'], filter: true };
