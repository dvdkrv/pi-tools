export const MIGRATIONS: readonly string[] = [
	`
CREATE TABLE project (
	slug TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'parked', 'archived')),
	jira_epic TEXT,
	notes_path TEXT
);
CREATE TABLE item (
	num INTEGER PRIMARY KEY AUTOINCREMENT,
	project TEXT NOT NULL REFERENCES project(slug),
	title TEXT NOT NULL,
	notes TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'waiting', 'parked', 'done', 'dropped')),
	waiting_on TEXT CHECK (waiting_on IS NULL OR waiting_on IN ('review', 'ci', 'person', 'external')),
	waiting_reason TEXT,
	waiting_since TEXT,
	due TEXT,
	pinned INTEGER NOT NULL DEFAULT 0,
	origin TEXT NOT NULL CHECK (origin IN ('manual', 'jira', 'github', 'agent')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK ((status = 'waiting') = (waiting_on IS NOT NULL))
);
CREATE TABLE link (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	item_num INTEGER NOT NULL REFERENCES item(num),
	kind TEXT NOT NULL,
	key TEXT NOT NULL UNIQUE,
	url TEXT,
	state TEXT,
	state_at TEXT
);
CREATE TABLE signal (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	item_num INTEGER NOT NULL REFERENCES item(num),
	link_id INTEGER NOT NULL REFERENCES link(id),
	kind TEXT NOT NULL,
	detail TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	seen_in_plan INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE candidate (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL CHECK (kind IN ('new-item', 'attach-link', 'jira-update')),
	source TEXT NOT NULL CHECK (source IN ('jira', 'github', 'agent')),
	query TEXT,
	dedupe_key TEXT NOT NULL,
	title TEXT NOT NULL,
	reason TEXT NOT NULL,
	evidence TEXT,
	proposed_project TEXT,
	relates_to INTEGER,
	payload TEXT NOT NULL DEFAULT '{}',
	proposer_session TEXT,
	proposer_repo TEXT,
	state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'merged', 'dismissed', 'snoozed', 'withdrawn')),
	snooze_until TEXT,
	created_at TEXT NOT NULL,
	resolved_at TEXT
);
CREATE UNIQUE INDEX candidate_open_key ON candidate(dedupe_key) WHERE state IN ('pending', 'snoozed');
CREATE TABLE dismissal (key TEXT PRIMARY KEY, dismissed_at TEXT NOT NULL);
CREATE TABLE plan (date TEXT PRIMARY KEY, item_ids TEXT NOT NULL, quick_actions TEXT NOT NULL, notes TEXT NOT NULL, saved_at TEXT NOT NULL);
CREATE TABLE event (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	entity TEXT NOT NULL,
	action TEXT NOT NULL,
	data TEXT NOT NULL
);
CREATE INDEX event_entity ON event(entity, at);
CREATE INDEX event_at ON event(at);
CREATE TABLE connector_run (
	connector TEXT NOT NULL,
	query TEXT NOT NULL,
	status TEXT NOT NULL,
	error TEXT,
	at TEXT NOT NULL,
	last_ok_at TEXT,
	PRIMARY KEY (connector, query)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO project (slug, title, status) VALUES ('misc', 'Misc', 'active');
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
