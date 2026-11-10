import React, { useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  CircleStop,
  FilePlus2,
  FolderKanban,
  Maximize2,
  MessageSquarePlus,
  Minus,
  PanelLeft,
  PanelRight,
  Paperclip,
  PanelTop,
  Send,
  Settings2,
  Sparkles,
  X
} from "lucide-react";

const fallbackSnapshot = {
  sessionId: "",
  sessionTitle: "新对话",
  model: "DeepSeek",
  running: false,
  sessions: [],
  messages: []
};
const bridge = window.baiqiuAssistantUI || {
  getSnapshot: () => fallbackSnapshot,
  subscribe: () => () => {},
  send: () => {},
  cancel: () => {},
  newSession: () => {},
  selectSession: () => {},
  openSettings: () => {},
  openTasks: () => {},
  windowAction: () => {}
};
const STRUCTURED_FADE_MS = 2400;

function useBaiqiuSnapshot() {
  return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
}

function eventText(event = {}) {
  const value = event.delta ?? event.message ?? event.text ?? event.detail ?? event.summary ?? event.title ?? event.label;
  if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  try { return JSON.stringify(event); } catch { return "公开事件"; }
}

function eventIdentity(event = {}, index = 0) {
  return String(event.eventId || `${event.turnId || "turn"}:${event.target || "stream"}:${event.sequence || index + 1}`);
}

function uniqueOrderedEvents(events = [], limit = 99) {
  const seen = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    const id = eventIdentity(event, seen.size);
    if (!seen.has(id)) seen.set(id, { ...event, eventId: id });
  }
  return [...seen.values()]
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    .slice(-limit);
}

function toThreadMessage(message, isLast, running) {
  const structured = uniqueOrderedEvents(message.structuredEvents, 3);
  const execution = uniqueOrderedEvents(message.executionEvents, 6);
  const segments = uniqueOrderedEvents(message.answerSegments, 99);
  const answerParts = segments.length
    ? segments.map((segment) => ({ type: "text", text: String(segment.text || segment.content || "") }))
    : (message.text ? [{ type: "text", text: String(message.text) }] : []);
  const content = [
    ...execution.map((event) => ({ type: "data", name: "execution", data: event })),
    ...structured.map((event) => ({ type: "data", name: "structured", data: event })),
    ...answerParts
  ];
  const createdAt = new Date(message.createdAt || Date.now());
  if (message.role === "user") {
    return {
      id: message.id || `user-${createdAt.getTime()}`,
      role: "user",
      content: answerParts.length ? answerParts : [{ type: "text", text: String(message.text || "") }],
      attachments: [],
      createdAt,
      metadata: { custom: { baiqiu: { turnId: message.turnId, eventId: message.eventId, sequence: message.sequence } } }
    };
  }
  return {
    id: message.id || `assistant-${createdAt.getTime()}`,
    role: "assistant",
    content,
    status: message.live && running && isLast
      ? { type: "running" }
      : { type: "complete", reason: "stop" },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {
        baiqiu: {
          turnId: message.turnId,
          eventId: message.eventId,
          sequence: message.sequence,
          live: message.live === true
        }
      }
    }
  };
}

function MarkdownPart() {
  return <MarkdownTextPrimitive className="aui-markdown" smooth defer />;
}

function AssistantMarkdownPart() {
  return <div className="aui-answer-part"><span className="aui-stream-tag">输出结果</span><MarkdownPart /></div>;
}

function ExecutionPart({ data }) {
  const text = eventText(data);
  if (!text) return null;
  return (
    <div className="aui-flow-event aui-execution-event">
      <span className="aui-flow-mark" aria-hidden="true"><Bot size={12} /></span><span className="aui-stream-tag">小剧场</span>
      <span>{text}</span>
    </div>
  );
}

function StructuredPart({ data }) {
  const shownAt = Number(data?.__shownAt || Date.now());
  const age = Math.max(0, Date.now() - shownAt);
  if (data?.transient === true && age > STRUCTURED_FADE_MS) return null;
  const text = eventText(data);
  if (!text) return null;
  return (
    <div className="aui-structured-event" data-fresh={age < 900 ? "1" : "0"}>
      <span className="aui-structured-dot" aria-hidden="true" /><span className="aui-stream-tag">结构化过程</span>
      <span>{text}</span>
    </div>
  );
}

