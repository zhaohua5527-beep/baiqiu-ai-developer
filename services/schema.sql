-- 白球AI SQLite 数据库 Schema
-- Phase 2: 记忆搜索升级

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  type TEXT DEFAULT 'chat' CHECK(type IN ('chat', 'Agent', 'CEO', 'project-agent')),
  project_id TEXT,
  parent_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);

-- 项目表
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);

-- 技能表（用于存储学习的技能）
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_keywords TEXT DEFAULT '[]',
  steps TEXT DEFAULT '[]',
  usage_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0.0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);

-- FTS5 全文搜索虚拟表（独立表，不依赖外部内容）
CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
  content,
  session_id,
  role,
  msg_id
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(type);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- 触发器：自动同步 FTS5 索引
CREATE TRIGGER IF NOT EXISTS messages_ai INSERT ON messages BEGIN
  INSERT INTO fts_messages(msg_id, content, session_id, role)
  VALUES (new.id, new.content, new.session_id, new.role);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad DELETE ON messages BEGIN
  DELETE FROM fts_messages WHERE msg_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_au UPDATE ON messages BEGIN
  DELETE FROM fts_messages WHERE msg_id = old.id;
  INSERT INTO fts_messages(msg_id, content, session_id, role)
  VALUES (new.id, new.content, new.session_id, new.role);
END;
