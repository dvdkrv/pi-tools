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
	`
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	file TEXT,
	cwd TEXT NOT NULL,
	name TEXT,
	pid INTEGER,
	tmux_pane TEXT,
	tmux_window TEXT,
	started_at TEXT NOT NULL,
	last_turn_at TEXT,
	ended_at TEXT,
	status TEXT NOT NULL CHECK (status IN ('working', 'needs-me', 'waiting-external', 'done')),
	note TEXT NOT NULL DEFAULT '',
	status_source TEXT NOT NULL CHECK (status_source IN ('agent', 'auto')),
	status_at TEXT NOT NULL,
	restored_from INTEGER,
	parent_session TEXT,
	headless INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX session_parent ON session(parent_session);
CREATE TABLE job (
	num INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('cron', 'process')),
	owner_session TEXT,
	item_num INTEGER REFERENCES item(num),
	schedule TEXT,
	pid INTEGER,
	cwd TEXT NOT NULL,
	check_command TEXT,
	stop_command TEXT,
	log_path TEXT,
	last_check_at TEXT,
	last_check_status TEXT CHECK (last_check_status IS NULL OR last_check_status IN ('healthy', 'unhealthy', 'unknown')),
	last_check_output TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	stopped_at TEXT
);
CREATE UNIQUE INDEX job_active_name ON job(name) WHERE stopped_at IS NULL;
CREATE TABLE usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	surface TEXT NOT NULL CHECK (surface IN ('dash', 'cli', 'pi', 'triage', 'planner')),
	action TEXT NOT NULL,
	context TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX usage_at ON usage(at);
`,
	`
CREATE TABLE child_run (
	num INTEGER PRIMARY KEY AUTOINCREMENT,
	lead_session TEXT NOT NULL,
	child_session TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('implement', 'read-only')),
	brief TEXT NOT NULL,
	model TEXT NOT NULL,
	repo TEXT,
	worktree TEXT,
	branch TEXT,
	base_commit TEXT,
	pid INTEGER,
	outcome TEXT NOT NULL CHECK (outcome IN ('running', 'done', 'failed', 'over-budget', 'over-spend', 'incomplete', 'stopped', 'merged', 'discarded', 'interrupted')),
	flags TEXT NOT NULL DEFAULT '[]',
	spend_usd REAL NOT NULL DEFAULT 0,
	diff_lines INTEGER NOT NULL DEFAULT 0,
	diff_files INTEGER NOT NULL DEFAULT 0,
	budget_lines INTEGER,
	budget_files INTEGER,
	acceptance TEXT NOT NULL DEFAULT '[]',
	summary TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	ended_at TEXT,
	merged_at TEXT
);
CREATE INDEX child_run_lead ON child_run(lead_session);
CREATE INDEX child_run_child ON child_run(child_session);
`,
	`
CREATE TABLE message_log (
	id TEXT PRIMARY KEY,
	at TEXT NOT NULL,
	group_label TEXT NOT NULL,
	sender_peer TEXT NOT NULL,
	sender_session TEXT,
	sender_name TEXT NOT NULL,
	recipient_peer TEXT NOT NULL,
	recipient_session TEXT,
	recipient_name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('notice', 'request', 'reply')),
	in_reply_to TEXT,
	state TEXT NOT NULL,
	state_at TEXT NOT NULL,
	body TEXT NOT NULL
);
CREATE INDEX message_log_at ON message_log(at);
CREATE INDEX message_log_reply ON message_log(in_reply_to);
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