function MessageView() {
  return (
    <MessagePrimitive.Root className="aui-message">
      <MessagePrimitive.If user>
        <div className="aui-user-message">
          <div className="aui-message-label">你</div>
          <div className="aui-user-bubble"><MessagePrimitive.Parts components={{ Text: MarkdownPart }} /></div>
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <div className="aui-assistant-message">
          <div className="aui-assistant-label"><span className="aui-avatar"><Sparkles size={14} /></span><span>黑球</span></div>
          <div className="aui-assistant-body">
            <MessagePrimitive.Parts components={{
              Text: AssistantMarkdownPart,
              data: { by_name: { execution: ExecutionPart, structured: StructuredPart } }
            }} />
          </div>
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

function ThreadView({ snapshot }) {
  const threadMessages = useMemo(
    () => snapshot.messages.map((message, index) => toThreadMessage(message, index === snapshot.messages.length - 1, snapshot.running)),
    [snapshot.messages, snapshot.running]
  );
  const adapter = useMemo(() => ({
    messages: threadMessages,
    isRunning: snapshot.running,
    onNew: async (message) => {
      const text = (message.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      bridge.send(text);
    },
    onCancel: async () => bridge.cancel()
  }), [threadMessages, snapshot.running]);
  const runtime = useExternalStoreRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="aui-thread">
        <ThreadPrimitive.Viewport className="aui-viewport" autoScroll turnAnchor="bottom">
          <div className="aui-thread-column">
            <ThreadPrimitive.Empty>
              <div className="aui-empty-thread">
                <div className="aui-empty-glyph"><Sparkles size={20} /></div>
                <h1>把想完成的事交给白球</h1>
                <p>黑球会在工作中持续发送公开过程和结果。</p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages>
              {() => <MessageView />}
            </ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ScrollToBottom className="aui-scroll-bottom" title="回到底部" aria-label="回到底部"><ArrowDown size={15} /></ThreadPrimitive.ScrollToBottom>
        </ThreadPrimitive.Viewport>
        <ComposerView running={snapshot.running} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function ComposerView({ running }) {
  return (
    <ComposerPrimitive.Root className="aui-composer">
      <div className="aui-composer-topline"><span>白球工作台</span><span className="aui-composer-hint">公开过程会在结果旁独立出现</span></div>
      <ComposerPrimitive.Input className="aui-composer-input" placeholder="给黑球发送消息" submitMode="enter" />
      <div className="aui-composer-actions">
        <button type="button" className="aui-tool-button" title="上传文件" aria-label="上传文件" onClick={() => document.getElementById("attachBtn")?.click()}><Paperclip size={16} /></button>
        <button type="button" className="aui-tool-button" title="新建会话" aria-label="新建会话" onClick={() => bridge.newSession()}><MessageSquarePlus size={16} /></button>
        <span className="aui-composer-spacer" />
        {running ? (
          <ComposerPrimitive.Cancel className="aui-send-button aui-stop-button" title="停止当前任务" aria-label="停止当前任务"><CircleStop size={17} /></ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="aui-send-button" title="发送" aria-label="发送"><Send size={17} /></ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}

function Sidebar({ snapshot, collapsed, setCollapsed }) {
  return (
    <aside className={`aui-sidebar${collapsed ? " is-collapsed" : ""}`}>
      <div className="aui-brand-row">
        <div className="aui-brand-mark"><span>白</span></div>
        {!collapsed && <div><strong>白球 AI</strong><small>工作台</small></div>}
        <button className="aui-icon-button aui-sidebar-toggle" type="button" title={collapsed ? "展开侧栏" : "收起侧栏"} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <PanelRight size={16} /> : <PanelLeft size={16} />}</button>
      </div>
      <button className="aui-new-session" type="button" onClick={() => bridge.newSession()} title="新建会话">
        <MessageSquarePlus size={17} />{!collapsed && <span>新建会话</span>}
      </button>
      {!collapsed && <div className="aui-sidebar-section-label"><span>会话</span><small>{snapshot.sessions.length}</small></div>}
      <nav className="aui-session-list" aria-label="会话列表">
        {snapshot.sessions.map((item) => (
          <button key={item.id} type="button" className={`aui-session-item${item.id === snapshot.sessionId ? " is-active" : ""}`} onClick={() => bridge.selectSession(item.id)} title={item.title}>
            <span className={`aui-session-dot${item.running ? " is-running" : ""}`} />
            {!collapsed && <><span className="aui-session-title">{item.title}</span>{item.pinned && <Check size={13} className="aui-session-pin" />}</>}
          </button>
        ))}
        {!snapshot.sessions.length && !collapsed && <div className="aui-session-empty">还没有会话</div>}
      </nav>
      <div className="aui-sidebar-footer">
        <button type="button" className="aui-utility-button" title="任务看板" onClick={() => bridge.openTasks()}><FolderKanban size={16} />{!collapsed && <span>任务看板</span>}</button>
        <button type="button" className="aui-utility-button" title="设置" onClick={() => bridge.openSettings()}><Settings2 size={16} />{!collapsed && <span>设置</span>}</button>
      </div>
    </aside>
  );
}

function Header({ snapshot }) {
  return (
    <header className="aui-header">
      <div className="aui-header-title"><span className="aui-live-indicator" data-running={snapshot.running ? "1" : "0"} /><div><strong>{snapshot.sessionTitle}</strong><small>{snapshot.running ? "黑球正在工作" : "本地会话"}</small></div></div>
      <div className="aui-header-tools"><span className="aui-model-badge"><Bot size={14} />{snapshot.model}</span><button type="button" className="aui-icon-button" title="任务看板" aria-label="任务看板" onClick={() => bridge.openTasks()}><PanelTop size={16} /></button><button type="button" className="aui-icon-button" title="设置" aria-label="设置" onClick={() => bridge.openSettings()}><Settings2 size={16} /></button></div>
    </header>
  );
}

function WindowBar() {
  return <div className="aui-windowbar"><span className="aui-windowbar-title">BAIQIU / AI WORKSPACE</span><div className="aui-window-controls"><button type="button" title="最小化" aria-label="最小化" onClick={() => bridge.windowAction("minimize")}><Minus size={14} /></button><button type="button" title="最大化" aria-label="最大化" onClick={() => bridge.windowAction("maximize")}><Maximize2 size={13} /></button><button type="button" title="关闭到托盘" aria-label="关闭到托盘" onClick={() => bridge.windowAction("close")}><X size={14} /></button></div></div>;
}

function App() {
  const snapshot = useBaiqiuSnapshot();
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div className="aui-app">
      <WindowBar />
      <div className="aui-layout">
        <Sidebar snapshot={snapshot} collapsed={collapsed} setCollapsed={setCollapsed} />
        <main className="aui-main"><Header snapshot={snapshot} /><ThreadView snapshot={snapshot} /></main>
      </div>
    </div>
  );
}

const root = document.getElementById("assistantUiRoot");
if (root) createRoot(root).render(<App />);
