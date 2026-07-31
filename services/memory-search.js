/**
 * MemorySearchService - SQLite + FTS5 记忆搜索服务
 * 白球AI Phase 2: 换骨架计划
 * 
 * 功能：
 * - 全文检索（FTS5）
 * - 跨会话语义搜索
 * - 时间范围过滤
 * - 会话/项目过滤
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class MemorySearchService {
  constructor(userDataPath) {
    this.dbPath = path.join(userDataPath, 'heiqiu-db.sqlite');
    this.db = null;
    this.initialized = false;
  }

  /**
   * 初始化数据库
   */
  initialize() {
    if (this.initialized) return;
    
    try {
      this.db = new Database(this.dbPath);
      
      // 启用 WAL 模式（提高并发性能）
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      
      // 读取并执行 schema
      const schemaPath = path.join(__dirname, 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf-8');
      this.db.exec(schema);
      
      this.initialized = true;
      console.log('[MemorySearch] SQLite 数据库初始化成功');
    } catch (error) {
      console.error('[MemorySearch] 初始化失败:', error);
      throw error;
    }
  }

  /**
   * 搜索消息（混合策略：LIKE 为主，FTS5 英文为辅）
   */
  searchMessages(query, options = {}) {
    if (!this.initialized) this.initialize();
    
    const { sessionId, projectId, limit = 20, timeRange } = options;
    
    // 主搜索：LIKE（可靠支持中英文）
    let sql = `
      SELECT 
        m.id,
        m.session_id,
        m.role,
        m.content,
        m.created_at,
        s.title as session_title,
        s.type as session_type,
        1.0 as rank
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.content LIKE ?
    `;
    const params = [`%${query}%`];
    
    if (sessionId) {
      sql += ' AND m.session_id = ?';
      params.push(sessionId);
    }
    
    if (projectId) {
      sql += ' AND s.project_id = ?';
      params.push(projectId);
    }
    
    if (timeRange?.from) {
      sql += ' AND m.created_at >= ?';
      params.push(timeRange.from);
    }
    
    if (timeRange?.to) {
      sql += ' AND m.created_at <= ?';
      params.push(timeRange.to);
    }
    
    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    params.push(limit);
    
    try {
      const stmt = this.db.prepare(sql);
      const likeResults = stmt.all(...params);
      
      // 英文搜索时，尝试 FTS5 补充排序
      if (!/[\u4e00-\u9fff]/.test(query) && likeResults.length < limit) {
        try {
          const ftsSql = `
            SELECT 
              m.id,
              m.session_id,
              m.role,
              m.content,
              m.created_at,
              s.title as session_title,
              s.type as session_type,
              f.rank
            FROM fts_messages f
            JOIN messages m ON m.id = f.msg_id
            JOIN sessions s ON m.session_id = s.id
            WHERE fts_messages MATCH ?
            ORDER BY f.rank
            LIMIT ?
          `;
          const ftsResults = this.db.prepare(ftsSql).all(query, limit);
          // 合并去重
          const seen = new Set(likeResults.map(r => r.id));
          for (const r of ftsResults) {
            if (!seen.has(r.id)) {
              likeResults.push(r);
              seen.add(r.id);
            }
          }
        } catch (e) {
          // FTS5 搜索失败不影响主结果
        }
      }
      
      return likeResults;
    } catch (error) {
      console.error('[MemorySearch] 搜索失败:', error);
      return [];
    }
  }

  /**
   * 获取会话历史（按时间排序）
   */
  getSessionHistory(sessionId, limit = 50) {
    if (!this.initialized) this.initialize();
    
    const sql = `
      SELECT 
        id,
        role,
        content,
        created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `;
    
    try {
      const stmt = this.db.prepare(sql);
      return stmt.all(sessionId, limit);
    } catch (error) {
      console.error('[MemorySearch] 获取会话历史失败:', error);
      return [];
    }
  }

  /**
   * 获取相关会话（基于共同关键词）
   */
  findRelatedSessions(sessionId, limit = 5) {
    if (!this.initialized) this.initialize();
    
    // 获取当前会话的关键词
    const currentMessages = this.getSessionHistory(sessionId, 20);
    if (currentMessages.length === 0) return [];
    
    // 提取关键词（简单实现：取前10个用户消息的分词）
    const keywords = currentMessages
      .filter(m => m.role === 'user')
      .slice(0, 10)
      .map(m => m.content)
      .join(' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 5);
    
    if (keywords.length === 0) return [];
    
    // 搜索包含这些关键词的其他会话
    const query = keywords.join(' OR ');
    const results = this.searchMessages(query, { 
      limit: limit * 3,  // 多取一些，然后去重
      sessionId: null 
    });
    
    // 按会话分组并去重
    const sessionMap = new Map();
    for (const msg of results) {
      if (msg.session_id === sessionId) continue;
      if (!sessionMap.has(msg.session_id)) {
        sessionMap.set(msg.session_id, {
          sessionId: msg.session_id,
          title: msg.session_title,
          type: msg.session_type,
          matchCount: 0,
          lastMessage: msg.created_at
        });
      }
      const session = sessionMap.get(msg.session_id);
      session.matchCount++;
      session.lastMessage = Math.max(session.lastMessage, msg.created_at);
    }
    
    // 按匹配度排序
    return Array.from(sessionMap.values())
      .sort((a, b) => b.matchCount - a.matchCount || b.lastMessage - a.lastMessage)
      .slice(0, limit);
  }

  /**
   * 插入消息（用于迁移或新消息）
   */
  insertMessage(message) {
    if (!this.initialized) this.initialize();
    
    const sql = `
      INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    try {
      const stmt = this.db.prepare(sql);
      stmt.run(
        message.id,
        message.session_id,
        message.role,
        message.content,
        message.created_at,
        JSON.stringify(message.metadata || {})
      );
      return true;
    } catch (error) {
      console.error('[MemorySearch] 插入消息失败:', error);
      return false;
    }
  }

  /**
   * 插入会话
   */
  insertSession(session) {
    if (!this.initialized) this.initialize();
    
    const sql = `
      INSERT OR REPLACE INTO sessions (id, title, type, project_id, parent_session_id, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    try {
      const stmt = this.db.prepare(sql);
      stmt.run(
        session.id,
        session.title || '',
        session.type || 'chat',
        session.projectId || null,
        session.parentSessionId || null,
        session.createdAt,
        session.updatedAt,
        JSON.stringify(session.metadata || {})
      );
      return true;
    } catch (error) {
      console.error('[MemorySearch] 插入会话失败:', error);
      return false;
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    if (!this.initialized) this.initialize();
    
    try {
      const sessionCount = this.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
      const messageCount = this.db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
      const projectCount = this.db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
      const skillCount = this.db.prepare('SELECT COUNT(*) as count FROM skills').get().count;
      
      return {
        sessions: sessionCount,
        messages: messageCount,
        projects: projectCount,
        skills: skillCount,
        dbSize: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0
      };
    } catch (error) {
      console.error('[MemorySearch] 获取统计失败:', error);
      return { sessions: 0, messages: 0, projects: 0, skills: 0, dbSize: 0 };
    }
  }

  /**
   * 从 JSON 数据库迁移数据到 SQLite
   * @param {Object} jsonDb - 从 heiqiu-db.json 读取的数据库对象
   * @returns {{ migratedSessions: number, migratedMessages: number }}
   */
  migrateFromJson(jsonDb) {
    if (!this.initialized) this.initialize();
    if (!jsonDb) return { migratedSessions: 0, migratedMessages: 0 };

    let migratedSessions = 0;
    let migratedMessages = 0;

    const insertSession = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, title, type, project_id, parent_session_id, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMessage = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, session_id, role, content, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const migrate = this.db.transaction(() => {
      // 迁移会话
      const sessions = jsonDb.sessions || [];
      for (const session of sessions) {
        const result = insertSession.run(
          session.id,
          session.title || '',
          session.type || 'chat',
          session.projectId || null,
          session.parentSessionId || null,
          session.createdAt || Date.now(),
          session.updatedAt || session.createdAt || Date.now(),
          JSON.stringify(session.metadata || {})
        );
        if (result.changes > 0) migratedSessions++;
      }

      // 迁移消息
      const messages = jsonDb.messages || {};
      for (const [sessionId, msgs] of Object.entries(messages)) {
        if (!Array.isArray(msgs)) continue;
        for (let i = 0; i < msgs.length; i++) {
          const msg = msgs[i];
          const msgId = msg.id || `${sessionId}-msg-${i}`;
          const result = insertMessage.run(
            msgId,
            sessionId,
            msg.role || 'user',
            msg.text || msg.content || (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')),
            msg.createdAt || msg.timestamp || Date.now(),
            JSON.stringify({
              attachments: msg.attachments || [],
              model: msg.model || null,
              tokens: msg.tokens || null
            })
          );
          if (result.changes > 0) migratedMessages++;
        }
      }

      // 迁移项目
      const projects = jsonDb.projects || [];
      const insertProject = this.db.prepare(`
        INSERT OR IGNORE INTO projects (id, name, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const project of projects) {
        insertProject.run(
          project.id,
          project.name || '',
          project.createdAt || Date.now(),
          project.updatedAt || project.createdAt || Date.now(),
          JSON.stringify(project.metadata || {})
        );
      }
    });

    try {
      migrate();
      console.log(`[MemorySearch] 迁移完成: ${migratedSessions} 会话, ${migratedMessages} 消息`);
    } catch (error) {
      console.error('[MemorySearch] 迁移失败:', error);
    }

    return { migratedSessions, migratedMessages };
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      console.log('[MemorySearch] 数据库连接已关闭');
    }
  }
}

module.exports = { MemorySearchService };
