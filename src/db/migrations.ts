import type { Migration } from './database.ts';

export const MIGRATIONS: readonly Migration[] = [
  // 1: 会話・発言・実行記録・KV
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'task')),
    title TEXT,
    -- 会話の開始時に作る凍結スナップショット（system の不変部分）。会話中は変えない
    snapshot TEXT,
    snapshot_hash TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_conversations_recent ON conversations (archived, last_message_at DESC);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    run_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    -- 検索と表示に使う平文
    text TEXT NOT NULL DEFAULT '',
    -- モデルに渡す構造（ツール呼び出しなど）の JSON
    parts TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_messages_conversation ON messages (conversation_id, id);

  CREATE VIRTUAL TABLE messages_fts USING fts5 (text, content = 'messages', content_rowid = 'id', tokenize = 'trigram');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE engine_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    conversation_id TEXT,
    model_id TEXT,
    provider_id TEXT,
    model TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    ok INTEGER,
    error_kind TEXT,
    error_message TEXT,
    stop TEXT,
    iterations INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    est_prompt_tokens INTEGER,
    flags TEXT NOT NULL DEFAULT '[]'
  ) STRICT;
  CREATE INDEX ix_engine_runs_started ON engine_runs (started_at DESC);
  CREATE INDEX ix_engine_runs_model ON engine_runs (model_id, started_at DESC);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 2: ツールの実行記録と承認
  `
  CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    conversation_id TEXT,
    tool TEXT NOT NULL,
    -- 伏せ字にした入力
    input TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
    decided_by TEXT NOT NULL,
    approval_id TEXT,
    ok INTEGER,
    duration_ms INTEGER,
    output_preview TEXT,
    full_ref TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_tool_calls_run ON tool_calls (run_id, created_at);
  CREATE INDEX ix_tool_calls_created ON tool_calls (created_at DESC);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    reasons TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
    scope TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  ) STRICT;
  CREATE INDEX ix_approvals_status ON approvals (status, created_at DESC);
  `,
  // 3: 記憶。会話中にその場で保存し、一覧で見て直せる。出典と変更履歴を残す
  `
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    book TEXT NOT NULL CHECK (book IN ('user', 'notes')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'forgotten')),
    origin TEXT NOT NULL CHECK (origin IN ('chat', 'review', 'user')),
    source_conversation_id TEXT,
    source_message_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_memories_book ON memories (book, status, updated_at DESC);

  CREATE VIRTUAL TABLE memories_fts USING fts5 (content, content = 'memories', content_rowid = 'id', tokenize = 'trigram');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
  END;

  -- 記憶の変更履歴（取り消しの元データ）
  CREATE TABLE memory_events (
    id INTEGER PRIMARY KEY,
    memory_id INTEGER NOT NULL REFERENCES memories (id),
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'forget', 'restore')),
    before TEXT,
    after TEXT,
    actor TEXT NOT NULL CHECK (actor IN ('beat', 'user', 'review')),
    run_id TEXT,
    reason TEXT,
    undone_at INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_memory_events_memory ON memory_events (memory_id, created_at DESC);

  -- SOUL.md と USER.md の版（会話の開始時に中身が変わっていたら残す）
  CREATE TABLE file_versions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_file_versions_name ON file_versions (name, id DESC);

  -- 会話の古い部分の要約（コンテキストに入りきらなくなったときに作る）
  ALTER TABLE conversations ADD COLUMN summary TEXT;
  ALTER TABLE conversations ADD COLUMN summary_upto INTEGER;
  `,
  // 4: タスク（自分で書いて自分で動くメモ帳）と通知
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    next_action TEXT,
    done_criteria TEXT,
    status TEXT NOT NULL CHECK (status IN ('inbox', 'ready', 'running', 'waiting', 'scheduled', 'done', 'failed', 'cancelled')),
    origin TEXT NOT NULL CHECK (origin IN ('user', 'self', 'curiosity', 'schedule')),
    priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    -- 繰り返し（status = 'scheduled' のひな形だけが持つ）
    cron TEXT,
    timezone TEXT,
    -- これより前には実行しない（予定・休止・再試行の待ち）
    run_at INTEGER,
    parent_id TEXT REFERENCES tasks (id),
    -- タスク専用の会話（実行の記録が積み上がる）
    conversation_id TEXT,
    waiting_kind TEXT CHECK (waiting_kind IN ('question', 'approval')),
    waiting_text TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_until INTEGER,
    result_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  ) STRICT;
  CREATE INDEX ix_tasks_actionable ON tasks (status, run_at, priority);
  CREATE INDEX ix_tasks_parent ON tasks (parent_id);

  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks (id),
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    content TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_task_events_task ON task_events (task_id, id);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    dedup_key TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_notifications_recent ON notifications (created_at DESC);
  CREATE INDEX ix_notifications_dedup ON notifications (dedup_key, created_at DESC);
  `,
  // 5: 好奇心リスト・スキルの下書きと使用回数・記憶の振り返りのジョブ
  `
  CREATE TABLE curiosity_items (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    why TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'researching', 'done', 'dropped')),
    result TEXT,
    task_id TEXT,
    source TEXT NOT NULL DEFAULT 'beat',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_curiosity_open ON curiosity_items (status, created_at);
  ALTER TABLE tasks ADD COLUMN curiosity_id INTEGER;

  CREATE TABLE skill_drafts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    conversation_id TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  ) STRICT;
  CREATE INDEX ix_skill_drafts_pending ON skill_drafts (status, created_at);

  CREATE TABLE skill_usage (
    name TEXT PRIMARY KEY,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER
  ) STRICT;

  CREATE TABLE memory_jobs (
    id INTEGER PRIMARY KEY,
    trigger TEXT NOT NULL CHECK (trigger IN ('task', 'idle', 'heavy_run', 'book_full', 'manual')),
    dedup_key TEXT NOT NULL UNIQUE,
    conversation_id TEXT,
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    run_id TEXT,
    review_conversation_id TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  ) STRICT;
  CREATE INDEX ix_memory_jobs_pending ON memory_jobs (status, created_at);
  `,
  // 6: 添付ファイル
  `
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'pdf', 'image')),
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    text TEXT,
    pages INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 7: 取り消しを元に戻すため、取り消す直前の状態を覚える（前に取り消したものは NULL = 戻せない）
  `
  ALTER TABLE tasks ADD COLUMN cancelled_from TEXT CHECK (cancelled_from IN ('inbox', 'ready', 'running', 'waiting', 'scheduled'));
  `,
  // 8: 会話の task_create で作ったタスクを、作った会話の ID で探せるようにする（前からある行は NULL。経過の文は探すのに使わない）
  `
  ALTER TABLE tasks ADD COLUMN created_in_conversation TEXT;
  CREATE INDEX ix_tasks_created_in ON tasks (created_in_conversation);
  `,
  // 9: 会話ごとに選んだモデルと考える深さ（NULL = 自動・モデルの既定。前からある会話はこれまでと同じ動き）
  `
  ALTER TABLE conversations ADD COLUMN model_id TEXT;
  ALTER TABLE conversations ADD COLUMN effort TEXT;
  `,
  // 10: 実行の「外から読んだ」印（Web・添付を読んだ実行は 1。やり直し・続きの実行が引き継ぐ）と、手元のモデルを選んだ会話から作ったタスクの印（1 = 手元のモデルだけで動かす）
  `
  ALTER TABLE engine_runs ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
  `,
  // 11: 会話ごとの権限モード（normal = ふつう / auto = 自動承認 / plan = 計画。前からある会話と新しい会話は normal）
  `
  ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'normal' CHECK (permission_mode IN ('normal', 'auto', 'plan'));
  `,
  // 12: 会話の「外から読んだことがある」印 ever_tainted（1 = この会話のチャットの実行が、Web・添付・シェルの取得を一度でも読んだ。付いたら外れない。自動承認の判定役は、この会話では使わない）。
  // 前からある会話は、外から読んだ実行の記録（engine_runs.tainted）から付ける。実行の「自動承認で許可フォルダの外を読んだ」印 auto_read_outside（止めた・失敗した実行から、次の実行が引き継ぐ）
  `
  ALTER TABLE conversations ADD COLUMN ever_tainted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE engine_runs ADD COLUMN auto_read_outside INTEGER NOT NULL DEFAULT 0;
  UPDATE conversations SET ever_tainted = 1 WHERE id IN (SELECT conversation_id FROM engine_runs WHERE kind = 'chat' AND tainted = 1 AND conversation_id IS NOT NULL);
  `,
  // 13: 会話の「自動承認で許可フォルダの外を読んだことがある」印 ever_auto_read（1 = この会話のどこかの実行で、自動承認の判定役が外を読むのを許した。付いたら外れない。
  // この会話のシェルのコマンドと通信の道具は、ずっと毎回確かめる）。12 で足した実行ごとの印 auto_read_outside は、この印に置き換える（印のある実行の会話に付けてから、列を落とす）
  `
  ALTER TABLE conversations ADD COLUMN ever_auto_read INTEGER NOT NULL DEFAULT 0;
  UPDATE conversations SET ever_auto_read = 1 WHERE id IN (SELECT conversation_id FROM engine_runs WHERE auto_read_outside = 1 AND conversation_id IS NOT NULL);
  ALTER TABLE engine_runs DROP COLUMN auto_read_outside;
  `,
  // 14: 12 の ever_tainted の付け直し。12 は実行の記録 engine_runs.tainted（10 で足した列）から付けるが、main からの更新では 10 も同じ更新で足されるので、前からある実行の記録は全部 0 で、1 つも付かなかった。
  // 前の記録から「外から読んでいない」とは確かめられないので、更新の時点で既にあるすべての会話に付ける（自動承認の判定役が、前からある会話では使われなくなるだけ。更新のあとに作る会話は 0 から始まる）
  `
  UPDATE conversations SET ever_tainted = 1;
  `,
  // 15: 承認の記録に、「この返事のあいだ、このフォルダ以下への書き込みを許可」を選んだときのフォルダ grant_folder（そのとき scope は folder。選ばなかった承認は NULL）
  `
  ALTER TABLE approvals ADD COLUMN grant_folder TEXT;
  `,
  // 16: 振り返りの会話が、材料にした会話・タスクを自分で覚える（外のモデルの履歴の検索・読み出しから隠す決まりが、振り返りの記録の結び付きに頼らないように）。前からある会話のうち、振り返りの記録から辿れるものは、記録の値で埋める
  `
  ALTER TABLE conversations ADD COLUMN source_conversation_id TEXT;
  ALTER TABLE conversations ADD COLUMN source_task_id TEXT;
  CREATE INDEX ix_conversations_source ON conversations (source_conversation_id);
  UPDATE conversations SET
    source_conversation_id = (SELECT j.conversation_id FROM memory_jobs j WHERE j.review_conversation_id = conversations.id ORDER BY j.id DESC LIMIT 1),
    source_task_id = (SELECT j.task_id FROM memory_jobs j WHERE j.review_conversation_id = conversations.id ORDER BY j.id DESC LIMIT 1)
  WHERE kind = 'task' AND id IN (SELECT review_conversation_id FROM memory_jobs WHERE review_conversation_id IS NOT NULL);
  `,
  // 17: スキルの登録簿。持ち主が認めた名前（承認した下書き・画面の保存・画面の「登録する」・更新の時点で既にあったもの）だけを、一覧と skill_view に出す。
  // 「登録している」とは、その名前の行があること（中身のハッシュは持たない。登録した名前は、あとで書き直されてもそのまま使う）。登録の行は、持ち主の画面の API だけが書く
  `
  CREATE TABLE skill_registry (
    name TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('approved', 'owner', 'upgrade')),
    registered_at INTEGER NOT NULL
  );
  `,
  // 18: 子の担当（agent_run）。子の会話・子の実行の記録が、親の実行を覚える（NULL は親の無い、ふつうの会話・実行）。子の会話は kind 'task' のまま（CHECK を作り直さない）で、この列で見分ける。一覧・履歴の検索・振り返りから外す決まりに使う
  `
  ALTER TABLE conversations ADD COLUMN parent_run_id TEXT;
  ALTER TABLE engine_runs ADD COLUMN parent_run_id TEXT;
  CREATE INDEX idx_conversations_parent_run ON conversations (parent_run_id) WHERE parent_run_id IS NOT NULL;
  `,
  // 19: 通知が「手元のモデルだけで扱う（localOnly）仕事から出た」ことを覚える。外の送り先（webhook）へは、この印のある通知の題・本文を送らない。前からある通知は 0（印なし）
  `
  ALTER TABLE notifications ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root TEXT NOT NULL,
    root_key TEXT NOT NULL,
    check_command TEXT,
    scout_mode TEXT NOT NULL DEFAULT 'off' CHECK (scout_mode IN ('off', 'research', 'fix')),
    remotes TEXT NOT NULL DEFAULT '[]',
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX ux_projects_root ON projects (root_key) WHERE archived_at IS NULL;
  ALTER TABLE conversations ADD COLUMN project_id TEXT;
  CREATE INDEX ix_conversations_project ON conversations (project_id) WHERE project_id IS NOT NULL;
  ALTER TABLE tasks ADD COLUMN project_id TEXT;
  ALTER TABLE tasks ADD COLUMN proposed_by TEXT;
  CREATE INDEX ix_tasks_project ON tasks (project_id) WHERE project_id IS NOT NULL;
  `,
  `
  CREATE TABLE acceptance_versions (
    project_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    hash TEXT NOT NULL,
    content TEXT NOT NULL,
    plan_hash TEXT,
    source TEXT NOT NULL CHECK (source IN ('build', 'change', 'question', 'proposal')),
    build_task_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, version)
  ) STRICT;
  ALTER TABLE projects ADD COLUMN doc_language TEXT;
  ALTER TABLE projects ADD COLUMN doc_language_pinned INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE tasks ADD COLUMN acceptance_items TEXT;
  `,
  `
  CREATE TABLE acceptance_changes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    ops TEXT NOT NULL,
    language TEXT,
    conversation_id TEXT,
    tainted INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  ) STRICT;
  CREATE INDEX ix_acceptance_changes_project ON acceptance_changes (project_id, status);
  `,
  `
  INSERT INTO task_events (task_id, kind, actor, content, run_id, created_at)
  SELECT DISTINCT e.task_id, 'context', 'system', 'Written by a run of a conversation that read text from elsewhere.', 'untrusted-input', CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM task_events e LEFT JOIN engine_runs r ON r.id = e.run_id LEFT JOIN conversations c ON c.id = r.conversation_id
  WHERE e.run_id IS NOT NULL AND e.run_id <> 'untrusted-input' AND e.kind IN ('context', 'note', 'edited')
    AND (r.conversation_id IS NULL OR r.tainted = 1 OR c.ever_tainted = 1)
    AND NOT EXISTS (SELECT 1 FROM task_events x WHERE x.task_id = e.task_id AND x.run_id = 'untrusted-input' AND x.kind = 'context');
  INSERT INTO task_events (task_id, kind, actor, content, run_id, created_at)
  SELECT t.id, 'context', 'system', 'Its text came from a schedule that had text written after reading text from elsewhere.', 'untrusted-input', CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM tasks t
  WHERE t.origin = 'schedule' AND t.parent_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM task_events x WHERE x.task_id = t.id AND x.run_id = 'untrusted-input' AND x.kind = 'context');
  `,
  `
  CREATE TABLE pending_actions (
    id INTEGER PRIMARY KEY,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    shown TEXT NOT NULL,
    masked INTEGER NOT NULL DEFAULT 0,
    cwd TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('send', 'delete', 'hook', 'policy', 'owner', 'judge', 'judge_failed')),
    reason TEXT NOT NULL,
    checks TEXT NOT NULL DEFAULT '[]',
    bind TEXT,
    state TEXT,
    files TEXT,
    run_id TEXT NOT NULL,
    run_kind TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    task_id TEXT,
    project_id TEXT,
    tainted INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'ran', 'failed', 'rejected', 'stale', 'cancelled')),
    reject_reason TEXT,
    exit_code INTEGER,
    output_preview TEXT,
    full_ref TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    ran_at INTEGER
  ) STRICT;
  CREATE INDEX ix_pending_actions_status ON pending_actions (status, created_at DESC);
  CREATE INDEX ix_pending_actions_project ON pending_actions (project_id, status);
  `,
  `
  ALTER TABLE tasks ADD COLUMN owner_request TEXT;
  `,
  `
  UPDATE conversations SET permission_mode = 'auto' WHERE permission_mode = 'normal';
  UPDATE approvals SET status = 'cancelled', decided_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE status = 'pending';
  `,
  `
  UPDATE conversations SET permission_mode = 'auto' WHERE permission_mode = 'normal';
  `,
  `
  CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    project_id TEXT,
    task_id TEXT,
    conversation_id TEXT,
    kind TEXT NOT NULL DEFAULT 'ai' CHECK (kind IN ('ai', 'stuck', 'check_failed', 'submit_refused')),
    question TEXT NOT NULL,
    why TEXT,
    options TEXT NOT NULL DEFAULT '[]',
    chosen INTEGER,
    blocking INTEGER NOT NULL DEFAULT 0 CHECK (blocking IN (0, 1)),
    acceptance_item TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
    answer TEXT,
    answer_kind TEXT CHECK (answer_kind IN ('kept', 'changed')),
    fix_task_id TEXT,
    tainted INTEGER NOT NULL DEFAULT 0 CHECK (tainted IN (0, 1)),
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  ) STRICT;
  CREATE INDEX ix_questions_status ON questions (status, created_at DESC);
  CREATE INDEX ix_questions_project ON questions (project_id, status);
  CREATE INDEX ix_questions_task ON questions (task_id);
  `,
  `
  ALTER TABLE tasks ADD COLUMN spawned_by TEXT;
  CREATE INDEX ix_tasks_spawned_by ON tasks (spawned_by) WHERE spawned_by IS NOT NULL;
  `,
  `
  ALTER TABLE notifications ADD COLUMN project_id TEXT;
  `,
  `
  ALTER TABLE tasks ADD COLUMN check_state TEXT CHECK (check_state IN ('awaiting', 'checked'));
  ALTER TABLE tool_calls ADD COLUMN evidence_no INTEGER;
  CREATE INDEX ix_tool_calls_evidence ON tool_calls (conversation_id, evidence_no) WHERE evidence_no IS NOT NULL;
  ALTER TABLE acceptance_versions ADD COLUMN item_states TEXT;
  `,
  `
  ALTER TABLE skill_drafts ADD COLUMN change_summary TEXT;
  `,
  `
  UPDATE tasks SET status = 'inbox', lease_until = NULL, updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE origin = 'curiosity' AND status IN ('ready', 'running');
  `,
  `
  CREATE TABLE research_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    conversation_id TEXT,
    run_id TEXT,
    phase TEXT NOT NULL CHECK (phase IN ('products', 'libraries')),
    mode TEXT NOT NULL CHECK (mode IN ('batch', 'one_by_one')),
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'cancelled', 'skipped', 'confirmed')),
    shown_hash TEXT,
    confirmed_at INTEGER,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    limits TEXT NOT NULL DEFAULT '{}'
  ) STRICT;
  CREATE INDEX ix_research_runs_project ON research_runs (project_id, created_at DESC);
  CREATE INDEX ix_research_runs_run ON research_runs (run_id) WHERE run_id IS NOT NULL;

  CREATE TABLE research_items (
    id INTEGER PRIMARY KEY,
    research_id TEXT NOT NULL REFERENCES research_runs (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('similar', 'feature', 'choice', 'library')),
    name_or_label TEXT NOT NULL,
    detail TEXT,
    url TEXT,
    license TEXT,
    updated TEXT,
    language TEXT,
    evidence TEXT NOT NULL DEFAULT '[]',
    products TEXT NOT NULL DEFAULT '[]',
    options TEXT,
    default_checked INTEGER NOT NULL DEFAULT 0 CHECK (default_checked IN (0, 1)),
    default_reason TEXT CHECK (default_reason IN ('owner_said', 'standard')),
    decision TEXT,
    reason TEXT,
    recommended INTEGER,
    answer_kind TEXT CHECK (answer_kind IN ('kept', 'changed'))
  ) STRICT;
  CREATE INDEX ix_research_items_research ON research_items (research_id, id);
  `,
  `
  CREATE TABLE judge_calls (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    run_kind TEXT NOT NULL,
    project_id TEXT,
    tool TEXT NOT NULL,
    reason_keys TEXT NOT NULL DEFAULT '[]',
    ask_kinds TEXT NOT NULL DEFAULT '[]',
    outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'ask', 'failed')),
    failed TEXT,
    judge_model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_judge_calls_created ON judge_calls (created_at);
  CREATE INDEX ix_judge_calls_run ON judge_calls (run_id);
  `,
  `
  ALTER TABLE questions ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
  CREATE INDEX ix_tasks_conversation ON tasks (conversation_id) WHERE conversation_id IS NOT NULL;
  `,
  `
  ALTER TABLE memory_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'memory' CHECK (kind IN ('memory', 'skill'));
  ALTER TABLE skill_drafts ADD COLUMN outside INTEGER NOT NULL DEFAULT 0 CHECK (outside IN (0, 1));
  ALTER TABLE skill_registry ADD COLUMN outside INTEGER NOT NULL DEFAULT 0 CHECK (outside IN (0, 1));
  `,
  `
  ALTER TABLE tasks ADD COLUMN proposal TEXT;
  `,
  `
  UPDATE tasks SET status = 'inbox', lease_until = NULL, updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE origin = 'self' AND status IN ('ready', 'running') AND proposed_by IS NOT 'scout-run'
    AND NOT EXISTS (SELECT 1 FROM kv WHERE kv.key = 'task-owner-run:' || tasks.id);
  `,
  `
  CREATE TABLE memory_file_events (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'forget', 'restore', 'outside', 'reviewed')),
    before TEXT,
    after TEXT,
    actor TEXT NOT NULL CHECK (actor IN ('beat', 'review', 'owner')),
    summary TEXT,
    tainted INTEGER NOT NULL CHECK (tainted IN (0, 1)),
    run_id TEXT,
    conversation_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_memory_file_events_name ON memory_file_events (project_id, name, id DESC);
  CREATE INDEX ix_memory_file_events_action ON memory_file_events (project_id, action, actor);
  `,
  `
  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    task_id TEXT,
    proposal_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('task', 'fix')),
    path TEXT,
    branch TEXT NOT NULL,
    base TEXT NOT NULL,
    tip TEXT,
    own_tip TEXT,
    state TEXT NOT NULL CHECK (state IN ('creating', 'active', 'branch', 'merged', 'discarded', 'removing', 'gone')),
    keep_branch INTEGER NOT NULL DEFAULT 1 CHECK (keep_branch IN (0, 1)),
    ending TEXT CHECK (ending IS NULL OR ending IN ('branch', 'merged', 'discarded', 'gone')),
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_worktrees_project ON worktrees (project_id);
  CREATE INDEX ix_worktrees_task ON worktrees (task_id) WHERE task_id IS NOT NULL;
  `,
  `
  CREATE TABLE approval_rules (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('judge', 'send', 'delete', 'policy')),
    tool TEXT NOT NULL,
    base TEXT NOT NULL,
    base_key TEXT NOT NULL,
    keys TEXT NOT NULL,
    shown TEXT NOT NULL,
    from_pending INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_approval_rules_lookup ON approval_rules (project_id, kind, base_key);
  `,
  `
  CREATE TABLE file_changes (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    place TEXT,
    run_id TEXT,
    conversation_id TEXT,
    task_id TEXT,
    batch TEXT,
    path TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'modify', 'undo', 'redo')),
    before_hash TEXT,
    after_hash TEXT,
    size INTEGER NOT NULL,
    kept INTEGER NOT NULL CHECK (kept IN (0, 1)),
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ix_file_changes_project ON file_changes (project_id, id);
  CREATE INDEX ix_file_changes_run ON file_changes (run_id) WHERE run_id IS NOT NULL;
  `,
];
