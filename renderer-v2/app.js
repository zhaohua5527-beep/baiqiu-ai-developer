// 全局错误捕获与白屏恢复
(function initGlobalErrorGuard() {
  let errorOverlay = null;
  const isNonBlockingScriptError = (error) => /^test is not defined$/i.test(String(error?.message || error || "").trim());
  function showFatalError(error) {
    if (errorOverlay) return;
    console.error('[FatalError]', error);
    errorOverlay = document.createElement('div');
    errorOverlay.className = 'fatal-error-overlay';
    errorOverlay.innerHTML = `
      <div class="fatal-error-card">
        <h2>⚠️ 应用遇到问题</h2>
        <p>${String(error?.message || error || '未知错误')}</p>
        <div class="fatal-error-actions">
          <button onclick="location.reload()">重新加载</button>
          <button onclick="this.closest('.fatal-error-overlay').remove()">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(errorOverlay);
  }
  window.addEventListener('error', (e) => {
    if (e.error && e.error.message && e.error.message.includes('ResizeObserver')) return;
    if (isNonBlockingScriptError(e.error || e.message)) {
      e.preventDefault();
      console.warn('[NonBlockingScriptError]', e.error || e.message);
      return;
    }
    showFatalError(e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason && String(e.reason.message || '').includes('ResizeObserver')) return;
    if (isNonBlockingScriptError(e.reason)) {
      e.preventDefault();
      console.warn('[NonBlockingScriptError]', e.reason);
      return;
    }
    showFatalError(e.reason || e);
  });
})();

const api = window.heiqiu;

const { formatMembershipCountdown } = window.BaiqiuMembershipUtils;
const LONG_REPLY_TEXT_THRESHOLD = 500;
const LONG_REPLY_MIN_HEADINGS = 2;
const COMPOSER_HEIGHT_KEY = "baiqiu.composerHeight";
const COMPOSER_MIN_INPUT_HEIGHT = 42;
const COMPOSER_AUTO_MAX_INPUT_HEIGHT = 150;
const SESSION_READ_STATE_KEY = "baiqiu.sessionReadRevisions";
const PROJECT_READ_STATE_KEY = "baiqiu.projectReadRevisions";
const TASK_BOARD_TOGGLE_POSITION_KEY = "baiqiu.taskBoardTogglePosition";
const INTENT_PREDICT_POSITION_KEY = "baiqiu.intentPredictPosition";

const state = {
  db: null,
  selectedSessionId: null,
  attachments: [],
  busy: false,
  abortRequestedSessions: new Set(),
  closedClarificationSessions: new Set(),
  pendingClarificationCards: new Map(),
  dragSessionId: null,
  longPressTimer: null,
  longPressReady: false,
  sidebarSortDrag: null,
  sidebarSortSuppressUntil: 0,
  queueSortDrag: null,
  queueSortSuppressUntil: 0,
  progress: 0,
  progressTimer: null,
  lastMessageCount: 0,
  currentMessages: [],
  composerQuote: null,
  messageContextTarget: null,
  presetTaskContextTarget: null,
  flickerTimer: null,
  ecgTimer: null,
  monitorLogLines: [],
  forceScrollBottom: false,
  followOutput: true,
  pendingResponseAnchor: null,
  activeLongReplyId: "",
  longReplySeq: 0,
  composerReplyNavRequested: false,
  lastMessageScrollTop: 0,
  newOutputAvailable: false,
  lastObservedMessageListHeight: 0,
  lastRenderedSessionId: null,
  lastMessageSignature: "",
  taskBoardTab: "overview",
  taskBoardFocusId: "",
  taskBoardPreviewRows: {},
  taskBoardPreviewContent: {},
  blackBallBrowser: { open: false, loading: false, url: "", title: "黑球浏览器", error: "", history: [] },
  taskBoardLiveEvents: {},
  taskBoardPreviewQuery: "",
  taskBoardPreviewPage: 1,
  taskBoardPreviewZoom: 1,
  taskBoardSheetDrafts: {},
  taskBoardFileListHidden: false,
  taskBoardAssetCache: { signature: "", value: null },
  taskBoardEventCache: { signature: "", value: null },
  providerModels: {},
  providerModelStatus: {},
  providerModelErrors: {},
  providerLastChecked: {},
  providerDetailKey: "",
  modelConfigKey: "",
  modelConfigMode: "edit",
  modelConfigDraft: null,
  modelConfigInterface: "official",
  modelConfigOriginalSnapshot: "",
  modelConfigSetDefault: false,
  modelConfigSaving: false,
  sessionQuery: "",
  batchDeleteMode: false,
  showArchivedSessions: false,
  selectedBatchSessionIds: new Set(),
  deepSearchResults: new Map(),
  deepSearchTimer: null,
  treeInitialized: false,
  projectTreeSignature: "",
  projectTreeRenderCount: 0,
  ceoRenderCounts: new Map(),
  expandedProjectIds: new Set(),
  expandedCeoSessionIds: new Set(),
  consciousBackupProgress: new Map(),
  consciousBackupCompleted: new Set(),
  consciousBackupTimers: new Map(),
  licenseStatus: null,
  membershipTimer: null,
  debugCenterRunning: false
};
const sessionTaskQueue = new window.BaiqiuSessionTaskQueue();
const liveChatStreams = new Map();
const sessionExecutionIndicators = new Map();
// A persisted reply can trigger an IPC refresh while its local typewriter is still playing.
const activeAssistantTypings = new Map();
const ASSISTANT_TYPING_CHARS_PER_SECOND = 80;
const ASSISTANT_TYPING_INTERVAL_MS = 1000 / ASSISTANT_TYPING_CHARS_PER_SECOND;
let streamingScrollFrame = 0;
let pendingConfirmations = {};

const CLIENT_DEFAULT_SETTINGS = {
  defaultProvider: "deepseek",
  reasoning: "minimal",
  webSearch: { enabled: true },
  appearance: { skin: "custom", fontSize: 16 },
  providers: {
    deepseek: { name: "DeepSeek", model: "deepseek-chat", enabled: true },
  },
  permissions: { accessMode: "full", permissionModes: {} },
  files: {},
  persona: {},
  license: {},
  skills: { custom: [], memories: [] }
};

function ensureClientDb(db = state.db) {
  const next = db && typeof db === "object" ? db : {};
  next.sessions = Array.isArray(next.sessions) ? next.sessions : [];
  next.projects = Array.isArray(next.projects) ? next.projects : [];
  next.messages = next.messages && typeof next.messages === "object" ? next.messages : {};
  next.queue = Array.isArray(next.queue) ? next.queue : [];
  next.settings = next.settings && typeof next.settings === "object" ? next.settings : {};
  next.settings = {
    ...CLIENT_DEFAULT_SETTINGS,
    ...next.settings,
    webSearch: { ...CLIENT_DEFAULT_SETTINGS.webSearch, ...(next.settings.webSearch || {}) },
    appearance: { ...CLIENT_DEFAULT_SETTINGS.appearance, ...(next.settings.appearance || {}) },
    providers: { ...CLIENT_DEFAULT_SETTINGS.providers, ...(next.settings.providers || {}) },
    permissions: { ...CLIENT_DEFAULT_SETTINGS.permissions, ...(next.settings.permissions || {}) },
    files: { ...CLIENT_DEFAULT_SETTINGS.files, ...(next.settings.files || {}) },
    persona: { ...CLIENT_DEFAULT_SETTINGS.persona, ...(next.settings.persona || {}) },
    license: { ...CLIENT_DEFAULT_SETTINGS.license, ...(next.settings.license || {}) },
    skills: { ...CLIENT_DEFAULT_SETTINGS.skills, ...(next.settings.skills || {}) }
  };
  if (next.settings.appearance.skin === "white") {
    Object.assign(next.settings.appearance, {
      skin: "custom",
      palette: "baiqiu",
      textColor: "#172033",
      accentColor: "#2563eb",
      backgroundColor: "#f5f8ff",
      panelColor: "#ffffff"
    });
  }
  return next;
}

function loadSessionReadRevisions() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_READ_STATE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function loadProjectReadRevisions() {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECT_READ_STATE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const sessionReadRevisions = loadSessionReadRevisions();
const projectReadRevisions = loadProjectReadRevisions();
const taskBoardEdgePosition = window.BaiqiuTaskBoardEdgePosition;
const draggablePanelPosition = window.BaiqiuDraggablePanelPosition;

const $ = (id) => document.getElementById(id);
const gatewayStatus = $("gatewayStatus");
const trialStatus = $("trialStatus");
const taskBoardToggleBtn = $("taskBoardToggleBtn");
const licenseOverlay = $("licenseOverlay");
const licenseCodeInput = $("licenseCodeInput");
const licenseActivateBtn = $("licenseActivateBtn");
const licenseBuyBtn = $("licenseBuyBtn");
const licenseOverlayStatus = $("licenseOverlayStatus");
const customerProfileOverlay = $("customerProfileOverlay");
const customerProfileForm = $("customerProfileForm");
const customerProfileName = $("customerProfileName");
const customerProfilePhone = $("customerProfilePhone");
const customerProfileError = $("customerProfileError");
const customerProfileSubmit = $("customerProfileSubmit");
const paymentPanel = $("paymentPanel");
const paymentTitle = $("paymentTitle");
const paymentAmount = $("paymentAmount");
const paymentOrderId = $("paymentOrderId");
const paymentHint = $("paymentHint");
const paymentStatus = $("paymentStatus");
const paymentCheckBtn = $("paymentCheckBtn");
const paymentCopyBtn = $("paymentCopyBtn");
const paymentCloseBtn = $("paymentCloseBtn");
const paymentReturnBtn = $("paymentReturnBtn");
const paymentQrPreview = $("paymentQrPreview");
const paymentQrPreviewClose = $("paymentQrPreviewClose");
const paymentQrPreviewTitle = $("paymentQrPreviewTitle");
const paymentQrPreviewImage = $("paymentQrPreviewImage");
const paymentQrPreviewHint = $("paymentQrPreviewHint");
const sessionList = $("sessionList");
const taskProgressRail = $("taskProgressRail");
const taskStagePopover = $("taskStagePopover");
const sessionSearch = $("sessionSearch");
const messageList = $("messageList");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const slashCommandMenu = $("slashCommandMenu");
const slashCommandList = $("slashCommandList");
const slashCommandCount = $("slashCommandCount");
const composerResizeHandle = $("composerResizeHandle");
const composerReplyNav = $("composerReplyNav");
const composerReplyNavItems = $("composerReplyNavItems");
const composerReplyNavOverflow = $("composerReplyNavOverflow");
const composerReplyNavMore = $("composerReplyNavMore");
const composerReplyNavMenu = $("composerReplyNavMenu");
const composerQuote = $("composerQuote");
const composerQuoteJump = $("composerQuoteJump");
const composerQuoteSource = $("composerQuoteSource");
const composerQuoteText = $("composerQuoteText");
const composerQuoteClose = $("composerQuoteClose");
const conversationStage = $("conversationStage");
const composerClarification = $("composerClarification");
const composerClarificationOptions = $("composerClarificationOptions");
const composerClarificationAbort = $("composerClarificationAbort");
const sendBtn = $("sendBtn");
const readingControls = $("readingControls");
const newOutputBtn = $("newOutputBtn");
const accessModeBtn = $("accessModeBtn");
const webSearchBtn = $("webSearchBtn");
const reasoningWaterControl = $("reasoningWaterControl");
const reasoningWaterLabel = $("reasoningWaterLabel");
const reasoningModeMenu = $("reasoningModeMenu");
const intentPredictBtn = $("intentPredictBtn");
const intentPredictLabel = $("intentPredictLabel");
const attachBtn = $("attachBtn");
const fileInput = $("fileInput");
const attachmentPreview = $("attachmentPreview");
const taskState = $("taskState");
const modelState = $("modelState");
const recordState = $("recordState");
const progressFill = $("progressFill");
const settingsDialog = $("settingsDialog");
const settingsCloseBtn = $("settingsCloseBtn");
const consciousCenterLayer = $("consciousCenterLayer");
const consciousCenterCloseBtn = $("consciousCenterCloseBtn");
const consciousExtractBtn = $("consciousExtractBtn");
const blackCoreLayer = $("blackCoreLayer");
const blackCoreCanvas = $("blackCoreCanvas");
const blackCoreCloseBtn = $("blackCoreCloseBtn");
const blackCoreSubject = $("blackCoreSubject");
const blackCoreConfidence = $("blackCoreConfidence");
const blackCoreEvidence = $("blackCoreEvidence");
const blackCoreStageLabel = $("blackCoreStageLabel");
const blackCoreAnalysisState = $("blackCoreAnalysisState");
const blackCoreGrowthStage = $("blackCoreGrowthStage");
const blackCoreDiscovered = $("blackCoreDiscovered");
const blackCorePending = $("blackCorePending");
const blackCoreUnknown = $("blackCoreUnknown");
const blackCoreAwakening = $("blackCoreAwakening");
const blackCoreRecommendation = $("blackCoreRecommendation");
const blackCoreProgressBar = $("blackCoreProgressBar");
const blackCorePhaseCode = $("blackCorePhaseCode");
const blackCorePhaseText = $("blackCorePhaseText");
const blackCoreProgressValue = $("blackCoreProgressValue");
const blackCoreCenterExtractBtn = $("blackCoreCenterExtractBtn");
const settingsSaveMenu = $("settingsSaveMenu");
const saveSettingsBtn = $("saveSettingsBtn");
const providerList = $("providerList");
const providerSelect = $("providerSelect");
const currentModelCard = $("currentModelCard");
const modelCenterCurrentName = $("modelCenterCurrentName");
const modelCenterCurrentId = $("modelCenterCurrentId");
const modelCenterCurrentStatus = $("modelCenterCurrentStatus");
const configuredModelList = $("configuredModelList");
const configuredModelCount = $("configuredModelCount");
const addModelBtn = $("addModelBtn");
const modelConfigLayer = $("modelConfigLayer");
const modelConfigCloseBtn = $("modelConfigCloseBtn");
const modelConfigTitle = $("modelConfigTitle");
const modelConfigBody = $("modelConfigBody");
const testModelConnectionBtn = $("testModelConnectionBtn");
const modelConfigSaveState = $("modelConfigSaveState");
const modelConfigCancelBtn = $("modelConfigCancelBtn");
const saveModelConfigBtn = $("saveModelConfigBtn");
const settingsForm = settingsDialog?.querySelector(":scope > form");
if (settingsForm && modelConfigLayer?.parentElement !== settingsForm) settingsForm.appendChild(modelConfigLayer);
const reasoningSelect = $("reasoningSelect");
const sideReasoningSelect = $("sideReasoningSelect");
const contextMenu = $("contextMenu");
const messageContextMenu = $("messageContextMenu");
const messageQuoteBtn = $("messageQuoteBtn");
const presetTaskContextMenu = $("presetTaskContextMenu");
const presetTaskEditBtn = $("presetTaskEditBtn");
const queuePanel = $("queuePanel");
const queueList = $("queueList");
const queueClearBtn = $("queueClearBtn");
const appShell = $("app");
const copyToast = $("copyToast");
const monitorModel = $("monitorModel");
const monitorSession = $("monitorSession");
const monitorMode = $("monitorMode");
const monitorContext = $("monitorContext");
const monitorLog = $("monitorLog");
const barUsed = $("barUsed");
const barRemain = $("barRemain");
const barToken = $("barToken");
const barCompress = $("barCompress");
const barLogic = $("barLogic");
const contextCompressState = $("contextCompressState");
const contextCompressDetail = $("contextCompressDetail");
const contextCompressMode = $("contextCompressMode");
const contextCompressFill = $("contextCompressFill");
const contextHeaderBar = $("contextHeaderBar");
const contextHeaderFill = $("contextHeaderFill");
const consciousBtn = $("consciousBtn");
const currentChatTitle = $("currentChatTitle");
const sessionRoleBadge = $("sessionRoleBadge");
const currentModelBadge = $("currentModelBadge");
const chatMoreBtn = $("chatMoreBtn");
const skinBtn = $("skinBtn");
const growthCenterBtn = $("growthCenterBtn");
const growthCenterDialog = $("growthCenterDialog");
const growthCenterCloseBtn = $("growthCenterCloseBtn");
const knowledgeCenterSummary = $("knowledgeCenterSummary");
const knowledgeRootPath = $("knowledgeRootPath");
const knowledgeStats = $("knowledgeStats");
const knowledgeCategoryTotal = $("knowledgeCategoryTotal");
const knowledgeCategoryList = $("knowledgeCategoryList");
const knowledgeNoteCount = $("knowledgeNoteCount");
const knowledgeNoteList = $("knowledgeNoteList");
const knowledgeSearchInput = $("knowledgeSearchInput");
const exportKnowledgeBtn = $("exportKnowledgeBtn");
const newKnowledgeNoteBtn = $("newKnowledgeNoteBtn");
const refreshKnowledgeBtn = $("refreshKnowledgeBtn");
const openKnowledgeVaultBtn = $("openKnowledgeVaultBtn");
const knowledgeEditorStatus = $("knowledgeEditorStatus");
const showKnowledgeNoteBtn = $("showKnowledgeNoteBtn");
const deleteKnowledgeNoteBtn = $("deleteKnowledgeNoteBtn");
const saveKnowledgeNoteBtn = $("saveKnowledgeNoteBtn");
const knowledgeEditorForm = $("knowledgeEditorForm");
const knowledgeTitleInput = $("knowledgeTitleInput");
const knowledgeCategorySelect = $("knowledgeCategorySelect");
const knowledgeTagsInput = $("knowledgeTagsInput");
const knowledgeBodyInput = $("knowledgeBodyInput");
const knowledgeFilePath = $("knowledgeFilePath");
const knowledgeUniverse = $("knowledgeUniverse");
const knowledgeUniverseViewport = $("knowledgeUniverseViewport");
const knowledgeUniverseScene = $("knowledgeUniverseScene");
const knowledgeOrbitLayer = $("knowledgeOrbitLayer");
const knowledgePlanetLayer = $("knowledgePlanetLayer");
const gantzCore = $("gantzCore");
const gantzSkillAudit = $("gantzSkillAudit");
const gantzSkillAuditBtn = $("gantzSkillAuditBtn");
const gantzSkillAuditStatus = $("gantzSkillAuditStatus");
const gantzSkillScanned = $("gantzSkillScanned");
const gantzSkillRemoved = $("gantzSkillRemoved");
const gantzSkillConflicts = $("gantzSkillConflicts");
const gantzSkillAuditRecord = $("gantzSkillAuditRecord");
const gantzZoomValue = $("gantzZoomValue");
const gantzUniverseStatus = $("gantzUniverseStatus");
const gantzFusionCount = $("gantzFusionCount");
const gantzRiskLevel = $("gantzRiskLevel");
const closeKnowledgeEditorBtn = $("closeKnowledgeEditorBtn");
const knowledgeMotionButtons = [...document.querySelectorAll("[data-knowledge-motion]")];
const updateQuickBtn = $("updateQuickBtn");
const updateQuickBadge = $("updateQuickBadge");
const textColorInput = $("textColorInput");
const accentColorInput = $("accentColorInput");
const backgroundColorInput = $("backgroundColorInput");
const panelColorInput = $("panelColorInput");
const textColorHexInput = $("textColorHexInput");
const accentColorHexInput = $("accentColorHexInput");
const backgroundColorHexInput = $("backgroundColorHexInput");
const panelColorHexInput = $("panelColorHexInput");
const fontSizeInput = $("fontSizeInput");
const skinSelect = $("skinSelect");
const skinImageInput = $("skinImageInput");
const skinImageFitSelect = $("skinImageFitSelect");
const clearSkinImageBtn = $("clearSkinImageBtn");
const skinImageStatus = $("skinImageStatus");
const saveThemeSettingsBtn = $("saveThemeSettingsBtn");
const renameDialog = $("renameDialog");
const renameInput = $("renameInput");
const renameSaveBtn = $("renameSaveBtn");
const personaDialog = $("personaDialog");
const personaNameInput = $("personaNameInput");
const personaPersonalityInput = $("personaPersonalityInput");
const personaAbilitiesInput = $("personaAbilitiesInput");
const savePersonaBtn = $("savePersonaBtn");
const personaNameSettingsInput = $("personaNameSettingsInput");
const personaPersonalitySettingsInput = $("personaPersonalitySettingsInput");
const personaAbilitiesSettingsInput = $("personaAbilitiesSettingsInput");
const personaNotesSettingsInput = $("personaNotesSettingsInput");
const updateCheckBtn = $("updateCheckBtn");
const updateTabBtn = $("updateTabBtn");
const applyOnlineUpdateBtn = $("applyOnlineUpdateBtn");
const updateManifestInput = $("updateManifestInput");
const autoLaunchInput = $("autoLaunchInput");
const updateContent = $("updateContent");
const appVersion = $("appVersion");
const publishUpdatePanel = $("publishUpdatePanel");
const publishVersionInput = $("publishVersionInput");
const publishNotesInput = $("publishNotesInput");
const publishUpdateBtn = $("publishUpdateBtn");
const startUpdateServerBtn = $("startUpdateServerBtn");
let availableUpdateInfo = null;
let updateOperationActive = false;
let updatePrepared = false;
let pendingUpdateProgressStatus = null;
let updateProgressFrame = 0;
let updateQuickResetTimer = 0;
const conversationUsageCache = new WeakMap();
const thinkingTimers = new WeakMap();
const saveLocationInput = $("saveLocationInput");
const chooseSaveLocationBtn = $("chooseSaveLocationBtn");
const resetSaveLocationBtn = $("resetSaveLocationBtn");
const inviteInput = $("inviteInput");
const inviteStatus = $("inviteStatus");
const unlockInviteBtn = $("unlockInviteBtn");
const ownerInvitePanel = $("ownerInvitePanel");
const inviteCountInput = $("inviteCountInput");
const adminCodeSearchInput = $("adminCodeSearchInput");
const adminRefreshCodesBtn = $("adminRefreshCodesBtn");
const adminExportCodesBtn = $("adminExportCodesBtn");
const adminCodeListOutput = $("adminCodeListOutput");
const licenseMonthlyBtn = $("licenseMonthlyBtn");
const licenseSixMonthsBtn = $("licenseSixMonthsBtn");
const licenseYearlyBtn = $("licenseYearlyBtn");
const settingsMonthlyBtn = $("settingsMonthlyBtn");
const settingsSixMonthsBtn = $("settingsSixMonthsBtn");
const settingsYearlyBtn = $("settingsYearlyBtn");
const membershipStatusCard = $("membershipStatusCard");
const membershipPlanName = $("membershipPlanName");
const membershipLevelBadge = $("membershipLevelBadge");
const membershipActivationState = $("membershipActivationState");
const membershipValidity = $("membershipValidity");
const developerLogsTab = $("developerLogsTab");
const runAgentHealthBtn = $("runAgentHealthBtn");
const agentHealthOrbit = $("agentHealthOrbit");
const blackBallRingLabel = $("blackBallRingLabel");
const agentHealthScore = $("agentHealthScore");
const agentHealthStatus = $("agentHealthStatus");
const agentHealthMeta = $("agentHealthMeta");
const agentHealthVersion = $("agentHealthVersion");
const agentHealthRun = $("agentHealthRun");
const agentHealthPhase = $("agentHealthPhase");
const agentHealthProgressCount = $("agentHealthProgressCount");
const agentHealthTestList = $("agentHealthTestList");
const agentHealthCurrentTask = $("agentHealthCurrentTask");
const agentHealthCurrentDetail = $("agentHealthCurrentDetail");
const agentHealthReportTitle = $("agentHealthReportTitle");
const agentHealthDimensions = $("agentHealthDimensions");
const agentHealthModules = $("agentHealthModules");
const agentHealthHistory = $("agentHealthHistory");
const agentHealthGaps = $("agentHealthGaps");
const blackBallRepairStatus = $("blackBallRepairStatus");
const blackBallRepairMeta = $("blackBallRepairMeta");
const blackBallRepairSummary = $("blackBallRepairSummary");
const blackBallLogBtn = $("blackBallLogBtn");
const blackBallLogDialog = $("blackBallLogDialog");
const blackBallLogContent = $("blackBallLogContent");
const runDebugCenterBtn = $("runDebugCenterBtn");
const debugCenterStatus = $("debugCenterStatus");
const debugCenterStage = $("debugCenterStage");
const debugCenterPassed = $("debugCenterPassed");
const debugCenterFailed = $("debugCenterFailed");
const debugCenterChecks = $("debugCenterChecks");
const debugCenterReport = $("debugCenterReport");
const debugCenterRunLabel = $("debugCenterRunLabel");
const debugCenterRunMeta = $("debugCenterRunMeta");
const consciousSearchInput = $("consciousSearchInput");
const consciousArchivedToggle = $("consciousArchivedToggle");
const consciousSnapshotList = $("consciousSnapshotList");
const consciousSnapshotDetail = $("consciousSnapshotDetail");
let consciousHistoryCache = new Map();
const developerLogsPage = $("developerLogsPage");
const developerLogTypeSelect = $("developerLogTypeSelect");
const refreshDeveloperLogsBtn = $("refreshDeveloperLogsBtn");
const exportDeveloperLogsBtn = $("exportDeveloperLogsBtn");
const developerLogOutput = $("developerLogOutput");
const generateInviteBtn = $("generateInviteBtn");
const generatedInviteOutput = $("generatedInviteOutput");
const skillList = $("skillList");
const installedToolList = $("installedToolList");
const installedToolCount = $("installedToolCount");
const mySkillCount = $("mySkillCount");
const toolCenterSummary = $("toolCenterSummary");
const skillNameInput = $("skillNameInput");
const skillBodyInput = $("skillBodyInput");
const addSkillBtn = $("addSkillBtn");
const openCustomSkillBtn = $("openCustomSkillBtn");
const cancelCustomSkillBtn = $("cancelCustomSkillBtn");
const customSkillEditor = $("customSkillEditor");
const agentModeInput = $("agentModeInput");
const advancedLocalExecutionInput = $("advancedLocalExecutionInput");
const memoryInput = $("memoryInput");
const addMemoryBtn = $("addMemoryBtn");
const memoryList = $("memoryList");
const manageMemoriesBtn = $("manageMemoriesBtn");
const verifyMemoryBtn = $("verifyMemoryBtn");
const memoryProofStatus = $("memoryProofStatus");
const learnSkillNameInput = $("learnSkillNameInput");
const learnSkillSourceInput = $("learnSkillSourceInput");
const learnSkillSourceLabel = $("learnSkillSourceLabel");
const learnSkillSourceFile = $("learnSkillSourceFile");
const learnSkillFileName = $("learnSkillFileName");
const learnSkillBtn = $("learnSkillBtn");
const learnSkillStatus = $("learnSkillStatus");
const learnSkillProgress = $("learnSkillProgress");
const learnSkillLog = $("learnSkillLog");
const clearSkillLearnLogBtn = $("clearSkillLearnLogBtn");
const closeConfirmLayer = $("closeConfirmLayer");
const closeConfirmText = $("closeConfirmText");
const closeHideBtn = $("closeHideBtn");
const closeQuitBtn = $("closeQuitBtn");
const closeCancelBtn = $("closeCancelBtn");
const neuralDashboard = $("neuralDashboard");
const productTaskId = $("productTaskId");
const productTaskStatus = $("productTaskStatus");
const productAgentStatus = $("productAgentStatus");
const productRuntimeDetails = $("productRuntimeDetails");
const productTimeline = $("productTimeline");
const productTaskStrip = $("productTaskStrip");

const ACCESS_MODES = {
  normal: { label: "普通", short: "普通", title: "普通模式：默认聊天，不执行系统权限工具。" },
  ask: { label: "询问", short: "询问", title: "询问模式：执行任务前先询问权限。" },
  full: { label: "信任", short: "信任", title: "信任模式：允许已授权工具直接执行。" }
};


const PROVIDER_REASONING_LEVELS = {
  openai: ["minimal", "low", "medium", "high", "extra_high"],
  deepseek: ["minimal", "low", "medium", "high"],
  ollama: ["off", "minimal", "low", "medium", "high"],
};

const SKIN_PRESETS = {
  black: {
    textColor: "#e8eaed",
    accentColor: "#8fa8c2",
    backgroundColor: "#0e0f11",
    panelColor: "#15171a",
    fontSize: 16
  },
  blue: {
    textColor: "#e8f2ff",
    accentColor: "#64a9f5",
    backgroundColor: "#081522",
    panelColor: "#10243a",
    fontSize: 16
  },
  green: {
    textColor: "#e8f5ed",
    accentColor: "#59bf83",
    backgroundColor: "#0b1711",
    panelColor: "#14251b",
    fontSize: 16
  },
  custom: {
    textColor: "#172033",
    accentColor: "#2563eb",
    backgroundColor: "#f5f8ff",
    panelColor: "#ffffff",
    fontSize: 16
  },
  mecha: {
    textColor: "#dce8ee",
    accentColor: "#55b8c8",
    backgroundColor: "#0a1014",
    panelColor: "#111a20",
    fontSize: 16
  },
  wasteland: {
    textColor: "#e5decb",
    accentColor: "#b99a56",
    backgroundColor: "#15140f",
    panelColor: "#201e18",
    fontSize: 16
  }
};

const THEME_COLOR_PALETTES = {
  baiqiu: { textColor: "#172033", accentColor: "#2563eb", backgroundColor: "#f5f8ff", panelColor: "#ffffff" },
  "tech-black": { textColor: "#edf4ff", accentColor: "#4da3ff", backgroundColor: "#080b10", panelColor: "#111720" },
  "space-gray": { textColor: "#e7ebf0", accentColor: "#7c91b8", backgroundColor: "#15191f", panelColor: "#20262e" },
  "minimal-white": { textColor: "#111827", accentColor: "#315fca", backgroundColor: "#f7f8fa", panelColor: "#ffffff" },
  "eye-green": { textColor: "#203229", accentColor: "#3d8b65", backgroundColor: "#eef5ef", panelColor: "#f9fcf9" }
};

const PROVIDER_ROUTE_LABELS = {
  deepseek: "DeepSeek 官方接口",
  openai: "OpenAI 官方接口",
  kimi: "Kimi / Moonshot 官方接口",
  anthropic: "Anthropic 官方接口",
  qwen: "通义千问官方接口",
  baidu: "百度千帆官方接口",
  zhipu: "智谱官方接口",
  doubao: "火山方舟豆包官方接口",
  hunyuan: "腾讯混元 TokenHub 官方接口",
  minimax: "MiniMax 中国区官方接口",
  stepfun: "阶跃星辰中国区官方接口",
  xiaomi: "Xiaomi MiMo 官方接口",
  ollama: "本地 Ollama 接口"
};

function providerApiStyle(key) {
  return key === "anthropic" || key === "minimax" ? "anthropic" : "openai";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function blackBallBrandText(value) {
  return String(value == null ? "" : value)
    .replace(/Hermes\s+Agent/gi, "黑球")
    .replace(/Hermes|OpenClaw/gi, "黑球");
}

function renderMarkdown(text) {
  const source = String(text || "").trim();
  if (!source) return "";
  if (!window.marked?.parse) return `<p>${escapeHtml(source).replace(/\n/g, "<br>")}</p>`;
  const template = document.createElement("template");
  template.innerHTML = window.marked.parse(escapeHtml(source), { gfm: true, breaks: true });
  template.content.querySelectorAll("a").forEach((link) => {
    const href = String(link.getAttribute("href") || "").trim();
    if (!/^(https?:|mailto:)/i.test(href)) link.removeAttribute("href");
    else {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  });
  return template.innerHTML;
}

function extractClientCodeBlocks(text) {
  return window.BaiqiuAssistantCodeUtils.extractCodeBlocks(text);
}

function filterAssistantExecutionOutput(text) {
  return window.BaiqiuAssistantCodeUtils.hideInternalToolOutput(
    window.BaiqiuAssistantCodeUtils.hideCodeBlocks(text)
  ).trim();
}

function stripClarificationOptionLines(text) {
  const lines = text.split("\n");
  const result = [];
  let pendingOptionLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const isOption = /^[-*•]?\s*[*]*[A-DＡ-Ｄ][*]*\s*[.、:：)）]\s*[\p{L}\p{N}\[\]（）()\u4e00-\u9fff]/u.test(trimmed);
    const isPromptLine = /^\s*请(?:选|候选|选用)[择：:]*\s*$/.test(line);
    if (isOption || isPromptLine) {
      pendingOptionLines.push(line);
    } else {
      if (pendingOptionLines.length < 2) {
        result.push(...pendingOptionLines);
      }
      pendingOptionLines = [];
      result.push(line);
    }
  }
  if (pendingOptionLines.length < 2) {
    result.push(...pendingOptionLines);
  }
  return result.join("\n").trim();
}

function openLinkInTaskBoard(url = "") {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return;
  openTaskBoard("links");
  requestAnimationFrame(() => {
    requestEmbeddedBrowserLayout(target);
  });
}

function bindRenderedLinks(rendered) {
  rendered.querySelectorAll("a[href]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openLinkInTaskBoard(link.getAttribute("href") || "");
    });
  });
}

function enhanceHiddenCodeBlocks(rendered, blocks = []) {
  if (!blocks.length) return;
  const placeholders = [...rendered.querySelectorAll("p, li")]
    .filter((element) => /代码内容已隐藏/.test(element.textContent || ""));
  if (!placeholders.length) return;
  const combined = {
    language: blocks.every((block) => block.language === blocks[0]?.language) ? blocks[0]?.language : "代码",
    code: blocks.map((block) => block.code || "").filter(Boolean).join("\n\n")
  };
  const card = document.createElement("section");
  card.className = "hidden-code-card";
  card.innerHTML = `
    <div class="hidden-code-head">
      <span>${escapeHtml(combined.language || "代码")}</span>
      <div>
        <button type="button" data-code-toggle>展开代码</button>
        <button type="button" data-code-copy>复制代码</button>
      </div>
    </div>
    <pre hidden><code></code></pre>
  `;
  const pre = card.querySelector("pre");
  const code = card.querySelector("code");
  const toggle = card.querySelector("[data-code-toggle]");
  const copy = card.querySelector("[data-code-copy]");
  code.textContent = combined.code;
  toggle.addEventListener("click", () => {
    pre.hidden = !pre.hidden;
    toggle.textContent = pre.hidden ? "展开代码" : "收起代码";
    toggle.setAttribute("aria-expanded", pre.hidden ? "false" : "true");
  });
  copy.addEventListener("click", async () => {
    await api.copyText(combined.code);
    markCopySuccess(copy);
  });
  placeholders[0].replaceWith(card);
  placeholders.slice(1).forEach((placeholder) => placeholder.remove());
}

function selectedSession() {
  return state.db?.sessions.find((item) => item.id === state.selectedSessionId) || state.db?.sessions[0];
}

function sessionRevision(session) {
  if (!session?.id) return "";
  const messages = state.db?.messages?.[session.id] || session.messages || [];
  const latest = messages[messages.length - 1] || {};
  return [
    String(session.status || "").toUpperCase(),
    messages.length,
    latest.id || latest.createdAt || latest.timestamp || session.updatedAt || ""
  ].join(":");
}

function markSessionRead(sessionId) {
  const session = state.db?.sessions?.find((item) => item.id === sessionId);
  const revision = sessionRevision(session);
  if (!session?.id || !revision || sessionReadRevisions[session.id] === revision) return;
  sessionReadRevisions[session.id] = revision;
  try {
    localStorage.setItem(SESSION_READ_STATE_KEY, JSON.stringify(sessionReadRevisions));
  } catch {
    // Read markers are UI-only and must never block navigation.
  }
}

function sessionHasUnreadResult(session) {
  if (!session?.id || session.id === state.selectedSessionId) return false;
  if (projectSessionStatus(session.status, session).tone !== "done") return false;
  const revision = sessionRevision(session);
  return Boolean(revision && sessionReadRevisions[session.id] !== revision);
}

function sessionSidebarStatus(session) {
  const executionStatus = projectSessionStatus(session?.status, session);
  const unread = sessionHasUnreadResult(session);
  const signal = executionStatus.tone === "failed"
    ? "failed"
    : executionStatus.tone === "running"
      ? "running"
      : unread ? "unread" : "read";
  return {
    ...executionStatus,
    label: unread ? "待查看" : executionStatus.label,
    executionTone: executionStatus.tone,
    signal,
    unread
  };
}

function projectRevision(project, sessions = state.db?.sessions || []) {
  if (!project?.id) return "";
  const projectSessionIds = new Set(project.sessions || []);
  const projectSession = sessions.find((session) =>
    (session.projectId === project.id || projectSessionIds.has(session.id)) && session.type === "CEO"
  );
  return projectSession
    ? `${projectSession.id}:${sessionRevision(projectSession)}`
    : `${project.id}:${project.status || "created"}:${project.updatedAt || project.createdAt || ""}`;
}

function markProjectRead(projectId) {
  const project = state.db?.projects?.find((item) => item.id === projectId);
  const revision = projectRevision(project);
  if (!project?.id || !revision || projectReadRevisions[project.id] === revision) return;
  projectReadRevisions[project.id] = revision;
  try {
    localStorage.setItem(PROJECT_READ_STATE_KEY, JSON.stringify(projectReadRevisions));
  } catch {
    // Project read markers are UI-only and must never block navigation.
  }
}

function sessionIsRunning(session) {
  if (!session?.id) return false;
  const status = String(session.status || "").toLowerCase();
  if (["done", "success", "completed", "failed", "cancelled", "aborted", "timeout", "interrupted", "waiting", "awaiting_confirmation"].includes(status)) {
    return false;
  }
  if (sessionTaskQueue.isActive(session.id)) return true;
  return status === "running";
}

async function selectSessionById(sessionId) {
  const session = state.db?.sessions?.find((item) => item.id === sessionId || item.sessionId === sessionId || item.conversationId === sessionId);
  const resolvedSessionId = session?.id || sessionId;
  if (!resolvedSessionId) return;
  if (resolvedSessionId === state.selectedSessionId) {
    markSessionRead(resolvedSessionId);
    updateProjectTreePresentation();
    return;
  }
  clearComposerClarification();
  clearComposerQuote();
  document.body.classList.add("session-transitioning");
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    state.db = await api.selectSession(resolvedSessionId);
    state.selectedSessionId = resolvedSessionId;
    markSessionRead(resolvedSessionId);
    await renderAll({ refreshSettings: false, refreshSecondary: false });
  } finally {
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("session-transitioning")));
  }
}

function statusText(status) {
  if (status === "running") return "执行中";
  if (status === "done") return "完成";
  if (status === "timeout" || status === "aborted") return "已结束";
  if (status === "failed") return "需检查";
  return "待命";
}

function productPhaseFor(status = "") {
  if (status === "created") return "UNDERSTANDING";
  if (status === "running") return "EXECUTING";
  if (status === "success") return "LEARNING";
  if (status === "failed") return "VERIFYING";
  return "IDLE";
}

function productStageLabel(stage = "") {
  return {
    received: "已接收",
    understanding: "正在理解",
    planning: "正在规划",
    executing: "正在执行",
    verifying: "正在验证",
    completed: "已完成",
    failed: "执行失败"
  }[stage] || "待命";
}

function shouldUseProductTask(text = "", attachments = []) {
  if (attachments.length) return true;
  const value = String(text || "").trim();
  if (!value) return false;
  if (/(学习|学|安装|创建|新增|做).{0,30}(?:skill|技能)|(?:skill|技能).{0,30}(?:学习|安装|创建|新增)/i.test(value)) return false;
  if (/(你.*(技能|能力|会什么)|有什么(技能|能力)|能做什么|介绍.*自己|你是谁|状态|记忆|上下文)/i.test(value)) return false;
  if (/(脚本|文案|文章|故事|标题|介绍|改写|翻译|润色|回复|台词|创意|营销方案)/i.test(value)
    && !/(保存|导出|写入|创建文件|生成文件|放到桌面|打开|运行|执行|下载|转换为文件)/i.test(value)) return false;
  return /(创建|新建|生成|制作|写一个|做一个|打开|保存|文件|文件夹|计算器|HTML|网页|表格|Excel|分析|整理|自动|执行|运行|下载|导出|转换|截图|浏览器)/i.test(value);
}

function isSkillLearningPrompt(text = "") {
  const value = String(text || "").trim();
  if (/^(?:你)?(?:可以|能|能够|是否可以|能不能|可不可以).{0,12}(?:学习|安装|新增|创建).{0,12}(?:其他|新的|更多)?(?:的)?(?:技能|skill)(?:吗|么|呢|？|\?)?$/i.test(value)) return false;
  return /(?:学习|学|安装|创建|新增|做).{0,40}(?:skill|技能)|(?:skill|技能).{0,40}(?:学习|安装|创建|新增)/i.test(value);
}

function setTaskProgressStage(label, value) {
  if (taskState) taskState.textContent = label || "执行中";
  if (monitorMode) monitorMode.textContent = label || "执行中";
  document.body.dataset.taskStage = /完成/.test(label || "") ? "completed"
    : /搜索|联网/.test(label || "") ? "searching"
      : /执行|读取|分析|学习|验证|规划|生成|理解|恢复|接收/.test(label || "") ? "working"
        : "idle";
  if (chatForm) chatForm.dataset.stageLabel = label || "待命";
  setProgress(value);
  renderTaskProgressRail();
  renderMonitorLog(selectedSession(), state.currentMessages || []);
}

async function submitProductInput(session, text, { taskMode = true, streamId = "" } = {}) {
  if (typeof api.productSubmitTask !== "function") {
    throw new Error("Product SDK 通道不可用，请检查发布包是否已同步。");
  }
  return api.productSubmitTask({
    productId: "desktop-assistant",
    templateId: taskMode ? "desktop.general_task" : "desktop.chat",
    sessionId: session.id,
    streamId,
    text,
    message: text,
    context: {
      conversationOnly: !taskMode
    }
  });
}

async function submitSkillLearningInput(session, text, { streamId = "" } = {}) {
  if (typeof api.productSubmitTask !== "function") {
    throw new Error("Product SDK 通道不可用，请检查发布包是否已同步。");
  }
  return api.productSubmitTask({
    productId: "desktop-assistant",
    templateId: "desktop.chat_runtime",
    sessionId: session.id,
    streamId,
    text,
    message: text,
    context: {
      chatRuntime: true,
      skillLearning: true
    }
  });
}

async function submitAttachmentInput(session, text, attachments = [], { streamId = "" } = {}) {
  if (typeof api.productSubmitTask !== "function") {
    throw new Error("Product SDK 通道不可用，请检查发布包是否已同步。");
  }
  return api.productSubmitTask({
    productId: "desktop-assistant",
    templateId: "desktop.chat_runtime",
    sessionId: session.id,
    streamId,
    text: text || "请分析附件内容。",
    message: text || "请分析附件内容。",
    attachments,
    context: {
      chatRuntime: true,
      hasAttachments: true
    }
  });
}

function renderProductDashboard(task = null, { devMode = false } = {}) {
  if (!neuralDashboard) return;
  neuralDashboard.hidden = !devMode;
  if (!devMode) return;
  const phase = productPhaseFor(task?.status || "");
  if (productTaskId) productTaskId.textContent = task?.taskId || "-";
  if (productTaskStatus) productTaskStatus.textContent = task?.status || "待命";
  if (productAgentStatus) productAgentStatus.textContent = phase;
  document.querySelectorAll("[data-product-phase]").forEach((item) => {
    item.classList.toggle("active", item.dataset.productPhase === phase);
  });
  const result = task?.result?.result || task?.result || {};
  const experience = task?.experience || task?.result?.experience || {};
  const plan = result?.normalized?.meta?.evidence?.planObject || result?.planObject || result?.result?.planObject || {};
  const strategy = plan.strategyResult || result?.strategyResult || null;
  const decision = plan.strategyDecision || result?.strategyDecision || null;
  const tool = result.toolId || result.logicalTool || result?.agentManager?.executorAgentId || "";
  const verification = result.response?.verification || result.normalized?.meta?.verification || result.verification || null;
  const experienceText = Array.isArray(plan.experienceMemoryHints) ? `${plan.experienceMemoryHints.length} hits` : (experience.details?.experience ? `${experience.details.experience} hits` : "");
  if (productRuntimeDetails) {
    productRuntimeDetails.innerHTML = [
      ["Strategy", strategy?.mode || strategy?.strategyId || "-"],
      ["Decision", decision?.decision || decision?.reason || "-"],
      ["Tool", tool || "-"],
      ["Verification", verification?.status || (result.normalized?.success ? "passed" : "-")],
      ["Experience", experienceText || "-"]
    ].map(([label, value]) => `<div><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("");
  }
  if (productTimeline) {
    productTimeline.innerHTML = (experience.timeline || []).map((item) => `
      <div class="timeline-item">
        <span>${escapeHtml(item.label || productStageLabel(item.stage))}</span>
        <b>${escapeHtml(item.message || "")}</b>
      </div>
    `).join("") || `<div class="timeline-item"><span>待命</span><b>暂无任务</b></div>`;
  }
}

function renderProductTaskStrip(tasks = []) {
  if (!productTaskStrip) return;
  productTaskStrip.hidden = true;
  productTaskStrip.innerHTML = "";
  return;
  const visible = tasks.filter(Boolean).slice(0, 5);
  productTaskStrip.hidden = visible.length === 0;
  productTaskStrip.innerHTML = visible.map((task) => {
    const experience = task.experience || {};
    return `
      <button class="product-task-pill" type="button" data-task-id="${escapeHtml(task.taskId || "")}">
        <span>${escapeHtml(experience.title || task.input || "产品任务")}</span>
        <b>${escapeHtml(productStageLabel(experience.currentStage || ""))}</b>
      </button>
    `;
  }).join("");
}

function renderTaskCard(experience = {}) {
  return [
    `**${experience.title || "产品任务"}**`,
    `${experience.message || productStageLabel(experience.currentStage || "")}`
  ].join("\n\n");
}

function renderResultCard(result = {}) {
  const text = productResultText(result) || (result.success ? "任务完成。" : "任务未完成。");
  return text;
}

function projectEmployeeResultsFromMessage(message = {}) {
  const raw = message.raw && typeof message.raw === "object" ? message.raw : {};
  const productResult = raw.productResult && typeof raw.productResult === "object" ? raw.productResult : {};
  const adaptedResult = productResult.raw && typeof productResult.raw === "object" ? productResult.raw : {};
  const integratedCeoDelivery = raw.integratedCeoDelivery === true
    || productResult.integratedCeoDelivery === true
    || adaptedResult.integratedCeoDelivery === true;
  if (integratedCeoDelivery) return [];
  const orchestration = raw.ceoOrchestration && typeof raw.ceoOrchestration === "object"
    ? raw.ceoOrchestration
    : productResult.ceoOrchestration && typeof productResult.ceoOrchestration === "object"
      ? productResult.ceoOrchestration
      : adaptedResult.ceoOrchestration && typeof adaptedResult.ceoOrchestration === "object"
        ? adaptedResult.ceoOrchestration
        : productResult;
  const results = orchestration.employeeResults || orchestration.results || productResult.employeeResults || adaptedResult.employeeResults;
  return Array.isArray(results) ? results.filter((item) => item && (item.roleSessionId || item.roleName)) : [];
}

function createProjectEmployeeResults(message = {}) {
  const results = projectEmployeeResultsFromMessage(message);
  if (!results.length) return null;
  const section = document.createElement("section");
  section.className = "project-employee-results";
  section.setAttribute("aria-label", "项目员工真实执行结果");

  const heading = document.createElement("div");
  heading.className = "project-employee-results-heading";
  const title = document.createElement("strong");
  title.textContent = "员工执行结果";
  const count = document.createElement("span");
  count.textContent = `${results.filter((item) => item.status === "completed").length}/${results.length}`;
  heading.append(title, count);
  section.appendChild(heading);

  const list = document.createElement("div");
  list.className = "project-employee-results-list";
  results.forEach((item) => {
    const completed = String(item.status || "").toLowerCase() === "completed";
    const row = document.createElement("div");
    row.className = "project-employee-result";
    row.dataset.status = completed ? "completed" : "failed";

    const state = document.createElement("span");
    state.className = "project-employee-result-state";
    state.textContent = completed ? "完成" : "失败";
    const name = document.createElement("strong");
    name.textContent = item.roleName || "项目员工";
    const preview = document.createElement("span");
    preview.className = "project-employee-result-preview";
    preview.textContent = item.summaryPreview || (completed ? "结果已写入员工会话" : "员工会话中查看失败原因");
    row.append(state, name, preview);

    if (item.roleSessionId) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "project-employee-result-view";
      view.textContent = "查看结果";
      view.title = "打开员工会话查看完整结果";
      view.addEventListener("click", () => selectSessionById(item.roleSessionId));
      row.appendChild(view);
    }
    list.appendChild(row);
  });
  section.appendChild(list);
  return section;
}

function reasoningLabel(value) {
  return {
    default: "默认",
    off: "关闭",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    extra_high: "极高",
    maximum: "极限"
  }[value || "minimal"] || value;
}

function availableReasoningLevels(providerKey = state.db?.settings?.defaultProvider || "deepseek") {
  return PROVIDER_REASONING_LEVELS[providerKey] || PROVIDER_REASONING_LEVELS.deepseek;
}

function normalizeReasoningForProvider(value, providerKey) {
  const levels = availableReasoningLevels(providerKey);
  if (levels.includes(value)) return value;
  if (value === "maximum" || value === "extra_high") return levels[levels.length - 1];
  return levels[0];
}

function compactReasoningOptions(providerKey) {
  const levels = availableReasoningLevels(providerKey).filter((level) => level !== "off");
  if (!levels.length) return [];
  const last = levels.length - 1;
  const indexes = [0, Math.round(last / 3), Math.round((last * 2) / 3), last];
  const labels = ["低", "中", "高", "极"];
  return indexes.map((index, slot) => ({ value: levels[index], label: labels[slot], index }))
    .filter((option, index, all) => all.findIndex((item) => item.value === option.value) === index);
}

function selectedCompactReasoning(value, providerKey) {
  const levels = availableReasoningLevels(providerKey).filter((level) => level !== "off");
  const options = compactReasoningOptions(providerKey);
  const exact = options.find((option) => option.value === value);
  if (exact) return exact;
  const currentIndex = Math.max(0, levels.indexOf(value));
  return options.reduce((nearest, option) => (
    !nearest || Math.abs(option.index - currentIndex) < Math.abs(nearest.index - currentIndex) ? option : nearest
  ), null) || { value, label: "低", index: 0 };
}

function renderReasoningWater() {
  renderReasoningMode();
}

async function setReasoningLevel(nextValue) {
  const providerKey = state.db?.settings?.defaultProvider || "deepseek";
  const levels = availableReasoningLevels(providerKey);
  const value = normalizeReasoningForProvider(nextValue, providerKey);
  if (!levels.includes(value)) return;
  state.db.settings.reasoning = value;
  if (reasoningSelect) reasoningSelect.value = value;
  renderReasoningMode();
  await api.saveSettings(state.db.settings);
  state.db = await api.init();
  renderSettings();
  renderMetricBars(selectedSession(), []);
}


const MEMBERSHIP_PLAN_NAMES = {
  monthly: "月卡会员",
  six_months: "6个月会员",
  yearly: "12个月会员"
};
const MEMBERSHIP_PLAN_PRICES = { monthly: "19.9", six_months: "88", yearly: "168" };
let pendingPaymentOrder = null;
let pendingPaymentPlan = "six_months";
let selectedPaymentMethod = "wechat";
let paymentQrPreviewTrigger = null;

function setPaymentStatus(message, tone = "") {
  if (!paymentStatus) return;
  paymentStatus.textContent = message || "";
  paymentStatus.dataset.tone = tone;
}

function selectPaymentMethod(method) {
  selectedPaymentMethod = method === "alipay" ? "alipay" : "wechat";
  document.querySelectorAll("[data-payment-method]").forEach((button) => {
    const selected = button.dataset.paymentMethod === selectedPaymentMethod;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-payment-qr]").forEach((node) => {
    node.hidden = node.dataset.paymentQr !== selectedPaymentMethod;
  });
}

function openPaymentQrPreview(method, trigger) {
  if (!paymentQrPreview || !paymentQrPreviewImage) return;
  const normalizedMethod = method === "alipay" ? "alipay" : "wechat";
  const paymentName = normalizedMethod === "alipay" ? "支付宝" : "微信";
  const sourceImage = document.querySelector(`[data-payment-qr="${normalizedMethod}"] img`);
  if (!sourceImage) return;
  paymentQrPreviewTrigger = trigger || null;
  if (paymentQrPreviewTitle) paymentQrPreviewTitle.textContent = `${paymentName}支付`;
  paymentQrPreviewImage.src = sourceImage.src;
  paymentQrPreviewImage.alt = `${paymentName}支付二维码大图`;
  if (paymentQrPreviewHint) paymentQrPreviewHint.textContent = `请使用${paymentName}扫码支付`;
  paymentQrPreview.hidden = false;
  paymentQrPreviewClose?.focus();
}

function closePaymentQrPreview() {
  if (!paymentQrPreview || paymentQrPreview.hidden) return;
  paymentQrPreview.hidden = true;
  paymentQrPreviewTrigger?.focus();
  paymentQrPreviewTrigger = null;
}

function closeMembershipPayment() {
  if (!paymentPanel) return;
  closePaymentQrPreview();
  paymentPanel.hidden = true;
  paymentPanel.dataset.state = "idle";
  pendingPaymentOrder = null;
  setPaymentStatus("");
}

async function createMembershipOrder(plan, paymentMethod) {
  const planName = MEMBERSHIP_PLAN_NAMES[plan] || "会员";
  pendingPaymentOrder = null;
  if (paymentPanel) paymentPanel.dataset.state = "loading";
  if (paymentTitle) paymentTitle.textContent = `开通${planName}`;
  if (paymentAmount) paymentAmount.textContent = `¥${MEMBERSHIP_PLAN_PRICES[plan] || "--"}`;
  if (paymentOrderId) paymentOrderId.textContent = "订单号：正在生成";
  if (paymentHint) paymentHint.textContent = "正在创建支付订单，请稍候。";
  if (paymentCheckBtn) paymentCheckBtn.disabled = true;
  if (paymentCopyBtn) paymentCopyBtn.disabled = true;
  setPaymentStatus("正在创建订单...");
  try {
    const result = await window.license.createOrder?.({ plan, customer: planName, paymentMethod });
    if (!result?.ok || !result.order) throw new Error(result?.message || `${planName}订单创建失败。`);
    pendingPaymentOrder = result.order;
    if (paymentPanel) paymentPanel.dataset.state = "pending";
    if (paymentAmount) paymentAmount.textContent = `¥${result.order.firstPrice || result.order.amount || MEMBERSHIP_PLAN_PRICES[plan] || "--"}`;
    if (paymentOrderId) paymentOrderId.textContent = `订单号：${result.order.orderId}`;
    if (paymentHint) paymentHint.textContent = `请使用${paymentMethod === "alipay" ? "支付宝" : "微信"}扫码付款，完成后查询支付结果。`;
    if (paymentCheckBtn) paymentCheckBtn.disabled = false;
    if (paymentCopyBtn) paymentCopyBtn.disabled = false;
    setPaymentStatus(result.message || "订单已创建，等待付款。", "info");
    if (licenseOverlayStatus) licenseOverlayStatus.textContent = result.message || "订单已创建。";
    return result;
  } catch (error) {
    if (paymentPanel) paymentPanel.dataset.state = "error";
    if (paymentOrderId) paymentOrderId.textContent = "订单号：创建失败";
    if (paymentHint) paymentHint.textContent = "订单创建失败，可以关闭后重新选择套餐。";
    setPaymentStatus(error.message || String(error), "error");
    return null;
  }
}

async function activateMembershipPlan(plan) {
  pendingPaymentPlan = MEMBERSHIP_PLAN_NAMES[plan] ? plan : "monthly";
  if (!settingsDialog?.open) openSettingsTab("invite");
  else switchSettingsTab("invite");
  if (licenseOverlay) licenseOverlay.hidden = true;
  if (paymentPanel) {
    paymentPanel.hidden = false;
    paymentPanel.dataset.state = "loading";
    requestAnimationFrame(() => paymentPanel.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }
  selectPaymentMethod(selectedPaymentMethod);
  return createMembershipOrder(pendingPaymentPlan, selectedPaymentMethod);
}

async function checkPaymentOrder() {
  const orderId = pendingPaymentOrder?.orderId || "";
  if (!orderId) {
    setPaymentStatus("请先选择会员套餐并创建订单。", "error");
    return;
  }
  if (paymentCheckBtn) paymentCheckBtn.disabled = true;
  setPaymentStatus("正在查询支付结果...", "info");
  try {
    const result = await window.license.checkOrder?.({ orderId });
    const message = result?.message || result?.order?.message || (result?.ok ? "查询完成。" : "暂未确认付款。");
    setPaymentStatus(message, result?.activated ? "success" : "info");
    if (licenseOverlayStatus) licenseOverlayStatus.textContent = message;
    if (result?.ok && result?.activated) {
      state.db = await api.init();
      await refreshLicenseStatus();
      await renderLicenseControls();
      if (paymentPanel) paymentPanel.dataset.state = "success";
      if (licenseOverlay) licenseOverlay.hidden = true;
    }
    return result;
  } catch (error) {
    setPaymentStatus(error.message || String(error), "error");
    return null;
  } finally {
    if (paymentCheckBtn) paymentCheckBtn.disabled = false;
  }
}

function formatTrialTime(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const min = Math.floor(value / 60);
  const sec = value % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatLicenseCode(value) {
  const original = String(value || "").toUpperCase();
  const inviteRaw = original.replace(/[^A-Z0-9]/g, "");
  if (inviteRaw.startsWith("BQ")) {
    const payload = inviteRaw.slice(2, 14);
    return ["BQ", payload.slice(0, 4), payload.slice(4, 8), payload.slice(8, 12)]
      .filter(Boolean)
      .join("-");
  }
  return original
    .toUpperCase()
    .replace(/[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g, "")
    .slice(0, 16)
    .replace(/(.{4})(?=.)/g, "$1-");
}

function renderLicenseStatus(status) {
  if (!status) return;
  state.licenseStatus = status;
  const isDeveloper = Boolean(status.state === "developer" || status.devMode || status.owner);
  const isActive = Boolean(status.unlocked || isDeveloper);
  if (membershipStatusCard) membershipStatusCard.dataset.state = isActive ? "active" : "inactive";
  if (membershipPlanName) {
    membershipPlanName.textContent = isDeveloper
      ? "开发者会员"
      : status.unlocked
        ? (status.lifetime ? "永久会员" : (status.planName || "限时会员"))
        : "尚未开通";
  }
  if (membershipLevelBadge) {
    membershipLevelBadge.textContent = isDeveloper
      ? "★ 开发者会员"
      : status.unlocked
        ? (status.lifetime ? "★ 永久会员" : `★ ${status.planName || "专业会员"}`)
        : (status.locked ? "免费版" : "体验会员");
  }
  if (membershipActivationState) membershipActivationState.textContent = isActive ? "已激活" : (status.locked ? "未激活" : "试用中");
  if (membershipValidity) {
    membershipValidity.textContent = isDeveloper || status.lifetime
      ? "永久有效"
      : status.unlocked && status.expiresAt
        ? new Date(status.expiresAt).toLocaleDateString("zh-CN")
        : status.locked
          ? "未开通"
          : formatTrialTime(status.trialRemainingSeconds);
  }
  if (status.state === "developer" || status.devMode || status.owner) {
    if (trialStatus) trialStatus.textContent = "2.1 测试版";
    if (licenseOverlay) licenseOverlay.hidden = true;
    if (inviteStatus) inviteStatus.textContent = "开发工具面板已解锁。";
    return;
  }
  const membershipText = status.unlocked
    ? (status.lifetime
      ? "永久会员"
      : `${status.planName || "限时会员"} · ${formatMembershipCountdown(status)}`)
    : "";
  if (trialStatus) {
    trialStatus.textContent = status.unlocked
      ? membershipText
      : status.locked
        ? "试用已结束"
        : `试用剩余：${formatTrialTime(status.trialRemainingSeconds)} | 开通会员解锁`;
  }
  if (licenseOverlay) licenseOverlay.hidden = Boolean(status.unlocked || !status.locked);
  if (inviteStatus) {
    inviteStatus.textContent = status.unlocked
      ? (status.lifetime
        ? "已激活：永久会员。"
        : `已激活：${status.planName || "限时会员"}，有效期至 ${new Date(status.expiresAt).toLocaleDateString("zh-CN")}，剩余 ${formatMembershipCountdown(status)}。`)
      : status.locked
        ? "试用已结束：请选择会员套餐或输入兑换码。"
        : `试用中：剩余 ${formatTrialTime(status.trialRemainingSeconds)}。`;
  }
}

function startMembershipCountdown() {
  clearInterval(state.membershipTimer);
  state.membershipTimer = setInterval(() => {
    if (state.licenseStatus?.unlocked && !state.licenseStatus?.lifetime) {
      renderLicenseStatus(state.licenseStatus);
    }
  }, 1000);
}

function renderCustomerProfileGate() {
  if (!customerProfileOverlay) return;
  const profile = state.db?.settings?.customerProfile || {};
  customerProfileOverlay.hidden = Boolean(profile.completed);
  if (!profile.completed) setTimeout(() => customerProfileName?.focus(), 0);
}

async function refreshLicenseStatus() {
  const status = await window.license?.getStatus?.();
  renderLicenseStatus(status);
  return status;
}

function markCopySuccess(button) {
  if (!button) return;
  const oldText = button.textContent;
  button.textContent = "✓";
  button.classList.add("copied");
  setTimeout(() => {
    button.textContent = oldText;
    button.classList.remove("copied");
  }, 900);
}

function showCopyToast(text = "已复制", duration = 900) {
  if (!copyToast) return;
  copyToast.textContent = text;
  copyToast.hidden = false;
  clearTimeout(showCopyToast.timer);
  showCopyToast.timer = setTimeout(() => {
    copyToast.hidden = true;
  }, duration);
}

async function tryOpenExternalUrl(url) {
  if (!url) return;
  if (typeof api.openExternal === "function") {
    await api.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function openAttachmentExternally(item = {}) {
  if (typeof api.openOriginalAttachment === "function") {
    const original = await api.openOriginalAttachment(item).catch(() => null);
    if (original?.ok) return;
  }
  if (typeof api.openAttachment === "function") {
    const result = await api.openAttachment(item);
    if (result?.ok !== false) return;
  }
  const pathValue = item.path || item.sourcePath || item.originalPath || item.filePath
    || item.outputPath || item.savedPath || item.targetPath || item.artifactPath || "";
  const urlValue = item.url || "";
  if (pathValue && typeof api.openPath === "function") {
    await api.openPath(pathValue);
    return;
  }
  if (urlValue) {
    await tryOpenExternalUrl(urlValue);
    return;
  }
  if (item.dataUrl && /^image\//i.test(String(item.mimeType || ""))) {
    window.open(item.dataUrl, "_blank", "noopener,noreferrer");
    return;
  }
  if (item.textContent) {
    const blob = new Blob([item.textContent], { type: item.mimeType || "text/plain;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    return;
  }
  showCopyToast("当前附件暂无可外部打开内容");
}

async function showAttachmentInFolder(item = {}) {
  if (typeof api.showAttachmentInFolder !== "function") return showCopyToast("当前版本不支持定位原文件");
  const result = await api.showAttachmentInFolder(item).catch((error) => ({ ok: false, message: error?.message || "定位原文件失败" }));
  if (!result?.ok) showCopyToast(result?.message || "当前内容没有可定位的原文件");
}

function openAttachmentInBoard(item = {}) {
  const isImage = /^image\//i.test(String(item.mimeType || ""));
  openTaskBoard(isImage ? "images" : "files", taskBoardFileKey(item));
}

function adjustComposerHeight() {
  if (!chatInput) return;
  if (chatInput.dataset.manualResize === "1") {
    const savedHeight = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY) || chatInput.getBoundingClientRect().height);
    applyManualComposerHeight(savedHeight);
    return;
  }
  chatInput.style.height = "0px";
  const nextHeight = Math.min(COMPOSER_AUTO_MAX_INPUT_HEIGHT, Math.max(COMPOSER_MIN_INPUT_HEIGHT, chatInput.scrollHeight));
  chatInput.style.height = nextHeight + "px";
  chatInput.style.overflowY = chatInput.scrollHeight > COMPOSER_AUTO_MAX_INPUT_HEIGHT ? "auto" : "hidden";
  requestAnimationFrame(positionTaskBoard);
}

function maxComposerInputHeight() {
  const chatHeight = chatForm?.closest(".chat")?.clientHeight || window.innerHeight;
  return Math.max(COMPOSER_MIN_INPUT_HEIGHT, Math.min(420, Math.floor(chatHeight * 0.5), chatHeight - 310, window.innerHeight - 260));
}

function applyManualComposerHeight(value) {
  if (!chatForm || !chatInput) return COMPOSER_MIN_INPUT_HEIGHT;
  const height = Math.max(COMPOSER_MIN_INPUT_HEIGHT, Math.min(Number(value) || COMPOSER_MIN_INPUT_HEIGHT, maxComposerInputHeight()));
  chatInput.dataset.manualResize = "1";
  chatForm.dataset.manualResize = "1";
  chatForm.style.setProperty("--composer-input-height", `${height}px`);
  chatInput.style.height = `${height}px`;
  chatInput.style.overflowY = "auto";
  requestAnimationFrame(positionTaskBoard);
  return height;
}

function resetComposerLayout({ clearDraft = false, clearPreference = false } = {}) {
  if (!chatForm || !chatInput) return;
  if (clearDraft) chatInput.value = "";
  if (clearPreference) localStorage.removeItem(COMPOSER_HEIGHT_KEY);
  const savedHeight = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY) || 0);
  if (!clearPreference && savedHeight > 0) {
    applyManualComposerHeight(savedHeight);
    return;
  }
  chatInput.dataset.manualResize = "0";
  delete chatForm.dataset.manualResize;
  chatForm.style.removeProperty("--composer-input-height");
  chatInput.style.removeProperty("height");
  chatInput.style.removeProperty("overflow-y");
  chatInput.scrollTop = 0;
  adjustComposerHeight();
}

function setupComposerResize() {
  if (!chatForm || !chatInput || !composerResizeHandle) return;
  resetComposerLayout();
  let activePointerId = null;
  let mouseResizeActive = false;
  let startY = 0;
  let startHeight = 0;

  const resizeToPointer = (clientY) => {
    const height = applyManualComposerHeight(startHeight + (startY - clientY));
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(height)));
  };

  const stopResize = (event) => {
    if (activePointerId === null || (event?.pointerId !== undefined && event.pointerId !== activePointerId)) return;
    if (composerResizeHandle.hasPointerCapture?.(activePointerId)) composerResizeHandle.releasePointerCapture(activePointerId);
    activePointerId = null;
    document.body.classList.remove("resizing-composer");
  };

  const beginResize = (clientY) => {
    startY = clientY;
    startHeight = chatInput.getBoundingClientRect().height;
    document.body.classList.add("resizing-composer");
  };

  composerResizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    activePointerId = event.pointerId;
    beginResize(event.clientY);
    composerResizeHandle.setPointerCapture?.(event.pointerId);
  });
  composerResizeHandle.addEventListener("pointermove", (event) => {
    if (event.pointerId === activePointerId) resizeToPointer(event.clientY);
  });
  composerResizeHandle.addEventListener("pointerup", stopResize);
  composerResizeHandle.addEventListener("pointercancel", stopResize);
  composerResizeHandle.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || activePointerId !== null) return;
    event.preventDefault();
    mouseResizeActive = true;
    beginResize(event.clientY);
  });
  document.addEventListener("mousemove", (event) => {
    if (mouseResizeActive) resizeToPointer(event.clientY);
  });
  document.addEventListener("mouseup", () => {
    if (!mouseResizeActive) return;
    mouseResizeActive = false;
    document.body.classList.remove("resizing-composer");
  });
  composerResizeHandle.addEventListener("dblclick", () => resetComposerLayout({ clearPreference: true }));
  composerResizeHandle.addEventListener("keydown", (event) => {
    if (event.key === "Home") {
      event.preventDefault();
      resetComposerLayout({ clearPreference: true });
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? 1 : -1;
    const height = applyManualComposerHeight(chatInput.getBoundingClientRect().height + direction * (event.shiftKey ? 40 : 12));
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(height)));
  });
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function scrollMessagesToBottom() {
  if (!messageList) return;
  state.followOutput = true;
  state.composerReplyNavRequested = false;
  state.newOutputAvailable = false;
  const scrollNow = () => {
    const previousBehavior = messageList.style.scrollBehavior;
    messageList.style.scrollBehavior = "auto";
    messageList.scrollTop = messageList.scrollHeight;
    messageList.style.scrollBehavior = previousBehavior;
    updateReadingControls();
  };
  scrollNow();
  requestAnimationFrame(scrollNow);
  requestAnimationFrame(() => requestAnimationFrame(scrollNow));
  setTimeout(scrollNow, 80);
  setTimeout(scrollNow, 180);
}

function hasVisibleLiveChatStream() {
  return [...liveChatStreams.values()].some((entry) => entry.sessionId === state.selectedSessionId && entry.row?.isConnected);
}

function scheduleStreamingScroll() {
  if (!messageList || !state.followOutput || streamingScrollFrame) return;
  streamingScrollFrame = requestAnimationFrame(() => {
    streamingScrollFrame = 0;
    messageList.scrollTop = messageList.scrollHeight;
    updateReadingControls();
  });
}

function scrollMessageToStart(row, behavior = "auto", { keepFollowing = false } = {}) {
  if (!messageList || !row) return;
  if (!keepFollowing) state.followOutput = false;
  const listRect = messageList.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  messageList.scrollTo({
    top: Math.max(0, messageList.scrollTop + rowRect.top - listRect.top - 18),
    behavior
  });
  requestAnimationFrame(updateReadingControls);
}

function countLongReplyChars(text = "") {
  return String(text || "").replace(/\s+/g, "").length;
}

function getLongReplyRows() {
  return messageList ? [...messageList.querySelectorAll(".message.assistant.long-reply[data-long-reply-id]")] : [];
}

function activeLongReplyRow() {
  const rows = getLongReplyRows();
  if (!rows.length) return null;
  const existing = state.activeLongReplyId
    ? rows.find((row) => row.dataset.longReplyId === state.activeLongReplyId)
    : null;
  if (existing) return existing;
  state.activeLongReplyId = rows[rows.length - 1].dataset.longReplyId || "";
  return rows[rows.length - 1];
}

function chooseViewportLongReply() {
  const rows = getLongReplyRows();
  if (!messageList || !rows.length) {
    state.activeLongReplyId = "";
    return null;
  }
  const listRect = messageList.getBoundingClientRect();
  let best = null;
  let bestScore = -1;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const overlap = Math.min(rect.bottom, listRect.bottom) - Math.max(rect.top, listRect.top);
    const score = overlap > 0 ? overlap : -Math.abs(rect.top - listRect.top);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  state.activeLongReplyId = best?.dataset.longReplyId || "";
  return best;
}

function setNewOutputAvailable(value) {
  state.newOutputAvailable = Boolean(value);
  updateReadingControls();
}

function updateReadingControls() {
  if (!readingControls || !newOutputBtn || !messageList) return;
  const row = chooseViewportLongReply() || activeLongReplyRow();
  renderComposerLongReplyNav(row);
  newOutputBtn.hidden = !state.newOutputAvailable;
  readingControls.hidden = newOutputBtn.hidden;
}

function scrollLongReplyHeadingIntoView(row, heading) {
  if (!messageList || !row || !heading) return;
  state.followOutput = false;
  const listRect = messageList.getBoundingClientRect();
  const headingRect = heading.getBoundingClientRect();
  messageList.scrollTo({
    top: Math.max(0, messageList.scrollTop + headingRect.top - listRect.top - 18),
    behavior: "smooth"
  });
  requestAnimationFrame(updateReadingControls);
}

function longReplyHeadings(row, rendered = null) {
  const content = rendered || row?.querySelector(":scope > .bubble > .rendered");
  if (!row || !content) return [];
  if (Array.isArray(row._longReplyHeadings)) return row._longReplyHeadings;
  const headings = [...content.querySelectorAll("h1, h2, h3")]
    .filter((heading) => {
      const title = String(heading.textContent || "").trim();
      return title && !/^(摘要|内容目录|summary|任务完成内容)$/i.test(title);
    })
    .slice(0, 24);
  row._longReplyHeadings = headings;
  return headings;
}

function clearLongReplyState(row) {
  if (!row) return;
  const wasActive = row.dataset.longReplyId && row.dataset.longReplyId === state.activeLongReplyId;
  row.classList.remove("long-reply", "expanded");
  row.removeAttribute("data-long-reply-id");
  row.removeAttribute("data-long-reply-chars");
  row._longReplyHeadings = null;
  row.querySelector(".long-reply-toggle")?.remove();
  if (wasActive) state.activeLongReplyId = "";
}

function isLongReplyDirectoryReady(row, rendered, text = "") {
  if (!row || !rendered || row.dataset.contentReady !== "1") return false;
  if (row.classList.contains("streaming-response") || row.classList.contains("thinking-message")) return false;
  if (row.classList.contains("confirm-card")) return false;
  const status = String(row.dataset.messageStatus || "").toLowerCase();
  if (/running|pending|queued|processing|failed|error|cancel|waiting|clarification/.test(status)) return false;
  const headings = longReplyHeadings(row, rendered);
  return headings.length >= LONG_REPLY_MIN_HEADINGS
    && countLongReplyChars(text) >= LONG_REPLY_TEXT_THRESHOLD;
}

function createComposerReplyNavButton(row, heading, { menu = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = menu
    ? "composer-reply-nav-menu-item"
    : `composer-reply-nav-item depth-${heading.tagName.slice(1)}`;
  const fullTitle = String(heading.textContent || "").trim();
  button.textContent = menu ? fullTitle.slice(0, 48) : compactLongReplyHeadingTitle(fullTitle);
  button.title = fullTitle;
  button.addEventListener("click", () => {
    scrollLongReplyHeadingIntoView(row, heading);
    if (composerReplyNavMenu) composerReplyNavMenu.hidden = true;
    composerReplyNavMore?.setAttribute("aria-expanded", "false");
  });
  return button;
}

function compactLongReplyHeadingTitle(value = "") {
  const fullTitle = String(value || "").trim();
  let title = fullTitle
    .replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/gu, "")
    .replace(/^(?:第?\s*[一二三四五六七八九十百\d]+\s*[章节部分篇项]|赛道\s*[一二三四五六七八九十\d]+)\s*[：:、.\-—]?\s*/u, "")
    .replace(/^[一二三四五六七八九十\d]+\s*[、.：:]\s*/u, "");
  const colon = title.search(/[：:]/u);
  if (colon > 0 && [...title.slice(0, colon)].length <= 8) title = title.slice(colon + 1);
  const compact = title
    .replace(/[（(][^）)]*[）)]/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  const final = (compact || fullTitle).replace(/^\d+[\s、.：:]*|^[\d]+/g, "");
  return [...final].slice(0, 4).join("");
}

function layoutComposerReplyNav() {
  if (!composerReplyNav || composerReplyNav.hidden || !composerReplyNavItems || !composerReplyNavOverflow || !composerReplyNavMenu) return;
  const buttons = [...composerReplyNavItems.children];
  buttons.forEach((button) => { button.hidden = false; });
  composerReplyNavOverflow.hidden = true;
  composerReplyNavMenu.hidden = true;
  composerReplyNavMore?.setAttribute("aria-expanded", "false");
  if (!buttons.length || composerReplyNav.clientWidth <= 0) return;

  const gap = 6;
  const available = Math.max(0, composerReplyNav.clientWidth);
  const total = buttons.reduce((sum, button) => sum + button.offsetWidth + gap, 0);
  if (total <= available) return;

  composerReplyNavOverflow.hidden = false;
  const overflowWidth = (composerReplyNavOverflow.offsetWidth || 32) + gap;
  const itemWidth = Math.max(0, available - overflowWidth);
  let used = 0;
  const hiddenIndexes = [];
  buttons.forEach((button, index) => {
    const width = button.offsetWidth + (used ? gap : 0);
    if (used + width <= itemWidth) used += width;
    else {
      button.hidden = true;
      hiddenIndexes.push(index);
    }
  });
  const row = composerReplyNav._activeRow || null;
  const menuButtons = hiddenIndexes
    .map((index) => {
      const heading = row?._longReplyHeadings?.[index];
      return row && heading ? createComposerReplyNavButton(row, heading, { menu: true }) : null;
    })
    .filter(Boolean);
  composerReplyNavMenu.replaceChildren(...menuButtons);
}

function hideComposerReplyNav() {
  if (!composerReplyNav) return;
  composerReplyNav.hidden = true;
  if (composerReplyNavMenu) composerReplyNavMenu.hidden = true;
  composerReplyNavMore?.setAttribute("aria-expanded", "false");
}

function renderComposerLongReplyNav(row) {
  if (!composerReplyNav || !composerReplyNavItems || !composerReplyNavMenu) return;
  if (composerClarification && !composerClarification.hidden) {
    hideComposerReplyNav();
    return;
  }
  const headings = row ? longReplyHeadings(row) : [];
  if (!row || !headings.length) {
    hideComposerReplyNav();
    composerReplyNav._activeRow = null;
    composerReplyNav.dataset.signature = "";
    composerReplyNavItems.replaceChildren();
    composerReplyNavMenu.replaceChildren();
    return;
  }
  const hasPendingAttachments = state.attachments.length > 0;
  if (!state.composerReplyNavRequested || hasPendingAttachments || !messageList || isNearBottom(messageList)) {
    hideComposerReplyNav();
    return;
  }
  composerReplyNav._activeRow = row;
  composerReplyNav.hidden = false;
  const signature = `${row.dataset.longReplyId || ""}:${headings.map((heading) => heading.textContent).join("|")}`;
  if (composerReplyNav.dataset.signature !== signature) {
    composerReplyNav.dataset.signature = signature;
    composerReplyNavItems.replaceChildren(...headings.map((heading) => createComposerReplyNavButton(row, heading)));
  }
  requestAnimationFrame(layoutComposerReplyNav);
}

const CLARIFICATION_MAX_ROUNDS = 4;

function clarificationOptionsFromMessage(message = {}) {
  if (message.role !== "assistant") return null;
  const text = String(message.text || "").trim();
  const raw = message.raw && typeof message.raw === "object" ? message.raw : {};
  const structured = raw.clarification
    || raw.productResult?.clarification
    || raw.productResult?.result?.clarification
    || null;
  if (!structured || typeof structured !== "object") return null;
  const options = Array.isArray(structured.options)
    ? structured.options.map((option, index) => ({
      id: String(option.id || option.optionId || "").trim(),
      key: String(option.key || option.id || String.fromCharCode(65 + index)).toUpperCase().slice(0, 1),
      label: String(option.label || option.text || option.value || "").trim(),
      value: String(option.value || option.text || option.label || "").trim(),
      action: String(option.action || "select").trim(),
      custom: option.custom === true,
      recommended: option.recommended === true
    })).filter((option) => option.label)
    : [];
  if (!options.length) return null;
  const domainOptions = options.filter((option) => option.custom !== true).slice(0, 3);
  const suppliedCustom = options.find((option) => option.custom === true);
  const customKey = String.fromCharCode(65 + domainOptions.length);
  const round = Math.max(1, Math.min(CLARIFICATION_MAX_ROUNDS, Number(structured.round || 1)));
  const originalRequest = String(structured.originalRequest || "").trim();
  const summary = String(structured.summary || "").trim();
  return {
    cardType: "intent_clarification",
    question: String(structured.question || text).trim(),
    originalRequest,
    requestId: String(structured.requestId || "").trim(),
    sessionId: String(structured.sessionId || "").trim(),
    round,
    dimension: String(structured.dimension || "").trim(),
    summary,
    options: [...domainOptions, suppliedCustom
      ? { ...suppliedCustom, key: customKey, label: suppliedCustom.label || "自己输入", custom: true }
      : { key: customKey, label: "自己输入", action: "custom", custom: true }]
  };
}

function clarificationCardKey(prompt = {}, sessionId = "") {
  const ownerSessionId = String(prompt.sessionId || sessionId || "").trim();
  if (prompt.cardType === "intent_clarification") {
    return [ownerSessionId, prompt.requestId, prompt.round, prompt.dimension].map((item) => String(item || "").trim()).join(":");
  }
  return [ownerSessionId, prompt.cardType, prompt.taskId].map((item) => String(item || "").trim()).join(":");
}

function clarificationPromptBelongsToSession(prompt = {}, session = null) {
  if (!session?.id) return false;
  if (prompt.cardType !== "intent_clarification") return true;
  return Boolean(prompt.sessionId && String(prompt.sessionId) === String(session.id));
}

function clearPendingClarificationCards(sessionId) {
  for (const [key, ownerSessionId] of state.pendingClarificationCards) {
    if (String(ownerSessionId) === String(sessionId)) state.pendingClarificationCards.delete(key);
  }
}

function compactClarificationOptionLabel(value = "") {
  const compact = String(value || "").replace(/[^\p{L}\p{N}]/gu, "");
  return [...compact].slice(0, 4).join("");
}

// [意图预测] 错误场景选项提取 —— 区分用户可操作 vs 系统内部错误
function errorPredictOptions(message = {}) {
  if (message.role !== "assistant") return null;
  const text = String(message.text || "").trim();
  const raw = message.raw && typeof message.raw === "object" ? message.raw : {};
  const productResult = raw.productResult || {};
  const errorText = String(productResult.error || raw.error || text);
  const productStatus = String(productResult.status || "").toLowerCase();
  const taskId = String(productResult.taskBrain?.task_id || productResult.taskId || raw.taskId || "").trim();
  const explicitFailure = productResult.success === false
    || ["failed", "error", "blocked", "cancelled"].includes(productStatus)
    || Boolean(raw.error || raw.uiError)
    || /执行失败|任务失败|发生错误|Internal error|Queued for the next turn|denied|拒绝|拦截|required|阻断|无法执行/i.test(text);
  if (!explicitFailure) return null;
  if (!taskId) return null;
  const internalPatterns = [
    /UnderstandingDecision|UUG_|UUG_GATE/i,
    /gate[_\s]?error|GATE_DENIED/i,
    /internal[_\s]?error|TypeError|ReferenceError|SyntaxError|RangeError/i,
    /ECONNR|ECONNRE|ECONNRESET|ETIMEDOUT|socket hang up/i,
    /undefined is not|null is not|Cannot read propert/i,
    /JSON\.parse|Unexpected token/i
  ];
  if (internalPatterns.some((p) => p.test(errorText) || p.test(text))) {
    return {
      cardType: "error_recovery",
      taskId,
      question: text,
      originalRequest: "",
      round: 1,
      errorType: "internal",
      options: [
        { key: "A", label: "重试任务", value: "重试任务", action: "retry", recommended: true },
        { key: "B", label: "结束恢复", value: "结束恢复", action: "cancel" }
      ]
    };
  }
  // === 用户可操作错误：权限拒绝、参数不足、能力缺失等 → 提供"重试/修改请求" ===
  const actionablePatterns = [
    /权限|拒绝|denied|permission|forbidden|blocked/i,
    /capability_missing|缺少能力|能力不足|无可用Agent|缺少能力/i,
    /需要|请提供|请补充|参数|缺少|missing/i,
    /工具.*失败|执行失败|task.*failed/i
  ];
  if (actionablePatterns.some((p) => p.test(errorText) || p.test(text))) {
    return {
      cardType: "error_recovery",
      taskId,
      question: text,
      originalRequest: "",
      round: 1,
      errorType: "actionable",
      options: [
        { key: "A", label: "重试", value: "重试", action: "retry", recommended: true },
        { key: "B", label: "取消", value: "取消", action: "cancel" }
      ]
    };
  }
  return null;
}

// [意图预测] 任务确认场景选项提取
function taskConfirmPredictOptions(message = {}) {
  if (message.role !== "assistant") return null;
  const raw = message.raw && typeof message.raw === "object" ? message.raw : {};
  const text = String(message.text || "").trim();
  // 检测 TaskBrain 确认消息
  const isAwaitingConfirm = raw.status === "awaiting_confirmation"
    || raw.taskBrain === true && raw.status === "awaiting_confirmation"
    || raw.confirmationRequired === true
    || (raw.productResult && (raw.productResult.status === "pending_confirmation" || raw.productResult.confirmationRequired === true));
  if (!isAwaitingConfirm) return null;
  const taskId = String(raw.taskId || raw.taskBrain?.task_id || raw.productResult?.taskBrain?.task_id || raw.productResult?.taskId || "").trim();
  if (!taskId) return null;
  return {
    cardType: "task_confirmation",
    taskId,
    question: text,
    originalRequest: "",
    round: 1,
    options: [
      { key: "A", label: "确认执行", value: "确认执行", action: "confirm", recommended: true },
      { key: "B", label: "取消任务", value: "取消任务", action: "cancel" },
      { key: "C", label: "修改需求", action: "modify", custom: true }
    ]
  };
}

function clearComposerClarification() {
  if (composerClarification) {
    composerClarification.hidden = true;
    delete composerClarification.dataset.sessionId;
    delete composerClarification.dataset.cardKey;
  }
  conversationStage?.classList.remove("clarification-open");
  composerClarificationOptions?.replaceChildren();
  if (chatInput && !chatInput.value) chatInput.placeholder = "给 Gantz 发送消息";
}

let composerClarificationPosition = { xRatio: 1, yRatio: 1 };
let composerClarificationDrag = null;

function composerClarificationMetrics() {
  const stageRect = conversationStage?.getBoundingClientRect();
  const panelRect = composerClarification?.getBoundingClientRect();
  if (!stageRect || !panelRect) return null;
  return {
    containerWidth: stageRect.width,
    containerHeight: stageRect.height,
    elementWidth: panelRect.width,
    elementHeight: panelRect.height,
    leftInset: 8,
    rightInset: 18,
    topInset: 8,
    bottomInset: 0
  };
}

function loadComposerClarificationPosition() {
  if (!draggablePanelPosition) return { xRatio: 1, yRatio: 1 };
  try {
    return draggablePanelPosition.normalizePosition(JSON.parse(localStorage.getItem(INTENT_PREDICT_POSITION_KEY) || "{}"));
  } catch {
    return draggablePanelPosition.normalizePosition();
  }
}

function saveComposerClarificationPosition() {
  localStorage.setItem(INTENT_PREDICT_POSITION_KEY, JSON.stringify(composerClarificationPosition));
}

function applyComposerClarificationPosition(position = composerClarificationPosition) {
  if (!composerClarification || composerClarification.hidden || !draggablePanelPosition) return;
  const metrics = composerClarificationMetrics();
  if (!metrics) return;
  composerClarificationPosition = draggablePanelPosition.normalizePosition(position);
  const placed = draggablePanelPosition.calculatePosition({ ...metrics, ...composerClarificationPosition });
  composerClarification.style.left = `${placed.left}px`;
  composerClarification.style.top = `${placed.top}px`;
  composerClarification.style.right = "auto";
  composerClarification.style.bottom = "auto";
  composerClarification.dataset.positionReady = "1";
}

function bindComposerClarificationDrag() {
  const handle = composerClarification?.querySelector(".intent-predict-head");
  if (!handle || !draggablePanelPosition) return;
  composerClarificationPosition = loadComposerClarificationPosition();
  handle.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest("button, input")) return;
    const stageRect = conversationStage.getBoundingClientRect();
    const panelRect = composerClarification.getBoundingClientRect();
    composerClarificationDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - panelRect.left,
      offsetY: event.clientY - panelRect.top,
      stageLeft: stageRect.left,
      stageTop: stageRect.top,
      dragging: false
    };
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!composerClarificationDrag || composerClarificationDrag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - composerClarificationDrag.startX, event.clientY - composerClarificationDrag.startY);
    if (!composerClarificationDrag.dragging && distance < 5) return;
    composerClarificationDrag.dragging = true;
    composerClarification.classList.add("dragging");
    handle.setAttribute("aria-grabbed", "true");
    const metrics = composerClarificationMetrics();
    if (!metrics) return;
    composerClarificationPosition = draggablePanelPosition.positionFromCoordinates({
      ...metrics,
      left: event.clientX - composerClarificationDrag.stageLeft - composerClarificationDrag.offsetX,
      top: event.clientY - composerClarificationDrag.stageTop - composerClarificationDrag.offsetY
    });
    applyComposerClarificationPosition();
    event.preventDefault();
  });
  const finishDrag = (event) => {
    if (!composerClarificationDrag || composerClarificationDrag.pointerId !== event.pointerId) return;
    const dragged = composerClarificationDrag.dragging;
    composerClarificationDrag = null;
    composerClarification.classList.remove("dragging");
    handle.setAttribute("aria-grabbed", "false");
    handle.releasePointerCapture?.(event.pointerId);
    if (dragged) {
      applyComposerClarificationPosition();
      saveComposerClarificationPosition();
    }
  };
  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
  window.addEventListener("resize", () => requestAnimationFrame(() => applyComposerClarificationPosition()));
}

function structuredCardContext(option, prompt, customValue = "") {
  const value = String(customValue || option.value || option.label || "").trim();
  if (prompt.cardType === "task_confirmation") {
    return { taskAction: { taskId: prompt.taskId, action: option.custom ? "modify" : option.action, value } };
  }
  if (prompt.cardType === "error_recovery") {
    return { recoveryAction: { taskId: prompt.taskId, action: option.action, value } };
  }
  return {
    clarificationResponse: {
      sessionId: prompt.sessionId,
      requestId: prompt.requestId,
      round: prompt.round,
      dimension: prompt.dimension,
      optionId: option.id || "",
      action: option.custom ? "custom" : option.action,
      label: option.label,
      value
    }
  };
}

function dispatchStructuredCardAction(option, prompt = {}, customValue = "") {
  const session = selectedSession();
  if (!session || !option) return;
  if (!clarificationPromptBelongsToSession(prompt, session)) {
    clearComposerClarification();
    showCopyToast("该意图确认属于其他会话，已停止提交");
    return;
  }
  const selectedLabel = String(customValue || option.label || option.value || "").trim();
  if (!selectedLabel) return;
  const cardKey = clarificationCardKey(prompt, session.id);
  if (!cardKey || state.pendingClarificationCards.has(cardKey)) return;
  state.pendingClarificationCards.set(cardKey, session.id);
  clearComposerClarification();
  const task = {
    text: `已选择：${selectedLabel}`,
    attachments: [],
    context: structuredCardContext(option, prompt, customValue),
    ui: { clarificationCardKey: cardKey }
  };
  if (sessionIsRunning(session)) {
    sessionTaskQueue.enqueue(session.id, task);
    renderQueue();
    return;
  }
  void sendCurrentTask(task, session.id);
}

function chooseClarificationOption(option, prompt = {}) {
  if (!option || option.custom) return;
  dispatchStructuredCardAction(option, prompt);
}

// 意图预测面板渲染 —— 统一入口
function renderComposerClarification(message = null) {
  if (!composerClarification || !composerClarificationOptions) return;
  if (state.closedClarificationSessions.has(state.selectedSessionId)) {
    clearComposerClarification();
    return;
  }
  if (!message || message.role !== "assistant") { clearComposerClarification(); return; }
  const intentPredictEnabled = intentPredictBtn?.dataset.enabled === "1";
  // Explicit task and failure states take precedence over clarification cards.
  let prompt = taskConfirmPredictOptions(message);
  if (!prompt) prompt = errorPredictOptions(message);
  if (!prompt && intentPredictEnabled) prompt = clarificationOptionsFromMessage(message);
  if (!prompt) {
    clearComposerClarification();
    return;
  }
  const session = selectedSession();
  const cardKey = clarificationCardKey(prompt, session?.id);
  if (!clarificationPromptBelongsToSession(prompt, session) || state.pendingClarificationCards.has(cardKey)) {
    clearComposerClarification();
    return;
  }
  const panelTitle = composerClarification.querySelector(".intent-predict-head strong");
  if (panelTitle) panelTitle.textContent = prompt.cardType === "task_confirmation"
    ? "任务确认"
    : prompt.cardType === "error_recovery" ? "错误恢复" : "意图预测";
  const rows = [];
  // AI生成的选项行
  const domainOptions = prompt.options.filter((o) => !o.custom);
  for (const option of domainOptions) {
    const row = document.createElement("div");
    row.className = `intent-predict-row${option.recommended ? " recommended" : ""}`;
    row.innerHTML = `<span class="intent-predict-key">${escapeHtml(option.key)}</span>` +
      `<span class="intent-predict-text">${escapeHtml(option.label)}</span>` +
      (option.recommended ? `<span class="intent-predict-badge">推荐</span>` : "");
    row.title = option.recommended ? `${option.label} · AI 推荐` : option.label;
    row.addEventListener("click", () => chooseClarificationOption(option, prompt));
    rows.push(row);
  }
  // 待输入行
  const customOption = prompt.options.find((o) => o.custom);
  if (customOption) {
    const customRow = document.createElement("div");
    customRow.className = "intent-predict-row custom";
    customRow.innerHTML = `<span class="intent-predict-key">${escapeHtml(customOption.key)}</span>` +
      `<input class="intent-predict-custom-input" type="text" placeholder="待输入……" />`;
    const customInput = customRow.querySelector("input");
    customInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const value = customInput.value.trim();
        if (!value) return;
        clearComposerClarification();
        dispatchStructuredCardAction(customOption, prompt, value);
      }
    });
    rows.push(customRow);
  }
  composerClarificationOptions.replaceChildren(...rows);
  composerClarification.dataset.sessionId = String(session.id);
  composerClarification.dataset.cardKey = cardKey;
  composerClarification.hidden = false;
  conversationStage?.classList.add("clarification-open");
  if (composerReplyNav) composerReplyNav.hidden = true;
  requestAnimationFrame(() => applyComposerClarificationPosition());
}

function ensureLongReplyNav(row, rendered) {
  if (!row || !rendered) return;
  longReplyHeadings(row, rendered);
  renderComposerLongReplyNav(row);
}

function markLongReply(row, rendered, text = "") {
  if (!row || !rendered) return;
  if (!row.dataset.longReplyId) row.dataset.longReplyId = row.dataset.messageId || `long-reply-${++state.longReplySeq}`;
  row.dataset.longReplyChars = String(countLongReplyChars(text));
  row.classList.add("long-reply");
  ensureLongReplyNav(row, rendered);
  // [长文档折叠] 添加展开/收起按钮
  if (!row.querySelector(".long-reply-toggle")) {
    const expandBtn = document.createElement("button");
    row.classList.add("expanded");
    expandBtn.type = "button";
    expandBtn.className = "long-reply-toggle";
    expandBtn.textContent = "收起";
    expandBtn.setAttribute("aria-expanded", "true");
    expandBtn.onclick = () => {
      row.classList.toggle("expanded");
      const expanded = row.classList.contains("expanded");
      expandBtn.textContent = expanded ? "收起" : "展开全文";
      expandBtn.setAttribute("aria-expanded", String(expanded));
    };
    row.querySelector(".bubble")?.appendChild(expandBtn);
  }
  state.activeLongReplyId = row.dataset.longReplyId || state.activeLongReplyId;
  updateReadingControls();
}

function evaluateLongReply(row, rendered, text = "", options = {}) {
  if (!row?.classList.contains("assistant") || !rendered) return;
  const ready = isLongReplyDirectoryReady(row, rendered, text);
  if (ready) {
    markLongReply(row, rendered, text);
    if (options.keepExpanded) {
      row.classList.add("expanded");
      const toggle = row.querySelector(".long-reply-toggle");
      if (toggle) {
        toggle.textContent = "收起";
        toggle.setAttribute("aria-expanded", "true");
      }
    }
  } else {
    clearLongReplyState(row);
    updateReadingControls();
  }
}

function refreshLongReplyCandidates() {
  if (!messageList) return;
  messageList.querySelectorAll(".message.assistant").forEach((row) => {
    const rendered = row.querySelector(":scope > .bubble > .rendered");
    evaluateLongReply(row, rendered, row.dataset.longReplyText || rendered?.textContent || "");
  });
  state.lastObservedMessageListHeight = messageList.scrollHeight;
  updateReadingControls();
}

messageList?.addEventListener("scroll", () => {
  const currentScrollTop = messageList.scrollTop;
  const scrollDelta = currentScrollTop - state.lastMessageScrollTop;
  state.lastMessageScrollTop = currentScrollTop;
  const nearBottom = isNearBottom(messageList);
  state.followOutput = nearBottom;
  if (nearBottom || scrollDelta > 1) state.composerReplyNavRequested = false;
  else if (scrollDelta < -1) state.composerReplyNavRequested = true;
  if (nearBottom) state.newOutputAvailable = false;
  updateReadingControls();
}, { passive: true });

if (typeof ResizeObserver === "function" && messageList) {
  new ResizeObserver(() => {
    const previousHeight = state.lastObservedMessageListHeight;
    const nextHeight = messageList.scrollHeight;
    if (state.followOutput && hasVisibleLiveChatStream()) scheduleStreamingScroll();
    else if (state.followOutput) scrollMessagesToBottom();
    else if (previousHeight > 0 && nextHeight > previousHeight + 6) setNewOutputAvailable(true);
    state.lastObservedMessageListHeight = nextHeight;
    updateReadingControls();
  }).observe(messageList);
}

window.addEventListener("resize", () => {
  if (state.followOutput) requestAnimationFrame(scrollMessagesToBottom);
  else requestAnimationFrame(updateReadingControls);
});

composerReplyNavMore?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!composerReplyNavMenu) return;
  composerReplyNavMenu.hidden = !composerReplyNavMenu.hidden;
  composerReplyNavMore.setAttribute("aria-expanded", String(!composerReplyNavMenu.hidden));
});

document.addEventListener("click", (event) => {
  if (composerReplyNavOverflow?.contains(event.target)) return;
  if (composerReplyNavMenu) composerReplyNavMenu.hidden = true;
  composerReplyNavMore?.setAttribute("aria-expanded", "false");
});

newOutputBtn?.addEventListener("click", () => scrollMessagesToBottom());

function setProgress(value) {
  state.progress = Math.max(0, Math.min(100, Math.round(value)));
  progressFill.style.width = `${state.progress}%`;
  progressFill.parentElement?.style.setProperty("--progress", `${state.progress}%`);
}

function startProgress() {
  clearInterval(state.progressTimer);
  if (state.progress < 8) setProgress(8);
  state.progressTimer = setInterval(() => {
    if (!state.busy) return;
    const ceiling = 92;
    const step = state.progress < 55 ? 3 : state.progress < 78 ? 2 : 1;
    setProgress(Math.min(ceiling, state.progress + step));
    barCompress?.style.setProperty("--value", `${state.progress}%`);
    updateLogicBar();
  }, 620);
}

function stopProgress(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "running") return;
  clearInterval(state.progressTimer);
  state.progressTimer = null;
  if (["done", "success", "completed"].includes(normalized)) setProgress(100);
  else if (["failed", "timeout", "aborted", "cancelled", "interrupted"].includes(normalized)) setProgress(0);
  else if (!state.busy) setProgress(0);
}

function randomizeEcg() {
  document.body.style.setProperty("--ecg-rate", "1.8s");
}

function scheduleCrtFlicker() {
  clearTimeout(state.flickerTimer);
  state.flickerTimer = null;
  document.documentElement.style.setProperty("--crt-brightness", "1");
  document.documentElement.style.setProperty("--crt-glow", "0");
  document.documentElement.style.setProperty("--ecg-pulse", "1");
}

function scheduleEcgRandomizer() {
  clearTimeout(state.ecgTimer);
  randomizeEcg();
  state.ecgTimer = null;
}

function resetMonitorEffects() {
  clearTimeout(state.flickerTimer);
  clearTimeout(state.ecgTimer);
  state.flickerTimer = null;
  state.ecgTimer = null;
  document.documentElement.style.setProperty("--crt-brightness", "1");
  document.documentElement.style.setProperty("--crt-glow", "0");
  document.documentElement.style.setProperty("--ecg-pulse", "1");
}

function compactMonitorText(text = "", limit = 48) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function paintMonitorLogLines(lines = []) {
  if (!monitorLog) return;
  const nextLines = [...lines].filter(Boolean).slice(-13);
  if (!nextLines.length) nextLines.push("暂无真实执行记录");
  const signature = nextLines.join("\n");
  if (monitorLog.dataset.signature === signature) return;

  let track = monitorLog.querySelector(".monitor-log-track");
  if (!track || track.children.length !== nextLines.length) {
    track = document.createElement("div");
    track.className = "monitor-log-track";
    for (let index = 0; index < nextLines.length; index += 1) {
      const row = document.createElement("span");
      track.appendChild(row);
    }
    monitorLog.replaceChildren(track);
  }

  nextLines.forEach((line, index) => {
    const row = track.children[index];
    if (row && row.textContent !== line) row.textContent = line;
  });
  monitorLog.dataset.signature = signature;
}

function renderMonitorLog(session, messages = []) {
  if (!monitorLog) return;
  const eventLines = collectTaskBoardExecutionEvents(session, messages)
    .slice(0, 10)
    .reverse()
    .map((event) => {
      const time = event.createdAt ? new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour12: false }) : "--:--:--";
      return `${time} [${event.source}] ${event.status} ${compactMonitorText(event.label, 48)}`;
    });
  const recentMessages = messages
    .slice(-3)
    .map((message) => {
      const role = message.role === "user" ? "USER" : "AI";
      const timestamp = taskBoardEventTimestamp(message.createdAt || message.timestamp);
      const time = timestamp ? new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : "--:--:--";
      return `${time} [${role}] ${compactMonitorText(message.text || message.content || "", 48)}`;
    });
  state.monitorLogLines = [...recentMessages, ...eventLines].slice(-13);
  paintMonitorLogLines(state.monitorLogLines);
}

function readableAccentInk(color) {
  let hex = String(color || "").trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((char) => char + char).join("");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return "#ffffff";
  const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#111318" : "#ffffff";
}

function browserThemeFromCurrentDocument() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const background = read("--surface", "#ffffff");
  const hex = background.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1] || "";
  const expanded = hex.length === 3 ? hex.split("").map((value) => value + value).join("") : hex;
  const rgb = expanded.length === 6
    ? [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16))
    : (background.match(/\d+(?:\.\d+)?/g)?.map(Number).slice(0, 3) || []);
  const luminance = rgb.length >= 3 ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : 1;
  return {
    background,
    surface: read("--surface", "#ffffff"),
    panel: read("--panel", "#ffffff"),
    text: read("--text", "#172033"),
    muted: read("--muted", "#737a84"),
    accent: read("--accent", "#2563eb"),
    line: read("--line", "#e5e8eb"),
    lineStrong: read("--line-strong", "#d8dde2"),
    accentSoft: read("--accent-soft", "#eaf1ff"),
    scheme: luminance < 0.48 ? "dark" : "light"
  };
}

function applyAppearance() {
  const appearance = state.db?.settings?.appearance || {};
  const fontSize = Math.max(12, Math.min(22, Number(appearance.fontSize || 16)));
  const skin = SKIN_PRESETS[appearance.skin] ? appearance.skin : "custom";
  const preset = SKIN_PRESETS[skin] || SKIN_PRESETS.custom;
  const colors = skin === "custom" ? {
    textColor: appearance.textColor || preset.textColor,
    accentColor: appearance.accentColor || preset.accentColor,
    backgroundColor: appearance.backgroundColor || preset.backgroundColor,
    panelColor: appearance.panelColor || preset.panelColor
  } : preset;
  document.body.dataset.skin = skin;
  document.documentElement.style.setProperty("--app-font-size", `${fontSize}px`);
  document.documentElement.style.setProperty("--text", colors.textColor);
  document.documentElement.style.setProperty("--accent", colors.accentColor);
  document.documentElement.style.setProperty("--surface", colors.backgroundColor);
  document.documentElement.style.setProperty("--panel", colors.panelColor);
  document.body.style.setProperty("--accent-ink", readableAccentInk(colors.accentColor));
  const hasSkinImage = skin === "custom" && !appearance.palette && Boolean(appearance.skinImage);
  document.body.classList.toggle("has-skin-image", hasSkinImage);
  document.body.style.setProperty("--skin-image", appearance.skinImage ? `url(${JSON.stringify(appearance.skinImage)})` : "none");
  const imageFit = ["cover", "contain", "original", "tile"].includes(appearance.skinImageFit) ? appearance.skinImageFit : "cover";
  document.body.dataset.skinImageFit = imageFit;
  document.body.style.setProperty("--skin-image-size", imageFit === "original" || imageFit === "tile" ? "auto" : imageFit);
  document.body.style.setProperty("--skin-image-repeat", imageFit === "tile" ? "repeat" : "no-repeat");
  if (skinImageStatus) skinImageStatus.hidden = true;
  void api.browserTheme?.(browserThemeFromCurrentDocument());
  if (blackCoreRuntime?.active) {
    syncBlackCoreTheme();
    renderBlackCoreCanvas();
  }
  syncKnowledgeTheme?.();
}

function updateLogicBar() {
  const logicMap = { off: 8, minimal: 18, low: 32, medium: 52, high: 74, extra_high: 88, maximum: 100, default: 42 };
  const logic = logicMap[state.db?.settings?.reasoning || "minimal"] || 18;
  barLogic?.style.setProperty("--value", `${logic}%`);
}

function estimateTokens(text) {
  const value = String(text || "");
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = value.replace(/[\u3400-\u9fff]/g, "");
  const words = (latin.match(/[A-Za-z0-9_]+/g) || []).join(" ");
  const symbols = latin.replace(/[A-Za-z0-9_\s]/g, "");
  return Math.ceil(cjk * 1.05 + words.length / 3.8 + symbols.length * 0.6);
}

function messageTokenText(message) {
  const files = (message.attachments || []).map((item) => `${item.name || ""} ${item.mimeType || ""}`).join("\n");
  return [message.role || "", message.text || "", files].filter(Boolean).join("\n");
}

function usageFromRaw(messages = []) {
  let total = 0;
  let prompt = 0;
  for (const message of messages) {
    const usage = message.raw?.usage || message.raw?.response?.usage || message.raw?.metadata?.usage;
    const used = Number(usage?.total_tokens || usage?.totalTokens || 0);
    const promptUsed = Number(usage?.prompt_tokens || usage?.input_tokens || usage?.inputTokens || 0);
    if (used > 0) total += used;
    if (promptUsed > 0) prompt += promptUsed;
  }
  return total > 0 ? { total, prompt } : null;
}

function contextLimitForSettings() {
  const settings = state.db?.settings || {};
  const provider = settings.providers?.[settings.defaultProvider] || {};
  const model = String(provider.model || provider.name || settings.defaultProvider || "").toLowerCase();
  if (model.includes("128k")) return 128000;
  if (model.includes("32k")) return 32000;
  if (model.includes("16k")) return 16000;
  if (model.includes("gpt-4.1") || model.includes("4.1")) return 1047576;
  if (model.includes("kimi") || model.includes("moonshot")) return 128000;
  if (model.includes("deepseek")) return 64000;
  return 64000;
}

function conversationUsage(messages = []) {
  const cached = conversationUsageCache.get(messages);
  if (cached) return cached;
  const rawUsage = usageFromRaw(messages);
  const estimated = messages.reduce((sum, message) => sum + estimateTokens(messageTokenText(message)), 0);
  const used = Math.max(rawUsage?.prompt || rawUsage?.total || 0, estimated);
  const limit = contextLimitForSettings();
  const remaining = Math.max(0, limit - used);
  const result = {
    used,
    limit,
    remaining,
    usedPercent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
    remainPercent: Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))),
    exact: Boolean(rawUsage)
  };
  conversationUsageCache.set(messages, result);
  return result;
}

function compactNumber(value) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
  if (number >= 10000) return `${Math.round(number / 1000)}K`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(number);
}

function renderMetricBars(session, messages = []) {
  const usage = conversationUsage(messages);
  const used = usage.usedPercent;
  const remain = usage.remainPercent;
  const compress = Math.max(8, Math.min(100, state.progress || (session?.status === "done" ? 100 : 12)));
  barUsed?.style.setProperty("--value", `${used}%`);
  barRemain?.style.setProperty("--value", `${remain}%`);
  if (barUsed) barUsed.title = `已用 ${compactNumber(usage.used)} / ${compactNumber(usage.limit)} token${usage.exact ? "（API真实值）" : "（本地估算）"}`;
  if (barRemain) barRemain.title = `剩余 ${compactNumber(usage.remaining)} token`;
  if (barToken) {
    barToken.style.setProperty("--value", `${remain}%`);
    const remainText = compactNumber(usage.remaining);
    const limitText = compactNumber(usage.limit);
    barToken.textContent = `${remainText}/${limitText}`;
    barToken.title = `剩余 ${Math.round(usage.remaining)} / ${Math.round(usage.limit)} token${usage.exact ? "（API真实值）" : "（本地估算）"}`;
  }
  barCompress?.style.setProperty("--value", `${compress}%`);
  updateLogicBar();
  if (monitorContext) monitorContext.textContent = `剩余 ${remain}% / ${compactNumber(usage.remaining)}T`;
  if (contextCompressState) contextCompressState.textContent = `剩余 ${remain}%`;
  if (contextCompressDetail) {
    contextCompressDetail.textContent = `可用 ${compactNumber(usage.remaining)} / 已用 ${compactNumber(usage.used)}`;
    contextCompressDetail.title = `上下文窗口 ${compactNumber(usage.limit)} token，剩余 ${compactNumber(usage.remaining)} token`;
  }
  if (contextCompressMode) contextCompressMode.textContent = usage.exact ? "API真实值" : "本地估算";
  if (contextCompressFill) {
    contextCompressFill.style.setProperty("--value", `${remain}%`);
    contextCompressFill.title = `上下文压缩剩余 ${remain}%`;
  }
  if (contextHeaderFill) contextHeaderFill.style.setProperty("--value", `${remain}%`);
  if (contextHeaderBar) contextHeaderBar.setAttribute("aria-valuenow", String(remain));
}

function setBusy(value) {
  const wasBusy = state.busy;
  state.busy = value;
  document.body.classList.toggle("running", value);
  if (!value) {
    document.body.dataset.taskStage = "idle";
    if (chatForm) chatForm.dataset.stageLabel = "待命";
  }
  sendBtn.classList.toggle("abort", value);
  sendBtn.title = value ? "终止执行（输入内容可加入后续任务）" : "发送";
  taskState.textContent = value ? "执行中" : "待命";
  if (monitorMode) monitorMode.textContent = value ? "执行中" : "待命";
  if (value) {
    if (!wasBusy) setProgress(0);
    startProgress();
  } else {
    positionTaskBoard();
  }
}

function currentAccessMode() {
  return state.db?.settings?.permissions?.accessMode || "full";
}

function renderAccessMode() {
  if (!accessModeBtn) return;
  const mode = currentAccessMode();
  const active = ACCESS_MODES[mode] || ACCESS_MODES.ask;
  const isFullTrust = mode === 'full';
  const textColorClass = isFullTrust ? 'access-mode-full-trust' : '';
  accessModeBtn.innerHTML = `
    <span class="access-mode-prefix">权限</span>
    <span class="access-mode-current ${textColorClass}">${active.short || active.label}</span>
    <span class="access-mode-menu" role="menu">
      ${["normal", "ask", "full"].map((key) => {
        const config = ACCESS_MODES[key];
        return `<span class="access-mode-option ${key === mode ? "active" : ""}" data-mode="${key}" role="menuitemradio" aria-checked="${key === mode ? "true" : "false"}"><b>权限${config.label}</b><i aria-hidden="true">✓</i></span>`;
      }).join("")}
    </span>
  `;
  accessModeBtn.title = (ACCESS_MODES[mode] || ACCESS_MODES.full).title;
  accessModeBtn.dataset.mode = mode;
  accessModeBtn.setAttribute("aria-expanded", accessModeBtn.dataset.open === "1" ? "true" : "false");
  renderReasoningMode();
}

function renderReasoningMode() {
  if (!reasoningWaterControl || !reasoningModeMenu) return;
  const providerKey = state.db?.settings?.defaultProvider || "deepseek";
  const levels = availableReasoningLevels(providerKey);
  const value = normalizeReasoningForProvider(state.db?.settings?.reasoning || levels[0], providerKey);
  const index = Math.max(0, levels.indexOf(value));
  const quickOptions = compactReasoningOptions(providerKey);
  const selectedQuick = selectedCompactReasoning(value, providerKey);
  reasoningWaterControl.dataset.level = value;
  reasoningWaterControl.dataset.maximum = index === levels.length - 1 ? "1" : "0";
  reasoningWaterControl.title = `${providerKey === "openai" ? "OpenAI" : providerKey === "deepseek" ? "DeepSeek" : "本地模型"}思考等级：${reasoningLabel(value)}`;
  if (reasoningWaterLabel) reasoningWaterLabel.textContent = selectedQuick.label;
  reasoningModeMenu.innerHTML = quickOptions.map((option) => `
    <span class="reasoning-mode-option ${option.value === selectedQuick.value ? "active" : ""}" data-reasoning-level="${option.value}" role="menuitemradio" aria-checked="${option.value === selectedQuick.value ? "true" : "false"}">
      ${option.label}
    </span>
  `).join("");
}

function renderWebSearchMode() {
  if (!webSearchBtn) return;
  const enabled = state.db?.settings?.webSearch?.enabled !== false;
  webSearchBtn.classList.toggle("active", enabled);
  webSearchBtn.setAttribute("aria-pressed", String(enabled));
  webSearchBtn.title = enabled ? "联网搜索已开启" : "联网搜索已关闭";
}

async function setAccessMode(next) {
  next = ["normal", "ask", "full"].includes(next) ? next : "full";
  if (next === "full") {
    const ok = await showAppConfirm({
      title: "开启完全访问模式",
      message: "完全访问模式会减少权限打断，允许已授权工具直接执行。请只在您信任当前任务时开启。",
      primary: "开启完全访问",
      secondary: "取消"
    });
    if (!ok) return;
  }
  state.db.settings.permissions ||= {};
  state.db.settings.permissions.accessMode = next;
  state.db.settings.permissions.advancedLocalExecution = next !== "normal";
  state.db.settings.permissions.permissionModes ||= {};
  if (next === "full") {
    for (const scope of ["file", "system", "tool", "network"]) state.db.settings.permissions.permissionModes[scope] = { mode: "allow_always", scope };
  }
  await api.saveSettings(state.db.settings);
  await api.setAutoLaunch?.(Boolean(autoLaunchInput?.checked));
  state.db = await api.init();
  renderSettings();
  renderAccessMode();
  renderWebSearchMode();
}

function showCloseConfirm(data = {}) {
  if (!closeConfirmLayer) return;
  if (closeConfirmText) closeConfirmText.textContent = data.message || "您想彻底关闭，还是隐藏到托盘继续后台运行？";
  closeConfirmLayer.hidden = false;
}

function hideCloseConfirm() {
  if (closeConfirmLayer) closeConfirmLayer.hidden = true;
}

function showAppConfirm({ title = "确认操作", message = "", primary = "确认", secondary = "取消" } = {}) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "app-modal-layer runtime-confirm-layer";
    layer.innerHTML = `
      <div class="app-modal-panel" role="dialog" aria-modal="true">
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(message)}</p>
        <div class="app-modal-actions">
          <button class="runtime-confirm-primary" type="button">${escapeHtml(primary)}</button>
          <button class="runtime-confirm-secondary" type="button">${escapeHtml(secondary)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(layer);
    const finish = (value) => {
      layer.remove();
      resolve(value);
    };
    layer.querySelector(".runtime-confirm-primary")?.addEventListener("click", () => finish(true));
    layer.querySelector(".runtime-confirm-secondary")?.addEventListener("click", () => finish(false));
    layer.addEventListener("click", (event) => { if (event.target === layer) finish(false); });
  });
}

function showAppAlert({ title = "提示", message = "", primary = "知道了" } = {}) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "app-modal-layer runtime-confirm-layer";
    layer.innerHTML = `
      <section class="app-modal runtime-confirm" role="alertdialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>
        <div class="app-modal-actions"><button class="runtime-confirm-primary" type="button">${escapeHtml(primary)}</button></div>
      </section>
    `;
    const finish = () => {
      layer.remove();
      resolve(true);
    };
    layer.querySelector(".runtime-confirm-primary")?.addEventListener("click", finish);
    layer.addEventListener("click", (event) => { if (event.target === layer) finish(); });
    document.body.appendChild(layer);
    layer.querySelector("button")?.focus();
  });
}

function showProjectEntityDialog({ title, fields = [], primary = "保存" } = {}) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "app-modal-layer project-entity-layer";
    const fieldHtml = fields.map((field) => {
      if (field.type === "choice") {
        return `<fieldset class="project-type-choice"><legend>${escapeHtml(field.label)}</legend>${field.options.map((option) => `<label><input type="radio" name="${escapeHtml(field.name)}" value="${escapeHtml(option.value)}" ${option.value === field.value ? "checked" : ""}><span><b>${escapeHtml(option.label)}</b><small>${escapeHtml(option.detail || "")}</small></span></label>`).join("")}</fieldset>`;
      }
      const tag = field.type === "textarea" ? "textarea" : "input";
      const attrs = field.type === "textarea" ? "rows=\"3\"" : `type="${field.type || "text"}"`;
      return `<label class="project-form-field"><span>${escapeHtml(field.label)}</span><${tag} name="${escapeHtml(field.name)}" ${attrs} value="${tag === "input" ? escapeHtml(field.value || "") : ""}" placeholder="${escapeHtml(field.placeholder || "")}" ${field.required ? "required" : ""}>${tag === "textarea" ? escapeHtml(field.value || "") : ""}</${tag}></label>`;
    }).join("");
    layer.innerHTML = `
      <form class="app-modal-panel project-entity-panel" role="dialog" aria-modal="true">
        <div class="project-form-head"><strong>${escapeHtml(title || "新建")}</strong><button type="button" class="project-form-close" aria-label="关闭">×</button></div>
        <div class="project-form-fields">${fieldHtml}</div>
        <div class="app-modal-actions"><button type="button" class="runtime-confirm-secondary">取消</button><button type="submit" class="runtime-confirm-primary">${escapeHtml(primary)}</button></div>
      </form>
    `;
    document.body.appendChild(layer);
    const form = layer.querySelector("form");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const remove = () => {
        if (layer.isConnected) layer.remove();
        resolve(value);
      };
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        remove();
        return;
      }
      layer.classList.add("is-closing");
      let timer;
      const complete = (event) => {
        if (event && event.target !== layer) return;
        clearTimeout(timer);
        layer.removeEventListener("animationend", complete);
        remove();
      };
      layer.addEventListener("animationend", complete);
      timer = setTimeout(complete, 240);
    };
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const data = Object.fromEntries(new FormData(form).entries());
      finish(data);
    });
    layer.querySelector(".project-form-close")?.addEventListener("click", () => finish(null));
    layer.querySelector(".runtime-confirm-secondary")?.addEventListener("click", () => finish(null));
    layer.addEventListener("click", (event) => { if (event.target === layer) finish(null); });
    requestAnimationFrame(() => form?.querySelector("input, textarea")?.focus());
  });
}

async function openProjectDialog(project = null) {
  const values = await showProjectEntityDialog({
    title: project ? "编辑项目" : "新建项目",
    fields: [
      { name: "name", label: "项目名称", value: project?.name || "", placeholder: "例如：白球 AI 开发", required: true },
      { name: "description", label: "项目目标", type: "textarea", value: project?.description || "", placeholder: "这个 AI 团队要完成什么" }
    ],
    primary: project ? "保存" : "创建"
  });
  if (!values) return;
  let activeProjectId = project?.id || "";
  if (project) await api.updateProject(project.id, values);
  else {
    const created = await api.createProject(values);
    activeProjectId = created.id;
    state.expandedProjectIds.add(created.id);
  }
  state.db = await api.init();
  const ceo = state.db.sessions.find((session) => session.projectId === activeProjectId && session.type === "CEO");
  if (ceo) state.expandedCeoSessionIds.add(ceo.id);
  state.selectedSessionId = state.db.selectedSessionId;
  await renderAll();
}

async function openAgentDialog(project) {
  const values = await showProjectEntityDialog({
    title: "创建子 Agent 岗位",
    fields: [
      { name: "name", label: "岗位名称", placeholder: "例如：技术开发", required: true },
      { name: "role", label: "岗位职责", placeholder: "例如：客户端开发工程师", required: true },
      { name: "task", label: "当前任务", type: "textarea", placeholder: "这个岗位当前主要负责什么", required: true }
    ],
    primary: "创建"
  });
  if (!values) return;
  const session = await api.createProjectAgent(project.id, values);
  state.expandedProjectIds.add(project.id);
  state.db = await api.init();
  const ceo = state.db.sessions.find((item) => item.projectId === project.id && item.type === "CEO");
  if (ceo) state.expandedCeoSessionIds.add(ceo.id);
  state.selectedSessionId = session.id;
  await api.selectSession(session.id);
  await renderAll();
}

async function editAgentRole(session) {
  const values = await showProjectEntityDialog({
    title: `${projectSessionDisplayName(session)} · 角色设置`,
    fields: [
      { name: "role", label: "角色", value: session.role || "", placeholder: "例如：客户端开发工程师", required: true },
      { name: "task", label: "当前任务", type: "textarea", value: session.task || "", placeholder: "该 Agent 当前负责什么" }
    ],
    primary: "保存"
  });
  if (!values) return;
  state.db = await api.updateProjectAgent(session.id, values);
  state.selectedSessionId = state.db.selectedSessionId || state.selectedSessionId;
  await renderAll();
}

async function openProjectHome(projectId) {
  markProjectRead(projectId);
  updateProjectTreePresentation();
  const ceo = state.db?.sessions?.find((session) => session.projectId === projectId && session.type === "CEO");
  if (ceo) await selectSessionById(ceo.sessionId || ceo.id);
}

async function confirmDeleteProject(project) {
  if (project.locked) {
    await showAppAlert({ title: "项目已锁定", message: "请先在项目右键菜单中解除锁定，再删除项目。" });
    return;
  }
  const protection = await api.consciousProtection?.("project", project.id).catch(() => null);
  if (protection) {
    const choice = await showProtectedDeleteDialog(project.name);
    if (choice === "cancel") return;
    if (choice === "archive") await api.archiveConsciousSnapshot(protection.id, true);
  } else if (!await showAppConfirm({ title: "删除项目", message: `删除项目「${project.name}」及其全部工作会话？`, primary: "删除", secondary: "取消" })) return;
  const ceoIds = (state.db.sessions || [])
    .filter((session) => session.projectId === project.id && session.type === "CEO")
    .map((session) => session.id);
  state.db = await api.deleteProject(project.id);
  state.expandedProjectIds.delete(project.id);
  for (const ceoId of ceoIds) state.expandedCeoSessionIds.delete(ceoId);
  state.selectedSessionId = state.db.selectedSessionId;
  await renderAll();
}

function showProtectedDeleteDialog(name) {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "app-modal-layer runtime-confirm-layer";
    layer.innerHTML = `
      <div class="app-modal-panel conscious-protection-dialog" role="dialog" aria-modal="true">
        <strong>该对象存在 AI 工作状态</strong>
        <p>「${escapeHtml(name || "当前对象")}」删除后工作状态仍保留在意识中心，但当前工作空间将移除。</p>
        <div class="app-modal-actions">
          <button type="button" data-choice="cancel">取消</button>
          <button type="button" data-choice="archive">移入归档</button>
          <button type="button" class="danger" data-choice="delete">删除</button>
        </div>
      </div>
    `;
    document.body.appendChild(layer);
    const finish = (choice) => { layer.remove(); resolve(choice); };
    layer.querySelectorAll("[data-choice]").forEach((button) => button.addEventListener("click", () => finish(button.dataset.choice)));
    layer.addEventListener("click", (event) => { if (event.target === layer) finish("cancel"); });
    layer.querySelector('[data-choice="cancel"]')?.focus();
  });
}

function projectSessionStatus(status = "", session = null) {
  const normalized = String(status || "").toUpperCase();
  if (session?.id && sessionTaskQueue.isActive(session.id)) return { label: "执行", tone: "running" };
  if (["RUNNING", "EXECUTING", "PLANNING"].includes(normalized)) return { label: "执行", tone: "running" };
  if (["SUCCESS", "DONE", "COMPLETED"].includes(normalized)) return { label: "完成", tone: "done" };
  if (["FAILED", "TIMEOUT", "ABORTED", "CANCELLED", "INTERRUPTED"].includes(normalized)) return { label: "失败", tone: "failed" };
  if (["WAITING", "AWAITING_CONFIRMATION"].includes(normalized)) return { label: "准备", tone: "created" };
  if (["CREATED", "IDLE", "READY"].includes(normalized)) return { label: "准备", tone: "created" };
  return { label: "状态未知", tone: "failed" };
}

function projectSidebarStatus(project, sessions = state.db?.sessions || []) {
  const projectSessionIds = new Set(project?.sessions || []);
  const linked = sessions.filter((session) => session.projectId === project?.id || projectSessionIds.has(session.id));
  const projectSession = linked.find((session) => session.type === "CEO");
  if (projectSession && sessionIsRunning(projectSession)) return { label: "执行", tone: "running", executionTone: "running", signal: "running", unread: false };
  const status = String(projectSession?.status || project?.status || "created").toLowerCase();
  if (["failed", "timeout", "aborted", "cancelled", "interrupted"].includes(status)) {
    return { label: "失败", tone: "failed", executionTone: "failed", signal: "failed", unread: false };
  }
  if (["done", "success", "completed"].includes(status)) {
    const revision = projectRevision(project, sessions);
    const unread = Boolean(revision && projectReadRevisions[project.id] !== revision);
    return { label: unread ? "待查看" : "完成", tone: "done", executionTone: "done", signal: unread ? "unread" : "read", unread };
  }
  return { label: "准备", tone: "created", executionTone: "created", signal: "read", unread: false };
}

function updateProjectStatusIndicator(indicator, status = {}) {
  if (!indicator) return;
  const tone = String(status.tone || "created");
  const label = String(status.label || "状态未知");
  indicator.dataset.tone = tone;
  indicator.dataset.signal = String(status.signal || "read");
  indicator.setAttribute("aria-label", label);
  indicator.title = label;
  indicator.innerHTML = tone === "running"
    ? '<span class="thinking-bars" aria-hidden="true"><i></i><i></i><i></i></span>'
    : '<i class="project-status-dot" aria-hidden="true"></i>';
}

function updateSessionStatusIndicator(indicator, status = {}) {
  if (!indicator) return;
  const tone = String(status.tone || "created");
  const signal = String(status.signal || "read");
  const label = String(status.label || "状态未知");
  indicator.dataset.tone = tone;
  indicator.dataset.signal = signal;
  indicator.setAttribute("aria-label", label);
  indicator.title = label;
  indicator.innerHTML = status.executionTone === "running"
    ? '<span class="thinking-bars" aria-hidden="true"><i></i><i></i><i></i></span>'
    : '<i class="project-status-dot" aria-hidden="true"></i>';
}

function agentRuntimeStatus(status = "") {
  const normalized = String(status || "CREATED").toUpperCase();
  if (["RUNNING", "EXECUTING", "PLANNING"].includes(normalized)) return "RUNNING";
  if (["WAITING", "AWAITING_CONFIRMATION"].includes(normalized)) return "WAITING";
  if (["SUCCESS", "DONE", "COMPLETED"].includes(normalized)) return "SUCCESS";
  if (["FAILED", "TIMEOUT", "ABORTED", "CANCELLED", "INTERRUPTED"].includes(normalized)) return "FAILED";
  return "CREATED";
}

function agentExecutionSummary(session = {}) {
  const execution = session.lastExecution || {};
  const evidence = execution.evidence || {};
  const verification = evidence.verification || execution.verification || {};
  const result = String(evidence.message || execution.summary || execution.result || "").trim();
  const status = agentRuntimeStatus(execution.status || session.status);
  return {
    agentId: session.agentId || session.id || "-",
    taskId: execution.taskId || session.activeTaskId || "-",
    traceId: execution.traceId || "-",
    resultId: execution.resultId || "-",
    status,
    task: session.task || "暂无任务",
    startedAt: execution.startedAt || "",
    finishedAt: execution.finishedAt || "",
    verification: verification.status || (status === "SUCCESS" ? "passed" : "-"),
    result: result || "暂无执行结果",
    toolResults: Array.isArray(evidence.toolResults) ? evidence.toolResults : []
  };
}

function agentExecutionTime(execution = {}) {
  if (!execution.startedAt && !execution.finishedAt) return "尚未执行";
  const start = execution.startedAt ? new Date(execution.startedAt).toLocaleString("zh-CN", { hour12: false }) : "-";
  const finish = execution.finishedAt ? new Date(execution.finishedAt).toLocaleString("zh-CN", { hour12: false }) : "执行中";
  return `${start} - ${finish}`;
}

function showAgentExecutionLog(session) {
  const detail = agentExecutionSummary(session);
  const layer = document.createElement("div");
  layer.className = "app-modal-layer agent-log-layer";
  layer.innerHTML = `
    <section class="app-modal-panel agent-log-panel" role="dialog" aria-modal="true" aria-labelledby="agentLogTitle">
      <header><div><span>Agent 执行日志</span><strong id="agentLogTitle">${escapeHtml(projectSessionDisplayName(session))}</strong></div><button type="button" data-agent-log-close aria-label="关闭">×</button></header>
      <div class="agent-log-grid">
        <div><span>Agent ID</span><code>${escapeHtml(detail.agentId)}</code></div>
        <div><span>Task ID</span><code>${escapeHtml(detail.taskId)}</code></div>
        <div><span>Trace ID</span><code>${escapeHtml(detail.traceId)}</code></div>
        <div><span>Result ID</span><code>${escapeHtml(detail.resultId)}</code></div>
        <div><span>状态</span><b>${escapeHtml(detail.status)}</b></div>
        <div><span>Verifier</span><b>${escapeHtml(detail.verification)}</b></div>
        <div class="agent-log-wide"><span>执行时间</span><p>${escapeHtml(agentExecutionTime(session.lastExecution || {}))}</p></div>
        <div class="agent-log-wide"><span>当前任务</span><p>${escapeHtml(detail.task)}</p></div>
        <div class="agent-log-wide"><span>Result</span><pre>${escapeHtml(detail.result)}</pre></div>
        <div class="agent-log-wide"><span>Tool Records</span><pre>${escapeHtml(detail.toolResults.length ? JSON.stringify(detail.toolResults, null, 2) : "本次任务没有工具调用")}</pre></div>
      </div>
    </section>`;
  document.body.appendChild(layer);
  const close = () => layer.remove();
  layer.querySelector("[data-agent-log-close]")?.addEventListener("click", close);
  layer.addEventListener("click", (event) => { if (event.target === layer) close(); });
}

function taskBoardAgentSummaryHtml(session = {}) {
  if (session?.type !== "CEO") return "";
  const detail = agentExecutionSummary(session);
  return `
    <section class="task-board-agent-summary" aria-label="Agent 执行详情">
      <header><div><span>黑球执行详情</span><strong>${escapeHtml(projectSessionDisplayName(session))}</strong><small>${escapeHtml(session.role || "项目负责人")}</small></div><button type="button" data-agent-log-open>查看详细日志</button></header>
      <dl>
        <div><dt>状态</dt><dd>${escapeHtml(detail.status)}</dd></div>
        <div class="task-board-agent-task"><dt>当前任务</dt><dd title="${escapeHtml(detail.task)}">${escapeHtml(detail.task)}</dd></div>
        <div><dt>执行时间</dt><dd title="${escapeHtml(agentExecutionTime(session.lastExecution || {}))}">${escapeHtml(agentExecutionTime(session.lastExecution || {}))}</dd></div>
        <div><dt>验证状态</dt><dd>${escapeHtml(detail.verification)}</dd></div>
        <div class="task-board-agent-result"><dt>Result 摘要</dt><dd title="${escapeHtml(detail.result)}">${escapeHtml(detail.result)}</dd></div>
      </dl>
    </section>`;
}

function treeAction(symbol, title, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-action";
  button.textContent = symbol;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    handler();
  });
  return button;
}

function currentProjectSession(sessionId) {
  return state.db?.sessions?.find((item) => item.id === sessionId) || null;
}

function projectSessionDisplayName(session = {}) {
  const name = String(session.name || "").trim();
  const title = String(session.title || "").trim();
  if (session.type === "CEO") {
    if (name && name !== "CEO") return name;
    if (title && title !== "CEO" && !/ · CEO$/.test(title)) return title;
    return "项目负责人";
  }
  return title || name || "新会话";
}

async function renameProjectSession(session) {
  const title = await askSessionTitle(projectSessionDisplayName(session));
  if (!title) return;
  state.db = await api.renameSession(session.id, title);
  state.selectedSessionId = state.db.selectedSessionId || state.selectedSessionId;
  await renderAll();
}

function sessionRowAction(symbol, title, handler) {
  const action = document.createElement("button");
  action.type = "button";
  action.className = "session-row-action";
  action.textContent = symbol;
  action.title = title;
  action.setAttribute("aria-label", title);
  action.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handler();
  });
  return action;
}

function sidebarSortClickSuppressed() {
  return Date.now() < Number(state.sidebarSortSuppressUntil || 0);
}

function moveSidebarOrder(ids, sourceId, targetId, before = true) {
  const next = [...ids];
  const sourceIndex = next.indexOf(sourceId);
  if (sourceIndex < 0 || !next.includes(targetId) || sourceId === targetId) return next;
  next.splice(sourceIndex, 1);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (before ? 0 : 1), 0, sourceId);
  return next;
}

function clearSidebarSortIndicators() {
  sessionList?.querySelectorAll(".sort-drop-before, .sort-drop-after").forEach((node) => node.classList.remove("sort-drop-before", "sort-drop-after"));
}

async function persistSidebarSort(drag) {
  if (!drag?.targetId || drag.targetId === drag.id) return;
  if (drag.kind === "project") {
    const ids = (state.db?.projects || []).map((project) => project.id);
    const nextIds = moveSidebarOrder(ids, drag.id, drag.targetId, drag.before);
    state.db = await api.reorderProjects(nextIds);
  } else {
    const sessions = (state.db?.sessions || []).filter((session) => isBatchChatSession(session)
      && `chat:${Boolean(session.archived)}:${Boolean(session.pinned)}` === drag.group);
    const nextIds = moveSidebarOrder(sessions.map((session) => session.id), drag.id, drag.targetId, drag.before);
    state.db = await api.reorderSessions(nextIds);
  }
  state.projectTreeSignature = "";
  renderSessions();
  showCopyToast("排序已保存");
}

function bindSidebarLongPressSort(handle, { element = handle, kind, id, group } = {}) {
  if (!handle || !element || !kind || !id) return;
  element.dataset.sortKind = kind;
  element.dataset.sortId = id;
  element.dataset.sortGroup = group || kind;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.batchDeleteMode || state.sessionQuery.trim()) return;
    if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select, .tree-actions, .session-row-actions")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let active = false;
    let timer = setTimeout(() => {
      active = true;
      state.sidebarSortDrag = { active: true, kind, id, group: group || kind, element, targetId: "", before: true };
      state.sidebarSortSuppressUntil = Date.now() + 700;
      element.classList.add("is-sort-dragging");
      document.body.classList.add("sidebar-sort-active");
      handle.setPointerCapture?.(pointerId);
    }, 420);

    const cleanup = () => {
      clearTimeout(timer);
      timer = null;
      clearSidebarSortIndicators();
      element.classList.remove("is-sort-dragging");
      document.body.classList.remove("sidebar-sort-active");
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onCancel, true);
      if (state.sidebarSortDrag?.id === id && state.sidebarSortDrag?.kind === kind) state.sidebarSortDrag = null;
    };
    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 7) cleanup();
        return;
      }
      moveEvent.preventDefault();
      const listRect = sessionList?.getBoundingClientRect();
      if (listRect) {
        if (moveEvent.clientY < listRect.top + 32) sessionList.scrollTop -= 12;
        else if (moveEvent.clientY > listRect.bottom - 32) sessionList.scrollTop += 12;
      }
      clearSidebarSortIndicators();
      const candidate = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.(`[data-sort-kind="${kind}"]`);
      if (!candidate || candidate === element || candidate.dataset.sortGroup !== (group || kind)) {
        if (state.sidebarSortDrag) state.sidebarSortDrag.targetId = "";
        return;
      }
      const candidateRow = kind === "project" ? candidate.querySelector(":scope > .project-row") : candidate;
      const rect = (candidateRow || candidate).getBoundingClientRect();
      const before = moveEvent.clientY < rect.top + rect.height / 2;
      candidate.classList.add(before ? "sort-drop-before" : "sort-drop-after");
      if (state.sidebarSortDrag) {
        state.sidebarSortDrag.targetId = candidate.dataset.sortId || "";
        state.sidebarSortDrag.before = before;
      }
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      const completed = active ? { ...state.sidebarSortDrag } : null;
      if (active) {
        upEvent.preventDefault();
        upEvent.stopPropagation();
        state.sidebarSortSuppressUntil = Date.now() + 700;
      }
      cleanup();
      if (completed?.targetId) persistSidebarSort(completed).catch((error) => showCopyToast(error?.message || "排序保存失败"));
    };
    const onCancel = (cancelEvent) => {
      if (cancelEvent.pointerId === pointerId) cleanup();
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
  });
  handle.addEventListener("contextmenu", (event) => {
    if (state.sidebarSortDrag?.active || sidebarSortClickSuppressed()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}

function createProjectSessionNode(session, { batchSelectable = false } = {}) {
  const status = sessionSidebarStatus(session);
  const isBatchCandidate = batchSelectable && isBatchChatSession(session) && state.batchDeleteMode;
  const isBatchSelected = state.selectedBatchSessionIds.has(session.id);
  const button = document.createElement("div");
  button.type = "button";
  button.setAttribute("role", "button");
  button.tabIndex = 0;
  button.className = `session-item project-session-item role-${String(session.type || "chat").toLowerCase()}${isBatchCandidate ? " batch-selectable" : ""}${isBatchSelected ? " batch-selected" : ""}${session.id === state.selectedSessionId ? " active" : ""}${status.unread && status.executionTone === "done" ? " unread-complete" : ""}`;
  button.dataset.id = session.id;
  button.dataset.projectId = session.projectId || "";
  button.dataset.agentId = session.type === "CEO" ? (session.agentId || session.id) : "";
  button.dataset.roleEntryId = session.type === "Agent" ? (session.roleEntryId || session.id) : "";
  button.dataset.conversationId = session.conversationId || session.sessionId || session.id;
  button.dataset.role = session.role || "";
  button.dataset.unread = status.unread ? "1" : "0";
  button.dataset.executionTone = status.executionTone;
  button.dataset.batchSelected = isBatchSelected ? "1" : "0";
  const coreType = session.type === "CEO" ? "ceo" : session.type === "Agent" ? "agent" : "chat";
  const displayName = projectSessionDisplayName(session);
  const nameLength = Array.from(displayName).length;
  const nameDensity = nameLength > 18 ? "tight" : nameLength > 12 ? "compact" : "normal";
  button.innerHTML = `
    ${isBatchCandidate ? `<span class="chat-batch-check" role="checkbox" aria-checked="${isBatchSelected ? "true" : "false"}" aria-label="选择${escapeHtml(displayName)}">${isBatchSelected ? "✓" : ""}</span>` : ""}
    <i class="ai-core ai-core-${coreType}" aria-hidden="true"><b class="conscious-ring"></b><em class="conscious-mark"></em></i>
    <span class="project-session-name" data-name-density="${nameDensity}" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
    <small class="session-status-indicator" data-session-status></small>
  `;
  updateSessionStatusIndicator(button.querySelector("[data-session-status]"), status);
  if (!session.projectId && session.type === "chat" && session.pinned && !isBatchCandidate) {
    const favorite = sessionRowAction("★", "取消收藏", () => handleSessionAction("favorite", session.id));
    favorite.classList.add("session-favorite-marker");
    favorite.dataset.pinned = "1";
    const statusNode = button.querySelector("[data-session-status]");
    button.insertBefore(favorite, statusNode?.nextSibling || null);
  }
  const ordinaryChat = !session.projectId && session.type === "chat";
  const projectConversation = Boolean(session.projectId && ["CEO", "Agent"].includes(session.type));
  if (!isBatchCandidate && (ordinaryChat || projectConversation)) {
    const actions = document.createElement("span");
    actions.className = `session-row-actions${projectConversation ? " project-session-row-actions" : ""}`;
    actions.append(sessionRowAction("✎", "修改名称", () => handleSessionAction("rename", session.id)));
    if (ordinaryChat) actions.append(sessionRowAction("×", "删除会话", () => handleSessionAction("delete", session.id)));
    button.appendChild(actions);
  }
  // 搜索摘要高亮
  const snippetHtml = highlightSearchSnippet(session.id, state.sessionQuery.trim());
  if (snippetHtml) {
    const snippetEl = document.createElement('div');
    snippetEl.className = 'search-snippet-row';
    snippetEl.innerHTML = snippetHtml;
    snippetEl.addEventListener('click', (e) => {
      e.stopPropagation();
      state._searchJumpQuery = state.sessionQuery.trim();
      selectSessionById(button.dataset.conversationId);
    });
    button.appendChild(snippetEl);
  }
  button.addEventListener("click", (event) => {
    if (sidebarSortClickSuppressed()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (isBatchCandidate && state.batchDeleteMode) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleBatchSessionSelection(session.id);
    }
  });
  button.addEventListener("click", () => selectSessionById(button.dataset.conversationId));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    button.click();
  });
  button.addEventListener("contextmenu", (event) => showSessionMenu(event, currentProjectSession(session.id) || session));
  if (isBatchChatSession(session)) {
    bindSidebarLongPressSort(button, {
      kind: "session",
      id: session.id,
      group: `chat:${Boolean(session.archived)}:${Boolean(session.pinned)}`
    });
  }
  if (session.type === "CEO" && isProjectTreeDevelopmentMode()) {
    const count = (state.ceoRenderCounts.get(session.id) || 0) + 1;
    state.ceoRenderCounts.set(session.id, count);
    console.debug("[CEO Render]", { sessionId: session.id, count });
  }
  return button;
}

function isBatchChatSession(session = {}) {
  return Boolean(session?.id && !session.projectId && !["CEO", "Agent"].includes(session.type));
}

function toggleBatchSessionSelection(sessionId) {
  const session = state.db?.sessions?.find((item) => item.id === sessionId);
  if (!isBatchChatSession(session) || sessionIsRunning(session)) return;
  if (state.selectedBatchSessionIds.has(sessionId)) state.selectedBatchSessionIds.delete(sessionId);
  else state.selectedBatchSessionIds.add(sessionId);
  renderSessions();
}

function exitBatchDeleteMode() {
  state.batchDeleteMode = false;
  state.selectedBatchSessionIds.clear();
  setBatchManageButtonState(false);
  renderSessions();
}

function setBatchManageButtonState(active) {
  const button = $("batchManageBtn");
  if (!button) return;
  const label = button.querySelector(".batch-manage-label");
  button.dataset.active = active ? "1" : "0";
  button.setAttribute("aria-pressed", String(Boolean(active)));
  button.setAttribute("aria-label", active ? "完成批量管理" : "开始批量管理");
  button.title = active ? "退出批量管理" : "批量管理聊天会话";
  if (label) label.textContent = active ? "完成" : "批量";
}

async function deleteSelectedChatSessions() {
  const selectedIds = [...state.selectedBatchSessionIds];
  const selected = selectedIds
    .map((id) => state.db?.sessions?.find((session) => session.id === id))
    .filter(isBatchChatSession);
  if (!selected.length) {
    await showAppAlert({ title: "未选择会话", message: "请先选择要删除的普通聊天会话。" });
    return;
  }
  const runningCount = selected.filter((session) => sessionIsRunning(session)).length;
  const deletableCount = selected.length - runningCount;
  if (!deletableCount) {
    await showAppAlert({ title: "暂不能删除", message: "所选会话都在执行中，请等待完成或先终止任务。" });
    return;
  }
  const detail = runningCount ? `\n${runningCount} 个执行中的会话将被跳过。` : "";
  const confirmed = await showAppConfirm({
    title: "批量删除会话",
    message: `确定删除 ${deletableCount} 个普通聊天会话？此操作不可恢复。${detail}`,
    primary: "删除",
    secondary: "取消"
  });
  if (!confirmed) return;
  const result = await api.deleteSessions(selected.map((session) => session.id));
  state.db = result?.db || await api.init();
  state.selectedBatchSessionIds.clear();
  const removedCount = Array.isArray(result?.removedIds) ? result.removedIds.length : 0;
  const skippedCount = Array.isArray(result?.skipped) ? result.skipped.length : 0;
  await renderAll();
  showCopyToast(`已删除 ${removedCount} 个会话${skippedCount ? `，跳过 ${skippedCount} 个` : ""}`);
}

async function archiveSelectedChatSessions() {
  const selected = [...state.selectedBatchSessionIds]
    .map((id) => state.db?.sessions?.find((session) => session.id === id))
    .filter(isBatchChatSession);
  if (!selected.length) {
    await showAppAlert({ title: "未选择会话", message: "请先选择要归档的普通聊天会话。" });
    return;
  }
  const runningCount = selected.filter((session) => sessionIsRunning(session)).length;
  const candidates = selected.filter((session) => !sessionIsRunning(session));
  if (!candidates.length) {
    await showAppAlert({ title: "暂不能归档", message: "所选会话都在执行中，请等待完成或先终止任务。" });
    return;
  }
  const restoring = state.showArchivedSessions;
  const detail = runningCount ? `\n${runningCount} 个执行中的会话将被跳过。` : "";
  if (!restoring && !await showAppConfirm({
    title: "批量归档会话",
    message: `确定归档 ${candidates.length} 个普通聊天会话？会话内容仍会保留，可从已归档列表恢复。${detail}`,
    primary: "归档",
    secondary: "取消"
  })) return;
  const result = await api.archiveSessions(candidates.map((session) => session.id), !restoring);
  state.db = result?.db || await api.init();
  state.selectedBatchSessionIds.clear();
  await renderAll();
  showCopyToast(restoring ? `已恢复 ${result?.archivedIds?.length || 0} 个会话` : `已归档 ${result?.archivedIds?.length || 0} 个会话`);
}

function createBatchActionButton(label, action, title, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chat-batch-action${options.danger ? " danger" : ""}`;
  button.dataset.batchAction = action;
  button.textContent = label;
  button.title = title;
  button.disabled = Boolean(options.disabled);
  button.addEventListener("click", options.handler);
  return button;
}

function createProjectSectionLabel(projects = []) {
  const heading = document.createElement("div");
  heading.className = "tree-section-heading";
  const label = document.createElement("div");
  label.className = "tree-section-label project-section-label";
  const title = document.createElement("span");
  title.textContent = "项目";
  const count = document.createElement("small");
  count.textContent = String(projects.length);
  label.append(title, count);
  heading.appendChild(label);
  return heading;
}

function createChatSectionLabel(unassigned = []) {
  const unassignedCount = unassigned.length;
  const selectable = unassigned.filter((session) => isBatchChatSession(session) && !sessionIsRunning(session));
  const allVisibleSelected = selectable.length > 0 && selectable.every((session) => state.selectedBatchSessionIds.has(session.id));
  const heading = document.createElement("div");
  heading.className = "tree-section-heading";
  const label = document.createElement("div");
  label.className = "tree-section-label chat-section-label";
  const title = document.createElement("span");
  title.textContent = state.showArchivedSessions ? "已归档" : "聊天";
  const count = document.createElement("small");
  count.textContent = String(unassignedCount);
  label.append(title, count);
  const archivedCount = (state.db?.sessions || []).filter((session) => isBatchChatSession(session) && session.archived).length;
  if (archivedCount || state.showArchivedSessions) {
    const archiveToggle = document.createElement("button");
    archiveToggle.type = "button";
    archiveToggle.className = "tree-section-filter";
    archiveToggle.textContent = state.showArchivedSessions ? "返回聊天" : `已归档 ${archivedCount}`;
    archiveToggle.title = state.showArchivedSessions ? "返回普通聊天" : "查看已归档会话";
    archiveToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.batchDeleteMode) exitBatchDeleteMode();
      state.showArchivedSessions = !state.showArchivedSessions;
      renderSessions();
    });
    label.appendChild(archiveToggle);
  }
  heading.appendChild(label);
  if (state.batchDeleteMode) {
    const tools = document.createElement("div");
    tools.className = "chat-section-tools tree-batch-toolbar";
    const selectedCount = state.selectedBatchSessionIds.size;
    const selected = document.createElement("span");
    selected.className = "chat-batch-count";
    selected.textContent = `已选 ${selectedCount}`;
    const selectAll = createBatchActionButton(allVisibleSelected ? "取消" : "全选", "select-all", allVisibleSelected ? "取消选择当前列表中的全部会话" : "选择当前列表中的全部可删除会话", { handler: () => {
      for (const session of selectable) {
        if (allVisibleSelected) state.selectedBatchSessionIds.delete(session.id);
        else state.selectedBatchSessionIds.add(session.id);
      }
      renderSessions();
    }});
    const archiveButton = createBatchActionButton(state.showArchivedSessions ? "恢复" : "归档", state.showArchivedSessions ? "restore" : "archive", state.showArchivedSessions ? "恢复已选归档会话" : "归档已选普通聊天会话", { disabled: selectedCount === 0, handler: archiveSelectedChatSessions });
    const deleteButton = createBatchActionButton("删除", "delete", "删除已选普通聊天会话", { danger: true, disabled: selectedCount === 0, handler: deleteSelectedChatSessions });
    tools.append(selected, selectAll, archiveButton, deleteButton);
    heading.appendChild(tools);
  }
  return heading;
}

function projectMatchesQuery(project, query, sessionById) {
  if (!query) return true;
  const values = [project.name, project.description];
  let hasDeepMatch = false;
  for (const id of project.sessions || []) {
    const session = sessionById.get(id);
    values.push(session?.title, session?.role, session?.task);
    // Phase 2: 检查深度搜索结果
    if (state.deepSearchResults.has(id)) hasDeepMatch = true;
  }
  return values.some((value) => String(value || "").toLowerCase().includes(query)) || hasDeepMatch;
}

function highlightSearchSnippet(sessionId, query) {
  const snippets = state.deepSearchResults.get(sessionId);
  if (!snippets || !snippets.length || !query) return '';
  const q = query.toLowerCase();
  const raw = snippets[0] || '';
  const idx = raw.toLowerCase().indexOf(q);
  let excerpt;
  if (idx >= 0) {
    const start = Math.max(0, idx - 30);
    const end = Math.min(raw.length, idx + query.length + 50);
    excerpt = (start > 0 ? '...' : '') + raw.slice(start, end) + (end < raw.length ? '...' : '');
  } else {
    excerpt = raw.slice(0, 80) + (raw.length > 80 ? '...' : '');
  }
  const escaped = escapeHtml(excerpt);
  const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return '<span class="deep-search-snippet">' + escaped.replace(re, '<mark>$1</mark>') + '</span>';
}

function isProjectTreeDevelopmentMode() {
  const license = state.db?.licenseStatus || state.licenseStatus || {};
  return Boolean(license.devMode || license.owner || license.state === "developer");
}

function projectTreeStructureSignature() {
  const projects = (state.db?.projects || []).map((project) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    order: project.order,
    sessions: project.sessions || [],
    locked: Boolean(project.locked)
  }));
  const sessions = (state.db?.sessions || []).map((session) => ({
    id: session.id,
    projectId: session.projectId || "",
    parentSessionId: session.parentSessionId || "",
    type: session.type || "chat",
    name: session.name || "",
    title: session.title || "",
    role: session.role || "",
    task: session.task || "",
    pinned: Boolean(session.pinned),
    archived: Boolean(session.archived),
    order: session.order,
  }));
  return JSON.stringify({
    query: state.sessionQuery.trim().toLowerCase(),
    batchDeleteMode: state.batchDeleteMode,
    showArchivedSessions: state.showArchivedSessions,
    selectedBatchSessionIds: [...state.selectedBatchSessionIds].sort(),
    projects,
    sessions,
    expandedProjects: [...state.expandedProjectIds].sort(),
    expandedCeos: [...state.expandedCeoSessionIds].sort()
  });
}

function updateProjectTreePresentation() {
  const sessions = new Map((state.db?.sessions || []).map((session) => [session.id, session]));
  sessionList.querySelectorAll(".project-session-item[data-id]").forEach((node) => {
    const session = sessions.get(node.dataset.id);
    if (!session) return;
    node.classList.toggle("active", session.id === state.selectedSessionId);
    const status = sessionSidebarStatus(session);
    node.classList.toggle("unread-complete", status.unread && status.executionTone === "done");
    node.dataset.unread = status.unread ? "1" : "0";
    node.dataset.executionTone = status.executionTone;
    const statusNode = node.querySelector("[data-session-status]");
    updateSessionStatusIndicator(statusNode, status);
  });
  const projects = new Map((state.db?.projects || []).map((project) => [project.id, project]));
  sessionList.querySelectorAll(".project-node[data-node-id]").forEach((node) => {
    const project = projects.get(node.dataset.nodeId);
    if (!project) return;
    const status = projectSidebarStatus(project, [...sessions.values()]);
    node.dataset.executionTone = status.tone;
    updateProjectStatusIndicator(node.querySelector(":scope > .project-row > .project-status-indicator"), status);
  });
}

function buildProjectOrganizationTree(project, sessions = []) {
  const projectSessionIds = new Set(project.sessions || []);
  const linkedSessions = sessions.filter((session) => session.projectId === project.id || projectSessionIds.has(session.id));
  const ceo = linkedSessions.find((session) => session.type === "CEO") || null;
  const agents = linkedSessions
    .filter((session) => session.type === "Agent")
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  return {
    id: project.id,
    type: "Project",
    project,
    children: ceo ? [{
      id: ceo.id,
      type: "CEO",
      session: ceo,
      children: [
        ...agents.map((agent) => ({
          id: agent.id,
          type: "Agent",
          session: agent,
          orphaned: agent.parentSessionId !== ceo.id,
          children: []
        }))
      ]
    }] : []
  };
}

function organizationTreeContextForNode(node, current) {
  if (node.type === "Project") return { project: node.project, query: state.sessionQuery.trim().toLowerCase() };
  const projectId = current?.closest('.org-tree-node[data-node-type="Project"]')?.dataset.nodeId;
  const project = state.db?.projects?.find((item) => item.id === projectId) || null;
  return { project, query: state.sessionQuery.trim().toLowerCase() };
}

function createOrganizationChildren(node, context) {
  const children = document.createElement("ul");
  children.className = `org-tree-children ${node.type === "Project" ? "project-children" : "project-agent-group"}`;
  children.setAttribute("role", "group");
  node.children.forEach((child, index) => children.appendChild(renderOrganizationBranch(child, context, index)));
  return children;
}

function setOrganizationNodeExpanded(current, expanded) {
  if (!current) return;
  current.setAttribute("aria-expanded", String(expanded));
  const button = current.querySelector(":scope > .org-node-line > .tree-toggle");
  if (!button) return;
  const title = expanded ? "收起团队" : "展开团队";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.setAttribute("aria-expanded", String(expanded));
}

function finishOrganizationTransition(element, duration, complete) {
  let finished = false;
  let timer = 0;
  const settle = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    element.removeEventListener("transitionend", onTransitionEnd);
    element.removeEventListener("transitioncancel", settle);
    complete();
  };
  const onTransitionEnd = (event) => {
    if (event.target === element && event.propertyName === "height") settle();
  };
  element.addEventListener("transitionend", onTransitionEnd);
  element.addEventListener("transitioncancel", settle);
  timer = window.setTimeout(settle, duration + 80);
}

function toggleOrganizationNode(node) {
  const expandedIds = node.type === "Project" ? state.expandedProjectIds : state.expandedCeoSessionIds;
  const current = sessionList?.querySelector(`.org-tree-node[data-node-id="${CSS.escape(String(node.id))}"]`);
  const currentChildren = current?.querySelector(":scope > .org-tree-children");
  const scrollTop = sessionList?.scrollTop || 0;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const expandDuration = reducedMotion ? 0 : 180;
  const collapseDuration = reducedMotion ? 0 : 160;
  if (!current || current.dataset.treeTransition || !node.children.length) return;

  if (expandedIds.has(node.id)) {
    if (!currentChildren || !collapseDuration) {
      expandedIds.delete(node.id);
      currentChildren?.remove();
      setOrganizationNodeExpanded(current, false);
      state.projectTreeSignature = projectTreeStructureSignature();
      return;
    }
    const anchorTop = current.getBoundingClientRect().top;
    current.dataset.treeTransition = "collapsing";
    setOrganizationNodeExpanded(current, false);
    sessionList?.classList.add("tree-collapse-active");
    currentChildren.classList.add("org-tree-children--collapsing");
    currentChildren.style.height = `${currentChildren.scrollHeight}px`;
    currentChildren.style.opacity = "1";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!currentChildren.isConnected || current.dataset.treeTransition !== "collapsing") return;
        currentChildren.style.height = "0px";
        currentChildren.style.opacity = "0";
      });
    });
    finishOrganizationTransition(currentChildren, collapseDuration, () => {
      expandedIds.delete(node.id);
      currentChildren.remove();
      current.dataset.treeTransition = "";
      requestAnimationFrame(() => {
        if (sessionList && current.isConnected) {
          const shift = current.getBoundingClientRect().top - anchorTop;
          if (Math.abs(shift) > 0.5) sessionList.scrollTop += shift;
        }
        if (!sessionList?.querySelector('[data-tree-transition="collapsing"]')) {
          sessionList?.classList.remove("tree-collapse-active");
        }
        requestAnimationFrame(() => {
          state.projectTreeSignature = projectTreeStructureSignature();
        });
      });
    });
    return;
  }

  const children = createOrganizationChildren(node, organizationTreeContextForNode(node, current));
  expandedIds.add(node.id);
  current.appendChild(children);
  setOrganizationNodeExpanded(current, true);
  state.projectTreeSignature = projectTreeStructureSignature();
  if (sessionList) sessionList.scrollTop = scrollTop;
  if (!expandDuration) return;

  current.dataset.treeTransition = "expanding";
  children.classList.add("org-tree-children--expanding");
  children.style.height = "0px";
  children.style.opacity = "0";
  requestAnimationFrame(() => {
    children.style.height = `${children.scrollHeight}px`;
    children.style.opacity = "1";
  });
  finishOrganizationTransition(children, expandDuration, () => {
    children.style.height = "";
    children.style.opacity = "";
    children.classList.remove("org-tree-children--expanding");
    current.dataset.treeTransition = "";
  });
}

function createOrganizationToggle(node, expanded) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-toggle";
  button.title = expanded ? "收起团队" : "展开团队";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-expanded", String(expanded));
  button.innerHTML = '<span aria-hidden="true"></span>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleOrganizationNode(node);
  });
  return button;
}

function renderOrganizationBranch(node, context, order = 0) {
  const item = document.createElement("li");
  item.className = `org-tree-node org-type-${node.type.toLowerCase()}${node.orphaned ? " org-node-unclassified" : ""}`;
  item.dataset.nodeId = node.id;
  item.dataset.nodeType = node.type;
  item.style.setProperty("--tree-order", order);
  item.setAttribute("role", "treeitem");

  const hasChildren = node.children.length > 0;
  const expanded = context.query || (node.type === "Project"
    ? state.expandedProjectIds.has(node.id)
    : node.type === "CEO" ? state.expandedCeoSessionIds.has(node.id) : false);
  item.setAttribute("aria-expanded", hasChildren ? String(expanded) : "false");

  if (node.type === "Project") {
    item.classList.add("project-node");
    const row = document.createElement("div");
    row.className = "project-row org-node-line";
    const projectStatus = projectSidebarStatus(node.project);
    item.dataset.executionTone = projectStatus.tone;
    row.append(createOrganizationToggle(node, expanded));
    const core = document.createElement("i");
    core.className = "project-core";
    core.setAttribute("aria-hidden", "true");
    const name = document.createElement("strong");
    name.textContent = node.project.name;
    const statusIndicator = document.createElement("span");
    statusIndicator.className = "project-status-indicator";
    updateProjectStatusIndicator(statusIndicator, projectStatus);
    const actions = document.createElement("span");
    actions.className = "tree-actions";
    actions.append(
      treeAction("✎", "编辑项目", () => openProjectDialog(node.project)),
      treeAction("×", "删除项目", () => confirmDeleteProject(node.project))
    );
    row.append(core, name, statusIndicator, actions);
    row.addEventListener("click", (event) => {
      if (sidebarSortClickSuppressed()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      openProjectHome(node.project.id);
    });
    row.addEventListener("contextmenu", (event) => showProjectMenu(event, node.project));
    bindSidebarLongPressSort(row, { element: item, kind: "project", id: node.project.id, group: "project" });
    item.appendChild(row);
  } else if (node.type === "CEO") {
    const row = document.createElement("div");
    row.className = "project-ceo-row org-node-line";
    if (hasChildren) row.appendChild(createOrganizationToggle(node, expanded));
    else {
      const spacer = document.createElement("span");
      spacer.className = "tree-toggle-spacer";
      row.appendChild(spacer);
    }
    const sessionNode = createProjectSessionNode(node.session);
    row.append(sessionNode);
    item.appendChild(row);
  } else if (node.type === "Agent") {
    const row = document.createElement("div");
    row.className = "project-agent-row org-node-line";
    const sessionNode = createProjectSessionNode(node.session);
    if (node.orphaned) sessionNode.title = "岗位归属已由项目结构校准到当前负责人";
    row.appendChild(sessionNode);
    item.appendChild(row);
  }

  if (hasChildren && expanded) {
    const children = document.createElement("ul");
    children.className = `org-tree-children ${node.type === "Project" ? "project-children" : "project-agent-group"}`;
    children.setAttribute("role", "group");
    node.children.forEach((child, index) => children.appendChild(renderOrganizationBranch(child, context, index)));
    item.appendChild(children);
  }
  return item;
}

function renderSessions() {
  const query = state.sessionQuery.trim().toLowerCase();
  const sessions = state.db?.sessions || [];
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const projects = (state.db?.projects || []).filter((project) => projectMatchesQuery(project, query, sessionById));
  if (!state.treeInitialized) {
    for (const project of projects) {
      state.expandedProjectIds.add(project.id);
      const tree = buildProjectOrganizationTree(project, sessions);
      if (tree.children[0]) state.expandedCeoSessionIds.add(tree.children[0].id);
    }
    state.treeInitialized = true;
  }

  const signature = projectTreeStructureSignature();
  if (signature === state.projectTreeSignature && sessionList.childElementCount) {
    updateProjectTreePresentation();
    return false;
  }
  state.projectTreeSignature = signature;
  state.projectTreeRenderCount += 1;
  if (isProjectTreeDevelopmentMode()) {
    console.debug("[Tree Render]", { count: state.projectTreeRenderCount });
  }
  const previousScrollTop = sessionList.scrollTop;
  state.selectedBatchSessionIds = new Set([...state.selectedBatchSessionIds].filter((id) => isBatchChatSession(sessions.find((session) => session.id === id))));
  sessionList.innerHTML = "";

  const projectSection = document.createElement("section");
  projectSection.className = "tree-section";
  projectSection.appendChild(createProjectSectionLabel(projects));
  const organizationTree = document.createElement("ul");
  organizationTree.className = "organization-tree";
  organizationTree.setAttribute("role", "tree");
  organizationTree.setAttribute("aria-label", "AI 项目组织架构");
  for (const project of projects) {
    const tree = buildProjectOrganizationTree(project, sessions);
    if (query && tree.children[0]) state.expandedCeoSessionIds.add(tree.children[0].id);
    organizationTree.appendChild(renderOrganizationBranch(tree, { project, query }, organizationTree.children.length));
  }
  if (projects.length) projectSection.appendChild(organizationTree);
  if (!projects.length) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.className = "tree-empty-action";
    empty.textContent = query ? "没有匹配的项目" : "＋ 新建第一个项目";
    if (!query) empty.addEventListener("click", () => openProjectDialog());
    projectSection.appendChild(empty);
  }
  sessionList.appendChild(projectSection);

  const unassigned = sessions.filter((session) => isBatchChatSession(session)
    && Boolean(session.archived) === Boolean(state.showArchivedSessions)
    && (!query || String(session.title || "").toLowerCase().includes(query) || state.deepSearchResults.has(session.id)));
  const chatSection = document.createElement("section");
  chatSection.className = "tree-section chat-section";
  chatSection.appendChild(createChatSectionLabel(unassigned));
  for (const session of unassigned) chatSection.appendChild(createProjectSessionNode(session, { batchSelectable: true }));
  sessionList.appendChild(chatSection);
  sessionList.scrollTop = previousScrollTop;
  return true;
}

const TASK_PHASES = [
  { id: "intent_detected", label: "理解需求", detail: "识别目标、约束和需要处理的内容。" },
  { id: "planning", label: "制定计划", detail: "拆分任务并确定执行顺序。" },
  { id: "tool_selected", label: "选择能力", detail: "匹配模型、技能或本地工具。" },
  { id: "executing", label: "执行任务", detail: "正在调用能力并生成实际结果。" },
  { id: "validating", label: "验证结果", detail: "检查结果完整性、正确性和文件状态。" },
  { id: "completed", label: "完成交付", detail: "整理结果并返回当前会话。" }
];

function taskPhaseIndex(stateName = "") {
  const mapped = {
    idle: -1,
    intent_detected: 0,
    planning: 1,
    tool_selected: 2,
    executing: 3,
    learning: 3,
    validating: 4,
    completed: 5,
    success: 5,
    done: 5,
    failed: 5,
    cancelled: 5,
    timeout: 5
  };
  return mapped[stateName] ?? -1;
}

function taskStageStatusLabel(status = "") {
  return ({ done: "已完成", active: "执行中", queued: "待执行", failed: "失败", cancelled: "已终止", timeout: "已超时" })[status] || "待执行";
}

function collectTaskProgressStages(session = selectedSession()) {
  if (!session) return [];
  const agentState = session.agent?.state || (session.status === "running" ? "executing" : session.status || "idle");
  const phaseIndex = taskPhaseIndex(agentState);
  const terminalStatus = ["failed", "cancelled", "timeout"].includes(agentState) ? agentState : "";
  const baseStages = TASK_PHASES.map((phase, index) => ({
    ...phase,
    status: terminalStatus && index === phaseIndex ? terminalStatus
      : phaseIndex > index || agentState === "completed" || session.status === "done" ? "done"
        : phaseIndex === index ? "active" : "queued",
    kind: "phase"
  }));
  const runtimeTasks = (state.db?.queue || [])
    .filter((task) => task.sessionId === session.id)
    .slice(-16);
  const plan = Array.isArray(session.agent?.plan) ? session.agent.plan : [];
  const taskStages = (runtimeTasks.length ? runtimeTasks : plan.map((title, index) => ({
    id: `plan-${index + 1}`,
    title: typeof title === "string" ? title : title?.title || title?.name || `任务 ${index + 1}`,
    status: session.status === "done" || agentState === "completed" ? "success" : index === 0 && phaseIndex >= 3 ? "running" : "waiting"
  }))).map((task, index) => ({
    id: task.id || task.taskId || `task-${index + 1}`,
    label: task.title || task.name || task.type || `子任务 ${index + 1}`,
    detail: task.error || `计划任务 ${index + 1}${task.toolId ? ` · ${task.toolId}` : ""}`,
    status: ({ success: "done", completed: "done", running: "active", verifying: "active", failed: "failed", cancelled: "cancelled", timeout: "timeout" })[task.status] || "queued",
    kind: "task"
  }));
  return [...baseStages.slice(0, 2), ...taskStages, ...baseStages.slice(2)];
}

function taskProgressTimelineHtml(stages = []) {
  if (!stages.length) return `<div class="task-board-line">当前暂无任务阶段。</div>`;
  return `<div class="task-stage-list">${stages.map((stage, index) => `
    <div class="task-stage-row ${stage.status}${state.taskBoardFocusId === stage.id ? " focused" : ""}">
      <span class="task-stage-index">${index + 1}</span>
      <div><strong>${escapeHtml(stage.label)}</strong><small>${escapeHtml(stage.detail || "")}</small></div>
      <b>${escapeHtml(taskStageStatusLabel(stage.status))}</b>
    </div>
  `).join("")}</div>`;
}

function showTaskStagePopover(button, stage) {
  if (!taskStagePopover || !button) return;
  const chatRect = document.querySelector(".chat")?.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  if (!chatRect) return;
  const time = conversationTime(stage.createdAt);
  taskStagePopover.innerHTML = `<strong>${escapeHtml(stage.label)}</strong><span>${escapeHtml(stage.statusLabel || taskStageStatusLabel(stage.status))}</span><p>${escapeHtml(stage.detail || "")}</p>${time ? `<div class="task-stage-time" title="${escapeHtml(time.full)}"><i aria-hidden="true"></i><time datetime="${escapeHtml(time.iso)}">${escapeHtml(time.label)}</time><b>${escapeHtml(time.relative)}</b></div>` : ""}`;
  taskStagePopover.dataset.status = stage.status;
  taskStagePopover.style.top = `${Math.max(58, Math.min(chatRect.height - (time ? 160 : 132), buttonRect.top - chatRect.top - 28))}px`;
  taskStagePopover.hidden = false;
}

function hideTaskStagePopover() {
  if (taskStagePopover) taskStagePopover.hidden = true;
}

function scrollToMessageNode(messageId) {
  const row = [...messageList.querySelectorAll(".message[data-message-id]")]
    .find((element) => element.dataset.messageId === String(messageId || ""));
  if (!row) return false;
  messageList.querySelectorAll(".message.node-highlight").forEach((element) => element.classList.remove("node-highlight"));
  row.classList.add("node-highlight");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => row.classList.remove("node-highlight"), 1400);
  return true;
}

function conversationTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const label = sameDay ? `今天 ${clock}` : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  const relative = elapsedMinutes < 1 ? "刚刚" : elapsedMinutes < 60 ? `${elapsedMinutes}分钟前` : elapsedMinutes < 1440 ? `${Math.floor(elapsedMinutes / 60)}小时前` : `${Math.floor(elapsedMinutes / 1440)}天前`;
  return { label, relative, iso: date.toISOString(), full: date.toLocaleString() };
}

function collectConversationNodes() {
  return (state.currentMessages || []).slice(-100).map((message, index) => {
    const text = compactMonitorText(message.text || message.content || "", 72) || (message.attachments?.length ? "附件任务" : "对话内容");
    const role = message.role === "user" ? "user" : "assistant";
    return {
      id: `message-${message.id || index}`,
      messageId: message.id || "",
      label: role === "user" ? `任务：${text}` : `回复：${text}`,
      detail: text,
      status: "done",
      statusLabel: role === "user" ? "用户任务" : "白球回复",
      kind: "message",
      role,
      createdAt: Number(message.createdAt || 0)
    };
  });
}

function renderTaskProgressRail() {
  if (!taskProgressRail) return;
  taskProgressRail.replaceChildren();
  const conversationNodes = collectConversationNodes();
  const latestUser = [...conversationNodes].reverse().find((node) => node.role === "user")?.messageId || "";
  const latestAssistant = [...conversationNodes].reverse().find((node) => node.role === "assistant")?.messageId || latestUser;
  const stages = collectTaskProgressStages().map((stage, index) => ({
    ...stage,
    messageId: index < 2 ? latestUser : latestAssistant
  }));
  const nodes = [...conversationNodes, ...stages];
  for (const stage of nodes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-progress-item ${stage.status}${stage.kind === "task" ? " task" : ""}${stage.kind === "message" ? ` message-node ${stage.role}` : ""}`;
    button.title = `${stage.label} · ${stage.statusLabel || taskStageStatusLabel(stage.status)}`;
    button.setAttribute("aria-label", button.title);
    button.innerHTML = `<i aria-hidden="true"></i>`;
    button.addEventListener("mouseenter", () => showTaskStagePopover(button, stage));
    button.addEventListener("focus", () => showTaskStagePopover(button, stage));
    button.addEventListener("mouseleave", hideTaskStagePopover);
    button.addEventListener("blur", hideTaskStagePopover);
    button.addEventListener("click", () => {
      if (stage.messageId && scrollToMessageNode(stage.messageId)) return;
      openTaskBoard("timeline", stage.id);
    });
    taskProgressRail.appendChild(button);
  }
}

function createEmptyConversation() {
  const empty = document.createElement("div");
  empty.className = "conversation-empty";
  empty.innerHTML = `
    <img src="./assets/baiqiu-icon.png" alt="">
    <h1>今天想做什么？</h1>
    <p>你好，我是 Gantz。今天从哪件事开始？</p>
    <div class="empty-actions">
      <button type="button" data-prompt="帮我整理并分析一份表格">整理表格</button>
      <button type="button" data-prompt="帮我分析一个文件并给出结论">分析文件</button>
      <button type="button" data-prompt="帮我联网查找最新资料并整合来源">查找资料</button>
      <button type="button" data-prompt="帮我操作电脑完成一个任务">操作电脑</button>
    </div>
  `;
  empty.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      chatInput.value = button.dataset.prompt || "";
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      chatInput.focus();
    });
  });
  return empty;
}

function quoteSnapshotFromMessage(message = {}) {
  const text = String(message.text || "").trim().slice(0, 4000) || "附件消息";
  const role = message.role === "user" ? "user" : "assistant";
  return {
    sessionId: String(state.selectedSessionId || ""),
    messageId: String(message.id || ""),
    role,
    source: role === "user" ? "你" : "白球",
    text
  };
}

function scrollToQuotedMessage(messageId = "") {
  if (!messageId || !messageList) return false;
  const row = messageList.querySelector(`.message[data-message-id="${CSS.escape(String(messageId))}"]`);
  if (!row) return false;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("node-highlight");
  setTimeout(() => row.classList.remove("node-highlight"), 1600);
  return true;
}

function renderComposerQuote() {
  if (!composerQuote) return;
  const quote = state.composerQuote;
  const visible = Boolean(quote && quote.sessionId === state.selectedSessionId);
  composerQuote.hidden = !visible;
  if (!visible) return;
  composerQuoteSource.textContent = `引用 · ${quote.source || "消息"}`;
  composerQuoteText.textContent = compactMonitorText(quote.text, 140);
  composerQuoteJump.disabled = !quote.messageId;
}

function clearComposerQuote() {
  state.composerQuote = null;
  state.messageContextTarget = null;
  if (composerQuote) composerQuote.hidden = true;
  if (messageContextMenu) messageContextMenu.hidden = true;
}

function setComposerQuote(quote = null) {
  if (!quote?.text) return;
  state.composerQuote = { ...quote, sessionId: String(state.selectedSessionId || quote.sessionId || "") };
  renderComposerQuote();
  chatInput?.focus();
}

function showMessageContextMenu(event, message) {
  if (!messageContextMenu) return;
  event.preventDefault();
  event.stopPropagation();
  contextMenu.hidden = true;
  state.messageContextTarget = quoteSnapshotFromMessage(message);
  messageContextMenu.hidden = false;
  messageContextMenu.style.visibility = "hidden";
  messageContextMenu.style.left = "0px";
  messageContextMenu.style.top = "0px";
  const rect = messageContextMenu.getBoundingClientRect();
  const position = window.BaiqiuContextMenuPosition.calculatePosition({
    pointerX: event.clientX,
    pointerY: event.clientY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    menuWidth: rect.width,
    menuHeight: rect.height,
    margin: 6
  });
  messageContextMenu.style.left = `${position.left}px`;
  messageContextMenu.style.top = `${position.top}px`;
  messageContextMenu.style.visibility = "visible";
  messageQuoteBtn?.focus({ preventScroll: true });
}

function showPresetTaskContextMenu(event, session, task) {
  if (!presetTaskContextMenu || Date.now() < Number(state.queueSortSuppressUntil || 0)) return;
  event.preventDefault();
  event.stopPropagation();
  contextMenu.hidden = true;
  if (messageContextMenu) messageContextMenu.hidden = true;
  state.presetTaskContextTarget = { sessionId: session.id, taskId: task.id };
  presetTaskContextMenu.hidden = false;
  presetTaskContextMenu.style.visibility = "hidden";
  presetTaskContextMenu.style.left = "0px";
  presetTaskContextMenu.style.top = "0px";
  const rect = presetTaskContextMenu.getBoundingClientRect();
  const position = window.BaiqiuContextMenuPosition.calculatePosition({
    pointerX: event.clientX,
    pointerY: event.clientY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    menuWidth: rect.width,
    menuHeight: rect.height,
    margin: 6
  });
  presetTaskContextMenu.style.left = `${position.left}px`;
  presetTaskContextMenu.style.top = `${position.top}px`;
  presetTaskContextMenu.style.visibility = "visible";
  presetTaskEditBtn?.focus({ preventScroll: true });
}

function positionContextMenu(event) {
  contextMenu.hidden = false;
  contextMenu.style.visibility = "hidden";
  contextMenu.style.left = "0px";
  contextMenu.style.top = "0px";
  const rect = contextMenu.getBoundingClientRect();
  const position = window.BaiqiuContextMenuPosition.calculatePosition({
    pointerX: event.clientX,
    pointerY: event.clientY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    menuWidth: rect.width,
    menuHeight: rect.height,
    margin: 8
  });
  contextMenu.style.left = `${position.left}px`;
  contextMenu.style.top = `${position.top}px`;
  contextMenu.style.visibility = "visible";
  contextMenu.dataset.opensUp = String(position.opensUp);
  contextMenu.dataset.opensLeft = String(position.opensLeft);
}

function showSessionMenu(event, session) {
  event.preventDefault();
  contextMenu.dataset.kind = "session";
  contextMenu.dataset.id = session.id;
  if (session.type === "CEO") {
    contextMenu.innerHTML = `
      <button data-action="new-session">新建会话</button>
      <button data-action="view-agent-task">查看任务</button>
      <button data-action="edit-agent">编辑岗位</button>
      <button data-action="save-conscious">提取意识</button>
    `;
  } else if (session.type === "Agent") {
    contextMenu.innerHTML = `
      <button data-action="new-session">新建会话</button>
      <button data-action="view-agent-task">查看任务</button>
      <button data-action="edit-agent">编辑岗位</button>
      <button data-action="save-conscious">提取意识</button>
      <button data-action="export-chat">导出对话</button>
      <button data-action="delete">删除岗位</button>
    `;
  } else {
    contextMenu.innerHTML = `
      <button data-action="save-conscious">提取意识</button>
      <button data-action="export-chat">导出对话</button>
      <button data-action="favorite">${session.pinned ? "取消收藏" : "收藏会话"}</button>
      <button data-action="delete">删除会话</button>
    `;
  }
  positionContextMenu(event);
}

function showProjectMenu(event, project) {
  event.preventDefault();
  event.stopPropagation();
  contextMenu.dataset.kind = "project";
  contextMenu.dataset.id = project.id;
  contextMenu.innerHTML = `
    <button data-action="conscious-backup">提取意识</button>
    <button data-action="edit-project">编辑项目</button>
    <button data-action="lock-project">${project.locked ? "解除锁定" : "锁定项目"}</button>
    <button data-action="delete-project">删除项目</button>
  `;
  positionContextMenu(event);
}

async function handleProjectAction(action, projectId) {
  const project = state.db.projects.find((item) => item.id === projectId);
  if (!project) return;
  if (action === "conscious-backup") {
    state.consciousBackupProgress.set(projectId, 1);
    const extraction = await runBlackCoreExtraction("project", projectId, project.name || "项目意识");
    if (!extraction?.ok) {
      state.consciousBackupProgress.delete(projectId);
      return;
    }
    state.db = await api.init();
    if (Number(state.consciousBackupProgress.get(projectId) || 0) < 100) {
      state.consciousBackupProgress.set(projectId, 100);
      state.consciousBackupCompleted.add(projectId);
      scheduleConsciousBackupSettlement(projectId);
    }
  }
  if (action === "edit-project") await openProjectDialog(project);
  if (action === "lock-project") state.db = await api.updateProject(project.id, { locked: !project.locked });
  if (action === "delete-project") await confirmDeleteProject(project);
  await renderAll();
}

async function handleSessionAction(action, sessionId) {
  const session = state.db.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (action === "new-session") {
    const created = await api.createSession();
    state.db = await api.init();
    state.selectedSessionId = created.id;
    await renderAll();
    return;
  }
  if (action === "save-conscious") {
    state.consciousBackupProgress.set(sessionId, 1);
    const extraction = await runBlackCoreExtraction("session", sessionId, projectSessionDisplayName(session));
    if (!extraction?.ok) {
      state.consciousBackupProgress.delete(sessionId);
      return;
    }
    state.db = await api.init();
    if (Number(state.consciousBackupProgress.get(sessionId) || 0) < 100) {
      state.consciousBackupProgress.set(sessionId, 100);
      state.consciousBackupCompleted.add(sessionId);
      scheduleConsciousBackupSettlement(sessionId);
    }
  }
  if (action === "favorite") state.db = await api.favoriteSession(sessionId, !session.pinned);
  if (action === "export-chat") {
    await exportSessionChat(session);
    return;
  }
  if (action === "rename") {
    const title = await askSessionTitle(projectSessionDisplayName(session));
    if (title) state.db = await api.renameSession(sessionId, title);
  }
  if (action === "edit-agent") {
    await editAgentRole(session);
    return;
  }
  if (action === "view-agent-task") {
    await selectSessionById(session.sessionId || session.id);
    openTaskBoard("timeline");
    return;
  }
  if (action === "delete") {
    const protection = await api.consciousProtection?.("session", sessionId).catch(() => null);
    let confirmed = false;
    if (protection) {
      const choice = await showProtectedDeleteDialog(session.title || "新会话");
      if (choice === "archive") await api.archiveConsciousSnapshot(protection.id, true);
      confirmed = choice === "archive" || choice === "delete";
    } else {
      confirmed = await showAppConfirm({
        title: "删除会话",
        message: `删除会话「${session.title || "新会话"}」？此操作不可恢复。`,
        primary: "删除",
        secondary: "取消"
      });
    }
    if (confirmed) state.db = await api.deleteSession(sessionId);
  }
  state.selectedSessionId = state.db.selectedSessionId || state.db.sessions[0]?.id;
  await renderAll();
}

async function exportSessionChat(session) {
  if (!session) return;
  try {
    const messages = await window.heiqiu?.memoryHistory?.(session.id, 9999);
    if (!messages || !messages.length) {
      showCopyToast('该会话暂无可导出的消息', 2000);
      return;
    }
    const title = session.title || '未命名会话';
    const now = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    // 格式化为 Markdown
    let md = `# ${title}\n\n> 导出时间: ${new Date().toLocaleString('zh-CN')}\n> 消息数: ${messages.length}\n\n---\n\n`;
    for (const msg of messages) {
      const role = msg.role === 'user' ? '👤 用户' : msg.role === 'assistant' ? '🤖 AI' : `📌 ${msg.role}`;
      const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString('zh-CN') : '';
      const content = (msg.content || msg.text || '').trim();
      md += `## ${role}${time ? ' · ' + time : ''}\n\n${content}\n\n---\n\n`;
    }
    // 通过 IPC 保存文件
    const filePath = await window.heiqiu?.exportToFile?.(title + '_' + now + '.md', md);
    if (filePath) showCopyToast('对话已导出', 2000);
  } catch (e) {
    showCopyToast('导出失败: ' + (e.message || '未知错误'), 3000);
  }
}

function askSessionTitle(currentTitle) {
  return new Promise((resolve) => {
    if (!renameDialog || !renameInput) {
      resolve("");
      return;
    }
    renameInput.value = currentTitle || "";
    renameDialog.returnValue = "";
    const cleanup = () => {
      renameDialog.removeEventListener("close", onClose);
      renameSaveBtn?.removeEventListener("click", onSave);
    };
    const onClose = () => {
      cleanup();
      resolve(renameDialog.returnValue === "save" ? renameInput.value.trim() : "");
    };
    const onSave = (event) => {
      event.preventDefault();
      renameDialog.returnValue = "save";
      renameDialog.close("save");
    };
    renameDialog.addEventListener("close", onClose);
    renameSaveBtn?.addEventListener("click", onSave);
    renameDialog.showModal();
    setTimeout(() => {
      renameInput.focus();
      renameInput.select();
    }, 30);
  });
}

function shouldUseProgressiveTextChunks(text = "", codeBlocks = []) {
  const value = String(text || "").trim();
  if (value.length < 80) return false;
  if (codeBlocks.length) return false;
  if (/```|^\s{0,3}#{1,6}\s|^\s{0,3}(?:[-*+]|\d+[.)])\s|\|.*\||!\[|\[[^\]]+\]\(/m.test(value)) return false;
  return true;
}

function progressiveTextChunksHtml(text = "") {
  const chars = Array.from(String(text || ""));
  const chunks = [];
  let buffer = "";
  for (const char of chars) {
    buffer += char;
    if (/[。！？!?；;，,、\n]/.test(char) || buffer.length >= 18) {
      chunks.push(buffer);
      buffer = "";
    }
  }
  if (buffer) chunks.push(buffer);
  return `<p class="progressive-text-chunks">${chunks.map((chunk, index) => {
    const safe = escapeHtml(chunk).replace(/\n/g, "<br>");
    return `<span style="--reveal-index:${Math.min(index, 80)}">${safe}</span>`;
  }).join("")}</p>`;
}

function activeAssistantTypingForSession(sessionId) {
  const key = String(sessionId || "");
  if (!key) return null;
  const entry = activeAssistantTypings.get(key);
  if (!entry) return null;
  if (entry.row?.isConnected && entry.rendered?.isConnected) return entry;
  activeAssistantTypings.delete(key);
  entry.cancel?.();
  return null;
}

function cancelAssistantTyping(sessionId) {
  const key = String(sessionId || "");
  const entry = activeAssistantTypings.get(key);
  if (!entry) return;
  activeAssistantTypings.delete(key);
  entry.cancel?.();
}

function cancelAssistantTypingsExcept(sessionId) {
  const activeKey = String(sessionId || "");
  for (const [key, entry] of activeAssistantTypings) {
    if (key === activeKey) continue;
    activeAssistantTypings.delete(key);
    entry.cancel?.();
  }
}

function completeAssistantTyping(sessionId, entry) {
  const key = String(sessionId || "");
  if (!key || activeAssistantTypings.get(key) !== entry) return;
  activeAssistantTypings.delete(key);
  if (state.selectedSessionId !== sessionId) return;
  // The persisted session update was deliberately held back while the text was playing.
  state.lastMessageSignature = "";
  requestAnimationFrame(() => {
    if (state.selectedSessionId !== sessionId) return;
    renderAll({ refreshSettings: false, refreshSecondary: false })
      .catch((error) => console.error("[TypingRender]", error));
  });
}

function startAssistantTyping(rendered, text, { codeBlocks = [], onComplete = null, onProgress = null } = {}) {
  if (!rendered) return;
  const source = String(text || "");
  const chars = Array.from(source);
  let index = 0;
  let timer = null;
  let completed = false;
  const cancel = () => {
    if (completed) return;
    completed = true;
    if (timer) clearTimeout(timer);
    rendered._typingCancel = null;
    rendered.classList.remove("typing-response");
  };
  const finish = () => {
    if (completed) return;
    completed = true;
    if (timer) clearTimeout(timer);
    rendered._typingCancel = null;
    rendered.classList.remove("typing-response");
    rendered.innerHTML = renderMarkdown(source);
    bindRenderedLinks(rendered);
    enhanceHiddenCodeBlocks(rendered, codeBlocks);
    onComplete?.();
  };
  const paint = () => {
    if (completed) return;
    if (!rendered.isConnected) {
      timer = setTimeout(paint, 30);
      return;
    }
    if (index >= chars.length) {
      finish();
      return;
    }
    index = Math.min(chars.length, index + 1);
    rendered.textContent = chars.slice(0, index).join("");
    onProgress?.({ current: index, total: chars.length });
    const lastChar = chars[index - 1] || "";
    const punctuationPause = /[。！？!?\n]/.test(lastChar) ? 54 : /[，,、；;]/.test(lastChar) ? 20 : 0;
    timer = setTimeout(paint, ASSISTANT_TYPING_INTERVAL_MS + punctuationPause);
  };
  rendered.classList.add("typing-response");
  rendered.textContent = "";
  rendered._typingCancel = cancel;
  paint();
  return { cancel, finish };
}

function addMessage(message, target = messageList, options = {}) {
  const row = document.createElement("div");
  row.className = `message ${message.role}${options.animate === false ? "" : " entering"}`;
  row.dataset.contentReady = options.contentReady === false ? "0" : "1";
  const messageStatus = String(message.raw?.productResult?.status || message.raw?.status || message.status || "").trim();
  if (messageStatus) row.dataset.messageStatus = messageStatus;
  if (message.id) row.dataset.messageId = String(message.id);
  row.addEventListener("contextmenu", (event) => showMessageContextMenu(event, message));
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const rendered = document.createElement("div");
  rendered.className = "rendered";
  const durationMs = messageDurationMs(message, options);
  if (message.role === "assistant" && durationMs > 0) {
    const meta = document.createElement("div");
    meta.className = "response-meta";
    meta.textContent = `用时 ${formatTaskDuration(durationMs)}`;
    bubble.appendChild(meta);
  }
  const sourceText = String(message.text || "");
  const codeBlocks = message.role === "assistant"
    ? (Array.isArray(message.raw?.hiddenCodeBlocks) && message.raw.hiddenCodeBlocks.length ? message.raw.hiddenCodeBlocks : extractClientCodeBlocks(sourceText))
    : [];
  const hasClarification = message.role === "assistant" && clarificationOptionsFromMessage(message);
  const filteredText = message.role === "assistant" ? filterAssistantExecutionOutput(sourceText) : sourceText;
  const displayText = (message.role === "assistant" && hasClarification) ? stripClarificationOptionLines(filteredText) : filteredText;
  const useTypingAnimation = options.progressive && message.role === "assistant" && Boolean(displayText);
  if (!useTypingAnimation) {
    rendered.innerHTML = renderMarkdown(displayText);
    bindRenderedLinks(rendered);
    enhanceHiddenCodeBlocks(rendered, codeBlocks);
  }
  const referencedQuote = message.raw?.quote && typeof message.raw.quote === "object" ? message.raw.quote : null;
  if (referencedQuote?.text) {
    const reference = document.createElement("button");
    reference.type = "button";
    reference.className = "message-quote-reference";
    reference.innerHTML = `<span>引用 · ${escapeHtml(referencedQuote.source || "消息")}</span><strong>${escapeHtml(compactMonitorText(referencedQuote.text, 140))}</strong>`;
    reference.disabled = !referencedQuote.messageId;
    reference.addEventListener("click", () => scrollToQuotedMessage(referencedQuote.messageId));
    bubble.appendChild(reference);
  }
  bubble.appendChild(rendered);
  const employeeResults = message.role === "assistant" ? createProjectEmployeeResults(message) : null;
  if (employeeResults) bubble.appendChild(employeeResults);
  for (const image of message.images || []) {
    const imageItem = image && typeof image === "object"
      ? image
      : { id: `${message.id || Date.now()}-img`, name: "会话图片", mimeType: "image/png", dataUrl: image };
    const img = document.createElement("img");
    img.className = "message-image";
    img.alt = imageItem.name || "会话图片";
    img.title = "点击在任务看板中查看图片";
    const inlineSource = imageItem.dataUrl || imageItem.url || "";
    if (inlineSource) img.src = inlineSource;
    img.addEventListener("click", () => openAttachmentInBoard(imageItem));
    bubble.appendChild(img);
    const imageActions = document.createElement("div");
    imageActions.className = "message-file-actions message-image-actions";
    const imageOpenBtn = document.createElement("button");
    imageOpenBtn.type = "button";
    imageOpenBtn.textContent = "打开图片";
    imageOpenBtn.addEventListener("click", () => openAttachmentExternally(imageItem).catch(() => showCopyToast("当前图片无法打开")));
    const imageFolderBtn = document.createElement("button");
    imageFolderBtn.type = "button";
    imageFolderBtn.textContent = "所在位置";
    imageFolderBtn.addEventListener("click", () => showAttachmentInFolder(imageItem));
    const imageBoardBtn = document.createElement("button");
    imageBoardBtn.type = "button";
    imageBoardBtn.textContent = "在看板查看";
    imageBoardBtn.addEventListener("click", () => openAttachmentInBoard(imageItem));
    imageActions.append(imageOpenBtn, imageFolderBtn, imageBoardBtn);
    bubble.appendChild(imageActions);
    if (!inlineSource && typeof api.previewAttachment === "function") {
      api.previewAttachment(imageItem).then((preview) => {
        if (preview?.ok && preview.kind === "image" && preview.dataUrl && img.isConnected) img.src = preview.dataUrl;
      }).catch(() => null);
    }
  }
  const messageFiles = generatedFilesFromMessage(message);
  if (messageFiles.length) {
    const files = document.createElement("div");
    files.className = "message-files";
    for (const item of messageFiles) {
      const file = document.createElement("div");
      file.className = "message-file-card";
      file.innerHTML = `
        <strong>▣ ${escapeHtml(item.name || "附件")}</strong>
        <small>${escapeHtml(item.mimeType || "未知类型")}${item.sizeBytes ? ` · ${formatTaskBoardBytes(item.sizeBytes)}` : ""}</small>
      `;
      const actions = document.createElement("div");
      actions.className = "message-file-actions";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "打开";
      openBtn.addEventListener("click", async () => {
        await openAttachmentExternally(item).catch(() => showCopyToast("当前附件暂无可外部打开路径"));
      });
      const boardBtn = document.createElement("button");
      boardBtn.type = "button";
      boardBtn.textContent = "在看板查看";
      boardBtn.addEventListener("click", () => {
        openAttachmentInBoard(item);
      });
      const folderBtn = document.createElement("button");
      folderBtn.type = "button";
      folderBtn.textContent = "所在位置";
      folderBtn.addEventListener("click", () => showAttachmentInFolder(item));
      actions.append(openBtn, folderBtn, boardBtn);
      file.appendChild(actions);
      files.appendChild(file);
    }
    bubble.appendChild(files);
  }
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.className = "copy";
  copy.type = "button";
  copy.innerHTML = `<span aria-hidden="true">⧉</span><span>复制</span>`;
  copy.title = "复制";
  copy.addEventListener("click", async () => {
    await api.copyText(filteredText || rendered.textContent || "");
    markCopySuccess(copy);
  });
  actions.appendChild(copy);
  if (message.role === "assistant") bubble.appendChild(actions);
  row.appendChild(bubble);
  target.appendChild(row);
  if (useTypingAnimation) {
    const typingSessionId = target === messageList ? String(options.typingSessionId || state.selectedSessionId || "") : "";
    const typingEntry = typingSessionId ? { row, rendered, cancel: null } : null;
    if (typingEntry) {
      cancelAssistantTyping(typingSessionId);
      activeAssistantTypings.set(typingSessionId, typingEntry);
    }
    const typingController = startAssistantTyping(rendered, displayText, {
      codeBlocks,
      onProgress: () => {
        if (target === messageList && state.followOutput) scheduleStreamingScroll();
      },
      onComplete: () => {
        if (typingEntry) completeAssistantTyping(typingSessionId, typingEntry);
        evaluateLongReply(row, rendered, displayText, options);
      }
    });
    if (typingEntry) typingEntry.cancel = typingController?.cancel || null;
  }
  renderComposerClarification(message);
  requestAnimationFrame(() => {
    row.classList.remove("entering");
    if (target !== messageList) return;
    if (message.role === "assistant" && !useTypingAnimation) evaluateLongReply(row, rendered, displayText, options);
    if (options.anchorStart && state.followOutput) {
      scrollMessageToStart(row, "auto", { keepFollowing: useTypingAnimation });
    }
    else if (options.follow !== false && state.followOutput) scrollMessagesToBottom();
    else if (options.follow !== false) setNewOutputAvailable(true);
  });
  return row;
}

function createThinkingMessage(label = "正在理解任务", options = {}) {
  const row = document.createElement("div");
  row.className = "message assistant thinking-message";
  row.innerHTML = `
    <div class="bubble">
      <div class="thinking-status">
        <span class="thinking-bars" aria-hidden="true"><i></i><i></i><i></i></span>
        <strong class="thinking-label">${escapeHtml(label)}</strong>
        <span class="thinking-elapsed">0 秒</span>
      </div>
    </div>
  `;
  messageList.appendChild(row);
  const startedAt = Number(options.startedAt || Date.now());
  const paintElapsed = () => {
    const elapsed = row.querySelector(".thinking-elapsed");
    if (elapsed) elapsed.textContent = formatTaskDuration(Date.now() - startedAt);
  };
  paintElapsed();
  thinkingTimers.set(row, setInterval(paintElapsed, 1000));
  if (options.follow !== false) scrollMessagesToBottom();
  return row;
}

function removeThinkingMessage(row) {
  if (!row) return;
  clearInterval(thinkingTimers.get(row));
  thinkingTimers.delete(row);
  row.remove();
}

function createChatStreamId(sessionId = "") {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `chat-${String(sessionId || "session").slice(0, 48)}-${id}`;
}

function registerLiveChatStream(streamId, sessionId, thinkingRow, options = {}) {
  removeSessionExecutionIndicator(sessionId);
  const entry = {
    streamId,
    sessionId,
    thinkingRow,
    row: null,
    rendered: null,
    activity: null,
    activityLabel: "正在输出",
    startedAt: Number(options.startedAt || Date.now()),
    text: "",
    resetPending: false,
    paintTimer: null,
    paintFrame: null,
    elapsedTimer: null,
    lastPaintAt: 0
  };
  liveChatStreams.set(streamId, entry);
  updateLiveStreamElapsed(entry);
  entry.elapsedTimer = setInterval(() => updateLiveStreamElapsed(entry), 1000);
  return entry;
}

function streamActivityHtml(label = "正在输出", elapsedMs = 0) {
  return `
    <div class="streaming-activity" role="status" aria-live="polite">
      <span class="thinking-bars" aria-hidden="true"><i></i><i></i><i></i></span>
      <strong class="streaming-activity-label">${escapeHtml(label)}</strong>
      <span class="streaming-elapsed">${escapeHtml(formatTaskDuration(elapsedMs))}</span>
    </div>
  `;
}

function updateLiveStreamElapsed(entry) {
  if (!entry) return;
  const elapsed = formatTaskDuration(Date.now() - entry.startedAt);
  const labels = [
    entry.activity?.querySelector?.(".streaming-elapsed"),
    entry.row?.querySelector?.(".streaming-elapsed")
  ].filter(Boolean);
  labels.forEach((node) => { node.textContent = elapsed; });
  const thinkingElapsed = entry.thinkingRow?.querySelector?.(".thinking-elapsed");
  if (thinkingElapsed) thinkingElapsed.textContent = elapsed;
}

function setLiveStreamActivity(entry, label = "正在输出") {
  if (!entry) return;
  entry.activityLabel = String(label || "正在输出");
  const thinkingLabel = entry.thinkingRow?.querySelector?.(".thinking-label");
  if (thinkingLabel) thinkingLabel.textContent = entry.activityLabel;
  const streamLabel = entry.activity?.querySelector?.(".streaming-activity-label")
    || entry.row?.querySelector?.(".streaming-activity-label");
  if (streamLabel) streamLabel.textContent = entry.activityLabel;
}

function ensureLiveStreamRow(entry) {
  if (!entry || entry.sessionId !== state.selectedSessionId || !messageList) return null;
  if (entry.row?.isConnected) return entry.row;
  removeThinkingMessage(entry.thinkingRow);
  const row = document.createElement("div");
  row.className = "message assistant streaming-response";
  row.dataset.streamId = entry.streamId;
  row.dataset.contentReady = "0";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const rendered = document.createElement("div");
  rendered.className = "rendered streaming-rendered";
  const activity = document.createElement("div");
  activity.innerHTML = streamActivityHtml(entry.activityLabel || "正在输出", Date.now() - entry.startedAt).trim();
  bubble.append(rendered, activity.firstElementChild);
  row.appendChild(bubble);
  messageList.appendChild(row);
  entry.row = row;
  entry.rendered = rendered;
  entry.activity = bubble.querySelector(".streaming-activity");
  return row;
}

function flushLiveChatStream(entry) {
  if (!entry) return;
  entry.paintFrame = null;
  entry.lastPaintAt = performance.now();
  const row = ensureLiveStreamRow(entry);
  if (!row || !entry.rendered || !entry.text) return;
  const visibleText = filterAssistantExecutionOutput(blackBallBrandText(entry.text));
  entry.rendered.innerHTML = renderMarkdown(visibleText);
  bindRenderedLinks(entry.rendered);
  scheduleStreamingScroll();
}

function scheduleLiveChatStreamPaint(entry, immediate = false) {
  if (!entry || entry.paintTimer || entry.paintFrame) return;
  const elapsed = performance.now() - entry.lastPaintAt;
  const delay = immediate ? 0 : Math.max(0, 40 - elapsed);
  entry.paintTimer = setTimeout(() => {
    entry.paintTimer = null;
    entry.paintFrame = requestAnimationFrame(() => flushLiveChatStream(entry));
  }, delay);
}

function handleChatStreamFrame(frame = {}) {
  const entry = liveChatStreams.get(String(frame.streamId || ""));
  if (!entry || entry.sessionId !== String(frame.sessionId || "")) return;
  if (frame.type === "start") {
    if (entry.text) entry.resetPending = true;
    setLiveStreamActivity(entry, "正在输出");
    return;
  }
  if (frame.type === "phase") {
    setLiveStreamActivity(entry, frame.label || "正在执行");
    return;
  }
  if (frame.type !== "delta") return;
  const delta = String(frame.delta || "");
  if (!delta) return;
  if (entry.resetPending) {
    entry.text = delta;
    entry.resetPending = false;
  } else {
    entry.text += delta;
  }
  scheduleLiveChatStreamPaint(entry);
}

function removeSessionExecutionIndicator(sessionId) {
  const key = String(sessionId || "");
  const row = sessionExecutionIndicators.get(key);
  if (row) removeThinkingMessage(row);
  sessionExecutionIndicators.delete(key);
}

function restoreLiveChatStream(entry) {
  if (!entry || entry.sessionId !== state.selectedSessionId) return false;
  if (entry.text) {
    if (!entry.row?.isConnected) {
      entry.row = null;
      entry.rendered = null;
      entry.activity = null;
    }
    const row = ensureLiveStreamRow(entry);
    if (row) flushLiveChatStream(entry);
    return Boolean(row);
  }
  if (!entry.thinkingRow?.isConnected) {
    removeThinkingMessage(entry.thinkingRow);
    entry.thinkingRow = createThinkingMessage(entry.activityLabel || "正在执行任务", {
      startedAt: entry.startedAt,
      follow: state.followOutput
    });
  }
  setLiveStreamActivity(entry, entry.activityLabel || "正在执行任务");
  updateLiveStreamElapsed(entry);
  return true;
}

function ensureSessionExecutionMotion(session) {
  if (!session?.id) return;
  if (!sessionIsRunning(session)) {
    discardLiveChatStreamsForSession(session.id);
    removeSessionExecutionIndicator(session.id);
    return;
  }
  const activeStream = [...liveChatStreams.values()].reverse().find((entry) => entry.sessionId === session.id);
  if (activeStream) {
    removeSessionExecutionIndicator(session.id);
    restoreLiveChatStream(activeStream);
    return;
  }
  removeSessionExecutionIndicator(session.id);
}

function finalizeLiveChatStream(streamId, message, options = {}) {
  const entry = liveChatStreams.get(streamId);
  if (!entry) return null;
  if (entry.paintTimer) clearTimeout(entry.paintTimer);
  if (entry.paintFrame) cancelAnimationFrame(entry.paintFrame);
  if (entry.elapsedTimer) clearInterval(entry.elapsedTimer);
  entry.paintTimer = null;
  entry.paintFrame = null;
  entry.elapsedTimer = null;
  if (!entry.text) {
    liveChatStreams.delete(streamId);
    return null;
  }
  const row = ensureLiveStreamRow(entry);
  if (!row?.isConnected || !entry.rendered) {
    liveChatStreams.delete(streamId);
    return null;
  }
  const followAtFinalize = state.followOutput;
  const previousScrollTop = messageList?.scrollTop || 0;
  const stage = document.createDocumentFragment();
  const completedRow = addMessage(message, stage, {
    ...options,
    animate: false,
    keepExpanded: true,
    progressive: message.role === "assistant",
    follow: false,
    anchorStart: false
  });
  entry.row.className = completedRow.className.replace(/\s*entering\b/g, "").trim();
  entry.row.dataset.contentReady = "1";
  if (completedRow.dataset.messageStatus) entry.row.dataset.messageStatus = completedRow.dataset.messageStatus;
  entry.row.removeAttribute("data-stream-id");
  entry.row.replaceChildren(...completedRow.childNodes);
  const rendered = entry.row.querySelector(":scope > .bubble > .rendered");
  evaluateLongReply(entry.row, rendered, String(message.text || ""), { keepExpanded: true });
  liveChatStreams.delete(streamId);
  if (followAtFinalize) scheduleStreamingScroll();
  else if (messageList) messageList.scrollTop = previousScrollTop;
  return entry.row;
}

function discardLiveChatStreamsForSession(sessionId) {
  for (const [streamId, entry] of liveChatStreams) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.paintTimer) clearTimeout(entry.paintTimer);
    if (entry.paintFrame) cancelAnimationFrame(entry.paintFrame);
    if (entry.elapsedTimer) clearInterval(entry.elapsedTimer);
    removeThinkingMessage(entry.thinkingRow);
    entry.row?.remove();
    liveChatStreams.delete(streamId);
  }
  removeSessionExecutionIndicator(sessionId);
}

function discardLiveChatStream(streamId) {
  const entry = liveChatStreams.get(streamId);
  if (!entry) return;
    if (entry.paintTimer) clearTimeout(entry.paintTimer);
    if (entry.paintFrame) cancelAnimationFrame(entry.paintFrame);
    if (entry.elapsedTimer) clearInterval(entry.elapsedTimer);
  removeThinkingMessage(entry.thinkingRow);
  entry.row?.remove();
  liveChatStreams.delete(streamId);
  removeSessionExecutionIndicator(entry.sessionId);
}

function formatTaskDuration(durationMs) {
  const milliseconds = Math.max(0, Number(durationMs || 0));
  const totalSeconds = milliseconds > 0 ? Math.ceil(milliseconds / 1000) : 0;
  if (totalSeconds < 60) return `${totalSeconds}S`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}M ${seconds}S` : `${minutes}M`;
}

function messageDurationMs(message = {}, options = {}) {
  const raw = message?.raw && typeof message.raw === "object" ? message.raw : {};
  const productResult = raw.productResult && typeof raw.productResult === "object" ? raw.productResult : {};
  const productRaw = productResult.raw && typeof productResult.raw === "object" ? productResult.raw : {};
  const nestedRaw = raw.raw && typeof raw.raw === "object" ? raw.raw : {};
  const elapsed = (startedAt, finishedAt) => {
    const started = Date.parse(String(startedAt || ""));
    const finished = Date.parse(String(finishedAt || ""));
    return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
      ? finished - started
      : 0;
  };
  return Math.max(
    0,
    ...[
      options.durationMs,
      raw.durationMs,
      productResult.durationMs,
      productRaw.durationMs,
      nestedRaw.durationMs,
      elapsed(raw.startedAt, raw.finishedAt),
      elapsed(productResult.startedAt, productResult.finishedAt),
      elapsed(productRaw.startedAt, productRaw.finishedAt)
    ].map((value) => Number(value) || 0)
  );
}

function buildPersistedAttachments(attachments = []) {
  return attachments.map((item) => ({
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    dataUrl: item.dataUrl,
    textContent: item.textContent,
    path: item.path || item.originalPath || item.filePath || "",
    url: item.url || ""
  }));
}

const GENERATED_FILE_PATH_KEYS = new Set([
  "path", "sourcePath", "originalPath", "filePath", "outputPath", "savedPath",
  "targetPath", "downloadPath", "artifactPath", "file", "outputFile", "savedFile"
]);

function generatedFileMimeType(name = "") {
  const extension = String(name).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return ({
    txt: "text/plain", md: "text/markdown", html: "text/html", htm: "text/html",
    csv: "text/csv", json: "application/json", pdf: "application/pdf",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp"
  })[extension] || "application/octet-stream";
}

function generatedFileDescriptor(value, key = "") {
  if (typeof value === "string") {
    if (!GENERATED_FILE_PATH_KEYS.has(key) || !value.trim()) return null;
    const pathValue = value.trim();
    if (!/\.[a-z0-9]{1,10}$/i.test(pathValue)) return null;
    const name = pathValue.split(/[\\/]/).pop() || "生成文件";
    return { name, mimeType: generatedFileMimeType(name), path: pathValue };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pathValue = [...GENERATED_FILE_PATH_KEYS]
    .map((field) => value[field])
    .find((item) => typeof item === "string" && item.trim()) || "";
  const url = typeof value.url === "string" && value.url.trim() ? value.url.trim() : "";
  const dataUrl = typeof value.dataUrl === "string" && value.dataUrl.trim() ? value.dataUrl : "";
  const declaredName = String(value.name || value.filename || value.fileName || value.title || "").trim();
  const inferredName = pathValue.split(/[\\/]/).pop() || "";
  const type = String(value.type || value.kind || "");
  const fileLike = /(?:^|[_-])(file|artifact|image|document|spreadsheet)(?:$|[_-])/i.test(type)
    || /\.[a-z0-9]{1,10}(?:$|[?#])/i.test(declaredName || inferredName || url);
  if ((!pathValue && !dataUrl && !url) || (!pathValue && !dataUrl && !fileLike)) return null;
  if (pathValue && !fileLike && !/\.[a-z0-9]{1,10}$/i.test(pathValue)) return null;
  const name = declaredName || inferredName || "生成文件";
  return {
    id: value.id,
    name,
    mimeType: value.mimeType || generatedFileMimeType(name),
    sizeBytes: value.sizeBytes || value.size || 0,
    path: pathValue,
    url,
    dataUrl,
    textContent: value.textContent || ""
  };
}

function generatedFilesFromMessage(message = {}) {
  const files = Array.isArray(message.attachments) ? [...message.attachments] : [];
  const raw = message.raw && typeof message.raw === "object" ? message.raw : null;
  const seenObjects = new Set();
  const visit = (value, key = "", depth = 0) => {
    if (!value || depth > 7) return;
    const descriptor = generatedFileDescriptor(value, key);
    if (descriptor) files.push(descriptor);
    if (typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key, depth + 1));
      return;
    }
    Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey, depth + 1));
  };
  visit(raw);
  const unique = new Map();
  files.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const pathValue = item.path || item.sourcePath || item.originalPath || item.filePath
      || item.outputPath || item.savedPath || item.url || item.dataUrl || "";
    const identity = `${pathValue}|${item.name || ""}`;
    if (!identity || unique.has(identity)) return;
    unique.set(identity, item);
  });
  return [...unique.values()];
}

function productResultText(result = {}) {
  const candidates = [
    result.text,
    result.result?.text,
    result.result?.normalized?.error,
    result.result?.response?.error
  ];
  const text = candidates.find((value) => typeof value === "string" && value.trim());
  return text?.trim() || (result.success ? "任务完成。" : "");
}

function isTaskBrainConfirmation(result = {}) {
  return result?.status === "pending_confirmation" || result?.confirmationRequired === true;
}

function showConfirmCard(request) {
  if (!request?.id || pendingConfirmations[request.id]) return;
  pendingConfirmations[request.id] = request;

  const card = document.createElement("div");
  card.className = "message assistant confirm-card";
  card.dataset.confirmId = request.id;

  let paramsDisplay = "";
  try {
    paramsDisplay = JSON.stringify(request.params || {}, null, 2);
  } catch {
    paramsDisplay = String(request.params || "");
  }

  const scopeName = ({ file: "文件", system: "系统", tool: "工具", network: "网络" })[request.scope] || "工具";
  const title = `小白要执行${scopeName}操作，可以吗？`;
  card.innerHTML = `
    <div class="bubble">
      <div class="confirm-title">
        <span aria-hidden="true">!</span>
        <strong>${escapeHtml(title)}</strong>
      </div>
      <div class="confirm-subtitle">${escapeHtml(request.toolName || request.toolId || "工具")} · ${escapeHtml(scopeName)}权限</div>
      <div class="confirm-params">${escapeHtml(paramsDisplay)}</div>
      <label class="confirm-mode">
        <span>权限记忆</span>
        <select class="confirm-mode-select">
          <option value="allow_once">一次允许</option>
          <option value="allow_always">始终允许（完全访问）</option>
          <option value="ask">每次询问</option>
          <option value="deny">拒绝</option>
        </select>
      </label>
      <div class="confirm-actions">
        <button class="confirm-yes" data-id="${escapeHtml(request.id)}" type="button">确认执行</button>
        <button class="confirm-no" data-id="${escapeHtml(request.id)}" type="button">取消</button>
      </div>
    </div>
  `;

  messageList.appendChild(card);
  messageList.scrollTop = messageList.scrollHeight;

  card.querySelector(".confirm-yes")?.addEventListener("click", () => {
    const mode = card.querySelector(".confirm-mode-select")?.value || "allow_once";
    api.confirmTool(request.id, mode !== "deny", mode);
    delete pendingConfirmations[request.id];
    card.remove();
  });
  card.querySelector(".confirm-no")?.addEventListener("click", () => {
    const mode = card.querySelector(".confirm-mode-select")?.value || "ask";
    api.confirmTool(request.id, false, mode === "deny" ? "deny" : "ask");
    delete pendingConfirmations[request.id];
    card.remove();
  });
}

function parsePersonaCommand(text) {
  const raw = String(text || "").trim();
  if (!/(设定|设置|修改|更改|改成|改为)/.test(raw)) return null;
  const boundary = String.raw`(?=\s*(?:，|。|；|;|\n|名字|名称|称呼|性格|人格|语气|说话方式|能力|技能|擅长|备注|主人备注|背景|偏好)\s*(?:为|成|是|:|：)?|$)`;
  const fields = [
    ["name", new RegExp(String.raw`(?:名字|名称|称呼)\s*(?:为|成|是|:|：)\s*([\s\S]+?)${boundary}`)],
    ["personality", new RegExp(String.raw`(?:性格|人格|语气|说话方式)\s*(?:为|成|是|:|：)\s*([\s\S]+?)${boundary}`)],
    ["abilities", new RegExp(String.raw`(?:能力|技能|擅长)\s*(?:为|成|是|:|：)\s*([\s\S]+?)${boundary}`)],
    ["notes", new RegExp(String.raw`(?:备注|主人备注|背景|偏好)\s*(?:为|成|是|:|：)\s*([\s\S]+?)${boundary}`)]
  ];
  const patch = {};
  for (const [key, pattern] of fields) {
    const match = raw.match(pattern);
    if (match?.[1]) patch[key] = match[1].trim();
  }
  return Object.keys(patch).length ? patch : null;
}

async function handlePersonaCommand(text, session) {
  const patch = parsePersonaCommand(text);
  if (!patch || !session) return false;
  state.db.settings.persona = {
    ...(state.db.settings.persona || {}),
    configured: true,
    ...patch
  };
  await api.saveSettings(state.db.settings);
  await api.setAutoLaunch?.(Boolean(autoLaunchInput?.checked));
  await api.appendMessage(session.id, { role: "user", text });
  const changed = [
    patch.name ? `名字：${patch.name}` : "",
    patch.personality ? `性格：${patch.personality}` : "",
    patch.abilities ? `能力：${patch.abilities}` : "",
    patch.notes ? `备注：${patch.notes}` : ""
  ].filter(Boolean);
  await api.appendMessage(session.id, {
    role: "assistant",
    text: `设定已保存。\n${changed.map((item) => `- ${item}`).join("\n")}`
  });
  chatInput.value = "";
  adjustComposerHeight();
  state.attachments = [];
  renderAttachments();
  state.db = await api.init();
  await renderAll();
  return true;
}

async function renderMessages() {
  const session = selectedSession();
  if (!session) return;
  cancelAssistantTypingsExcept(session.id);
  const messages = await api.messages(session.id);
  if (state.selectedSessionId !== session.id) return;
  const sessionChanged = state.lastRenderedSessionId !== session.id;
  if (sessionChanged) {
    resetComposerLayout({ clearDraft: Boolean(state.lastRenderedSessionId) });
    state.activeLongReplyId = "";
    renderComposerLongReplyNav(null);
  }
  const messageCountIncreased = messages.length > state.lastMessageCount;
  const pendingAnchor = state.pendingResponseAnchor?.sessionId === session.id ? state.pendingResponseAnchor : null;
  const shouldFollow = !pendingAnchor && (
    state.forceScrollBottom
    || sessionChanged
    || state.lastMessageCount === 0
    || (state.followOutput && (messageCountIncreased || isNearBottom(messageList)))
  );
  state.currentMessages = messages;
  const visibleMessages = messages.slice(-120);
  const tail = visibleMessages.slice(-3).map((message) => `${message.id || ""}:${String(message.text || message.content || "").slice(-240)}`).join("|");
  const signature = `${session.id}:${visibleMessages.length}:${tail}`;
  const activeTyping = activeAssistantTypingForSession(session.id);
  if (signature !== state.lastMessageSignature || sessionChanged) {
    if (activeTyping) {
      // Keep the live DOM node until its local typewriter finishes.
      requestAnimationFrame(updateReadingControls);
    } else {
      const fragment = document.createDocumentFragment();
      clearComposerClarification();
      if (visibleMessages.length) visibleMessages.forEach((message) => addMessage(message, fragment, { animate: false }));
      else fragment.appendChild(createEmptyConversation());
      messageList.replaceChildren(fragment);
      requestAnimationFrame(refreshLongReplyCandidates);
      state.lastMessageSignature = signature;
    }
  } else {
    requestAnimationFrame(updateReadingControls);
  }
  state.lastMessageCount = messages.length;
  state.lastRenderedSessionId = session.id;
  const anchoredMessage = pendingAnchor
    ? [...visibleMessages].reverse().find((message) => message.role === "assistant" && String(message.text || "").startsWith(pendingAnchor.text))
    : null;
  if (anchoredMessage?.id) {
    state.pendingResponseAnchor = null;
    if (state.followOutput) {
      requestAnimationFrame(() => {
        const row = messageList.querySelector(`.message[data-message-id="${CSS.escape(String(anchoredMessage.id))}"]`);
        scrollMessageToStart(row);
      });
    } else {
      setNewOutputAvailable(true);
    }
  } else if (shouldFollow) {
    state.followOutput = true;
    scrollMessagesToBottom();
  }
  ensureSessionExecutionMotion(session);
  setBusy(sessionIsRunning(session));
  stopProgress(session.status);
  renderMonitorLog(session, messages.slice(-20));
  renderMetricBars(session, messages);
  renderTaskProgressRail();
  renderTaskBoard();
  // 搜索跳转：找到匹配消息并滚动
  if (state._searchJumpQuery) {
    const query = state._searchJumpQuery;
    state._searchJumpQuery = null;
    requestAnimationFrame(() => {
      const rows = messageList.querySelectorAll('.message');
      for (const row of rows) {
        const text = (row.textContent || '').toLowerCase();
        if (text.includes(query.toLowerCase())) {
          row.classList.add('node-highlight');
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => row.classList.remove('node-highlight'), 2000);
          break;
        }
      }
    });
  }
}

function renderAttachments() {
  attachmentPreview.hidden = state.attachments.length === 0;
  attachmentPreview.innerHTML = "";
  for (const [index, item] of state.attachments.entries()) {
    const chip = document.createElement("div");
    chip.className = "chip";
    if (item.mimeType.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = item.dataUrl;
      chip.appendChild(img);
    }
    const label = document.createElement("span");
    label.textContent = item.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(label, remove);
    attachmentPreview.appendChild(chip);
  }
  requestAnimationFrame(positionTaskBoard);
}

function restoreQueuedTaskToComposer(session, task) {
  if (!session?.id || !task) return;
  const draftText = chatInput.value.trim();
  if (draftText || state.attachments.length || state.composerQuote) {
    sessionTaskQueue.enqueue(session.id, {
      text: draftText,
      attachments: [...state.attachments],
      quote: state.composerQuote ? { ...state.composerQuote } : null
    });
  }
  sessionTaskQueue.remove(session.id, task.id);
  chatInput.value = task.text || "";
  state.attachments = [...(task.attachments || [])];
  state.composerQuote = task.quote ? { ...task.quote, sessionId: session.id } : null;
  adjustComposerHeight();
  renderAttachments();
  renderComposerQuote();
  renderQueue();
  chatInput.focus();
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
}

async function startQueuedTask(session, task) {
  if (!session?.id || !task) return;
  const running = state.busy || sessionIsRunning(session) || sessionTaskQueue.isActive(session.id);
  if (running) {
    const index = sessionTaskQueue.list(session.id).findIndex((item) => item.id === task.id);
    if (index > 0) sessionTaskQueue.move(session.id, task.id, -index);
    sessionTaskQueue.update(session.id, task.id, { autoStart: true });
    renderQueue();
    showCopyToast("已设为下一项任务", 1600);
    return;
  }
  const nextTask = sessionTaskQueue.remove(session.id, task.id);
  renderQueue();
  if (nextTask) await sendCurrentTask(nextTask, session.id);
}

function clearQueueSortIndicators() {
  queueList?.querySelectorAll(".queue-drop-before, .queue-drop-after").forEach((item) => item.classList.remove("queue-drop-before", "queue-drop-after"));
}

function reorderQueuedTask(sessionId, taskId, targetId, before) {
  const ids = sessionTaskQueue.list(sessionId).map((task) => task.id);
  const nextIds = moveSidebarOrder(ids, taskId, targetId, before);
  if (!sessionTaskQueue.reorder(sessionId, nextIds)) return;
  renderQueue();
  showCopyToast("预置任务顺序已调整", 1400);
}

function bindQueueLongPressSort(item, session, task) {
  item.dataset.queueTaskId = task.id;
  item.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let active = false;
    let timer = setTimeout(() => {
      active = true;
      state.queueSortDrag = { active: true, sessionId: session.id, taskId: task.id, targetId: "", before: true };
      state.queueSortSuppressUntil = Date.now() + 700;
      item.classList.add("is-sort-dragging");
      document.body.classList.add("queue-sort-active");
      if (presetTaskContextMenu) presetTaskContextMenu.hidden = true;
      item.setPointerCapture?.(pointerId);
    }, 420);

    const cleanup = () => {
      clearTimeout(timer);
      timer = null;
      clearQueueSortIndicators();
      item.classList.remove("is-sort-dragging");
      document.body.classList.remove("queue-sort-active");
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onCancel, true);
      if (state.queueSortDrag?.taskId === task.id) state.queueSortDrag = null;
    };
    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 7) cleanup();
        return;
      }
      moveEvent.preventDefault();
      const listRect = queueList?.getBoundingClientRect();
      if (listRect) {
        if (moveEvent.clientY < listRect.top + 26) queueList.scrollTop -= 10;
        else if (moveEvent.clientY > listRect.bottom - 26) queueList.scrollTop += 10;
      }
      clearQueueSortIndicators();
      const candidate = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.(".queue-item[data-queue-task-id]");
      if (!candidate || candidate === item) {
        if (state.queueSortDrag) state.queueSortDrag.targetId = "";
        return;
      }
      const rect = candidate.getBoundingClientRect();
      const before = moveEvent.clientY < rect.top + rect.height / 2;
      candidate.classList.add(before ? "queue-drop-before" : "queue-drop-after");
      if (state.queueSortDrag) {
        state.queueSortDrag.targetId = candidate.dataset.queueTaskId || "";
        state.queueSortDrag.before = before;
      }
    };
    const onUp = (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      const completed = active ? { ...state.queueSortDrag } : null;
      if (active) {
        upEvent.preventDefault();
        upEvent.stopPropagation();
        state.queueSortSuppressUntil = Date.now() + 700;
      }
      cleanup();
      if (completed?.targetId) reorderQueuedTask(completed.sessionId, completed.taskId, completed.targetId, completed.before);
    };
    const onCancel = (cancelEvent) => {
      if (cancelEvent.pointerId === pointerId) cleanup();
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
  });
  item.addEventListener("contextmenu", (event) => {
    if (state.queueSortDrag?.active || Date.now() < Number(state.queueSortSuppressUntil || 0)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}

function renderQueue() {
  const selected = selectedSession();
  const queue = selected?.id ? sessionTaskQueue.list(selected.id) : [];
  queuePanel.hidden = queue.length === 0;
  queueList.innerHTML = "";
  queue.forEach((task, index) => {
    const item = document.createElement("div");
    item.className = "queue-item queued-input";
    const label = task.text || `附件任务 ${task.attachments.length}`;
    item.innerHTML = `
      <span class="queue-position">${index + 1}</span>
      <span class="queue-task-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="queue-item-actions">
        <button class="queue-start" type="button" data-action="start" title="${sessionIsRunning(selected) ? "设为下一项" : "开始任务"}" aria-label="${sessionIsRunning(selected) ? "设为下一项" : "开始任务"}">→</button>
      </span>
    `;
    item.querySelector('[data-action="start"]').addEventListener("click", () => void startQueuedTask(selected, task));
    item.addEventListener("contextmenu", (event) => showPresetTaskContextMenu(event, selected, task));
    bindQueueLongPressSort(item, selected, task);
    queueList.appendChild(item);
  });
  requestAnimationFrame(positionTaskBoard);
}

function renderSettings({ heavy = true } = {}) {
  providerSelect.innerHTML = "";
  const settings = state.db.settings;
  settings.appearance ||= {};
  settings.appearance.skin = SKIN_PRESETS[settings.appearance.skin] ? settings.appearance.skin : "custom";
  const skinPreset = SKIN_PRESETS[settings.appearance.skin] || SKIN_PRESETS.custom;
  for (const [key, provider] of Object.entries(settings.providers)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = provider.name || key;
    option.selected = settings.defaultProvider === key;
    providerSelect.appendChild(option);
  }
  if (reasoningSelect) reasoningSelect.value = settings.reasoning || "minimal";
  if (sideReasoningSelect) sideReasoningSelect.value = settings.reasoning || "minimal";
  renderReasoningWater();
  renderProviderDetails();
  const current = settings.providers[settings.defaultProvider];
  modelState.textContent = `${current?.name || "DeepSeek"} · ${current?.model || "未选模型"} / ${reasoningLabel(settings.reasoning)}`;
  if (currentModelBadge) {
    const nextModelLabel = current?.model || current?.name || "选择模型";
    if (currentModelBadge.textContent !== nextModelLabel) {
      currentModelBadge.textContent = nextModelLabel;
      currentModelBadge.classList.remove("model-confirmed");
      requestAnimationFrame(() => currentModelBadge.classList.add("model-confirmed"));
      clearTimeout(currentModelBadge.confirmTimer);
      currentModelBadge.confirmTimer = setTimeout(() => currentModelBadge.classList.remove("model-confirmed"), 700);
    }
  }
  if (monitorModel) monitorModel.textContent = (current?.model || current?.name || "DeepSeek").toUpperCase();
  if (skinSelect) skinSelect.value = settings.appearance.skin;
  if (skinImageFitSelect) skinImageFitSelect.value = ["cover", "contain", "original", "tile"].includes(settings.appearance.skinImageFit) ? settings.appearance.skinImageFit : "cover";
  if (textColorInput) textColorInput.value = settings.appearance.textColor || skinPreset.textColor;
  if (accentColorInput) accentColorInput.value = settings.appearance.accentColor || skinPreset.accentColor;
  if (backgroundColorInput) backgroundColorInput.value = settings.appearance.backgroundColor || skinPreset.backgroundColor;
  if (panelColorInput) panelColorInput.value = settings.appearance.panelColor || skinPreset.panelColor;
  syncThemeHexInputs();
  updateThemePaletteSelection(settings.appearance.palette || "");
  if (fontSizeInput) fontSizeInput.value = settings.appearance.fontSize || skinPreset.fontSize || 16;
  if (skinImageStatus) skinImageStatus.hidden = true;
  setThemeSettingsDirty(false);
  if (inviteInput) inviteInput.value = settings.license?.inviteCode || "";
  if (heavy) refreshLicenseStatus();
  if (personaNameInput) personaNameInput.value = settings.persona?.name || "Gantz";
  if (personaPersonalityInput) personaPersonalityInput.value = settings.persona?.personality || "";
  if (personaAbilitiesInput) personaAbilitiesInput.value = settings.persona?.abilities || "";
  if (personaNameSettingsInput) personaNameSettingsInput.value = settings.persona?.name || "Gantz";
  if (personaPersonalitySettingsInput) personaPersonalitySettingsInput.value = settings.persona?.personality || "";
  if (personaAbilitiesSettingsInput) personaAbilitiesSettingsInput.value = settings.persona?.abilities || "";
  if (personaNotesSettingsInput) personaNotesSettingsInput.value = settings.persona?.notes || "";
  if (updateManifestInput) updateManifestInput.value = settings.update?.updateServer || settings.update?.manifestUrl || "";
  if (heavy) window.heiqiu.getAutoLaunch?.().then((enabled) => { if (autoLaunchInput) autoLaunchInput.checked = Boolean(enabled); }).catch(() => null);
  if (saveLocationInput) saveLocationInput.value = settings.files?.saveLocation || settings.files?.defaultSaveLocation || "D:\\白球AI\\data\\workspace";
  if (agentModeInput) agentModeInput.checked = true;
  if (advancedLocalExecutionInput) advancedLocalExecutionInput.checked = (settings.permissions?.accessMode || "full") !== "normal";
  applyAppearance();
  updateLogicBar();
  renderAccessMode();
  if (heavy) renderSkills();
  setSettingsDirty(false);
}

function renderProviderDetails() {
  const settings = state.db.settings;
  const key = providerSelect.value || settings.defaultProvider || "deepseek";
  state.providerDetailKey = key;
  if (providerList) {
    providerList.hidden = true;
    providerList.innerHTML = "";
  }
  renderModelCenterOverview();
}

function providerConnectionState(key, provider) {
  if (state.providerModelErrors[key]) return { online: false, state: "error", label: "配置异常" };
  const verified = Boolean(provider?.verifiedAt)
    && provider.verifiedModel === provider.model
    && String(provider.verifiedBaseURL || "").replace(/\/+$/, "") === String(provider.baseURL || "").replace(/\/+$/, "");
  if (verified) return { online: true, state: "online", label: "已验证" };
  if ((provider?.apiKey || provider?.requiresApiKey === false) && provider?.model) {
    return { online: false, state: "pending", label: "待验证" };
  }
  return { online: false, state: "offline", label: "待配置" };
}

const MODEL_ORDER_STORAGE_KEY = "baiqiu.modelProviderOrder";
const PROTECTED_MODEL_PROVIDERS = new Set([
  "deepseek", "openai", "anthropic", "kimi", "qwen", "baidu", "zhipu",
  "doubao", "hunyuan", "minimax", "stepfun", "xiaomi", "ollama"
]);

function orderedModelProviders(providers = {}) {
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(MODEL_ORDER_STORAGE_KEY) || "[]"); } catch {}
  const keys = Object.keys(providers);
  const order = [...stored.filter((key) => keys.includes(key)), ...keys.filter((key) => !stored.includes(key))];
  return order.map((key) => [key, providers[key]]);
}

function saveModelProviderOrder(keys = []) {
  localStorage.setItem(MODEL_ORDER_STORAGE_KEY, JSON.stringify(keys));
}

const MODEL_PROVIDER_ICON_ASSETS = Object.freeze({
  deepseek: "assets/model-icons/deepseek-color.svg",
  openai: "assets/model-icons/openai.svg",
  anthropic: "assets/model-icons/anthropic.svg",
  kimi: "assets/model-icons/kimi-color.svg",
  qwen: "assets/model-icons/qwen-color.svg",
  baidu: "assets/model-icons/wenxin-color.svg",
  zhipu: "assets/model-icons/zhipu-color.svg",
  doubao: "assets/model-icons/doubao-color.svg",
  hunyuan: "assets/model-icons/hunyuan-color.svg",
  minimax: "assets/model-icons/minimax-color.svg",
  stepfun: "assets/model-icons/stepfun-color.svg",
  xiaomi: "assets/model-icons/xiaomimimo.svg",
  ollama: "assets/model-icons/ollama.svg"
});

function modelProviderIcon(provider = {}, key = "") {
  const label = String(provider.name || key || "AI").trim();
  const asset = MODEL_PROVIDER_ICON_ASSETS[String(key || "").toLowerCase()];
  if (asset) return `<img src="${asset}" alt="${escapeHtml(label)} 官方图标" loading="lazy" decoding="async" />`;
  return `<b aria-hidden="true">${escapeHtml((label.match(/[A-Za-z0-9]/)?.[0] || label.slice(0, 1) || "AI").toUpperCase())}</b>`;
}

async function useModelProvider(key) {
  const provider = state.db.settings.providers?.[key];
  if (!provider) return;
  state.providerModelStatus[key] = "正在进行真实推理验证...";
  renderModelCenterOverview();
  try {
    const result = await api.activateModel(key);
    state.providerModels[key] = result?.verification?.models || [];
    state.providerLastChecked[key] = Date.now();
    state.providerModelErrors[key] = false;
    state.providerModelStatus[key] = `真实推理验证通过，响应 ${result?.verification?.latencyMs ?? "--"}ms`;
    providerSelect.value = key;
    state.db = await api.init();
    renderSettings();
    showCopyToast(`已验证并切换到 ${provider.name || key}`, 2200);
  } catch (error) {
    state.providerModelErrors[key] = true;
    state.providerModelStatus[key] = error?.message || String(error);
    renderModelCenterOverview();
    showCopyToast(`切换失败，仍使用原模型：${state.providerModelStatus[key]}`, 3200);
  }
}

async function toggleModelProvider(key, enabled) {
  const settings = state.db.settings;
  if (!enabled && key === settings.defaultProvider) {
    renderModelCenterOverview();
    showCopyToast("当前使用模型不能停用，请先切换模型", 2200);
    return;
  }
  settings.providers[key] = { ...settings.providers[key], enabled };
  await api.saveSettings(settings);
  state.db = await api.init();
  renderSettings();
}

async function deleteModelProvider(key) {
  const settings = state.db.settings;
  if (key === settings.defaultProvider) {
    showCopyToast("当前使用模型不能删除，请先切换模型", 2200);
    return;
  }
  if (PROTECTED_MODEL_PROVIDERS.has(key)) {
    showCopyToast("系统预置模型不能删除，可以将其停用", 2200);
    return;
  }
  const provider = settings.providers?.[key];
  if (!provider) return;
  const confirmed = await showAppConfirm({
    title: "删除模型",
    message: `确定删除「${provider.name || key}」的本地配置？此操作不会影响模型服务商账号。`,
    primary: "确认删除",
    secondary: "取消"
  });
  if (!confirmed) return;
  delete settings.providers[key];
  saveModelProviderOrder(orderedModelProviders(settings.providers).map(([providerKey]) => providerKey));
  await api.saveSettings(settings);
  state.db = await api.init();
  renderSettings();
}

function closeModelCardMenus(except = null) {
  configuredModelList?.querySelectorAll(".model-card-more-menu").forEach((menu) => {
    if (menu !== except) menu.hidden = true;
  });
}

function renderModelCenterOverview() {
  if (!configuredModelList) return;
  const settings = state.db.settings;
  const selectedKey = providerSelect.value || settings.defaultProvider || "deepseek";
  const selectedProvider = settings.providers[selectedKey] || {};
  const selectedConnection = providerConnectionState(selectedKey, selectedProvider);
  if (currentModelCard) currentModelCard.dataset.state = selectedConnection.state;
  if (modelCenterCurrentName) modelCenterCurrentName.textContent = selectedProvider.name || selectedKey;
  if (modelCenterCurrentId) modelCenterCurrentId.textContent = selectedProvider.model || "尚未选择模型 ID";
  if (modelCenterCurrentStatus) modelCenterCurrentStatus.textContent = selectedConnection.label;

  const entries = orderedModelProviders(settings.providers || {});
  if (configuredModelCount) configuredModelCount.textContent = String(entries.length);
  configuredModelList.innerHTML = entries.map(([key, provider]) => {
    const connection = providerConnectionState(key, provider);
    const selected = key === selectedKey;
    const routeLabel = provider.interfaceType === "custom" ? "自定义接口" : (PROVIDER_ROUTE_LABELS[key] || "官方接口");
    const checkedLabel = state.providerLastChecked[key] ? "刚刚" : "尚未检测";
    return `
      <article class="configured-model-card${selected ? " selected" : ""}" data-provider-card="${escapeHtml(key)}" data-state="${connection.state}">
        <div class="configured-model-identity">
          <button class="model-drag-handle" type="button" draggable="true" data-model-drag="${escapeHtml(key)}" title="拖动排序" aria-label="拖动 ${escapeHtml(provider.name || key)} 排序">⋮⋮</button>
          <span class="model-provider-icon">${modelProviderIcon(provider, key)}</span>
          <div><strong>${escapeHtml(provider.name || key)}</strong>${selected ? "<small>默认模型</small>" : ""}</div>
        </div>
        <div class="configured-model-summary">
          <span>${escapeHtml(routeLabel)}</span>
          <b title="${escapeHtml(provider.model || "未配置")}">${escapeHtml(provider.model || "未配置模型版本")}</b>
          <em class="model-connection-badge"><i></i>${escapeHtml(connection.label)}</em>
          <small>最后检测：${checkedLabel}</small>
        </div>
        <div class="configured-model-actions">
          <button class="configured-model-use" type="button" data-use-provider="${escapeHtml(key)}"${selected ? " disabled" : ""}>${selected ? "使用中" : "使用"}</button>
          <button type="button" data-configure-provider="${escapeHtml(key)}">配置</button>
          <button type="button" data-test-provider="${escapeHtml(key)}">测试</button>
          <button type="button" data-delete-provider="${escapeHtml(key)}">删除</button>
        </div>
        <div class="configured-model-controls">
          <label class="model-enabled-toggle" title="启用或停用模型"><input type="checkbox" data-toggle-provider="${escapeHtml(key)}"${provider.enabled || selected ? " checked" : ""}><span></span><b>${provider.enabled || selected ? "已启用" : "已停用"}</b></label>
          <button class="model-more-button" type="button" data-model-more="${escapeHtml(key)}" aria-label="更多模型操作">⋮</button>
          <div class="model-card-more-menu" hidden>
            <button type="button" data-copy-provider="${escapeHtml(key)}">复制配置</button>
            <button type="button" data-reconnect-provider="${escapeHtml(key)}">重新连接</button>
            <button type="button" data-provider-log="${escapeHtml(key)}">查看日志</button>
          </div>
        </div>
      </article>
    `;
  }).join("");

  configuredModelList.querySelectorAll("[data-use-provider]").forEach((button) => {
    button.addEventListener("click", () => useModelProvider(button.dataset.useProvider || selectedKey));
  });
  configuredModelList.querySelectorAll("[data-configure-provider]").forEach((button) => {
    button.addEventListener("click", () => openModelConfigDrawer(button.dataset.configureProvider, "edit"));
  });
  configuredModelList.querySelectorAll("[data-test-provider]").forEach((button) => {
    button.addEventListener("click", () => refreshProviderModels(button.dataset.testProvider, button, null, "test"));
  });
  configuredModelList.querySelectorAll("[data-delete-provider]").forEach((button) => {
    button.addEventListener("click", () => deleteModelProvider(button.dataset.deleteProvider));
  });
  configuredModelList.querySelectorAll("[data-toggle-provider]").forEach((input) => {
    input.addEventListener("change", () => toggleModelProvider(input.dataset.toggleProvider, input.checked));
  });
  configuredModelList.querySelectorAll("[data-model-more]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = button.parentElement?.querySelector(".model-card-more-menu");
      if (!menu) return;
      const opening = menu.hidden;
      closeModelCardMenus(menu);
      menu.hidden = !opening;
    });
  });
  configuredModelList.querySelectorAll("[data-copy-provider]").forEach((button) => {
    button.addEventListener("click", async () => {
      const key = button.dataset.copyProvider;
      const provider = settings.providers[key] || {};
      await api.copyText(JSON.stringify({ name: provider.name || key, baseURL: provider.baseURL || "", apiKeyUrl: provider.apiKeyUrl || "", model: provider.model || "", apiStyle: provider.apiStyle || "openai" }, null, 2));
      closeModelCardMenus();
      showCopyToast("模型配置已复制，API Key 未包含在内", 2000);
    });
  });
  configuredModelList.querySelectorAll("[data-reconnect-provider]").forEach((button) => {
    button.addEventListener("click", () => refreshProviderModels(button.dataset.reconnectProvider, button, null, "test"));
  });
  configuredModelList.querySelectorAll("[data-provider-log]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.providerLog;
      const provider = settings.providers[key] || {};
      closeModelCardMenus();
      showAppConfirm({ title: `${provider.name || key} 连接日志`, message: state.providerModelStatus[key] || "尚无连接测试记录。", primary: "知道了", secondary: "关闭" });
    });
  });
  configuredModelList.querySelectorAll("[data-model-drag]").forEach((handle) => {
    handle.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/model-provider", handle.dataset.modelDrag || "");
      handle.closest(".configured-model-card")?.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => handle.closest(".configured-model-card")?.classList.remove("dragging"));
  });
  configuredModelList.querySelectorAll("[data-provider-card]").forEach((card) => {
    card.addEventListener("dragover", (event) => event.preventDefault());
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceKey = event.dataTransfer.getData("text/model-provider");
      const targetKey = card.dataset.providerCard;
      if (!sourceKey || !targetKey || sourceKey === targetKey) return;
      const keys = entries.map(([entryKey]) => entryKey);
      const sourceIndex = keys.indexOf(sourceKey);
      const targetIndex = keys.indexOf(targetKey);
      keys.splice(targetIndex, 0, keys.splice(sourceIndex, 1)[0]);
      saveModelProviderOrder(keys);
      renderModelCenterOverview();
    });
  });
  // 渲染供应商健康度面板
  renderProviderHealthPanel();
}

async function renderProviderHealthPanel({ runCheck = false } = {}) {
  const list = document.getElementById('providerHealthList');
  if (!list) return;
  const settings = state.db.settings;
  const entries = Object.entries(settings.providers || {});
  if (!entries.length) {
    list.innerHTML = '<div class="provider-health-empty">暂无已配置的模型供应商</div>';
    return;
  }
  list.innerHTML = entries.map(([key, provider]) => {
    const isDefault = settings.defaultProvider === key;
    return `
      <div class="provider-health-card" data-health-provider="${escapeHtml(key)}" data-status="checking">
        <div class="provider-health-header">
          <strong>${escapeHtml(provider.name || key)}</strong>
          ${isDefault ? '<small class="health-default-tag">默认</small>' : ''}
          <span class="health-status-dot" data-dot></span>
          <span class="health-status-label" data-label>检测中</span>
        </div>
        <div class="provider-health-metrics">
          <div class="health-metric"><span>性能评分</span><b data-score>--</b></div>
          <div class="health-metric"><span>成功率</span><b data-success>--</b></div>
          <div class="health-metric"><span>响应速度</span><b data-latency>--</b></div>
        </div>
      </div>
    `;
  }).join('');
  // 异步获取状态报告
  try {
    if (runCheck && window.heiqiu?.modelHealthCheck) await window.heiqiu.modelHealthCheck();
    if (window.heiqiu?.modelStatusReport) {
      const report = await window.heiqiu.modelStatusReport();
      const rows = Array.isArray(report) ? report : Object.values(report?.providers || {});
      if (rows.length) {
        for (const data of rows) {
          const key = data.id;
          const card = list.querySelector(`[data-health-provider="${key}"]`);
          if (!card) continue;
          const healthy = data.healthy;
          const status = !data.configured ? 'unconfigured' : healthy === true ? 'healthy' : healthy === false ? 'unhealthy' : 'unknown';
          card.dataset.status = status;
          const dot = card.querySelector('[data-dot]');
          const label = card.querySelector('[data-label]');
          if (dot) dot.className = `health-status-dot ${healthy === true ? 'dot-ok' : healthy === false ? 'dot-fail' : ''}`;
          if (label) label.textContent = !data.configured ? '未配置' : healthy === true ? '健康' : healthy === false ? '异常' : '未检测';
          const score = card.querySelector('[data-score]');
          const success = card.querySelector('[data-success]');
          const latency = card.querySelector('[data-latency]');
          if (score) score.textContent = data.performanceScore != null ? data.performanceScore + '分' : '--';
          if (success) success.textContent = data.successRate != null ? Math.round(data.successRate * 100) + '%' : '--';
          if (latency) latency.textContent = data.latency >= 0 ? Math.round(data.latency) + 'ms' : '--';
        }
      }
    }
  } catch (e) {
    // 忽略
  }
}

async function renderSmartRecommend(taskType) {
  const panel = document.getElementById('recommendResult');
  if (!panel) return;
  panel.innerHTML = '<div class="recommend-loading">正在分析...</div>';
  try {
    const result = await window.heiqiu.modelRecommend(taskType);
    if (!result || !result.recommended) {
      panel.innerHTML = `<div class="recommend-empty">${escapeHtml(result?.reason || '暂无推荐')}</div>`;
      return;
    }
    const rec = result.recommended;
    const alts = result.alternatives || [];
    const TASK_LABELS = { coding: '编程', writing: '写作', analysis: '分析', vision: '视觉', conversation: '对话' };
    let html = `<div class="recommend-card">
      <div class="recommend-top">
        <span class="recommend-badge">⭐ 推荐</span>
        <strong>${escapeHtml(rec.name)}</strong>
        <small>${escapeHtml(rec.model || '未指定模型')}</small>
      </div>
      <div class="recommend-reason">${escapeHtml(result.reason)}</div>
      <div class="recommend-score">评分: <b>${rec.score}</b> | 性能: <b>${rec.perfScore}</b></div>
    </div>`;
    if (alts.length) {
      html += '<div class="recommend-alternatives"><span>备选</span>';
      for (const alt of alts) {
        html += `<div class="recommend-alt-card">
          <strong>${escapeHtml(alt.name)}</strong>
          <small>${escapeHtml(alt.model || '')} · 评分 ${alt.score}</small>
        </div>`;
      }
      html += '</div>';
    }
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = `<div class="recommend-error">推荐失败: ${escapeHtml(e.message || '未知错误')}</div>`;
  }
}

function initSmartRecommend() {
  const panel = document.getElementById('smartRecommendPanel');
  if (!panel || panel.dataset.bound) return;
  panel.dataset.bound = '1';
  panel.querySelectorAll('.recommend-task-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.recommend-task-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderSmartRecommend(btn.dataset.taskType);
    });
  });
  // 初始加载对话类型推荐
  renderSmartRecommend('conversation');
}

function modelProviderOptions() {
  const preferred = [
    "deepseek", "qwen", "kimi", "zhipu", "baidu", "doubao", "hunyuan",
    "minimax", "stepfun", "xiaomi", "openai", "anthropic", "ollama"
  ];
  const entries = Object.entries(state.db.settings.providers || {});
  const ordered = [...preferred, ...entries.map(([key]) => key).filter((key) => !preferred.includes(key))];
  const unique = ordered.filter((key, index) => key !== "custom" && ordered.indexOf(key) === index && state.db.settings.providers?.[key]);
  return [...unique.map((key) => ({ key, label: state.db.settings.providers[key].name || key })), { key: "custom", label: "自定义模型" }];
}

function defaultCustomProvider() {
  return { name: "自定义模型", enabled: false, baseURL: "", apiKey: "", apiKeyUrl: "", model: "", apiStyle: "openai" };
}

function closeModelConfigDrawer() {
  if (modelConfigLayer) modelConfigLayer.hidden = true;
  state.modelConfigKey = "";
  state.modelConfigDraft = null;
  state.modelConfigOriginalSnapshot = "";
  state.modelConfigSetDefault = false;
  state.modelConfigSaving = false;
}

function modelConfigSnapshot(key = state.modelConfigKey, draft = state.modelConfigDraft) {
  if (!key || !draft) return "";
  return JSON.stringify({
    key,
    name: String(draft.name || "").trim(),
    apiKey: String(draft.apiKey || ""),
    apiKeyUrl: String(draft.apiKeyUrl || "").trim(),
    baseURL: String(draft.baseURL || "").trim(),
    model: String(draft.model || "").trim(),
    apiStyle: String(draft.apiStyle || providerApiStyle(key)),
    interfaceType: String(state.modelConfigInterface || "official"),
    defaultModel: Boolean(state.modelConfigSetDefault)
  });
}

function modelConfigIsDirty() {
  if (!state.modelConfigDraft || modelConfigLayer?.hidden) return false;
  return modelConfigSnapshot(state.modelConfigKey, readModelConfigDraft()) !== state.modelConfigOriginalSnapshot;
}

function setModelConfigSaveState(status = "saved", message = "") {
  if (!modelConfigSaveState) return;
  modelConfigSaveState.dataset.status = status;
  modelConfigSaveState.textContent = message || (status === "dirty" ? "未保存修改" : status === "checking" ? "正在验证配置..." : status === "error" ? "保存失败" : "✓ 已保存");
  modelConfigSaveState.title = message || "";
}

function markModelConfigDirty() {
  readModelConfigDraft();
  setModelConfigSaveState(modelConfigIsDirty() ? "dirty" : "saved");
}

function showModelUnsavedConfirm() {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "app-modal-layer runtime-confirm-layer model-unsaved-layer";
    layer.innerHTML = `
      <section class="app-modal-panel model-unsaved-panel" role="alertdialog" aria-modal="true" aria-labelledby="modelUnsavedTitle">
        <strong id="modelUnsavedTitle">配置已修改，是否保存？</strong>
        <p>未保存的 API 配置和模型选择将在关闭后丢失。</p>
        <div class="app-modal-actions">
          <button type="button" data-model-unsaved="cancel">取消</button>
          <button type="button" data-model-unsaved="discard">放弃修改</button>
          <button class="runtime-confirm-primary" type="button" data-model-unsaved="save">保存并退出</button>
        </div>
      </section>`;
    (settingsForm || document.body).appendChild(layer);
    const finish = (choice) => {
      layer.remove();
      resolve(choice);
    };
    layer.querySelectorAll("[data-model-unsaved]").forEach((button) => button.addEventListener("click", () => finish(button.dataset.modelUnsaved)));
    layer.addEventListener("click", (event) => { if (event.target === layer) finish("cancel"); });
  });
}

async function requestCloseModelConfigDrawer() {
  if (!modelConfigIsDirty()) {
    closeModelConfigDrawer();
    return true;
  }
  const choice = await showModelUnsavedConfirm();
  if (choice === "discard") {
    closeModelConfigDrawer();
    return true;
  }
  if (choice === "save") return saveModelConfig({ closeAfter: true });
  return false;
}

function readModelConfigDraft() {
  if (!state.modelConfigDraft) return null;
  state.modelConfigDraft = {
    ...state.modelConfigDraft,
    name: $("modelConfigNameInput")?.value?.trim() || state.modelConfigDraft.name || state.modelConfigKey,
    apiKey: $("apiKeyInput")?.value || "",
    apiKeyUrl: $("apiKeyUrlInput")?.value?.trim() || "",
    baseURL: $("baseUrlInput")?.value?.trim() || "",
    model: $("modelVersionInput")?.value?.trim() || "",
    apiStyle: providerApiStyle(state.modelConfigKey),
    interfaceType: state.modelConfigInterface
  };
  state.modelConfigSetDefault = Boolean($("modelConfigDefaultInput")?.checked);
  return state.modelConfigDraft;
}

function openModelConfigDrawer(key = "deepseek", mode = "edit") {
  const provider = state.db.settings.providers?.[key] || (key === "custom" ? defaultCustomProvider() : null);
  if (!provider || !modelConfigLayer) return;
  state.modelConfigKey = key;
  state.modelConfigMode = mode;
  state.modelConfigDraft = JSON.parse(JSON.stringify(provider));
  state.modelConfigInterface = provider.interfaceType || (key === "custom" ? "custom" : "official");
  state.modelConfigSetDefault = key === state.db.settings.defaultProvider;
  modelConfigLayer.hidden = false;
  renderModelConfigDrawer();
  state.modelConfigOriginalSnapshot = modelConfigSnapshot(key, readModelConfigDraft());
  setModelConfigSaveState(mode === "add" ? "dirty" : "saved", mode === "add" ? "等待保存" : "✓ 已保存");
}

function renderModelConfigDrawer() {
  if (!modelConfigBody || !state.modelConfigDraft) return;
  const key = state.modelConfigKey;
  const provider = state.modelConfigDraft;
  const discovered = state.providerModels[key] || [];
  const apiKeyUrl = String(provider.apiKeyUrl || "").trim();
  const modelControl = discovered.length
    ? `<select id="modelVersionInput">${discovered.map((model) => `<option value="${escapeHtml(model)}"${model === provider.model ? " selected" : ""}>${escapeHtml(model)}</option>`).join("")}</select>`
    : `<input id="modelVersionInput" value="${escapeHtml(provider.model || "")}" placeholder="输入模型 ID 或自动获取模型列表">`;
  const providerPicker = state.modelConfigMode === "add"
    ? `<label class="model-config-field"><span>模型供应商</span><select id="modelProviderTypeInput">${modelProviderOptions().map((item) => `<option value="${escapeHtml(item.key)}"${item.key === key ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>`
    : "";
  if (modelConfigTitle) modelConfigTitle.textContent = state.modelConfigMode === "add" ? "添加模型" : `${provider.name || key} 配置`;
  if (testModelConnectionBtn) testModelConnectionBtn.hidden = false;
  modelConfigLayer?.classList.remove("local-model-config");
  modelConfigBody.innerHTML = `
    <section class="model-config-group">
      <div class="model-config-group-title"><strong>基础信息</strong><span>用于模型中心识别与展示</span></div>
      ${providerPicker}
      <label class="model-config-field"><span>模型名称</span><input id="modelConfigNameInput" value="${escapeHtml(provider.name || "")}" placeholder="请输入模型名称"></label>
      <div class="model-config-field"><span>接口类型</span><div class="model-interface-switch"><button type="button" data-model-interface="official" class="${state.modelConfigInterface === "official" ? "active" : ""}">官方接口</button><button type="button" data-model-interface="custom" class="${state.modelConfigInterface === "custom" ? "active" : ""}">自定义接口</button></div></div>
      <label class="model-config-default"><input id="modelConfigDefaultInput" type="checkbox"${state.modelConfigSetDefault ? " checked" : ""}><span><strong>设为默认模型</strong><small>保存后立即用于新任务和对话</small></span></label>
    </section>
    <section class="model-config-group">
      <div class="model-config-group-title"><strong>API 配置</strong><span>${escapeHtml(PROVIDER_ROUTE_LABELS[key] || "兼容 OpenAI 协议的自定义接口")}</span></div>
      <label class="model-config-field"><span>API Key</span><input id="apiKeyInput" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(provider.apiKey || "")}" placeholder="sk-xxxxxxxx"></label>
      <label class="model-config-field"><span>API Key 获取地址</span><div class="model-picker-row"><input id="apiKeyUrlInput" value="${escapeHtml(apiKeyUrl)}" placeholder="https://..."><button id="openApiKeyUrlBtn" type="button">${provider.requiresApiKey === false ? "查看说明" : "打开获取页"}</button></div></label>
      <label class="model-config-field"><span>Base URL</span><input id="baseUrlInput" value="${escapeHtml(provider.baseURL || "")}" placeholder="https://api.deepseek.com"></label>
    </section>
    <section class="model-config-group">
      <div class="model-config-group-title"><strong>模型选择</strong><span>选择版本或从接口自动获取</span></div>
      <label class="model-config-field"><span>模型版本</span><div class="model-picker-row">${modelControl}<button id="refreshModelsBtn" type="button">自动获取</button></div></label>
      <div id="modelDiscoveryStatus" class="model-config-status" aria-live="polite">${escapeHtml(state.providerModelStatus[key] || "尚未检测连接")}</div>
    </section>
  `;
  $("modelProviderTypeInput")?.addEventListener("change", (event) => {
    const nextKey = event.target.value;
    state.modelConfigKey = nextKey;
    state.modelConfigDraft = JSON.parse(JSON.stringify(state.db.settings.providers?.[nextKey] || defaultCustomProvider()));
    state.modelConfigInterface = state.modelConfigDraft.interfaceType || (nextKey === "custom" ? "custom" : "official");
    state.modelConfigSetDefault = nextKey === state.db.settings.defaultProvider;
    renderModelConfigDrawer();
    markModelConfigDirty();
  });
  modelConfigBody.querySelectorAll("[data-model-interface]").forEach((button) => {
    button.addEventListener("click", () => {
      readModelConfigDraft();
      state.modelConfigInterface = button.dataset.modelInterface;
      renderModelConfigDrawer();
      markModelConfigDirty();
    });
  });
  modelConfigBody.querySelectorAll("input, select").forEach((control) => {
    control.addEventListener("input", markModelConfigDirty);
    control.addEventListener("change", markModelConfigDirty);
  });
  $("openApiKeyUrlBtn")?.addEventListener("click", async () => {
    const url = $("apiKeyUrlInput")?.value?.trim() || "";
    if (!url) {
      showCopyToast("请先填写 API Key 获取地址", 2200);
      return;
    }
    await tryOpenExternalUrl(url);
  });
  $("refreshModelsBtn")?.addEventListener("click", () => refreshProviderModels(key, $("refreshModelsBtn"), $("modelDiscoveryStatus"), "refresh"));
  setModelConfigSaveState(modelConfigIsDirty() ? "dirty" : "saved");
}

async function saveModelConfig({ closeAfter = false } = {}) {
  if (state.modelConfigSaving) return false;
  const key = state.modelConfigKey;
  const draft = readModelConfigDraft();
  if (!key || !draft) return false;
  if (!draft.name) {
    setModelConfigSaveState("error", "请输入模型名称");
    return false;
  }
  if ((draft.requiresApiKey !== false && !draft.apiKey) || !draft.baseURL || !draft.model) {
    setModelConfigSaveState("error", `请完整填写${draft.requiresApiKey === false ? "" : " API Key、"}Base URL 和模型版本`);
    return false;
  }
  state.modelConfigSaving = true;
  [testModelConnectionBtn, modelConfigCancelBtn, saveModelConfigBtn].forEach((button) => { if (button) button.disabled = true; });
  setModelConfigSaveState("checking", "正在验证 API、接口和模型...");
  try {
    const existing = state.db.settings.providers?.[key] || {};
    const result = await api.verifyModel({ providerId: key, ...draft });
    const models = Array.isArray(result?.models) ? result.models : [];
    state.providerModels[key] = models;
    state.providerLastChecked[key] = Date.now();
    state.providerModelErrors[key] = false;
    state.providerModelStatus[key] = models.length
      ? `真实推理验证通过，发现 ${models.length} 个可用模型`
      : `真实推理验证通过；该接口未提供模型列表${result?.modelListWarning ? `（${result.modelListWarning}）` : ""}`;
    const nextSettings = JSON.parse(JSON.stringify(state.db.settings));
    nextSettings.providers[key] = {
      ...existing,
      ...draft,
      interfaceType: state.modelConfigInterface,
      enabled: true,
      verifiedAt: result.verifiedAt,
      verifiedModel: result.model,
      verifiedBaseURL: result.baseURL,
      verificationLatencyMs: result.latencyMs
    };
    if (state.modelConfigSetDefault) nextSettings.defaultProvider = key;
    await api.saveSettings(nextSettings);
    state.db = await api.init();
    state.modelConfigDraft = JSON.parse(JSON.stringify(state.db.settings.providers[key]));
    state.modelConfigSetDefault = state.db.settings.defaultProvider === key;
    state.modelConfigOriginalSnapshot = modelConfigSnapshot(key, state.modelConfigDraft);
    renderSettings({ heavy: false });
    setModelConfigSaveState("saved", "✓ 配置完成");
    showCopyToast("模型配置已保存并通过真实推理验证", 2400);
    if (closeAfter) closeModelConfigDrawer();
    return true;
  } catch (error) {
    setModelConfigSaveState("error", error?.message || String(error));
    return false;
  } finally {
    state.modelConfigSaving = false;
    [testModelConnectionBtn, modelConfigCancelBtn, saveModelConfigBtn].forEach((button) => { if (button) button.disabled = false; });
  }
}

async function refreshProviderModels(key, button, statusNode = null, mode = "refresh") {
  const defaultButtonText = button?.textContent || (mode === "test" ? "测试" : "自动获取");
  if (button) button.disabled = true;
  if (statusNode) statusNode.textContent = mode === "test" ? "正在测试连接..." : "正在获取模型列表...";
  else {
    button.textContent = "正在检测...";
    button.closest(".configured-model-card")?.classList.add("checking");
  }
  const draft = key === state.modelConfigKey ? readModelConfigDraft() : state.db.settings.providers?.[key];
  try {
    const result = mode === "test"
      ? await api.verifyModel({ providerId: key, ...draft })
      : await api.listModels({ providerId: key, ...draft });
    state.providerModels[key] = result.models || [];
    state.providerLastChecked[key] = Date.now();
    state.providerModelErrors[key] = false;
    state.providerModelStatus[key] = mode === "test"
      ? `真实推理验证通过，响应 ${result.latencyMs ?? "--"}ms${state.providerModels[key].length ? `，发现 ${state.providerModels[key].length} 个模型` : ""}`
      : `发现 ${state.providerModels[key].length} 个可用模型`;
    if (mode === "test" && result.verifiedAt && (modelConfigLayer?.hidden || key !== state.modelConfigKey)) {
      state.db.settings.providers[key] = {
        ...state.db.settings.providers[key],
        verifiedAt: result.verifiedAt,
        verifiedModel: result.model,
        verifiedBaseURL: result.baseURL,
        verificationLatencyMs: result.latencyMs
      };
      await api.saveSettings(state.db.settings);
      state.db = await api.init();
    }
    if (state.modelConfigDraft && key === state.modelConfigKey && !state.providerModels[key].includes(state.modelConfigDraft.model)) {
      state.modelConfigDraft.model = state.providerModels[key][0] || state.modelConfigDraft.model;
    }
    if (key === state.modelConfigKey) renderModelConfigDrawer();
    renderModelCenterOverview();
  } catch (error) {
    state.providerModelStatus[key] = error?.message || String(error);
    state.providerModelErrors[key] = true;
    if (key === state.modelConfigKey) renderModelConfigDrawer();
    else if (statusNode) statusNode.textContent = state.providerModelStatus[key];
    renderModelCenterOverview();
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = defaultButtonText;
      button.closest(".configured-model-card")?.classList.remove("checking");
    }
  }
}

let renderAllInFlight = null;
let renderAllQueued = false;
let secondaryRenderTimer = null;
let sessionChangedRenderTimer = null;

function scheduleSecondaryRender() {
  clearTimeout(secondaryRenderTimer);
  secondaryRenderTimer = setTimeout(async () => {
    const [owner, history] = await Promise.all([
      api.ownerStatus?.().catch(() => ({ devMode: false })),
      api.productTaskHistory?.({ productId: "desktop-assistant", limit: 5 }).catch(() => [])
    ]);
    await renderLicenseControls(owner);
    renderProductTaskStrip(history || []);
    renderProductDashboard(history?.[0] || null, { devMode: Boolean(owner?.devMode) });
  }, 250);
}

async function renderAllPass({ refreshSettings = true, refreshSecondary = true } = {}) {
  document.body.classList.add("ui-rendering");
  try {
    state.db = ensureClientDb(state.db);
    state.selectedSessionId ||= state.db.selectedSessionId || state.db.sessions[0]?.id;
    const activeSession = selectedSession();
    if (activeSession?.id) markSessionRead(activeSession.id);
    if (currentChatTitle) currentChatTitle.textContent = activeSession ? projectSessionDisplayName(activeSession) : "新对话";
    if (sessionRoleBadge) {
      const projectSession = activeSession?.type === "CEO" || activeSession?.type === "Agent";
      sessionRoleBadge.hidden = !projectSession;
      sessionRoleBadge.textContent = projectSession ? `${activeSession.type} · ${activeSession.role || (activeSession.type === "CEO" ? "项目负责人" : "执行人员")}` : "";
      sessionRoleBadge.title = activeSession?.task || "";
    }
    renderSessions();
    await renderMessages();
    if (refreshSettings) renderSettings({ heavy: false });
    renderQueue();
    renderComposerQuote();
    recordState.textContent = `${state.db.sessions.length} 会话`;
    if (monitorSession) monitorSession.textContent = statusText(selectedSession()?.status);
    if (refreshSecondary) scheduleSecondaryRender();
  } finally {
    requestAnimationFrame(() => document.body.classList.remove("ui-rendering"));
  }
}

// Coalesce bursts of IPC updates so one task cannot trigger overlapping full-page renders.
async function renderAll(options = {}) {
  if (renderAllInFlight) {
    renderAllQueued = true;
    return renderAllInFlight;
  }
  renderAllInFlight = (async () => {
    do {
      renderAllQueued = false;
       await renderAllPass(options);
    } while (renderAllQueued);
  })();
  try {
    return await renderAllInFlight;
  } finally {
    renderAllInFlight = null;
  }
}

function readSettingsFromDialog() {
  const settings = JSON.parse(JSON.stringify(state.db.settings));
  settings.webSearch = { ...(settings.webSearch || {}), enabled: true };
  const updateTarget = updateManifestInput?.value?.trim() || "";
  settings.defaultProvider = providerSelect.value || "deepseek";
  settings.reasoning = state.db?.settings?.reasoning || "minimal";
  for (const [key, provider] of Object.entries(settings.providers)) provider.enabled = key === settings.defaultProvider;
  const selectedSkin = SKIN_PRESETS[skinSelect?.value] ? skinSelect.value : "custom";
  const selectedPreset = SKIN_PRESETS[selectedSkin] || SKIN_PRESETS.custom;
  settings.appearance = {
    ...(settings.appearance || {}),
    skin: selectedSkin,
    textColor: textColorInput?.value || selectedPreset.textColor,
    accentColor: accentColorInput?.value || selectedPreset.accentColor,
    backgroundColor: backgroundColorInput?.value || selectedPreset.backgroundColor,
    panelColor: panelColorInput?.value || selectedPreset.panelColor,
    fontSize: Number(fontSizeInput?.value || selectedPreset.fontSize || 16),
    skinImageFit: skinImageFitSelect?.value || settings.appearance?.skinImageFit || "cover"
  };
  settings.license = {
    ...(settings.license || {}),
    inviteCode: inviteInput?.value || "",
    unlocked: Boolean(settings.license?.unlocked)
  };
  settings.persona = {
    ...(settings.persona || {}),
    configured: Boolean(settings.persona?.configured || personaNameSettingsInput?.value?.trim() || personaPersonalitySettingsInput?.value?.trim() || personaAbilitiesSettingsInput?.value?.trim() || personaNotesSettingsInput?.value?.trim()),
    name: personaNameSettingsInput?.value?.trim() || personaNameInput?.value?.trim() || "Gantz",
    personality: personaPersonalitySettingsInput?.value?.trim() || personaPersonalityInput?.value?.trim() || "",
    abilities: personaAbilitiesSettingsInput?.value?.trim() || personaAbilitiesInput?.value?.trim() || "桌面工作、文件分析、图片识别、表格处理、运营分析和自动化任务。",
    notes: personaNotesSettingsInput?.value?.trim() || settings.persona?.notes || ""
  };
  settings.update = {
    ...(settings.update || {}),
    updateServer: /\.json(?:\?.*)?$/i.test(updateTarget) ? "" : updateTarget,
    manifestUrl: /\.json(?:\?.*)?$/i.test(updateTarget) ? updateTarget : (settings.update?.manifestUrl || ""),
    autoLaunch: Boolean(autoLaunchInput?.checked)
  };
  settings.files = {
    ...(settings.files || {}),
    saveLocation: saveLocationInput?.value?.trim() || state.db?.settings?.files?.defaultSaveLocation || "D:\\白球AI\\data\\workspace"
  };
  settings.permissions = {
    ...(settings.permissions || {}),
    accessMode: settings.permissions?.accessMode || currentAccessMode(),
    permissionModes: settings.permissions?.permissionModes || {},
    agentMode: true,
    advancedLocalExecution: (settings.permissions?.accessMode || currentAccessMode()) !== "normal"
  };
  return settings;
}

async function savePersona(configured = true) {
  state.db.settings.persona = {
    ...(state.db.settings.persona || {}),
    configured,
    name: personaNameInput?.value?.trim() || "Gantz",
    personality: personaPersonalityInput?.value?.trim() || "",
    abilities: personaAbilitiesInput?.value?.trim() || "桌面工作、文件分析、图片识别、表格处理、运营分析和自动化任务。",
    notes: state.db.settings.persona?.notes || ""
  };
  await api.saveSettings(state.db.settings);
  await api.setAutoLaunch?.(Boolean(autoLaunchInput?.checked));
  state.db = await api.init();
  renderSettings();
}

function maybeShowPersonaDialog() {
  const persona = state.db?.settings?.persona || {};
  if (!persona.configured && personaDialog && !personaDialog.open) {
    personaNameInput.value = persona.name || "";
    personaPersonalityInput.value = persona.personality || "";
    personaAbilitiesInput.value = persona.abilities || "";
    personaDialog.showModal();
  }
}

function normalizeHexColor(value) {
  const normalized = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toUpperCase() : "";
}

function syncThemeHexInputs() {
  [
    [textColorInput, textColorHexInput],
    [accentColorInput, accentColorHexInput],
    [backgroundColorInput, backgroundColorHexInput],
    [panelColorInput, panelColorHexInput]
  ].forEach(([picker, hex]) => {
    if (picker && hex) hex.value = String(picker.value || "").toUpperCase();
  });
}

function updateThemePaletteSelection(palette = "") {
  document.querySelectorAll("[data-theme-palette]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themePalette === palette);
  });
}

function setThemeSettingsDirty(dirty) {
  if (!saveThemeSettingsBtn) return;
  saveThemeSettingsBtn.hidden = !dirty;
}

function applyCustomThemeColors({ palette = "", notify = false } = {}) {
  const fallback = SKIN_PRESETS.custom;
  if (skinSelect) skinSelect.value = "custom";
  state.db.settings.appearance = {
    ...(state.db.settings.appearance || {}),
    skin: "custom",
    palette,
    textColor: textColorInput?.value || fallback.textColor,
    accentColor: accentColorInput?.value || fallback.accentColor,
    backgroundColor: backgroundColorInput?.value || fallback.backgroundColor,
    panelColor: panelColorInput?.value || fallback.panelColor,
    fontSize: Number(fontSizeInput?.value || fallback.fontSize || 16)
  };
  updateThemePaletteSelection(palette);
  applyAppearance();
  updateSettingsTabSummaries();
  setThemeSettingsDirty(true);
  if (notify) showCopyToast("主题已应用", 2000);
}

function applyThemeColorPalette(palette) {
  const colors = THEME_COLOR_PALETTES[palette];
  if (!colors) return;
  if (textColorInput) textColorInput.value = colors.textColor;
  if (accentColorInput) accentColorInput.value = colors.accentColor;
  if (backgroundColorInput) backgroundColorInput.value = colors.backgroundColor;
  if (panelColorInput) panelColorInput.value = colors.panelColor;
  syncThemeHexInputs();
  applyCustomThemeColors({ palette, notify: true });
}

function applySkinPreset(skin) {
  const normalized = SKIN_PRESETS[skin] ? skin : "custom";
  const preset = SKIN_PRESETS[normalized] || SKIN_PRESETS.custom;
  if (textColorInput) textColorInput.value = preset.textColor;
  if (accentColorInput) accentColorInput.value = preset.accentColor;
  if (backgroundColorInput) backgroundColorInput.value = preset.backgroundColor;
  if (panelColorInput) panelColorInput.value = preset.panelColor;
  if (fontSizeInput) fontSizeInput.value = preset.fontSize || 16;
  state.db.settings.appearance = {
    ...(state.db.settings.appearance || {}),
    skin: normalized,
    palette: "",
    ...preset
  };
  syncThemeHexInputs();
  updateThemePaletteSelection("");
  applyAppearance();
  updateSettingsTabSummaries();
  setThemeSettingsDirty(true);
  showCopyToast("主题已应用", 2000);
}

function switchSettingsTab(tab) {
  const previousTab = settingsDialog?.dataset.activeTab || "";
  if (tab !== "debug") releaseDebugCenterSurfaceSize();
  if (settingsDialog) settingsDialog.dataset.activeTab = tab;
  document.querySelectorAll(".settings-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === tab);
  });
  document.querySelectorAll(".settings-page").forEach((page) => {
    page.classList.toggle("active", page.dataset.settingsPage === tab);
  });
  if (previousTab !== tab) {
    const activePage = settingsDialog?.querySelector(`.settings-page[data-settings-page="${CSS.escape(String(tab))}"]`);
    if (activePage) {
      activePage.scrollTop = 0;
      activePage.scrollLeft = 0;
    }
  }
  if (tab === "update") renderUpdateInfo();
  if (tab === "skills") renderSkills(true);
  if (tab === "conscious") renderConsciousCenter();
  if (tab === "health") {
    if (blackBallRepairLastResult || blackBallScanState) renderAgentHealth();
    else loadLatestAgentHealthReport();
  }
  if (tab === "model") { renderProviderHealthPanel(); initSmartRecommend(); }
  // 刷新健康度按钮
  const healthBtn = document.getElementById('refreshProviderHealthBtn');
  if (healthBtn && !healthBtn.dataset.bound) {
    healthBtn.dataset.bound = '1';
    healthBtn.addEventListener('click', () => {
      healthBtn.textContent = '检测中...';
      healthBtn.disabled = true;
      renderProviderHealthPanel({ runCheck: true }).finally(() => {
        healthBtn.textContent = '刷新';
        healthBtn.disabled = false;
      });
    });
  }
  if (tab === "debug") {
    renderDebugCenter();
    scheduleDebugCenterSurfaceSizeLock();
  }
  if (tab === "invite") renderInviteOwner();
  if (tab === "developerLogs") renderDeveloperLogs();
}

function setSettingsTabSummary(tab, summary) {
  const button = document.querySelector(`.settings-tab[data-settings-tab="${tab}"]`);
  const node = button?.querySelector(".settings-tab-summary");
  if (!node) return;
  node.textContent = summary;
  button.dataset.summary = summary;
}

async function updateSettingsTabSummaries() {
  const settings = state.db?.settings || {};
  const providerKey = settings.defaultProvider || "deepseek";
  const provider = settings.providers?.[providerKey] || {};
  const modelCount = state.providerModels[providerKey]?.length || (provider.model ? 1 : 0);
  const skinLabel = skinSelect?.selectedOptions?.[0]?.textContent || settings.appearance?.skin || "白球蓝调";
  const savePath = saveLocationInput?.value || settings.files?.saveLocation || "默认工作区";
  const license = state.db?.licenseStatus || state.licenseStatus || {};

  setSettingsTabSummary("skin", `当前：${skinLabel}`);
  setSettingsTabSummary("model", `${provider.model || provider.name || "未选择"} · ${modelCount} 个可用模型`);
  setSettingsTabSummary("general", `${autoLaunchInput?.checked ? "已启用自启动" : "未启用自启动"} · ${savePath.split(/[\\/]/).filter(Boolean).pop() || "默认工作区"}`);
  setSettingsTabSummary("skills", "正在读取技能状态");
  setSettingsTabSummary("conscious", "正在读取最近工作状态");
  setSettingsTabSummary("health", agentHealthStatus?.textContent || "尚未检测");
  setSettingsTabSummary("debug", debugCenterStatus?.textContent || "尚未自检");
  setSettingsTabSummary("invite", license.active || license.valid || license.unlocked ? "会员已激活" : "查看会员状态");
  setSettingsTabSummary("update", `当前版本 ${appVersion?.textContent || "2.1.0"}`);

  const [skillsResult, snapshotsResult, healthResult] = await Promise.allSettled([
    api.skills?.(),
    api.consciousSnapshots?.({ includeArchived: true, limit: 1 }),
    api.latestAgentHealthReport?.()
  ]);
  if (skillsResult.status === "fulfilled" && skillsResult.value) {
    const data = skillsResult.value;
    const ready = [...(data.bundled || []), ...(data.custom || [])].filter((item) => item.builtin || String(item.status || "").toUpperCase() === "READY").length;
    setSettingsTabSummary("skills", `${ready} 个技能可用`);
  } else setSettingsTabSummary("skills", "技能状态暂不可用");
  if (snapshotsResult.status === "fulfilled") {
    const latest = snapshotsResult.value?.[0];
    setSettingsTabSummary("conscious", latest ? `${consciousDate(latest.updatedAt)} · 可继续工作` : "尚未保存工作状态");
  } else setSettingsTabSummary("conscious", "工作状态暂不可用");
  if (healthResult.status === "fulfilled" && healthResult.value) {
    setSettingsTabSummary("health", "已有历史报告 · 等待检测");
  } else {
    setSettingsTabSummary("health", "等待检测");
  }
}

async function loadLatestAgentHealthReport() {
  const report = await api.latestAgentHealthReport?.().catch(() => null);
  await renderAgentHealth(report || null);
  return report || null;
}

const HEALTH_DIMENSION_LABELS = {
  intelligence: "智能能力",
  execution: "执行能力",
  tools: "工具能力",
  stability: "稳定能力"
};

const HEALTH_DIMENSION_META = {
  intelligence: { tests: ["understanding", "context", "runtime"] },
  execution: { tests: ["planning", "delegation"] },
  tools: { tests: ["tools", "skills"] },
  stability: { tests: ["file", "runtime"] }
};

const HEALTH_TEST_LABELS = {
  runtime: "黑球运行时",
  delegation: "黑球任务委派",
  skills: "黑球技能清单",
  understanding: "意图理解",
  context: "上下文保持",
  planning: "任务规划",
  tools: "工具调用",
  file: "文件处理"
};

const HEALTH_TEST_DETAILS = {
  runtime: { task: "启动黑球并完成真实模型回合", detail: "验证黑球进程、ACP 握手、模型响应和会话标识" },
  delegation: { task: "通过黑球任务委派执行一个叶子任务", detail: "验证真实委派工具记录、任务标识和返回状态" },
  skills: { task: "读取并复检黑球技能清单", detail: "验证技能文件、注册状态和一次真实技能检查" },
  understanding: { task: "分析复杂需求并识别真实目标", detail: "验证意图分类、目标识别与需求边界" },
  context: { task: "执行连续多轮上下文保持任务", detail: "验证前文记忆、目标一致性与约束保持" },
  planning: { task: "拆解复杂任务并生成执行方案", detail: "验证步骤规划、验收标准与任务闭环" },
  tools: { task: "调用已注册工具并校验执行结果", detail: "验证工具发现、参数正确性与真实返回值" },
  file: { task: "读取测试文件并分析内容", detail: "验证文件识别、解析、关联与清理" }
};

const HEALTH_PHASE_DETAILS = {
  preparing: { status: "检测准备中", task: "初始化能力检测环境", detail: "检查当前模型、AI 运行状态与工具环境" },
  generating: { status: "检测准备中", task: "生成八项能力测试任务", detail: "建立测试输入、验证条件与结果采集器" },
  executing: { status: "AI正在执行能力测试", task: "执行真实能力任务", detail: "正在等待当前测试返回可验证结果" },
  collecting: { status: "正在生成能力报告", task: "收集执行结果", detail: "汇总成功项、失败项、错误次数与质量证据" },
  analyzing: { status: "正在生成能力报告", task: "分析能力表现", detail: "根据任务结果计算四项核心能力" },
  scoring: { status: "正在生成能力报告", task: "生成最终评分", detail: "完成评分校验后才会展示本次结果" }
};

function healthTone(score) {
  return score >= 85 ? "good" : score >= 65 ? "normal" : "risk";
}

function healthProgressPercent(progress = {}) {
  if (progress.completed) return 100;
  if (progress.phase === "preparing") return 0;
  if (progress.phase === "generating") return 16;
  if (progress.phase === "executing") {
    const completed = Number(progress.completedTests || 0);
    const hasRunning = (progress.tests || []).some((test) => test.status === "running");
    return Math.min(78, 20 + Math.round(((completed + (hasRunning ? 0.45 : 0)) / Math.max(1, Number(progress.totalTests || 8))) * 58));
  }
  if (progress.phase === "collecting") return 84;
  if (progress.phase === "analyzing") return 91;
  if (progress.phase === "scoring") return 97;
  return 0;
}

function healthScoreLabel(score) {
  return score >= 85 ? "优秀" : score >= 65 ? "良好" : "需要关注";
}

function healthTestProgress(test = {}) {
  if (test.status === "passed" || test.status === "failed") return 100;
  if (test.status === "running") return 56;
  return 0;
}

let agentHealthDisplayedProgress = 0;
let agentHealthProgressAnimation = 0;
let agentHealthRunStartedAt = 0;

function setAgentHealthProgressVisual(value) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  agentHealthDisplayedProgress = percent;
  if (agentHealthOrbit) {
    agentHealthOrbit.style.setProperty("--health-progress", String(percent));
    agentHealthOrbit.style.setProperty("--health-progress-offset", String(264 * (1 - percent / 100)));
  }
  if (blackBallRingLabel && agentHealthOrbit?.dataset.display === "score") blackBallRingLabel.textContent = `${percent}%`;
}

function animateAgentHealthProgress(target, duration = 520) {
  const to = Math.max(0, Math.min(100, Number(target) || 0));
  const from = agentHealthDisplayedProgress;
  cancelAnimationFrame(agentHealthProgressAnimation);
  if (to === from) return;
  const startedAt = performance.now();
  const tick = (now) => {
    const elapsed = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - elapsed, 3);
    setAgentHealthProgressVisual(from + ((to - from) * eased));
    if (elapsed < 1) agentHealthProgressAnimation = requestAnimationFrame(tick);
  };
  agentHealthProgressAnimation = requestAnimationFrame(tick);
}

function animateHealthDimensionScore(card, target, duration = 650) {
  const value = card?.querySelector("header > b");
  if (!card || !value) return;
  const token = String(Date.now() + Math.random());
  card.dataset.animationToken = token;
  const from = Number(value.dataset.value || 0);
  const to = Math.max(0, Math.min(100, Number(target) || 0));
  const startedAt = performance.now();
  const tick = (now) => {
    if (card.dataset.animationToken !== token) return;
    const elapsed = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - elapsed, 3);
    const current = Math.round(from + ((to - from) * eased));
    value.dataset.value = String(current);
    value.textContent = `${current}%`;
    if (elapsed < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function ensureAgentHealthDimensionCards() {
  if (!agentHealthDimensions || agentHealthDimensions.children.length === Object.keys(HEALTH_DIMENSION_LABELS).length) return;
  agentHealthDimensions.innerHTML = Object.entries(HEALTH_DIMENSION_LABELS).map(([key, label]) => `
    <article class="health-dimension pending" data-dimension="${key}">
      <header><span>${label}</span><b data-value="0">--</b></header>
      <div><i></i></div>
    </article>`).join("");
}

function renderAgentHealthDimensionCards({ dimensions = null, tests = [], running = false } = {}) {
  if (!agentHealthDimensions) return;
  ensureAgentHealthDimensionCards();
  const testMap = new Map(tests.map((test) => [test.id, test]));
  Object.entries(HEALTH_DIMENSION_LABELS).forEach(([key]) => {
    const meta = HEALTH_DIMENSION_META[key];
    const hasScore = dimensions && Number.isFinite(Number(dimensions[key]));
    const score = hasScore ? Math.max(0, Math.min(100, Number(dimensions[key]))) : 0;
    const related = meta.tests.map((id) => testMap.get(id) || { status: "pending" });
    const scanProgress = related.length ? Math.round(related.reduce((sum, test) => sum + healthTestProgress(test), 0) / related.length) : 0;
    const tone = hasScore ? healthTone(score) : running && scanProgress > 0 ? "scanning" : "pending";
    const card = agentHealthDimensions.querySelector(`[data-dimension="${key}"]`);
    if (!card) return;
    card.className = `health-dimension ${tone}`;
    const value = card.querySelector("header > b");
    const bar = card.querySelector(":scope > div > i");
    if (hasScore) animateHealthDimensionScore(card, score);
    else if (value) {
      card.dataset.animationToken = "idle";
      value.dataset.value = "0";
      value.textContent = "--";
    }
    if (bar) bar.style.width = `${hasScore ? score : scanProgress}%`;
  });
}

function renderAgentHealthPendingModules(tests = []) {
  if (!agentHealthModules) return;
  const testMap = new Map((tests || []).map((test) => [test.id, test]));
  if (agentHealthModules.children.length !== Object.keys(HEALTH_TEST_LABELS).length) {
    agentHealthModules.innerHTML = Object.entries(HEALTH_TEST_LABELS).map(([id, label]) => {
      const detail = HEALTH_TEST_DETAILS[id];
      return `<article class="health-module health-module-pending pending" data-health-module-id="${id}">
        <div class="health-module-title"><strong>${escapeHtml(label)}能力</strong><b>--</b></div>
        <div class="health-module-status"><span>等待检测</span><b>测试 --</b><b>错误 --</b><b>质量 --</b></div>
        <p>${escapeHtml(detail?.detail || "等待执行能力测试")}</p>
      </article>`;
    }).join("");
  }
  Object.keys(HEALTH_TEST_LABELS).forEach((id) => {
    const test = testMap.get(id) || { status: "pending" };
    const item = agentHealthModules.querySelector(`[data-health-module-id="${id}"]`);
    if (!item) return;
    const status = test.status || "pending";
    item.className = `health-module health-module-pending ${status}`;
    item.querySelector(".health-module-status > span").textContent = status === "running" ? "执行中" : status === "passed" ? "已完成" : status === "failed" ? "失败" : status === "skipped" ? "未启用" : "等待检测";
  });
}

function renderAgentHealthProgress(progress = null) {
  if (!agentHealthRun || !agentHealthTestList) return;
  const tests = progress?.tests || Object.entries(HEALTH_TEST_LABELS).map(([id, label]) => ({ id, label, status: "pending" }));
  agentHealthRun.dataset.active = String(Boolean(progress && !progress.completed));
  agentHealthPhase.textContent = progress?.completed ? "检测完成" : (progress?.phaseLabel || "等待开始");
  agentHealthProgressCount.textContent = `${Number(progress?.completedTests || 0)}/${Number(progress?.totalTests || tests.length)}`;
  const current = tests.find((test) => test.status === "running");
  const phaseDetail = HEALTH_PHASE_DETAILS[progress?.phase] || { status: "等待检测", task: "等待开始检测", detail: "检测开始后将依次执行八项真实能力任务" };
  const testDetail = current ? HEALTH_TEST_DETAILS[current.id] : null;
  if (agentHealthCurrentTask) agentHealthCurrentTask.textContent = testDetail?.task || phaseDetail.task;
  if (agentHealthCurrentDetail) agentHealthCurrentDetail.textContent = testDetail?.detail || phaseDetail.detail;
  if (progress?.revealScores) {
    if (progress.dimensions) renderAgentHealthDimensionCards({ dimensions: progress.dimensions });
    if (agentHealthCurrentTask) agentHealthCurrentTask.textContent = "本次能力检测已完成";
    if (agentHealthCurrentDetail) agentHealthCurrentDetail.textContent = "评分已根据真实任务结果、错误次数与响应质量生成";
  }
  if (agentHealthTestList.children.length !== tests.length) {
    agentHealthTestList.innerHTML = tests.map((test, index) => `
      <article class="health-test-item pending" data-health-test-id="${escapeHtml(test.id || "")}">
        <span class="health-test-number">${String(index + 1).padStart(2, "0")}</span>
        <div><strong>${escapeHtml(test.label || HEALTH_TEST_LABELS[test.id] || test.id)}</strong><small>${escapeHtml(HEALTH_TEST_DETAILS[test.id]?.detail || "等待能力检测")}</small><i aria-hidden="true"></i></div>
        <b>等待检测</b>
      </article>`).join("");
  }
  tests.forEach((test, index) => {
    const item = agentHealthTestList.children[index];
    if (!item) return;
    const status = test.status || "pending";
    item.className = `health-test-item ${escapeHtml(status)}`;
    item.querySelector("strong").textContent = test.label || HEALTH_TEST_LABELS[test.id] || test.id;
    item.querySelector("small").textContent = HEALTH_TEST_DETAILS[test.id]?.detail || "等待能力检测";
    item.querySelector(":scope > b").textContent = status === "passed" ? "✓ 完成" : status === "failed" ? "× 失败" : status === "skipped" ? "⊘ 跳过" : status === "running" ? "扫描中..." : "等待";
  });
  if (progress && !progress.revealScores) {
    const percent = healthProgressPercent(progress);
    agentHealthOrbit.dataset.status = "scanning";
    agentHealthOrbit.dataset.display = "progress";
    if (blackBallRingLabel) blackBallRingLabel.textContent = "检测中";
    animateAgentHealthProgress(percent);
    agentHealthStatus.textContent = progress.completed ? "正在完成检测" : phaseDetail.status;
    agentHealthMeta.textContent = current ? `正在检测：${test.label || HEALTH_TEST_LABELS[current.id] || current.id}` : (progress.phaseLabel || "AI 能力检测");
    if (agentHealthReportTitle) agentHealthReportTitle.textContent = "能力检测进行中";
    renderAgentHealthDimensionCards({ tests, running: true });
    renderAgentHealthPendingModules(tests);
  }
}

async function renderAgentHealthHistory() {
  if (!agentHealthHistory) return;
  const history = await api.agentHealthHistory?.().catch(() => []) || [];
  const recent = history.slice(-5).reverse();
  agentHealthHistory.innerHTML = recent.length ? recent.map((item, index) => {
    const previous = history[history.length - 2 - index];
    const change = previous ? (Number(item.overallScore) || 0) - (Number(previous.overallScore) || 0) : null;
    return `<div class="health-history-row">
      <time>${new Date(item.generatedAt).toLocaleString()}</time>
      <strong>${escapeHtml(item.reportVersion || "V1")}</strong>
      <b>${Number(item.overallScore) || 0} 分</b>
      <span class="${change > 0 ? "up" : change < 0 ? "down" : "flat"}">${change === null ? "首次检测" : change > 0 ? `↑ 提升 ${change} 分` : change < 0 ? `↓ 下降 ${Math.abs(change)} 分` : "无变化"}</span>
    </div>`;
  }).join("") : `<div class="health-empty">暂无检测记录</div>`;
}

let activeHealthSkillInstall = null;
const LOCAL_HEALTH_GAP_IDS = new Set(["pdf", "word", "excel", "archive", "file_management", "cpu", "memory", "disk", "port", "screenshot", "clipboard_window"]);
const OPTIONAL_HEALTH_GAP_IDS = new Set(["image", "process"]);
const NETWORK_HEALTH_GAP_IDS = new Set(["network"]);

function healthGapStageLabel(stage = "") {
  const normalized = String(stage || "").toUpperCase();
  if (["RESEARCHING", "GENERATING"].includes(normalized)) return "分析需求";
  if (normalized === "PREPARING") return "准备接入";
  if (["INSTALLING", "REGISTERING"].includes(normalized)) return "安装中";
  if (normalized === "PERSISTING") return "保存状态";
  if (["TESTING", "VERIFYING"].includes(normalized)) return "测试中";
  if (normalized === "READY") return "已启用";
  if (normalized === "FAILED") return "安装失败";
  return "准备安装";
}

function updateHealthGapInstallState(button, stage, detail = "", progress = null) {
  if (!button) return;
  const row = button.closest(".health-gap");
  const status = row?.querySelector(".health-gap-install-status");
  const bar = row?.querySelector(".health-gap-install-progress > i");
  const percent = row?.querySelector(".health-gap-install-percent");
  const normalized = String(stage || "IDLE").toUpperCase();
  const stageProgress = { IDLE: 0, PREPARING: 10, RESEARCHING: 10, GENERATING: 25, INSTALLING: 45, REGISTERING: 35, VERIFYING: 60, PERSISTING: 88, TESTING: 92, READY: 100, FAILED: Number(progress) || 0 };
  const hasProgress = progress !== null && progress !== undefined && Number.isFinite(Number(progress));
  const value = Math.max(0, Math.min(100, hasProgress ? Number(progress) : (normalized === "FAILED" ? Number(row.dataset.installProgress || 0) : stageProgress[normalized] || 0)));
  row.dataset.installStage = normalized;
  row.dataset.installProgress = String(value);
  if (status) {
    status.textContent = detail || healthGapStageLabel(normalized);
    status.title = detail || "";
  }
  if (bar) bar.style.width = `${value}%`;
  if (percent) percent.textContent = `${value}%`;
  const connectorAction = button.dataset.healthConnectorAction || "install";
  const defaultLabel = button.dataset.healthDefaultLabel || (connectorAction === "add" ? "添加工具" : connectorAction === "verify" ? "验证工具" : "自动安装");
  button.textContent = normalized === "READY"
    ? "已接入"
    : normalized === "FAILED"
      ? (connectorAction === "add" ? "重试添加" : connectorAction === "verify" ? "重新验证" : "重试")
      : normalized === "IDLE"
        ? defaultLabel
        : healthGapStageLabel(normalized);
  button.disabled = !["IDLE", "FAILED", "READY"].includes(normalized);
}

async function autoInstallHealthSkill(button) {
  const name = button?.dataset.healthSkill || "";
  const suggestion = button?.dataset.healthSuggestion || "";
  if (!button || !name || button.disabled) return;
  activeHealthSkillInstall = { button, name };
  updateHealthGapInstallState(button, "RESEARCHING", "正在确认来源", 10);
  try {
    const source = `${suggestion || `为白球 AI 补充${name}能力`}。请分析需求、创建 Skill、安装所需依赖、注册到工具中心，并完成真实调用测试。`;
    let result = await api.learnSkill({ source, name });
    if (result?.confirmationRequired) {
      const detail = result.confirmation || {};
      const confirmed = await showAppConfirm({
        title: `安装 ${name}`,
        message: `来源：${detail.source?.repository || "技能仓库"}\n权限：${detail.permissions?.join("、") || "本地技能文件"}\n确认后将继续安装并执行测试。`,
        primary: "确认安装",
        secondary: "取消"
      });
      if (!confirmed) throw new Error("已取消安装");
      result = await api.learnSkill({ source: result.selectedSource || source, name, confirmed: true, confirmationHash: result.confirmationHash });
    }
    if (!result?.success || result?.status !== "READY" || !result?.verification?.verified) {
      throw new Error(result?.error || "技能未通过真实调用测试");
    }
    updateHealthGapInstallState(button, "READY", "已安装、注册并通过测试");
    showCopyToast(`${result.item?.name || name} 已启用`, 2000);
    if (skillList) skillList.dataset.loaded = "0";
    await renderSkills(true);
    await runAgentHealthCheck({ silent: true });
  } catch (error) {
    updateHealthGapInstallState(button, "FAILED", error.message || String(error));
  } finally {
    activeHealthSkillInstall = null;
  }
}

async function connectHealthTool(button) {
  const capabilityId = button?.dataset.healthCapability || "";
  if (!button || !capabilityId || button.disabled) return;
  updateHealthGapInstallState(button, "PREPARING", "正在提交接入请求", 0);
  try {
    const result = await api.agentHealthConnectTool?.(capabilityId);
    if (!result?.success) throw new Error(result?.error || "本地工具接入失败");
    updateHealthGapInstallState(button, "READY", "已接入并通过真实调用验证", 100);
    await runAgentHealthCheck({ silent: true });
  } catch (error) {
    updateHealthGapInstallState(button, "FAILED", error.message || String(error));
  }
}

async function renderAgentHealth(report = undefined) {
  if (!agentHealthDimensions || !agentHealthModules || !agentHealthGaps) return;
  if (report === undefined && blackBallRepairLastResult) {
    renderBlackBallRepairResult(blackBallRepairLastResult);
    return;
  }
  if (report === undefined && blackBallScanState) {
    renderBlackBallScan(blackBallScanState);
    return;
  }
  const current = report === undefined ? null : report;
  if (!current) {
    agentHealthOrbit.dataset.status = "idle";
    agentHealthOrbit.dataset.display = "empty";
    agentHealthOrbit.style.setProperty("--health-progress", "0");
    agentHealthOrbit.style.setProperty("--health-progress-offset", "264");
    agentHealthDisplayedProgress = 0;
    setBlackBallIssueCount(null);
    agentHealthStatus.textContent = "等待检测";
    agentHealthMeta.textContent = "专业 AI 能力体检";
    agentHealthVersion.textContent = "--";
    if (agentHealthReportTitle) agentHealthReportTitle.textContent = "能力检测项目";
    renderAgentHealthDimensionCards();
    renderAgentHealthPendingModules();
    agentHealthGaps.innerHTML = `<div class="health-empty">完成本次检测后生成技能缺口建议</div>`;
    renderAgentHealthProgress();
    await renderAgentHealthHistory();
    return;
  }
  const score = Math.max(0, Math.min(100, Number(current.overallScore) || 0));
  agentHealthOrbit.dataset.status = healthTone(score);
  agentHealthOrbit.dataset.display = "score";
  cancelAnimationFrame(agentHealthProgressAnimation);
  setAgentHealthProgressVisual(0);
  animateAgentHealthProgress(score, 700);
  agentHealthStatus.textContent = healthScoreLabel(score);
  agentHealthMeta.textContent = `健康状态：${healthScoreLabel(score)}`;
  agentHealthVersion.textContent = current.reportVersion || "V1";
  if (agentHealthReportTitle) agentHealthReportTitle.textContent = "AI能力报告";
  const testSummary = current.evidence?.testSummary;
  renderAgentHealthProgress(testSummary ? {
    completed: true,
    revealScores: true,
    phaseLabel: "检测完成",
    completedTests: Number(testSummary.passed || 0) + Number(testSummary.failed || 0) + Number(testSummary.skipped || 0),
    totalTests: Number(testSummary.total || 5),
    tests: testSummary.tests || []
  } : null);
  renderAgentHealthDimensionCards({ dimensions: current.dimensions || {} });
  agentHealthModules.innerHTML = (current.modules || []).map((module) => {
    const tests = module.tests || module.checks || [];
    const passed = tests.filter((item) => item.passed).length;
    const skipped = tests.filter((item) => item.skipped === true || String(item.status || "").toLowerCase() === "skipped").length;
    const errors = Number(module.errors ?? Math.max(0, tests.length - passed));
    const moduleTone = module.status === "未启用" ? "pending" : healthTone(module.score);
    return `
    <article class="health-module ${moduleTone}">
      <div class="health-module-title"><strong>${escapeHtml(module.name || "能力模块")}</strong><b>${module.status === "未启用" ? "--" : `${Number(module.score) || 0}分`}</b></div>
      <div class="health-module-status"><span>${escapeHtml(module.status || "未评估")}</span><b>测试 ${passed}/${tests.length || 0}</b><b>${skipped ? `跳过 ${skipped} 项` : `错误 ${errors} 次`}</b><b>质量 ${escapeHtml(module.quality || "已评估")}</b></div>
      <p>${escapeHtml(module.detail || "暂无详细说明")}</p>
    </article>
  `;
  }).join("");
  const phaseRank = { P0: 0, P1: 1, P2: 2 };
  const gaps = [...(current.priorityRecommendations || current.capabilityGaps || [])].sort((a, b) => {
    const phaseDifference = (phaseRank[a.phase] ?? 1) - (phaseRank[b.phase] ?? 1);
    return phaseDifference || (Number(b.priorityScore || 0) - Number(a.priorityScore || 0));
  });
  agentHealthGaps.innerHTML = gaps.length ? gaps.map((gap) => {
    const gapId = String(gap.id || "");
    const connectable = gap.connectable === true || LOCAL_HEALTH_GAP_IDS.has(gapId) || OPTIONAL_HEALTH_GAP_IDS.has(gapId) || NETWORK_HEALTH_GAP_IDS.has(gapId);
    const installable = gap.installable === true;
    const reportedAction = String(gap.connectorAction || "");
    const connectorAction = reportedAction && reportedAction !== "unavailable"
      ? reportedAction
      : OPTIONAL_HEALTH_GAP_IDS.has(gapId)
        ? "add"
        : connectable
          ? "verify"
          : "unavailable";
    const action = connectable ? "connect" : installable ? "install" : "none";
    const disabled = action === "none" ? "disabled" : "";
    const status = connectorAction === "add" ? "可添加内置工具" : connectorAction === "verify" ? "已安装，等待验证" : installable ? "准备安装" : "尚未提供";
    const buttonLabel = connectorAction === "add" ? "添加工具" : connectorAction === "verify" ? "验证工具" : installable ? "自动安装" : "尚未提供";
    return `
    <div class="health-gap ${action === "none" ? "health-gap-uninstallable" : ""}" data-install-stage="IDLE" data-install-progress="0">
      <b data-phase="${escapeHtml(gap.phase || "P1")}">${escapeHtml(gap.phase || "P1")}</b>
      <div><strong>${escapeHtml(gap.name || gap.id || "能力缺口")}</strong><span>${escapeHtml(gap.suggestion || "建议补充对应技能")}</span></div>
      <div class="health-gap-install"><span class="health-gap-install-status">${status}</span><i class="health-gap-install-progress"><i></i></i><b class="health-gap-install-percent">0%</b></div>
      <button type="button" data-health-action="${action}" data-health-connector-action="${connectorAction}" data-health-default-label="${buttonLabel}" data-health-capability="${escapeHtml(gap.id || "")}" data-health-installable="${installable ? "true" : "false"}" data-health-skill="${installable ? escapeHtml(gap.name || gap.id || "") : ""}" data-health-suggestion="${installable ? escapeHtml(gap.suggestion || "") : ""}" ${disabled}>${buttonLabel}</button>
    </div>
  `;
  }).join("") : `<div class="health-empty">当前核心能力没有明显缺口</div>`;
  agentHealthGaps.querySelectorAll("[data-health-action]").forEach((button) => {
    button.addEventListener("click", () => button.dataset.healthAction === "connect" ? connectHealthTool(button) : autoInstallHealthSkill(button));
  });
  await renderAgentHealthHistory();
}

function consciousDate(value) {
  try { return new Date(value).toLocaleString(); } catch { return String(value || ""); }
}

function consciousArchiveStatus(item) {
  const completed = Number(item.progress || 0) >= 100 || /completed|done|已完成|完成/i.test(`${item.status || ""} ${item.currentStage || ""}`);
  if (item.archived) return { key: "archived", label: "已归档", tone: "archived" };
  if (completed) return { key: "completed", label: "已完成", tone: "saved" };
  if (/running|executing|工作中|进行中|执行中/i.test(`${item.status || ""} ${item.currentStage || ""}`)) return { key: "working", label: "运行中", tone: "working" };
  return { key: "working", label: "已保存", tone: "saved" };
}

function groupConsciousSnapshots(items) {
  const groups = new Map();
  for (const item of items || []) {
    const key = `${item.scope || "session"}:${item.sourceId || item.projectId || item.sessionId || item.title || item.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map((history) => {
    history.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return { ...history[0], history };
  });
}

function consciousListHtml(items, emptyText = "暂无工作状态") {
  if (!items?.length) return `<div class="conscious-empty"><i></i><strong>${escapeHtml(emptyText)}</strong><span>白球会在任务完成、定时保存和退出前记录当前工作状态</span></div>`;
  return items.map((item) => {
    const stateLabel = consciousArchiveStatus(item);
    const stage = item.currentStage || item.currentObjective || item.status || "等待继续工作";
    return `
    <article class="conscious-snapshot-card black-core-archive-row${item.archived ? " archived" : ""}" data-snapshot-id="${escapeHtml(item.id)}">
      <div class="conscious-card-head">
        <div><strong>${escapeHtml(item.title || "工作状态")}</strong><span>${escapeHtml(item.scope === "project" ? "项目意识" : "会话意识")}</span></div>
      </div>
      <div class="conscious-card-meta"><div class="conscious-card-stage"><span>阶段</span><strong>${escapeHtml(stage)}</strong></div><div class="conscious-card-state"><span>状态</span><b class="${stateLabel.tone}"><i></i>${stateLabel.label}</b></div><div class="conscious-card-updated"><span>更新</span><time>${escapeHtml(consciousDate(item.updatedAt))}</time></div></div>
    </article>
  `;
  }).join("");
}

async function renderConsciousCenter() {
  if (!consciousSnapshotList) return;
  consciousSnapshotList.innerHTML = `<div class="conscious-loading"><i></i><span>正在读取意识索引</span></div>`;
  const query = consciousSearchInput?.value?.trim() || "";
  const includeArchived = true;
  const items = await api.consciousSnapshots({ query, includeArchived }).catch(() => []);
  const records = groupConsciousSnapshots(items);
  consciousHistoryCache = new Map(records.map((item) => [item.id, item.history]));
  consciousSnapshotList.innerHTML = consciousListHtml(records, query ? "没有匹配的意识档案" : "暂无意识档案");
  consciousSnapshotList.querySelectorAll("[data-snapshot-id]").forEach((card) => {
    card.addEventListener("click", async () => {
      const id = card.dataset.snapshotId;
      const record = records.find((item) => item.id === id);
      if (record) {
        blackCoreRuntime.selectedSnapshotId = id;
        const profile = await api.blackCoreProfile?.(record.scope, record.sourceId).catch(() => null);
        if (profile) renderBlackCoreProfile(profile);
        consciousSnapshotList.querySelectorAll("[data-snapshot-id]").forEach((row) => row.classList.toggle("selected", row === card));
      }
    });
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showConsciousContextMenu(event.clientX, event.clientY, card.dataset.snapshotId, card);
    });
  });
  const selected = records.find((item) => item.id === blackCoreRuntime.selectedSnapshotId) || records[0];
  if (selected) {
    blackCoreRuntime.selectedSnapshotId = selected.id;
    const profile = await api.blackCoreProfile?.(selected.scope, selected.sourceId).catch(() => null);
    if (profile) renderBlackCoreProfile(profile);
  }
}

function closeConsciousContextMenu() {
  document.querySelector(".black-core-conscious-menu")?.remove();
}

function showConsciousContextMenu(x, y, id, host) {
  closeConsciousContextMenu();
  const menu = document.createElement("div");
  menu.className = "black-core-conscious-menu";
  menu.innerHTML = `<button type="button" data-conscious-context="continue">继续工作</button><button type="button" class="danger" data-conscious-context="delete">删除意识</button>`;
  document.body.appendChild(menu);
  const width = 132;
  const height = 72;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, x))}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, y))}px`;
  menu.addEventListener("click", (event) => {
    const action = event.target.closest("[data-conscious-context]")?.dataset.consciousContext;
    if (!action) return;
    closeConsciousContextMenu();
    if (action === "continue") void continueConsciousWorkFromUi(id, host);
    if (action === "delete") void deleteConsciousSnapshotFromUi(id);
  });
  const dismissOutside = (event) => {
    if (menu.contains(event.target)) return;
    closeConsciousContextMenu();
    document.removeEventListener("pointerdown", dismissOutside, true);
  };
  requestAnimationFrame(() => document.addEventListener("pointerdown", dismissOutside, true));
}

async function deleteConsciousSnapshotFromUi(id) {
  try {
    await api.deleteConsciousSnapshot(id);
    if (blackCoreRuntime.selectedSnapshotId === id) blackCoreRuntime.selectedSnapshotId = "";
    if (consciousSnapshotDetail) consciousSnapshotDetail.hidden = true;
    if (consciousSnapshotList) consciousSnapshotList.hidden = false;
    await renderConsciousCenter();
    showCopyToast("意识资产已删除", 1800);
  } catch (error) {
    await showAppAlert({ title: "删除失败", message: error.message || String(error) });
  }
}

function showConsciousHistory(id) {
  const history = consciousHistoryCache.get(id) || [];
  if (!consciousSnapshotDetail) return;
  const current = history[0] || {};
  consciousSnapshotDetail.innerHTML = `
    <div class="conscious-detail-head"><div><span>意识历史档案</span><strong>${escapeHtml(current.title || "工作状态")}</strong></div><button type="button" data-detail-close aria-label="关闭历史">×</button></div>
    <div class="conscious-history-list">${history.map((item) => `
      <article><div><strong>V${Number(item.version || 1)}</strong><span>${item.auto ? "自动保存" : "手动保存"}</span></div><time>${escapeHtml(consciousDate(item.updatedAt))}</time><button type="button" data-history-continue="${escapeHtml(item.id)}">继续工作</button></article>
    `).join("")}</div>
  `;
  consciousSnapshotDetail.hidden = false;
  consciousSnapshotList.hidden = true;
  consciousSnapshotDetail.querySelector("[data-detail-close]")?.addEventListener("click", () => {
    consciousSnapshotDetail.hidden = true;
    consciousSnapshotList.hidden = false;
  });
  consciousSnapshotDetail.querySelectorAll("[data-history-continue]").forEach((button) => button.addEventListener("click", () => continueConsciousWorkFromUi(button.dataset.historyContinue, consciousSnapshotDetail)));
}

async function showConsciousSnapshotDetail(id) {
  const owner = await api.ownerStatus?.().catch(() => ({ devMode: false }));
  if (!owner?.devMode) return;
  const snapshot = await api.consciousSnapshot(id).catch(() => null);
  if (!snapshot || !consciousSnapshotDetail) return;
  const core = snapshot.core || {};
  const rows = [
    ["用户目标", snapshot.user_goal || core.goal || snapshot.projectGoal],
    ["当前目标", snapshot.current_objective || snapshot.currentTaskGoal],
    ["当前阶段", snapshot.current_stage || core.current_stage || snapshot.currentProgress?.summary],
    ["已完成", (snapshot.completed_tasks || core.completed_tasks || snapshot.completedTasks || []).join("；")],
    ["下一步", (snapshot.next_actions || snapshot.pending_tasks || core.pending_tasks || []).join("；")],
    ["重要约束", (snapshot.constraints || core.constraints || snapshot.projectConstraints || []).join("；")],
    ["确认决策", (snapshot.decisions || core.decisions || snapshot.coreDecisions || []).map((item) => item.decision || item).join("；")],
    ["Agent 状态", (snapshot.agent_state || core.agent_state || snapshot.agentStates || []).map((item) => `${item.name || item.currentAgent || item.type || "Agent"} · ${item.status || item.state || "waiting"}`).join("；")],
    ["重要文件", (snapshot.important_files || core.important_files || snapshot.fileChanges || []).map((item) => item.name || item.path || item).join("；")],
    ["上下文压缩", snapshot.distillation ? `${Number(snapshot.distillation.originalMessages || 0)} 条 → ${Number(snapshot.distillation.distilledMessages || 1)} 条，减少 ${Number(snapshot.distillation.reductionPercent || 0)}%` : "旧版快照"]
  ].filter(([, value]) => value);
  consciousSnapshotDetail.innerHTML = `
    <div class="conscious-detail-head"><div><span>开发者模式 · ${snapshot.scope === "project" ? "项目工作状态" : "会话工作状态"} · V${Number(snapshot.version || 1)}</span><strong>${escapeHtml(snapshot.title || "工作状态")}</strong></div><button type="button" data-detail-close aria-label="关闭详情">×</button></div>
    <div class="conscious-detail-meta"><span>${escapeHtml(snapshot.status || "已保存")}</span><span>${escapeHtml(consciousDate(snapshot.updatedAt))}</span>${snapshot.important ? "<b>★ 重要意识</b>" : ""}</div>
    <div class="conscious-detail-grid">${rows.map(([label, value]) => `<section><span>${escapeHtml(label)}</span><p>${escapeHtml(String(value))}</p></section>`).join("")}</div>
    <div class="conscious-detail-actions"><button type="button" data-detail-close>返回</button><button type="button" class="primary" data-detail-continue>继续工作</button></div>
  `;
  consciousSnapshotDetail.hidden = false;
  consciousSnapshotList.hidden = true;
  consciousSnapshotDetail.querySelectorAll("[data-detail-close]").forEach((button) => button.addEventListener("click", () => {
    consciousSnapshotDetail.hidden = true;
    consciousSnapshotList.hidden = false;
  }));
  consciousSnapshotDetail.querySelector("[data-detail-continue]")?.addEventListener("click", () => continueConsciousWorkFromUi(id, consciousSnapshotDetail));
}

async function continueConsciousWorkFromUi(id, host) {
  const previous = host.innerHTML;
  host.innerHTML = `
    <div class="conscious-restore-progress">
      <i class="conscious-restore-spinner"></i><strong>正在加载工作状态...</strong>
      <ul><li>✓ 项目目标</li><li>✓ 历史决策</li><li>✓ 当前任务</li><li>✓ 用户偏好</li><li class="active">Agent 状态</li></ul>
    </div>
  `;
  try {
    const result = await api.continueConsciousSnapshot(id);
    blackCoreRuntime.returnToConsciousCenter = false;
    closeBlackCore({ force: true });
    const targetSessionId = result.sessionId || result.db?.selectedSessionId || "";
    if (!targetSessionId) throw new Error("意识已恢复，但没有找到对应工作会话");
    state.db = await api.selectSession(targetSessionId);
    state.selectedSessionId = targetSessionId;
    if (result.projectId) state.expandedProjectIds.add(result.projectId);
    await renderAll();
    settingsDialog?.close();
  } catch (error) {
    host.innerHTML = previous;
    await showAppAlert({ title: "继续工作失败", message: error.message || String(error) });
  }
}

function bindDialogOutsideDismiss(dialog, dismiss) {
  if (!dialog || typeof dismiss !== "function" || dialog.dataset.outsideDismissBound === "1") return;
  dialog.dataset.outsideDismissBound = "1";
  let startedOnBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => {
    startedOnBackdrop = event.target === dialog;
  });
  dialog.addEventListener("pointerup", (event) => {
    const shouldDismiss = startedOnBackdrop && event.target === dialog;
    startedOnBackdrop = false;
    if (!shouldDismiss) return;
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(dismiss(event)).catch(() => null);
  });
  dialog.addEventListener("pointercancel", () => {
    startedOnBackdrop = false;
  });
}

function openSettingsTab(tab, mode = "external") {
  if (tab !== "debug") releaseDebugCenterSurfaceSize();
  settingsDialog.dataset.mode = mode;
  settingsDialog.showModal();
  switchSettingsTab(tab);
  updateSettingsTabSummaries();
  requestAnimationFrame(() => renderSettings({ heavy: true }));
}

function openConsciousCenter() {
  void openBlackCoreCenter();
}

async function extractCurrentConsciousnessFromCenter() {
  const session = selectedSession();
  if (!session) {
    showCopyToast("请先选择一个项目或会话");
    return;
  }
  const project = session.projectId ? state.db.projects.find((item) => item.id === session.projectId) : null;
  const scope = project ? "project" : "session";
  const sourceId = project?.id || session.id;
  const title = project?.name || projectSessionDisplayName(session) || "当前意识";
  if (blackCoreCenterExtractBtn) blackCoreCenterExtractBtn.disabled = true;
  blackCoreRuntime.returnToConsciousCenter = true;
  closeConsciousCenter();
  try {
    const result = await runBlackCoreExtraction(scope, sourceId, title);
    if (!result?.ok) blackCoreRuntime.returnToConsciousCenter = false;
  } finally {
    if (blackCoreCenterExtractBtn) blackCoreCenterExtractBtn.disabled = false;
  }
}

function closeConsciousCenter() {
  if (blackCoreRuntime.active && blackCoreLayer?.dataset.mode === "center") closeBlackCore();
}

consciousCenterCloseBtn?.addEventListener("click", closeConsciousCenter);
consciousExtractBtn?.addEventListener("click", () => { void extractCurrentConsciousnessFromCenter(); });
blackCoreCenterExtractBtn?.addEventListener("click", () => { void extractCurrentConsciousnessFromCenter(); });
consciousCenterLayer?.addEventListener("pointerdown", (event) => {
  if (event.target === consciousCenterLayer) closeConsciousCenter();
});

const KNOWLEDGE_CATEGORY_FALLBACK = [
  { id: "core", label: "核心项目" },
  { id: "assets", label: "沉淀资产" },
  { id: "resources", label: "外部资源" },
  { id: "archive", label: "归档内容" },
  { id: "ideas", label: "灵感库" },
  { id: "templates", label: "技能模板" }
];
const KNOWLEDGE_MOTION_STORAGE_KEY = "baiqiu.knowledgeUniverseMotion";
let knowledgeVaultCache = null;
let selectedKnowledgeCategory = "all";
let selectedKnowledgeNoteId = "";
let knowledgeEditorDirty = false;
let knowledgeUniverseZoom = 1;
let knowledgeMotionMode = "static";
let gantzSkillAuditInFlight = null;

function knowledgeHash(value = "") {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function knowledgeFusionCandidates(notes = []) {
  let count = 0;
  for (let left = 0; left < notes.length; left += 1) {
    const leftTags = new Set((notes[left]?.tags || []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean));
    if (!leftTags.size) continue;
    for (let right = left + 1; right < notes.length; right += 1) {
      if ((notes[right]?.tags || []).some((tag) => leftTags.has(String(tag).trim().toLowerCase()))) count += 1;
    }
  }
  return count;
}

function knowledgeCoreGrade(total, units) {
  if (total >= 50 || units >= 30000) return "S";
  if (total >= 24 || units >= 12000) return "A";
  if (total >= 12 || units >= 5000) return "B";
  if (total >= 5 || units >= 1600) return "C";
  return "D";
}

function setKnowledgeUniverseZoom(value) {
  knowledgeUniverseZoom = Math.max(0.65, Math.min(1.5, Number(value) || 1));
  if (knowledgeUniverseScene) knowledgeUniverseScene.style.setProperty("--universe-zoom", knowledgeUniverseZoom.toFixed(2));
  if (gantzZoomValue) gantzZoomValue.textContent = `${Math.round(knowledgeUniverseZoom * 100)}%`;
}

function setKnowledgeMotion(mode, { persist = true } = {}) {
  knowledgeMotionMode = mode === "static" ? "static" : "dynamic";
  knowledgeUniverse?.setAttribute("data-motion", knowledgeMotionMode);
  knowledgeUniverse?.setAttribute("data-mode", knowledgeMotionMode);
  growthCenterDialog?.querySelector(".growth-center-shell")?.setAttribute("data-motion", knowledgeMotionMode);
  growthCenterDialog?.setAttribute("data-motion", knowledgeMotionMode);
  for (const button of knowledgeMotionButtons) {
    const active = button.dataset.knowledgeMotion === knowledgeMotionMode;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-active", active);
    button.dataset.active = active ? "1" : "0";
  }
  if (persist) {
    try { localStorage.setItem(KNOWLEDGE_MOTION_STORAGE_KEY, knowledgeMotionMode); } catch {}
    if (state.db?.settings) {
      state.db.settings = { ...state.db.settings, knowledgeMotion: knowledgeMotionMode };
      void api.saveSettings(state.db.settings).catch(() => null);
    }
  }
}

function syncKnowledgeTheme() {
  if (!growthCenterDialog) return "light";
  const theme = browserThemeFromCurrentDocument();
  growthCenterDialog.dataset.theme = theme.scheme;
  for (const [name, value] of Object.entries({
    "--gantz-blue": theme.accent,
    "--gantz-blue-soft": theme.accentSoft,
    "--gantz-panel": theme.panel,
    "--gantz-silver": theme.text,
    "--gantz-muted": theme.muted,
    "--gantz-line": theme.line,
    "--gantz-line-strong": theme.lineStrong
  })) growthCenterDialog.style.setProperty(name, value);
  return theme.scheme;
}

function renderSkillAuditRecord(record = null, state = "idle") {
  gantzSkillAudit?.setAttribute("data-state", state);
  if (!record) {
    if (gantzSkillAuditStatus) gantzSkillAuditStatus.textContent = state === "detecting" ? "检测中" : "未检测";
    if (gantzSkillScanned) gantzSkillScanned.textContent = state === "detecting" ? "..." : "--";
    if (gantzSkillRemoved) gantzSkillRemoved.textContent = state === "detecting" ? "..." : "--";
    if (gantzSkillConflicts) gantzSkillConflicts.textContent = state === "detecting" ? "..." : "--";
    if (gantzSkillAuditRecord) gantzSkillAuditRecord.textContent = state === "detecting" ? "正在读取 Hermes 本地技能目录" : "尚无检测记录";
    return;
  }
  const executedAt = new Date(record.executedAt || Date.now());
  const timestamp = Number.isNaN(executedAt.getTime()) ? "时间未记录" : executedAt.toLocaleString("zh-CN", { hour12: false });
  if (gantzSkillAuditStatus) gantzSkillAuditStatus.textContent = "已完成";
  if (gantzSkillScanned) gantzSkillScanned.textContent = String(Number(record.scanned || 0));
  if (gantzSkillRemoved) gantzSkillRemoved.textContent = String(Number(record.removedCount || 0));
  if (gantzSkillConflicts) gantzSkillConflicts.textContent = String(Number(record.conflictCount ?? record.conflicts?.length ?? 0));
  if (gantzSkillAuditRecord) gantzSkillAuditRecord.textContent = `${timestamp} · 剩余 ${Number(record.remaining || 0)} 项`;
}

async function deduplicateSkillsFromAudit() {
  if (gantzSkillAuditInFlight) return gantzSkillAuditInFlight;
  gantzSkillAuditInFlight = (async () => {
    renderSkillAuditRecord(null, "detecting");
    if (gantzSkillAuditBtn) {
      gantzSkillAuditBtn.disabled = true;
      gantzSkillAuditBtn.textContent = "正在检测";
    }
    if (gantzUniverseStatus) gantzUniverseStatus.textContent = "DEDUPING";
    try {
      const result = await api.deduplicateSkills?.();
      if (!result?.success) throw new Error(result?.error || "技能去重接口未完成");
      const removed = Number(result.removedCount || 0);
      const conflicts = Number(result.conflicts?.length || 0);
      renderSkillAuditRecord(result.record || result, "completed");
      if (gantzUniverseStatus) gantzUniverseStatus.textContent = removed ? `DEDUPED ${removed}` : "DEDUPED";
      showCopyToast(`真实技能检测完成：移除 ${removed} 个重复项${conflicts ? `，保留 ${conflicts} 个内容冲突项` : ""}`, 2400);
      return result;
    } catch (error) {
      gantzSkillAudit?.setAttribute("data-state", "failed");
      if (gantzSkillAuditStatus) gantzSkillAuditStatus.textContent = "失败";
      if (gantzSkillAuditRecord) gantzSkillAuditRecord.textContent = error.message || String(error);
      if (gantzUniverseStatus) gantzUniverseStatus.textContent = "ERROR";
      showCopyToast(`技能去重失败：${error.message || String(error)}`, 3000);
      return { success: false, error: error.message || String(error) };
    } finally {
      if (gantzSkillAuditBtn) {
        gantzSkillAuditBtn.disabled = false;
        gantzSkillAuditBtn.textContent = "再次检测并去重";
      }
      if (knowledgeVaultCache) renderKnowledgeUniverse();
      gantzSkillAuditInFlight = null;
    }
  })();
  return gantzSkillAuditInFlight;
}

function storedKnowledgeMotion() {
  try {
    const stored = localStorage.getItem(KNOWLEDGE_MOTION_STORAGE_KEY);
    if (stored === "dynamic" || stored === "static") return stored;
  } catch {}
  return state.db?.settings?.knowledgeMotion === "dynamic" ? "dynamic" : "static";
}

function knowledgePlanetCoordinates(index, total) {
  const ringCounts = total <= 8 ? [Math.max(1, total)] : total <= 18 ? [8, total - 8] : [8, 10, total - 18];
  const radii = [132, 205, 282];
  let offset = index;
  let ring = 0;
  while (ring < ringCounts.length - 1 && offset >= ringCounts[ring]) {
    offset -= ringCounts[ring];
    ring += 1;
  }
  const count = Math.max(1, ringCounts[ring]);
  const angle = ((offset / count) * Math.PI * 2) - (Math.PI / 2) + ring * 0.23;
  return {
    x: Math.cos(angle) * radii[ring],
    y: Math.sin(angle) * radii[ring] * 0.72
  };
}

function renderKnowledgeUniverse() {
  const notes = filteredKnowledgeNotes();
  const allNotes = knowledgeVaultCache?.notes || [];
  const categories = knowledgeCategories();
  const total = Number(knowledgeVaultCache?.total || 0);
  const errors = Array.isArray(knowledgeVaultCache?.scanErrors) ? knowledgeVaultCache.scanErrors.length : 0;
  const fusionCount = knowledgeFusionCandidates(allNotes);
  if (knowledgeUniverse) knowledgeUniverse.dataset.phase = errors ? "anomaly" : total ? "online" : "idle";
  if (gantzUniverseStatus) gantzUniverseStatus.textContent = errors ? "ANOMALY" : total ? "ONLINE" : "EMPTY";
  if (gantzFusionCount) gantzFusionCount.textContent = String(fusionCount);
  if (gantzRiskLevel) gantzRiskLevel.textContent = errors >= 3 ? "HIGH" : errors ? "MEDIUM" : "LOW";
  const axis = knowledgeUniverse?.querySelector(".axis-north");
  if (axis) axis.textContent = `ABILITY DOMAIN / ${String(total).padStart(2, "0")}`;

  if (knowledgeOrbitLayer) {
    knowledgeOrbitLayer.innerHTML = categories.map((item, index) => {
      const angle = ((index * 360) / Math.max(1, categories.length)) - 90;
      const radius = 210 + ((index % 2) * 34);
      const radians = angle * Math.PI / 180;
      const x = (Math.cos(radians) * radius).toFixed(1);
      const y = (Math.sin(radians) * radius * 0.72).toFixed(1);
      return `<button type="button" class="gantz-domain${item.id === selectedKnowledgeCategory ? " active" : ""}" data-knowledge-category="${escapeHtml(item.id)}" style="--domain-x:${x}px;--domain-y:${y}px;--domain-delay:${(index * -1.7).toFixed(1)}s" title="${escapeHtml(item.label)}：${Number(item.count || 0)} 条"><i></i><span>${escapeHtml(item.label)}</span><b>${Number(item.count || 0)}</b></button>`;
    }).join("");
  }

  if (knowledgePlanetLayer) {
    const visible = notes.slice(0, 32);
    knowledgePlanetLayer.innerHTML = visible.map((note, index) => {
      const hash = knowledgeHash(note.id || note.title || index);
      const point = knowledgePlanetCoordinates(index, visible.length);
      const x = point.x.toFixed(1);
      const y = point.y.toFixed(1);
      const level = Math.max(1, Math.min(9, Number(note.level || 1)));
      const size = 25 + level * 2.6;
      const selected = note.id === selectedKnowledgeNoteId ? " selected" : "";
      return `<button type="button" class="gantz-knowledge-planet${selected}" data-knowledge-note="${escapeHtml(note.id)}" style="--planet-x:${x}px;--planet-y:${y}px;--planet-size:${size.toFixed(1)}px;--planet-delay:${((hash % 70) / -10).toFixed(1)}s" title="${escapeHtml(note.title)} · Lv${level}"><i></i><strong>${escapeHtml(note.title || "未命名知识")}</strong><small>LV ${level} · ${Number(note.progress || 0)}%</small></button>`;
    }).join("") || `<div class="gantz-empty-orbit"><strong>NO KNOWLEDGE OBJECTS</strong><span>新建知识后，真实 Markdown 会在这里形成星体。</span></div>`;
  }
}

function openKnowledgeEditor() {
  growthCenterDialog?.querySelector(".knowledge-editor-panel")?.setAttribute("data-open", "true");
}

function closeKnowledgeEditor() {
  growthCenterDialog?.querySelector(".knowledge-editor-panel")?.setAttribute("data-open", "false");
}

function knowledgeCategories() {
  return Array.isArray(knowledgeVaultCache?.categories) && knowledgeVaultCache.categories.length
    ? knowledgeVaultCache.categories
    : KNOWLEDGE_CATEGORY_FALLBACK.map((item) => ({ ...item, count: 0 }));
}

function knowledgeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未记录" : date.toLocaleString("zh-CN", { hour12: false });
}

function shortKnowledgePath(value = "") {
  const parts = String(value || "").split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `...\\${parts.slice(-3).join("\\")}` : (value || "未设置");
}

function setKnowledgeDirty(dirty) {
  knowledgeEditorDirty = Boolean(dirty);
  if (saveKnowledgeNoteBtn) {
    saveKnowledgeNoteBtn.disabled = !selectedKnowledgeNoteId;
    saveKnowledgeNoteBtn.textContent = knowledgeEditorDirty ? "保存 *" : "保存";
  }
  if (knowledgeEditorStatus && selectedKnowledgeNoteId) knowledgeEditorStatus.textContent = knowledgeEditorDirty ? "有未保存修改" : "已保存到本地 Markdown";
}

function filteredKnowledgeNotes() {
  const query = (knowledgeSearchInput?.value || "").trim().toLowerCase();
  return (knowledgeVaultCache?.notes || []).filter((note) => {
    if (selectedKnowledgeCategory !== "all" && note.category !== selectedKnowledgeCategory) return false;
    if (!query) return true;
    return [note.title, note.categoryLabel, note.excerpt, ...(note.tags || [])].some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function renderKnowledgeStats() {
  const total = Number(knowledgeVaultCache?.total || 0);
  const units = Number(knowledgeVaultCache?.totalKnowledgeUnits || 0);
  const fusionCount = knowledgeFusionCandidates(knowledgeVaultCache?.notes || []);
  const errors = Array.isArray(knowledgeVaultCache?.scanErrors) ? knowledgeVaultCache.scanErrors.length : 0;
  if (knowledgeCenterSummary) knowledgeCenterSummary.textContent = `${total} 个知识体 · ${units.toLocaleString("zh-CN")} KU`;
  if (knowledgeRootPath) knowledgeRootPath.textContent = knowledgeVaultCache?.root || "知识库目录读取中";
  if (knowledgeCategoryTotal) knowledgeCategoryTotal.textContent = String(total);
  if (!knowledgeStats) return;
  knowledgeStats.innerHTML = `
    <div><span>核心等级</span><strong>${knowledgeCoreGrade(total, units)}</strong><small>${total} OBJECTS</small></div>
    <div><span>知识单位</span><strong>${units.toLocaleString("zh-CN")}</strong><small>LOCAL KU</small></div>
    <div><span>融合候选</span><strong>${fusionCount}</strong><small>TAG LINKS</small></div>
    <div><span>扫描异常</span><strong>${errors}</strong><small>${errors ? "REVIEW" : "CLEAR"}</small></div>`;
}

function renderKnowledgeCategories() {
  if (!knowledgeCategoryList) return;
  const total = Number(knowledgeVaultCache?.total || 0);
  knowledgeCategoryList.innerHTML = [{ id: "all", label: "全部知识", count: total }, ...knowledgeCategories()].map((item) => `
    <button type="button" class="${item.id === selectedKnowledgeCategory ? "active" : ""}" data-knowledge-category="${escapeHtml(item.id)}">
      <i aria-hidden="true"></i><span>${escapeHtml(item.label)}</span><b>${Number(item.count || 0)}</b>
    </button>`).join("");
}

function renderKnowledgeNoteList() {
  if (!knowledgeNoteList) return;
  const notes = filteredKnowledgeNotes();
  if (knowledgeNoteCount) knowledgeNoteCount.textContent = `${notes.length} 条`;
  knowledgeNoteList.innerHTML = notes.length ? notes.map((note) => `
    <button type="button" class="knowledge-note-item${note.id === selectedKnowledgeNoteId ? " active" : ""}" data-knowledge-note="${escapeHtml(note.id)}">
      <i class="knowledge-object-dot" aria-hidden="true"></i>
      <span><strong>${escapeHtml(note.title || "未命名知识")}</strong><small>${escapeHtml(note.categoryLabel || note.category)} · LV ${Number(note.level || 1)}</small></span>
      <b>${Number(note.progress || 0)}%</b>
    </button>`).join("") : `<div class="knowledge-empty"><strong>NO OBJECTS</strong><span>当前星域还没有知识体。</span></div>`;
}

function populateKnowledgeCategorySelect() {
  if (!knowledgeCategorySelect) return;
  knowledgeCategorySelect.innerHTML = knowledgeCategories().map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("");
}

function resetKnowledgeEditor(message = "选择或新建一条知识") {
  selectedKnowledgeNoteId = "";
  if (knowledgeTitleInput) knowledgeTitleInput.value = "";
  if (knowledgeTagsInput) knowledgeTagsInput.value = "";
  if (knowledgeBodyInput) knowledgeBodyInput.value = "";
  if (knowledgeFilePath) knowledgeFilePath.textContent = "未选择文件";
  for (const node of [knowledgeTitleInput, knowledgeTagsInput, knowledgeBodyInput, knowledgeCategorySelect]) if (node) node.disabled = true;
  for (const button of [showKnowledgeNoteBtn, deleteKnowledgeNoteBtn, saveKnowledgeNoteBtn]) if (button) button.disabled = true;
  if (knowledgeEditorStatus) knowledgeEditorStatus.textContent = message;
  setKnowledgeDirty(false);
  closeKnowledgeEditor();
}

async function loadKnowledgeNote(noteId) {
  if (!noteId) return resetKnowledgeEditor();
  try {
    const data = await api.knowledgeNoteRead(noteId);
    const note = data.note || {};
    selectedKnowledgeNoteId = note.id || noteId;
    populateKnowledgeCategorySelect();
    for (const node of [knowledgeTitleInput, knowledgeTagsInput, knowledgeBodyInput, knowledgeCategorySelect]) if (node) node.disabled = false;
    if (knowledgeTitleInput) knowledgeTitleInput.value = note.title || "";
    if (knowledgeCategorySelect) knowledgeCategorySelect.value = note.category || "core";
    if (knowledgeTagsInput) knowledgeTagsInput.value = (note.tags || []).join(", ");
    if (knowledgeBodyInput) knowledgeBodyInput.value = data.body || "";
    if (knowledgeFilePath) knowledgeFilePath.textContent = note.filePath || "";
    for (const button of [showKnowledgeNoteBtn, deleteKnowledgeNoteBtn, saveKnowledgeNoteBtn]) if (button) button.disabled = false;
    setKnowledgeDirty(false);
    renderKnowledgeNoteList();
    renderKnowledgeUniverse();
    openKnowledgeEditor();
  } catch (error) {
    resetKnowledgeEditor(`读取失败：${error.message || error}`);
  }
}

async function renderKnowledgeCenter(force = false) {
  if (!growthCenterDialog || (!force && knowledgeVaultCache)) return;
  const loading = knowledgeUniverse?.querySelector(".knowledge-loading");
  if (loading) loading.hidden = false;
  try {
    const historyRequest = typeof api.skillDeduplicationHistory === "function"
      ? api.skillDeduplicationHistory().catch(() => null)
      : Promise.resolve(null);
    const [vaultState, dedupHistory] = await Promise.all([api.knowledgeVaultState(), historyRequest]);
    knowledgeVaultCache = vaultState;
    renderSkillAuditRecord(dedupHistory?.records?.[0] || null, dedupHistory?.records?.length ? "completed" : "idle");
    populateKnowledgeCategorySelect();
    renderKnowledgeStats();
    renderKnowledgeCategories();
    renderKnowledgeNoteList();
    renderKnowledgeUniverse();
    if (selectedKnowledgeNoteId && knowledgeVaultCache.notes?.some((note) => note.id === selectedKnowledgeNoteId)) await loadKnowledgeNote(selectedKnowledgeNoteId);
    else resetKnowledgeEditor();
  } catch (error) {
    knowledgeVaultCache = { total: 0, notes: [], categories: KNOWLEDGE_CATEGORY_FALLBACK };
    if (knowledgeCenterSummary) knowledgeCenterSummary.textContent = `读取失败：${error.message || error}`;
    renderKnowledgeStats();
    renderKnowledgeCategories();
    renderKnowledgeNoteList();
    renderKnowledgeUniverse();
  } finally {
    if (loading) loading.hidden = true;
  }
}

async function saveKnowledgeNote({ silent = false } = {}) {
  if (!selectedKnowledgeNoteId) return;
  const result = await api.knowledgeNoteUpdate(selectedKnowledgeNoteId, {
    title: knowledgeTitleInput?.value?.trim() || "未命名知识",
    category: knowledgeCategorySelect?.value || "core",
    tags: knowledgeTagsInput?.value || "",
    body: knowledgeBodyInput?.value || ""
  });
  knowledgeVaultCache = result.state;
  selectedKnowledgeNoteId = result.note.id;
  setKnowledgeDirty(false);
  renderKnowledgeStats();
  renderKnowledgeCategories();
  renderKnowledgeNoteList();
  renderKnowledgeUniverse();
  if (!silent) showCopyToast("知识已保存", 1600);
}

async function openGrowthCenter() {
  if (settingsDialog?.open) settingsDialog.close("close");
  if (!growthCenterDialog.open) growthCenterDialog.showModal();
  syncKnowledgeTheme();
  setKnowledgeMotion(storedKnowledgeMotion(), { persist: false });
  setKnowledgeUniverseZoom(knowledgeUniverseZoom);
  await renderKnowledgeCenter(true);
}

async function closeGrowthCenter() {
  if (knowledgeEditorDirty) await saveKnowledgeNote({ silent: true }).catch(() => null);
  if (growthCenterDialog?.open) growthCenterDialog.close("close");
}

growthCenterBtn?.addEventListener("click", openGrowthCenter);
growthCenterCloseBtn?.addEventListener("click", closeGrowthCenter);
bindDialogOutsideDismiss(growthCenterDialog, closeGrowthCenter);
refreshKnowledgeBtn?.addEventListener("click", () => renderKnowledgeCenter(true));
exportKnowledgeBtn?.addEventListener("click", async () => {
  if (exportKnowledgeBtn.disabled) return;
  exportKnowledgeBtn.disabled = true;
  exportKnowledgeBtn.textContent = "导出中";
  try {
    const result = await api.exportKnowledgeAssets?.();
    if (!result?.success) throw new Error(result?.error || "知识资产导出失败");
    showCopyToast(`知识资产已导出：${Number(result.fileCount || 0)} 个文件`, 2600);
  } catch (error) {
    await showAppAlert({ title: "导出失败", message: error.message || String(error) });
  } finally {
    exportKnowledgeBtn.disabled = false;
    exportKnowledgeBtn.textContent = "导出";
  }
});
openKnowledgeVaultBtn?.addEventListener("click", () => api.openKnowledgeVault().catch((error) => showAppAlert({ title: "打开失败", message: error.message || String(error) })));
newKnowledgeNoteBtn?.addEventListener("click", async () => {
  try {
    const result = await api.knowledgeNoteCreate({ category: selectedKnowledgeCategory === "all" ? "core" : selectedKnowledgeCategory });
    knowledgeVaultCache = result.state;
    selectedKnowledgeNoteId = result.note.id;
    renderKnowledgeStats();
    renderKnowledgeCategories();
    await loadKnowledgeNote(selectedKnowledgeNoteId);
    knowledgeTitleInput?.focus();
  } catch (error) { await showAppAlert({ title: "新建失败", message: error.message || String(error) }); }
});
function selectKnowledgeCategory(button) {
  if (!button) return;
  selectedKnowledgeCategory = button.dataset.knowledgeCategory || "all";
  renderKnowledgeStats();
  renderKnowledgeCategories();
  renderKnowledgeNoteList();
  renderKnowledgeUniverse();
  if (selectedKnowledgeCategory !== "all") setKnowledgeUniverseZoom(1.14);
}

knowledgeCategoryList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-knowledge-category]");
  selectKnowledgeCategory(button);
});

knowledgeOrbitLayer?.addEventListener("click", (event) => {
  selectKnowledgeCategory(event.target.closest("[data-knowledge-category]"));
});

async function selectKnowledgeObject(button) {
  if (!button) return;
  if (knowledgeEditorDirty) await saveKnowledgeNote({ silent: true }).catch(() => null);
  await loadKnowledgeNote(button.dataset.knowledgeNote || "");
}

knowledgeNoteList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-knowledge-note]");
  await selectKnowledgeObject(button);
});

knowledgePlanetLayer?.addEventListener("click", async (event) => {
  await selectKnowledgeObject(event.target.closest("[data-knowledge-note]"));
});

knowledgeSearchInput?.addEventListener("input", () => {
  renderKnowledgeNoteList();
  renderKnowledgeUniverse();
});
knowledgeEditorForm?.addEventListener("input", () => { if (selectedKnowledgeNoteId) setKnowledgeDirty(true); });
saveKnowledgeNoteBtn?.addEventListener("click", () => saveKnowledgeNote().catch((error) => showAppAlert({ title: "保存失败", message: error.message || String(error) })));
showKnowledgeNoteBtn?.addEventListener("click", () => api.showKnowledgeInFolder(selectedKnowledgeNoteId).catch((error) => showAppAlert({ title: "定位失败", message: error.message || String(error) })));
closeKnowledgeEditorBtn?.addEventListener("click", async () => {
  if (knowledgeEditorDirty) await saveKnowledgeNote({ silent: true }).catch(() => null);
  closeKnowledgeEditor();
});
gantzSkillAuditBtn?.addEventListener("click", () => { void deduplicateSkillsFromAudit(); });
knowledgeUniverseViewport?.addEventListener("wheel", (event) => {
  event.preventDefault();
  setKnowledgeUniverseZoom(knowledgeUniverseZoom + (event.deltaY < 0 ? 0.08 : -0.08));
}, { passive: false });
for (const button of knowledgeMotionButtons) {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    setKnowledgeMotion(button.dataset.knowledgeMotion || "dynamic");
  });
}
setKnowledgeMotion(storedKnowledgeMotion(), { persist: false });
syncKnowledgeTheme();
setKnowledgeUniverseZoom(1);
deleteKnowledgeNoteBtn?.addEventListener("click", async () => {
  if (!selectedKnowledgeNoteId) return;
  if (!await showAppConfirm({ title: "删除知识", message: "删除后本地 Markdown 文件会同时移除。", primary: "删除", secondary: "取消" })) return;
  const result = await api.knowledgeNoteDelete(selectedKnowledgeNoteId);
  knowledgeVaultCache = result.state;
  resetKnowledgeEditor();
  renderKnowledgeStats();
  renderKnowledgeCategories();
  renderKnowledgeNoteList();
  renderKnowledgeUniverse();
});

function setSettingsDirty(dirty) {
  const form = settingsDialog?.querySelector("form");
  if (!form || !settingsSaveMenu || !saveSettingsBtn) return;
  const changed = Boolean(dirty);
  form.classList.toggle("settings-clean", !changed);
  settingsSaveMenu.hidden = !changed;
  saveSettingsBtn.disabled = !changed;
}

async function renderAdminCodeList() {
  if (!adminCodeListOutput) return;
  try {
    const query = (adminCodeSearchInput?.value || "").trim().toLowerCase();
    const list = await window.admin.getCodeList();
    const rows = list
      .filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query))
      .map((item) => [
        item.code,
        item.status || "unknown",
        item.type || "",
        item.activatedAt ? new Date(item.activatedAt).toLocaleString() : "未激活",
        item.deviceId || "",
        item.notes || ""
      ].join(" | "));
    adminCodeListOutput.value = rows.length ? rows.join("\n") : "暂无兑换码记录";
  } catch (error) {
    adminCodeListOutput.value = `读取失败：${error.message || error}`;
  }
}
async function renderInviteOwner() {
  if (!ownerInvitePanel) return;
  const status = await api.ownerStatus().catch(() => ({ owner: false }));
  ownerInvitePanel.hidden = !status.owner;
}

async function renderLicenseControls(knownStatus = null) {
  const status = knownStatus || await api.ownerStatus().catch(() => ({ owner: false }));
  if (status.owner) await renderAdminCodeList();
  if (developerLogsTab) developerLogsTab.hidden = !status.devMode;
  if (developerLogsPage) developerLogsPage.hidden = !status.devMode;
  if (applyOnlineUpdateBtn) applyOnlineUpdateBtn.hidden = Boolean(status.devMode);
  if (ownerInvitePanel) ownerInvitePanel.hidden = !status.owner;
  if (publishUpdatePanel) publishUpdatePanel.hidden = !status.owner;
}

async function renderDeveloperLogs() {
  if (!developerLogOutput) return;
  const status = await api.ownerStatus().catch(() => ({ devMode: false }));
  if (!status.devMode || !window.admin?.readLogs) {
    developerLogOutput.value = "开发者日志仅开发者版本可见。";
    return;
  }
  const type = developerLogTypeSelect?.value || "system";
  try {
    const data = await window.admin.readLogs(type, 500);
    developerLogOutput.value = (data.lines || []).join("\n") || "暂无日志。";
  } catch (error) {
    developerLogOutput.value = `读取失败：${error.message || error}`;
  }
}

async function renderUpdateInfo() {
  if (!updateContent) return;
  renderUpdateStatus({ phase: "checking", title: "正在检查更新", detail: "正在连接白球官方更新线路。" });
  if (updateCheckBtn) updateCheckBtn.disabled = true;
  const info = await api.updateInfo().catch(() => null);
  if (updateCheckBtn) updateCheckBtn.disabled = false;
  if (!info) {
    availableUpdateInfo = null;
    if (applyOnlineUpdateBtn) applyOnlineUpdateBtn.hidden = true;
    renderUpdateStatus({ phase: "error", title: "检查更新失败", detail: "无法读取更新信息，请检查网络后重试。" });
    return;
  }
  if (appVersion) appVersion.textContent = info.currentVersion;
  setSettingsTabSummary("update", `当前版本 ${info.currentVersion || "-"}`);
  if (publishVersionInput && !publishVersionInput.value) publishVersionInput.value = info.currentVersion;
  if (!info.configured) {
    availableUpdateInfo = null;
    if (applyOnlineUpdateBtn) applyOnlineUpdateBtn.hidden = true;
    renderUpdateStatus({ phase: "error", title: "检查更新失败", detail: info.error || "版本服务器未返回有效数据。", info });
    return;
  }
  availableUpdateInfo = info.hasUpdate ? info : null;
  if (info.hasUpdate) {
    if (applyOnlineUpdateBtn) {
      applyOnlineUpdateBtn.hidden = false;
      applyOnlineUpdateBtn.disabled = false;
      applyOnlineUpdateBtn.textContent = "立即更新";
    }
    renderUpdateStatus({
      phase: "available",
      title: "发现新版本",
      detail: "更新包将在白球内下载，SHA-256 校验通过后自动安装并重启。",
      info
    });
  } else {
    if (applyOnlineUpdateBtn) applyOnlineUpdateBtn.hidden = true;
    renderUpdateStatus({
      phase: "current",
      title: "当前已是最新版本",
      detail: `白球 ${info.currentVersion} 无需更新。`,
      info
    });
  }
}

function formatUpdateSize(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "服务器校验";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function renderUpdateStatus({ phase, title, detail, progress = 0, info = availableUpdateInfo } = {}) {
  if (!updateContent) return;
  const percent = Math.max(0, Math.min(100, Number(progress || 0)));
  renderUpdateTabProgress(phase, percent);
  const showProgress = ["downloading", "verifying", "preparing", "restarting"].includes(phase);
  const verification = phase === "error"
    ? `<div class="update-verify-row"><span>完整性校验</span><b data-valid="false">未完成</b></div>`
    : ["verifying", "preparing", "restarting"].includes(phase)
      ? `<div class="update-verify-row"><span>SHA-256 完整性校验</span><b data-valid="true">${phase === "verifying" ? "校验中" : "已通过"}</b></div>`
      : info?.hasUpdate
        ? `<div class="update-verify-row"><span>更新包校验</span><b>${info.sha256 || info.checksum ? "SHA-256" : "服务器校验"}</b></div>`
        : "";
  const notes = Array.isArray(info?.notes)
    ? info.notes.filter(Boolean)
    : [info?.updateNote || info?.releaseNotes || info?.changelog].filter(Boolean);
  const statusMeta = phase === "downloading" ? `${percent}%`
    : phase === "current" ? "已是最新"
      : phase === "available" ? "可下载"
        : formatUpdateSize(info?.fileSize);
  updateContent.dataset.phase = phase || "idle";
  updateContent.innerHTML = `
    <div class="update-state-head"><b>${escapeHtml(title || "版本更新")}</b><span>${escapeHtml(statusMeta)}</span></div>
    ${info?.hasUpdate && info?.latestVersion ? `<div class="update-version-row"><span>版本</span><b>${escapeHtml(info.currentVersion || "-")} → ${escapeHtml(info.latestVersion)}</b></div>` : ""}
    ${showProgress ? `<div class="update-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="update-progress-fill" style="--update-progress:${phase === "verifying" || phase === "preparing" || phase === "restarting" ? 100 : percent}%"></div></div>` : ""}
    ${verification}
    <p>${escapeHtml(detail || "")}</p>
    ${phase === "available" && notes.length ? `<ul>${notes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
  `;
}

function renderUpdateTabProgress(phase = "idle", progress = 0) {
  const active = ["checking", "downloading", "verifying", "preparing"].includes(phase);
  const fallback = phase === "checking" ? 8 : phase === "verifying" ? 96 : phase === "preparing" ? 99 : progress;
  const percent = Math.max(0, Math.min(100, Number(fallback || 0)));
  for (const button of [updateTabBtn, updateQuickBtn].filter(Boolean)) {
    button.setAttribute("aria-label", active ? `更新进度 ${Math.round(percent)}%` : "更新");
    button.title = active ? `更新 ${Math.round(percent)}%` : "更新";
  }
  if (updateQuickBtn) {
    const label = updateQuickBtn.querySelector("span:last-of-type");
    if (label) label.textContent = phase === "checking" ? "检查中..."
      : phase === "downloading" ? "更新中..."
        : phase === "verifying" ? "校验中..."
          : phase === "preparing" ? "安装中..."
            : phase === "restarting" || phase === "completed" ? "已更新"
              : phase === "error" ? "更新失败"
                : "检查更新";
  }
}

function showUpdateBadge(info) {
  if (!updateQuickBtn) return;
  updateQuickBtn.dataset.updateBadge = "1";
  if (updateQuickBadge) updateQuickBadge.hidden = false;
  updateQuickBtn.title = `新版本 ${info.latestVersion} 可用`;
}

function clearUpdateBadge() {
  if (!updateQuickBtn) return;
  updateQuickBtn.dataset.updateBadge = "0";
  if (updateQuickBadge) updateQuickBadge.hidden = true;
}

function resetQuickUpdateVisual(delay = 0) {
  clearTimeout(updateQuickResetTimer);
  updateQuickResetTimer = setTimeout(() => {
    renderUpdateTabProgress("idle", 0);
    if (updateQuickBtn) updateQuickBtn.disabled = false;
  }, delay);
}

async function runQuickUpdate() {
  if (!updateQuickBtn || updateOperationActive) return;
  updateOperationActive = true;
  updateQuickBtn.disabled = true;
  clearUpdateBadge();
  renderUpdateTabProgress("checking", 0);
  showCopyToast("正在检查白球更新", 1400);
  let restartScheduled = false;
  try {
    const info = await api.updateInfo();
    if (!info?.configured) throw new Error(info?.error || "版本服务器未返回有效数据");
    availableUpdateInfo = info?.hasUpdate ? info : null;
    if (!info?.hasUpdate) {
      renderUpdateStatus({ phase: "current", title: "当前已是最新版本", detail: `白球 ${info.currentVersion || ""} 无需更新。`, info });
      clearUpdateBadge();
      showCopyToast("当前已是最新版本", 1800);
      resetQuickUpdateVisual(250);
      return;
    }
    const downloadUrl = String(info.downloadUrl || info.packageUrl || "").trim();
    const checksum = String(info.sha256 || info.checksum || "").replace(/^sha256:/i, "").trim();
    if (!/^https?:\/\//i.test(downloadUrl)) throw new Error("版本清单没有提供有效的更新包 HTTP(S) 地址");
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error("版本清单缺少有效的 SHA-256 校验值");
    showUpdateBadge(info);
    showCopyToast(`发现 ${info.latestVersion || "新版本"}，开始后台更新`, 2400);
    paintUpdateProgress({ phase: "downloading", progress: 0 });
    const result = await api.applyOnlineUpdate({ autoApply: true });
    if (!result?.ok) throw new Error(result?.error || "更新安装器未能启动");
    restartScheduled = Boolean(result.restart);
    paintUpdateProgress({ phase: restartScheduled ? "restarting" : "preparing", progress: 100 });
    showCopyToast(restartScheduled ? "更新已准备，白球即将自动重启" : "更新包已准备", 2600);
  } catch (error) {
    console.error("[Update] 一键更新失败", error);
    const detail = String(error?.message || error || "更新失败").replace(/Error:|Exception:|Failed:/gi, "").trim();
    renderUpdateStatus({ phase: "error", title: "更新失败", detail });
    renderUpdateTabProgress("error", 0);
    showCopyToast(`更新失败：${detail}`, 3600);
    if (updateQuickBtn) updateQuickBtn.title = detail || "更新失败";
    resetQuickUpdateVisual(1800);
  } finally {
    updateOperationActive = false;
    if (restartScheduled && updateQuickBtn) {
      updateQuickBtn.disabled = true;
    }
  }
}

function normalizedSkillIdentity(item = {}) {
  return String(item.id || item.name || "").trim().toLowerCase();
}

function skillDisplayState(item = {}, builtin = false) {
  const reportedStatus = String(item.status || "UNVERIFIED").toUpperCase();
  const status = builtin && reportedStatus !== "FAILED" && reportedStatus !== "DISABLED" ? "BUILT_IN" : reportedStatus;
  const labels = {
    READY: "已启用",
    FAILED: "验证失败",
    RESEARCHING: "研究中",
    GENERATING: "生成中",
    INSTALLING: "安装中",
    REGISTERING: "注册中",
    TESTING: "测试中",
    VERIFYING: "验证中",
    INSTALLED: "已安装",
    REGISTERED: "已注册",
    LOADED: "已加载",
    BUILT_IN: "已启用",
    UNVERIFIED: "未验证"
  };
  return { status, label: labels[status] || "未验证", enabled: status === "READY" || status === "BUILT_IN" };
}

function skillTypeLabel(item = {}, builtin = false) {
  if (builtin) return "黑球内置";
  return "黑球技能";
}

function toolManagementCard(item, options = {}) {
  const builtin = Boolean(options.builtin);
  const custom = Boolean(options.custom);
  const stateInfo = skillDisplayState(item, builtin);
  const id = item.id || item.name || "";
  const type = skillTypeLabel(item, builtin);
  const source = builtin
    ? "黑球内置"
    : blackBallBrandText(item.source || (custom ? "黑球本地" : "黑球本地")).trim();
  const description = blackBallBrandText(item.description || item.body || "暂无工具描述").trim();
  const scope = Array.isArray(item.tools) && item.tools.length
    ? blackBallBrandText(item.tools.join("、"))
    : Array.isArray(item.capabilities) && item.capabilities.length ? blackBallBrandText(item.capabilities.join("、")) : "按当前任务调用对应能力";
  const inputOutput = blackBallBrandText(item.inputOutput || item.input || item.output || "由 Agent 根据任务参数输入，并返回结构化执行结果").trim();
  const runLog = blackBallBrandText(item.error || item.verification?.error || item.verification?.message || item.lastTest?.message || "暂无运行日志").trim();
  const testable = Boolean(options.testable && id);
  return `
    <article class="tool-management-card${custom ? " custom-skill" : ""}" data-skill-id="${escapeHtml(id)}" data-tool-type="${escapeHtml(type)}" tabindex="0" aria-expanded="false">
      <i class="tool-kind-icon" data-kind="${escapeHtml(type)}" aria-hidden="true"></i>
      <div class="tool-card-main">
        <div class="tool-card-title"><strong>${escapeHtml(blackBallBrandText(item.name || "未命名工具"))}</strong><small data-state="${escapeHtml(stateInfo.status.toLowerCase())}"><i></i>${escapeHtml(stateInfo.label)}</small></div>
        <div class="tool-card-meta"><span>${escapeHtml(source)}</span></div>
      </div>
      <div class="tool-card-actions">
        ${testable ? `<button type="button" class="skill-test-btn" data-skill-test="${escapeHtml(id)}">测试</button>` : '<span class="tool-card-action-spacer" aria-hidden="true"></span>'}
        <button type="button" class="tool-card-more" data-tool-details-toggle aria-label="展开工具详情" title="展开工具详情">⋮</button>
      </div>
      <div class="tool-card-details" hidden>
        <div><span>工具描述</span><p>${escapeHtml(description)}</p></div>
        <div><span>能力范围</span><p>${escapeHtml(scope)}</p></div>
        <div><span>输入输出</span><p>${escapeHtml(inputOutput)}</p></div>
        <div><span>运行日志</span><p>${escapeHtml(runLog)}</p></div>
      </div>
    </article>
  `;
}

function toggleToolCardDetails(card, force = undefined) {
  if (!card) return;
  const details = card.querySelector(".tool-card-details");
  if (!details) return;
  const expanded = force === undefined ? !card.classList.contains("expanded") : Boolean(force);
  card.classList.toggle("expanded", expanded);
  card.setAttribute("aria-expanded", String(expanded));
  details.hidden = !expanded;
  const toggle = card.querySelector("[data-tool-details-toggle]");
  if (toggle) {
    toggle.textContent = expanded ? "×" : "⋮";
    toggle.title = expanded ? "收起工具详情" : "展开工具详情";
    toggle.setAttribute("aria-label", toggle.title);
  }
}

function formatSkillUsageTime(item = {}) {
  const value = item.lastUsedAt || item.lastUsed || item.metadata?.lastUsedAt || item.metadata?.lastUsed;
  if (!value) return "暂无调用记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "暂无调用记录" : date.toLocaleString();
}

function skillManagementCard(item = {}) {
  const id = String(item.id || item.skillId || item.name || "");
  const stateInfo = skillDisplayState(item, false);
  return `
    <article class="skill-management-card" data-skill-id="${escapeHtml(id)}" data-state="${escapeHtml(stateInfo.status.toLowerCase())}">
      <header><div><strong>${escapeHtml(blackBallBrandText(item.name || "未命名技能"))}</strong><small data-state="${escapeHtml(stateInfo.status.toLowerCase())}"><i></i>${escapeHtml(stateInfo.label)}</small></div><span>${escapeHtml(blackBallBrandText(item.source || "全局技能池"))}</span></header>
      <dl><div><dt>最近使用</dt><dd>${escapeHtml(formatSkillUsageTime(item))}</dd></div><div><dt>能力状态</dt><dd>${stateInfo.enabled ? "Agent 可调用" : "等待完整验证"}</dd></div></dl>
      <div class="skill-management-actions"><button type="button" data-skill-manage="${escapeHtml(id)}">管理</button><button type="button" data-skill-test="${escapeHtml(id)}">测试</button></div>
      <div class="skill-management-detail" hidden><p>${escapeHtml(item.description || "暂无技能说明")}</p><span>创建时间：${escapeHtml(item.createdAt ? new Date(item.createdAt).toLocaleString() : "未知")}</span><button type="button" data-skill-delete="${escapeHtml(id)}">删除技能</button></div>
    </article>`;
}

function toggleSkillManagementCard(card) {
  const detail = card?.querySelector(".skill-management-detail");
  if (!detail) return;
  const expanded = detail.hidden;
  detail.hidden = !expanded;
  card.classList.toggle("expanded", expanded);
  const button = card.querySelector("[data-skill-manage]");
  if (button) button.textContent = expanded ? "收起" : "管理";
}

async function renderSkills(force = false) {
  if (!skillList || (!force && skillList.dataset.loaded === "1")) return;
  const data = await api.skills().catch(() => null);
  if (!data) {
    skillList.textContent = "技能读取失败。";
    if (installedToolList) installedToolList.textContent = "工具读取失败。";
    return;
  }
  const bundled = data.bundled || [];
  const custom = data.custom || [];
  const customIdentities = new Set(custom.flatMap((item) => [item.id, item.name].filter(Boolean).map((value) => String(value).toLowerCase())));
  const installedByIdentity = new Map();
  for (const item of bundled) {
    const key = normalizedSkillIdentity(item);
    if (key && !installedByIdentity.has(key)) installedByIdentity.set(key, { ...item, builtin: true });
  }
  for (const item of data.installed || []) {
    const identityValues = [item.id, item.name].filter(Boolean).map((value) => String(value).toLowerCase());
    if (identityValues.some((value) => customIdentities.has(value))) continue;
    const stateInfo = skillDisplayState(item, false);
    if (!stateInfo.enabled) continue;
    const key = normalizedSkillIdentity(item);
    if (key && !installedByIdentity.has(key)) installedByIdentity.set(key, item);
  }
  const installedTools = [...installedByIdentity.values()];
  const installedCards = installedTools.map((item) => toolManagementCard(item, {
    builtin: Boolean(item.builtin),
    testable: Boolean(item.id)
  })).join("");
  const skillCards = custom.map((item) => skillManagementCard(item)).join("");
  const memoryCards = (data.memories || []).map((item) => `
    <article class="memory-card custom-memory" data-memory-id="${escapeHtml(item.id || "")}">
      <div><strong>用户记忆</strong><small>${escapeHtml(blackBallBrandText(item.source || "白球记忆"))} · ${escapeHtml(item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "长期有效")}</small></div>
      <p>${escapeHtml(item.text || "")}</p>
      <button type="button" data-memory-delete="${escapeHtml(item.id || "")}">删除</button>
    </article>
  `).join("");
  skillList.dataset.loaded = "1";
  skillList.innerHTML = skillCards || '<div class="tool-list-empty">暂无个人技能</div>';
  if (installedToolList) installedToolList.innerHTML = installedCards || '<div class="tool-list-empty">暂无已安装工具</div>';
  if (installedToolCount) installedToolCount.textContent = String(installedTools.length);
  if (mySkillCount) mySkillCount.textContent = String(custom.length);
  const readyCount = [...installedTools, ...custom].filter((item) => skillDisplayState(item, Boolean(item.builtin)).status === "READY" || skillDisplayState(item, Boolean(item.builtin)).status === "BUILT_IN").length;
  const unverifiedCount = [...installedTools, ...custom].filter((item) => skillDisplayState(item, Boolean(item.builtin)).status === "UNVERIFIED").length;
  if (toolCenterSummary) toolCenterSummary.textContent = `${installedTools.length + custom.length} 项能力 · ${readyCount} 项已验证 · ${unverifiedCount} 项待验证`;
  setSettingsTabSummary("skills", `${installedTools.length + custom.length} 项能力可管理`);
  if (memoryList) {
    memoryList.hidden = false;
    memoryList.innerHTML = memoryCards || "暂无偏好记忆";
  }
  skillList.querySelectorAll(".custom-skill").forEach((item) => {
    item.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      const name = item.textContent || "该技能";
      const ok = await showAppConfirm({
        title: "删除技能",
        message: `删除技能「${name}」？`,
        primary: "删除",
        secondary: "取消"
      });
      if (!ok) return;
      await api.deleteSkill(item.dataset.skillId);
      skillList.dataset.loaded = "0";
      await renderSkills(true);
    });
  });
  skillList.querySelectorAll("[data-skill-manage]").forEach((button) => {
    button.addEventListener("click", () => toggleSkillManagementCard(button.closest(".skill-management-card")));
  });
  skillList.querySelectorAll("[data-skill-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const card = button.closest(".skill-management-card");
      const name = card?.querySelector("header strong")?.textContent || "该技能";
      const ok = await showAppConfirm({ title: "删除技能", message: `删除技能「${name}」？`, primary: "删除", secondary: "取消" });
      if (!ok) return;
      await api.deleteSkill(button.dataset.skillDelete || "");
      skillList.dataset.loaded = "0";
      await renderSkills(true);
    });
  });
  document.querySelectorAll("#installedToolList [data-skill-test], #skillList [data-skill-test]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = button.dataset.skillTest || "";
      button.disabled = true;
      button.textContent = "测试中";
      const result = await api.verifySkill?.(id).catch((error) => ({ success: false, status: "FAILED", error: error?.message || String(error) })) || { success: false, status: "FAILED", error: "验证接口未接入" };
      skillList.dataset.loaded = "0";
      await renderSkills(true);
      const refreshed = document.querySelector(`#installedToolList [data-skill-id="${CSS.escape(id)}"], #skillList [data-skill-id="${CSS.escape(id)}"]`);
      if (refreshed) refreshed.title = result.success ? "已通过 Agent、Tool 与结果验证" : blackBallBrandText(result.error || "未通过完整调用链验证");
    });
  });
  document.querySelectorAll("#installedToolList .tool-management-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-skill-test]")) return;
      toggleToolCardDetails(card);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target.closest("button")) return;
      event.preventDefault();
      toggleToolCardDetails(card);
    });
  });
  memoryList?.querySelectorAll(".custom-memory").forEach((item) => {
    item.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      const text = item.textContent || "该记忆";
      const ok = await showAppConfirm({
        title: "删除记忆",
        message: `删除记忆「${text.slice(0, 40)}」？`,
        primary: "删除",
        secondary: "取消"
      });
      if (!ok) return;
      await api.deleteMemory(item.dataset.memoryId);
      if (skillList) skillList.dataset.loaded = "0";
      await renderSkills(true);
    });
  });
  memoryList?.querySelectorAll("[data-memory-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = button.closest(".custom-memory");
      const text = item?.querySelector("p")?.textContent || "该记忆";
      const ok = await showAppConfirm({ title: "删除记忆", message: `删除记忆「${text.slice(0, 40)}」？`, primary: "删除", secondary: "取消" });
      if (!ok) return;
      await api.deleteMemory(button.dataset.memoryDelete || "");
      skillList.dataset.loaded = "0";
      await renderSkills(true);
    });
  });
}

function applySavedLayout() {
  const sessionsW = localStorage.getItem("heiqiu.sessionsW");
  const terminalW = localStorage.getItem("heiqiu.terminalW");
  if (sessionsW) appShell.style.setProperty("--sessions-w", `${sessionsW}px`);
  if (terminalW) appShell.style.setProperty("--terminal-w", `${terminalW}px`);
}

function setupSplitters() {
  let active = null;
  document.querySelector(".splitter-left")?.addEventListener("pointerdown", (event) => {
    active = "left";
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  document.querySelector(".splitter-right")?.addEventListener("pointerdown", (event) => {
    active = "right";
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", (event) => {
    if (!active) return;
    const rect = appShell.getBoundingClientRect();
    if (active === "left") {
      const value = Math.min(340, Math.max(210, event.clientX - rect.left));
      appShell.style.setProperty("--sessions-w", `${value}px`);
      localStorage.setItem("heiqiu.sessionsW", String(value));
    } else {
      const value = Math.min(680, Math.max(340, rect.right - event.clientX));
      appShell.style.setProperty("--terminal-w", `${value}px`);
      localStorage.setItem("heiqiu.terminalW", String(value));
    }
  });
  document.addEventListener("pointerup", () => {
    active = null;
  });
  document.addEventListener("pointercancel", () => {
    active = null;
  });
}

function guessMime(name) {
  if (/\.xlsx$/i.test(name)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.xls$/i.test(name)) return "application/vnd.ms-excel";
  if (/\.csv$/i.test(name)) return "text/csv";
  if (/\.md$/i.test(name)) return "text/markdown";
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.docx$/i.test(name)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.pdf$/i.test(name)) return "application/pdf";
  if (/\.pptx$/i.test(name)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (/\.html?$/i.test(name)) return "text/html";
  if (/\.zip$/i.test(name)) return "application/zip";
  return "application/octet-stream";
}

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    let localPath = "";
    try {
      localPath = api.pathForFile?.(file) || "";
    } catch {}
    const mimeType = file.type || guessMime(file.name || "");
    const attachment = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: file.name || "clipboard-image.png",
      mimeType,
      sizeBytes: file.size,
      path: localPath,
      dataUrl: "",
      textContent: ""
    };
    const finish = () => {
      if (/^text\/|json|markdown|csv/i.test(attachment.mimeType) || /\.(txt|md|json|csv)$/i.test(file.name || "")) {
        const textReader = new FileReader();
        textReader.onload = () => {
          attachment.textContent = String(textReader.result || "").slice(0, 120000);
          resolve(attachment);
        };
        textReader.onerror = () => resolve(attachment);
        textReader.readAsText(file);
      } else {
        resolve(attachment);
      }
    };
    if (localPath && !/^image\//i.test(mimeType)) {
      finish();
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      attachment.dataUrl = String(reader.result || "");
      finish();
    };
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  state.composerReplyNavRequested = false;
  hideComposerReplyNav();
  for (const file of files) state.attachments.push(await fileToAttachment(file));
  renderAttachments();
}

const SLASH_COMMANDS = Object.freeze([
  { name: "/new", aliases: ["/reset"], label: "新建会话", action: "new" },
  { name: "/branch", aliases: ["/fork"], label: "分支当前会话", action: "branch" },
  { name: "/model", label: "切换当前模型", action: "model" },
  { name: "/resume", aliases: ["/sessions", "/switch"], label: "查找并恢复会话", action: "resume" },
  { name: "/agents", aliases: ["/tasks"], label: "查看 Agent 与任务", action: "agents" },
  { name: "/compress", aliases: ["/compact"], label: "压缩当前上下文", action: "compress" },
  { name: "/debug", label: "打开自检中心", action: "debug" },
  { name: "/memory", label: "打开意识中心", action: "memory" },
  { name: "/skills", label: "打开技能中心", action: "skills" },
  { name: "/tools", label: "打开工具中心", action: "skills" },
  { name: "/queue", aliases: ["/q"], label: "加入下一项任务", action: "queue", needsArg: true },
  { name: "/retry", label: "重试上一条消息", action: "retry" },
  { name: "/save", label: "导出当前会话", action: "save" },
  { name: "/status", label: "查看当前任务状态", action: "status" },
  { name: "/stop", label: "终止当前任务", action: "stop" },
  { name: "/undo", label: "撤销上一轮对话", action: "undo" },
  { name: "/usage", label: "查看上下文用量", action: "usage" },
  { name: "/version", label: "查看当前版本", action: "version" },
  { name: "/browser", label: "打开黑球浏览器", action: "browser" },
  { name: "/journey", aliases: ["/learning", "/memory-graph"], label: "打开知识星球", action: "journey" },
  { name: "/personality", label: "设置助手人格", action: "personality" },
  { name: "/reasoning", label: "选择推理等级", action: "reasoning" },
  { name: "/skin", label: "切换界面主题", action: "skin" },
  { name: "/title", label: "重命名当前会话", action: "title" },
  { name: "/update", label: "打开系统更新", action: "update" },
  { name: "/help", aliases: ["/commands"], label: "显示命令面板", action: "help" },
  { name: "/yolo", label: "开启完全访问模式", action: "yolo" }
]);

let slashVisibleCommands = [];
let slashActiveIndex = 0;

function slashCommandForToken(token = "") {
  const normalized = String(token || "").trim().toLowerCase();
  return SLASH_COMMANDS.find((item) => item.name === normalized || item.aliases?.includes(normalized)) || null;
}

function hideSlashCommandMenu() {
  if (slashCommandMenu) slashCommandMenu.hidden = true;
}

function updateSlashCommandActiveRow() {
  slashCommandList?.querySelectorAll(".slash-command-item").forEach((button, index) => {
    const active = index === slashActiveIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    if (active) button.scrollIntoView({ block: "nearest" });
  });
}

function renderSlashCommandMenu({ forceAll = false } = {}) {
  if (!slashCommandMenu || !slashCommandList || !chatInput) return;
  const value = chatInput.value;
  if (!forceAll && (!value.startsWith("/") || value.includes("\n") || /\s/.test(value.slice(1)))) {
    hideSlashCommandMenu();
    return;
  }
  const query = forceAll ? "" : value.slice(1).trim().toLowerCase();
  slashVisibleCommands = SLASH_COMMANDS.filter((item) => {
    const terms = [item.name, item.label, ...(item.aliases || [])].join(" ").toLowerCase();
    return !query || terms.includes(query);
  });
  slashActiveIndex = 0;
  slashCommandList.innerHTML = slashVisibleCommands.length
    ? slashVisibleCommands.map((item, index) => `
      <button class="slash-command-item${index === slashActiveIndex ? " active" : ""}" type="button" role="option" data-slash-command="${escapeHtml(item.name)}">
        <code>${escapeHtml(item.name)}</code><span>${escapeHtml(item.label)}</span><b>白球</b>
      </button>`).join("")
    : `<div class="slash-command-empty">没有匹配的命令</div>`;
  if (slashCommandCount) slashCommandCount.textContent = `${slashVisibleCommands.length} 项`;
  slashCommandMenu.hidden = false;
  slashCommandList.querySelectorAll("[data-slash-command]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const command = slashCommandForToken(button.dataset.slashCommand);
      if (!command) return;
      void chooseSlashCommand(command);
    });
  });
}

function moveSlashCommandSelection(direction) {
  if (!slashVisibleCommands.length) return;
  slashActiveIndex = (slashActiveIndex + direction + slashVisibleCommands.length) % slashVisibleCommands.length;
  updateSlashCommandActiveRow();
}

async function chooseSlashCommand(command) {
  if (command.needsArg) {
    chatInput.value = `${command.name} `;
    adjustComposerHeight();
    hideSlashCommandMenu();
    chatInput.focus();
    return;
  }
  await executeSlashCommand(command.name);
}

function clearSlashCommandInput() {
  chatInput.value = "";
  adjustComposerHeight();
  hideSlashCommandMenu();
}

async function executeSlashCommand(rawValue = "") {
  const raw = String(rawValue || "").trim();
  if (!raw.startsWith("/")) return false;
  const token = raw.split(/\s+/, 1)[0].toLowerCase();
  const command = slashCommandForToken(token);
  const arg = raw.slice(token.length).trim();
  if (!command) {
    showCopyToast("未知斜杠命令，输入 / 查看可用命令", 2200);
    return true;
  }
  if (command.needsArg && !arg) {
    chatInput.value = `${command.name} `;
    adjustComposerHeight();
    hideSlashCommandMenu();
    chatInput.focus();
    return true;
  }

  const session = selectedSession();
  clearSlashCommandInput();
  switch (command.action) {
    case "new": {
      const created = await api.createSession();
      state.db = await api.init();
      state.selectedSessionId = created.id;
      await renderAll();
      break;
    }
    case "branch":
      if (!session) break;
      state.db = ensureClientDb(await api.duplicateSession(session.id));
      state.selectedSessionId = state.db.selectedSessionId;
      await renderAll();
      break;
    case "model": openSettingsTab("model"); break;
    case "resume":
      if (arg) {
        sessionSearch.value = arg;
        state.sessionQuery = arg;
        renderSessions();
      }
      sessionSearch?.focus();
      sessionSearch?.select();
      break;
    case "agents": openTaskBoard("timeline"); break;
    case "compress": await extractCurrentConsciousnessFromCenter(); break;
    case "debug": openSettingsTab("debug"); break;
    case "memory": openConsciousCenter(); break;
    case "skills": openSettingsTab("skills"); break;
    case "queue":
      if (!session) break;
      sessionTaskQueue.enqueue(session.id, { text: arg, attachments: [] });
      renderQueue();
      showCopyToast("已加入任务队列", 1500);
      break;
    case "retry": {
      if (!session || state.busy || sessionIsRunning(session)) {
        showCopyToast("当前任务结束后再重试", 1800);
        break;
      }
      const lastUser = [...(state.currentMessages || [])].reverse().find((message) => message.role === "user");
      if (!lastUser?.text) {
        showCopyToast("当前会话没有可重试的消息", 1800);
        break;
      }
      chatInput.value = lastUser.text;
      await sendCurrentTask();
      break;
    }
    case "save": await exportSessionChat(session); break;
    case "status": openTaskBoard("overview"); break;
    case "stop": await abortCurrentTask(); break;
    case "undo": {
      if (!session || state.busy || sessionIsRunning(session)) {
        showCopyToast("任务运行中不能撤销对话", 1800);
        break;
      }
      const result = await api.undoSession?.(session.id);
      if (!result?.removed) {
        showCopyToast("当前会话没有可撤销内容", 1800);
        break;
      }
      state.db = ensureClientDb(result.db);
      await renderAll();
      showCopyToast("已撤销上一轮对话", 1500);
      break;
    }
    case "usage": {
      const usage = conversationUsage(state.currentMessages || []);
      showCopyToast(`上下文已用 ${compactNumber(usage.used)} / ${compactNumber(usage.limit)} token`, 2600);
      break;
    }
    case "version": {
      const info = await api.updateInfo().catch(() => null);
      showCopyToast(`白球 AI ${info?.currentVersion || appVersion?.textContent || "-"}`, 2200);
      break;
    }
    case "browser": openTaskBoard("links"); break;
    case "journey": await openGrowthCenter(); break;
    case "personality": openSettingsTab("general"); break;
    case "reasoning": reasoningWaterControl?.click(); break;
    case "skin": openSettingsTab("skin"); break;
    case "title": {
      if (!session) break;
      const title = arg || await askSessionTitle(projectSessionDisplayName(session));
      if (title) {
        state.db = await api.renameSession(session.id, title);
        await renderAll();
      }
      break;
    }
    case "update": openSettingsTab("update"); break;
    case "help":
      chatInput.value = "/";
      adjustComposerHeight();
      renderSlashCommandMenu({ forceAll: true });
      chatInput.focus();
      break;
    case "yolo":
      if (currentAccessMode() === "full") showCopyToast("当前已是完全访问模式", 1600);
      else await setAccessMode("full");
      break;
  }
  return true;
}

async function enqueueCurrentTask() {
  const session = selectedSession();
  if (!session) return false;
  const text = chatInput.value.trim();
  const quote = state.composerQuote?.sessionId === session.id ? { ...state.composerQuote } : null;
  if (!text && !state.attachments.length && !quote) return false;
  sessionTaskQueue.enqueue(session.id, { text, attachments: [...state.attachments], quote });
  chatInput.value = "";
  adjustComposerHeight();
  state.attachments = [];
  state.composerQuote = null;
  renderAttachments();
  renderComposerQuote();
  renderQueue();
  return true;
}

async function abortCurrentTask() {
  const session = selectedSession();
  if (!session) return;
  const hasActiveTask = Boolean(state.busy || sessionIsRunning(session));
  if (hasActiveTask) state.abortRequestedSessions.add(session.id);
  state.closedClarificationSessions.add(session.id);
  clearPendingClarificationCards(session.id);
  clearComposerClarification();
  setBusy(false);
  discardLiveChatStreamsForSession(session.id);
  taskState.textContent = "正在终止";
  if (monitorMode) monitorMode.textContent = "正在终止";
  try {
    await api.abortChat(session.id);
    sessionTaskQueue.clear(session.id);
    state.db = await api.init();
    await renderAll();
  } catch (error) {
    console.error("[Abort] 终止当前任务失败", error);
  } finally {
    clearComposerClarification();
  }
}

async function sendCurrentTask(task = null, sessionId = state.selectedSessionId) {
  const session = state.db?.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  state.abortRequestedSessions.delete(session.id);
  state.closedClarificationSessions.delete(session.id);
  const text = task ? task.text : chatInput.value.trim();
  const attachments = task ? task.attachments : [...state.attachments];
  const quote = task?.quote && typeof task.quote === "object"
    ? { ...task.quote, sessionId: session.id }
    : state.composerQuote?.sessionId === session.id ? { ...state.composerQuote } : null;
  const requestText = quote
    ? `引用${quote.source || "消息"}的内容：\n${quote.text}\n\n当前请求：\n${text || "请结合引用内容继续处理"}`
    : text;
  const structuredContext = task?.context && typeof task.context === "object" ? task.context : null;
  const clarificationCardKey = String(task?.ui?.clarificationCardKey || "");
  if (!text && !attachments.length && !quote) return;
  const persistedAttachments = buildPersistedAttachments(attachments);
  const taskStartedAt = Date.now();
  // Responses are intentionally rendered after the complete model result.
  // The UI then reveals that result character by character.
  const streamId = "";
  const userMessage = {
    role: "user",
    text,
    ...((structuredContext || quote) ? { raw: {
      ...(structuredContext ? { cardAction: true, cardType: Object.keys(structuredContext)[0] || "" } : {}),
      ...(quote ? { quote: { messageId: quote.messageId || "", role: quote.role || "assistant", source: quote.source || "消息", text: quote.text } } : {})
    } } : {}),
    attachments: persistedAttachments,
    images: persistedAttachments.filter((item) => String(item.mimeType || "").startsWith("image/")).map((item) => item.dataUrl)
  };
  let thinkingRow = null;
  let streamFinalizedInView = false;
  const isVisible = () => state.selectedSessionId === session.id;
  const addVisibleMessage = (message) => {
    if (!isVisible()) return;
    if (message.role === "assistant") {
      message.raw = {
        ...(message.raw && typeof message.raw === "object" ? message.raw : {}),
        durationMs: Math.max(
          1,
          Date.now() - taskStartedAt,
          messageDurationMs(message)
        )
      };
      const streamedRow = finalizeLiveChatStream(streamId, message, {
        durationMs: message.raw.durationMs
      });
      if (streamedRow) {
        streamFinalizedInView = true;
        thinkingRow = null;
        return streamedRow;
      }
      removeThinkingMessage(thinkingRow);
      thinkingRow = null;
      state.pendingResponseAnchor = {
        sessionId: session.id,
        text: String(message.text || "").slice(0, 200)
      };
    }
    const row = addMessage(message, messageList, {
      progressive: message.role === "assistant",
      anchorStart: message.role === "assistant",
      typingSessionId: message.role === "assistant" ? session.id : ""
    });
    if (message.role === "assistant" && row) streamFinalizedInView = true;
    return row;
  };
  const scrollVisible = () => {
    if (isVisible() && !state.pendingResponseAnchor) scrollMessagesToBottom();
  };
  const updateVisibleProgress = (label, value) => {
    if (!isVisible()) return;
    setTaskProgressStage(label, value);
    const thinkingLabel = thinkingRow?.querySelector(".thinking-label");
    if (thinkingLabel) thinkingLabel.textContent = label || "正在执行任务";
  };
  addVisibleMessage(userMessage);
  if (isVisible()) {
    state.forceScrollBottom = true;
    scrollMessagesToBottom();
    chatInput.value = "";
    chatInput.placeholder = "给 Gantz 发送消息";
    adjustComposerHeight();
    state.attachments = [];
    state.composerQuote = null;
    renderAttachments();
    renderComposerQuote();
  }
  sessionTaskQueue.setActive(session.id, true);
  updateProjectTreePresentation();
  if (isVisible()) {
    setBusy(true);
    thinkingRow = createThinkingMessage("正在理解任务", { startedAt: taskStartedAt });
    if (streamId) registerLiveChatStream(streamId, session.id, thinkingRow, { startedAt: taskStartedAt });
  }
  updateVisibleProgress("已接收", 8);
  try {
    if (structuredContext && api.productSubmitTask) {
      updateVisibleProgress("正在处理选择", 24);
      const productResult = await api.productSubmitTask({
        productId: "desktop-assistant",
        templateId: "desktop.general_task",
        sessionId: session.id,
        streamId,
        text: requestText,
        message: requestText,
        context: structuredContext
      });
      if (state.abortRequestedSessions.has(session.id)) return;
      const assistantText = productResultText(productResult) || productResult?.text || "操作已完成。";
      addVisibleMessage({ role: "assistant", text: assistantText, raw: { productResult } });
      scrollVisible();
      const awaitingConfirmation = isTaskBrainConfirmation(productResult);
      updateVisibleProgress(awaitingConfirmation ? "等待确认" : productResult?.success ? "已完成" : "执行失败", awaitingConfirmation ? 32 : productResult?.success ? 100 : 0);
      await api.appendMessage(session.id, userMessage);
      await api.appendMessage(session.id, { role: "assistant", text: assistantText, raw: { productLayer: true, cardAction: true, productResult } });
      state.db = await api.init();
      return;
    }
    const useProductTask = shouldUseProductTask(text, attachments);
    if (isSkillLearningPrompt(text) && api.productSubmitTask) {
      updateVisibleProgress("正在学习技能", 24);
      const productResult = await submitSkillLearningInput(session, requestText, { streamId });
      if (state.abortRequestedSessions.has(session.id)) return;
      updateVisibleProgress("正在验证", 88);
      const assistantText = productResultText(productResult) || productResult?.text || "技能学习流程已结束。";
      addVisibleMessage({ role: "assistant", text: assistantText, raw: { productResult } });
      scrollVisible();
      updateVisibleProgress(isTaskBrainConfirmation(productResult) ? "等待确认" : productResult?.success ? "已完成" : "执行失败", isTaskBrainConfirmation(productResult) ? 32 : productResult?.success ? 100 : 0);
      await api.appendMessage(session.id, userMessage);
      await api.appendMessage(session.id, { role: "assistant", text: assistantText, raw: { productLayer: true, skillLearning: true, productResult } });
      state.db = await api.init();
      const owner = await api.ownerStatus?.().catch(() => ({ devMode: false }));
      const productTask = await api.productQueryTask?.(productResult.taskId).catch(() => null);
      if (isVisible()) renderProductDashboard(productTask, { devMode: Boolean(owner?.devMode) });
      return;
    }
    if (!useProductTask) {
      updateVisibleProgress("正在理解", 18);
      const productResult = await submitProductInput(session, requestText, { taskMode: false, streamId });
      if (state.abortRequestedSessions.has(session.id)) return;
      updateVisibleProgress("正在执行", 76);
      const assistantText = productResultText(productResult) || productResult?.text || "我在。";
      addVisibleMessage({ role: "assistant", text: assistantText, raw: { productResult } });
      scrollVisible();
      updateVisibleProgress(isTaskBrainConfirmation(productResult) ? "等待确认" : productResult?.success ? "已完成" : "执行失败", isTaskBrainConfirmation(productResult) ? 32 : productResult?.success ? 100 : 0);
      await api.appendMessage(session.id, userMessage);
      await api.appendMessage(session.id, { role: "assistant", text: assistantText, raw: { productLayer: true, conversationOnly: true, productResult } });
      return;
    }
    if (attachments.length && api.productSubmitTask) {
      updateVisibleProgress("正在读取附件", 24);
      const productResult = await submitAttachmentInput(session, requestText, attachments, { streamId });
      if (state.abortRequestedSessions.has(session.id)) return;
      updateVisibleProgress("正在分析", 70);
      const assistantText = productResultText(productResult) || productResult?.text || "附件已收到，但没有生成有效分析。";
      addVisibleMessage({ role: "assistant", text: assistantText, raw: { productResult } });
      scrollVisible();
      updateVisibleProgress(isTaskBrainConfirmation(productResult) ? "等待确认" : productResult?.success ? "已完成" : "执行失败", isTaskBrainConfirmation(productResult) ? 32 : productResult?.success ? 100 : 0);
      await api.appendMessage(session.id, userMessage);
      await api.appendMessage(session.id, { role: "assistant", text: assistantText, raw: { productLayer: true, attachmentAnalysis: true, productResult } });
      state.db = await api.init();
      const owner = await api.ownerStatus?.().catch(() => ({ devMode: false }));
      const productTask = await api.productQueryTask?.(productResult.taskId).catch(() => null);
      if (isVisible()) renderProductDashboard(productTask, { devMode: Boolean(owner?.devMode) });
      return;
    }
    if (api.productSubmitTask) {
      updateVisibleProgress("正在规划", 28);
      updateVisibleProgress("正在执行", 58);
      const productResult = await api.productSubmitTask({
        productId: "desktop-assistant",
        templateId: "desktop.general_task",
        sessionId: session.id,
        streamId,
        text: requestText,
        message: requestText
      });
      if (state.abortRequestedSessions.has(session.id)) return;
      updateVisibleProgress("正在验证", 86);
      const assistantText = productResultText(productResult) || (productResult?.success ? "任务完成。" : "这次没有取得有效结果。我先说明当前能力范围；需要实际操作时，可以直接提供文件或目标。");
      if (!productResult?.success && !productResult?.taskBrain) {
        updateVisibleProgress("正在执行", 64);
        const fallbackResult = await submitProductInput(session, requestText, { taskMode: false, streamId });
        if (state.abortRequestedSessions.has(session.id)) return;
        const fallbackText = productResultText(fallbackResult) || fallbackResult?.text || "我已经理解任务方向，但当前缺少可执行对象。需要继续操作时，直接提供文件或目标即可。";
        addVisibleMessage({ role: "assistant", text: fallbackText, raw: { productResult: fallbackResult } });
        scrollVisible();
        updateVisibleProgress(fallbackResult?.success ? "已完成" : "执行失败", fallbackResult?.success ? 100 : 0);
        await api.appendMessage(session.id, userMessage);
        await api.appendMessage(session.id, { role: "assistant", text: fallbackText, raw: { productLayer: true, fallback: true, productResult: fallbackResult } });
        return;
      }
      const awaitingConfirmation = isTaskBrainConfirmation(productResult);
      const agentReport = session.type === "Agent" && !awaitingConfirmation;
      addVisibleMessage({
        role: "assistant",
        text: renderResultCard({ ...productResult, text: assistantText }),
        raw: { productResult, agentReport, reportTitle: agentReport ? `${session.name || session.title || "Agent"}任务报告` : "" }
      });
      scrollVisible();
      updateVisibleProgress(awaitingConfirmation ? "等待确认" : productResult?.success ? "已完成" : "执行失败", awaitingConfirmation ? 32 : productResult?.success ? 100 : 0);
      await api.appendMessage(session.id, userMessage);
      await api.appendMessage(session.id, { role: "assistant", text: assistantText, raw: { productLayer: true, productResult, agentReport, reportTitle: agentReport ? `${session.name || session.title || "Agent"}任务报告` : "" } });
      state.db = await api.init();
      const owner = await api.ownerStatus?.().catch(() => ({ devMode: false }));
      const productTask = await api.productQueryTask?.(productResult.taskId).catch(() => null);
      if (isVisible()) renderProductDashboard(productTask, { devMode: Boolean(owner?.devMode) });
      return;
    }
    addVisibleMessage({ role: "assistant", text: "当前产品层暂时没有返回结果，请稍后再试。" });
    scrollVisible();
    await api.appendMessage(session.id, userMessage);
    await api.appendMessage(session.id, { role: "assistant", text: "当前产品层暂时没有返回结果，请稍后再试。", raw: { productLayer: true, emptyResult: true } });
  } catch (error) {
    if (state.abortRequestedSessions.has(session.id)) return;
    console.error(error);
    const message = error?.message || String(error || "未知错误");
    addVisibleMessage({ role: "assistant", text: `没有发送成功。\n原因：${message}` });
    scrollVisible();
    updateVisibleProgress("执行失败", 0);
    await api.appendMessage(session.id, { role: "assistant", text: `没有发送成功。\n原因：${message}`, raw: { uiError: true } }).catch(() => null);
  } finally {
    const preserveStreamedView = streamFinalizedInView && isVisible();
    discardLiveChatStream(streamId);
    removeThinkingMessage(thinkingRow);
    thinkingRow = null;
    sessionTaskQueue.setActive(session.id, false);
    updateProjectTreePresentation();
    state.db = await api.init();
    if (preserveStreamedView) {
      const currentSession = selectedSession();
      setBusy(sessionIsRunning(currentSession));
      stopProgress(currentSession?.status);
      renderSessions();
      renderQueue();
      recordState.textContent = `${state.db.sessions.length} 会话`;
      if (monitorSession) monitorSession.textContent = statusText(currentSession?.status);
      renderMonitorLog(currentSession, state.currentMessages || []);
      renderMetricBars(currentSession, state.currentMessages || []);
      renderTaskProgressRail();
      renderTaskBoard();
    } else {
      await renderAll();
    }
    state.abortRequestedSessions.delete(session.id);
    if (clarificationCardKey) state.pendingClarificationCards.delete(clarificationCardKey);
    if (preserveStreamedView) scheduleStreamingScroll();
    else scrollVisible();
    if (isVisible()) state.forceScrollBottom = false;
    processQueue(session.id);
  }
}

async function processQueue(sessionId = state.selectedSessionId) {
  if (!sessionId || sessionTaskQueue.isActive(sessionId)) return;
  const nextTask = sessionTaskQueue.list(sessionId)[0];
  if (!nextTask?.autoStart) return;
  const task = sessionTaskQueue.shift(sessionId);
  if (!task) return;
  if (sessionId === state.selectedSessionId) renderQueue();
  await sendCurrentTask(task, sessionId);
}

attachBtn.addEventListener("click", () => {
  state.composerReplyNavRequested = false;
  hideComposerReplyNav();
  fileInput.click();
});
fileInput.addEventListener("change", async () => {
  await addFiles([...fileInput.files]);
  fileInput.value = "";
});

document.addEventListener("dragenter", (event) => {
  if (event.dataTransfer?.types?.includes("Files")) document.body.classList.add("file-dragging");
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) document.body.classList.remove("file-dragging");
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  document.body.classList.remove("file-dragging");
  if (event.dataTransfer?.files?.length) await addFiles([...event.dataTransfer.files]);
});

document.addEventListener("paste", async (event) => {
  let files = [...(event.clipboardData?.files || [])];
  if (!files.length) {
    files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }
  if (files.length) await addFiles(files);
});

chatInput.addEventListener("input", () => {
  adjustComposerHeight();
  renderSlashCommandMenu();
  if (chatInput.value.startsWith("/")) {
    clearTimeout(state._recommendTimer);
    hideRecommendBadge();
    return;
  }
  // 智能模型推荐（800ms 防抖）
  clearTimeout(state._recommendTimer);
  state._recommendTimer = setTimeout(() => {
    const text = chatInput.value.trim();
    if (text.length < 4) {
      hideRecommendBadge();
      return;
    }
    checkAndShowRecommendBadge(text);
  }, 800);
});

async function checkAndShowRecommendBadge(text) {
  try {
    if (!window.heiqiu?.modelDetectTaskType || !window.heiqiu?.modelRecommend) return;
    const taskType = await window.heiqiu.modelDetectTaskType(text);
    if (taskType === 'conversation') {
      hideRecommendBadge();
      return;
    }
    const result = await window.heiqiu.modelRecommend(taskType);
    if (!result?.recommended) { hideRecommendBadge(); return; }
    const rec = result.recommended;
    const currentKey = state.db?.settings?.defaultProvider;
    if (rec.providerId === currentKey) { hideRecommendBadge(); return; }
    const TASK_ICONS = { coding: '💻', writing: '📝', analysis: '🔍', vision: '👁️' };
    const TASK_LABELS = { coding: '编程', writing: '写作', analysis: '分析', vision: '视觉' };
    const badge = document.getElementById('modelRecommendBadge');
    const badgeText = document.getElementById('recommendBadgeText');
    if (!badge || !badgeText) return;
    badgeText.textContent = `${TASK_ICONS[taskType] || ''} ${TASK_LABELS[taskType] || taskType}任务建议用 ${rec.name}`;
    badge.hidden = false;
    state._recommendProviderId = rec.providerId;
  } catch (e) { /* 忽略 */ }
}

function hideRecommendBadge() {
  const badge = document.getElementById('modelRecommendBadge');
  if (badge) badge.hidden = true;
  state._recommendProviderId = null;
}

// 推荐徽章切换按钮
document.getElementById('recommendBadgeSwitch')?.addEventListener('click', async () => {
  const providerId = state._recommendProviderId;
  if (!providerId) return;
  try {
    await useModelProvider(providerId);
    renderSettings();
    hideRecommendBadge();
    showCopyToast(`已切换到推荐模型`, 1500);
  } catch (e) { /* 忽略 */ }
});
document.getElementById('recommendBadgeClose')?.addEventListener('click', hideRecommendBadge);

chatInput.addEventListener("keydown", (event) => {
  if (slashCommandMenu && !slashCommandMenu.hidden) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSlashCommandSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      const command = slashVisibleCommands[slashActiveIndex];
      if (command?.supported !== false) {
        event.preventDefault();
        void chooseSlashCommand(command);
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideSlashCommandMenu();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await executeSlashCommand(chatInput.value)) return;
  const session = selectedSession();
  if (state.busy || sessionIsRunning(session)) {
    if (chatInput.value.trim() || state.attachments.length || state.composerQuote) await enqueueCurrentTask();
    else await abortCurrentTask();
    return;
  }
  await sendCurrentTask();
});
composerClarificationAbort?.addEventListener("click", () => {
  void abortCurrentTask();
});
webSearchBtn?.addEventListener("click", async () => {
  const previous = state.db.settings.webSearch?.enabled !== false;
  state.db.settings.webSearch = {
    ...(state.db.settings.webSearch || {}),
    enabled: !previous
  };
  renderWebSearchMode();
  try {
    await api.saveSettings(state.db.settings);
  } catch (error) {
    state.db.settings.webSearch.enabled = previous;
    renderWebSearchMode();
    showCopyToast("联网搜索设置保存失败");
  }
});
queueClearBtn?.addEventListener("click", () => {
  const session = selectedSession();
  if (!session) return;
  sessionTaskQueue.clear(session.id);
  clearPendingClarificationCards(session.id);
  renderQueue();
});
accessModeBtn?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-mode]");
  if (target && target !== accessModeBtn) {
    accessModeBtn.dataset.open = "0";
    accessModeBtn.setAttribute("aria-expanded", "false");
    setAccessMode(target.dataset.mode || "ask");
    return;
  }
  const willOpen = accessModeBtn.dataset.open !== "1";
  accessModeBtn.dataset.open = willOpen ? "1" : "0";
  accessModeBtn.setAttribute("aria-expanded", String(willOpen));
});

reasoningWaterControl?.addEventListener("click", async (event) => {
  const option = event.target.closest("[data-reasoning-level]");
  if (option) {
    reasoningWaterControl.dataset.open = "0";
    reasoningWaterControl.setAttribute("aria-expanded", "false");
    await setReasoningLevel(option.dataset.reasoningLevel);
    return;
  }
  const willOpen = reasoningWaterControl.dataset.open !== "1";
  reasoningWaterControl.dataset.open = willOpen ? "1" : "0";
  reasoningWaterControl.setAttribute("aria-expanded", String(willOpen));
});

// 意图预测开关 - 上拉菜单式交互
intentPredictBtn?.addEventListener("click", (event) => {
  const option = event.target.closest("[data-value]");
  if (option && option.closest(".intent-predict-menu")) {
    intentPredictBtn.dataset.open = "0";
    intentPredictBtn.setAttribute("aria-expanded", "false");
    const nextState = option.dataset.value;
    intentPredictBtn.dataset.enabled = nextState;
    if (intentPredictLabel) intentPredictLabel.textContent = nextState === "1" ? "开" : "关";
    // 更新菜单选中状态
    intentPredictBtn.querySelectorAll(".intent-predict-option").forEach((o) => {
      o.classList.toggle("active", o.dataset.value === nextState);
    });
    // 保存到设置
    state.db = ensureClientDb(state.db);
    state.db.settings.intentPredict = nextState === "1";
    api.saveSettings?.(state.db.settings).catch(() => showCopyToast("意图预测设置保存失败"));
    return;
  }
  const willOpen = intentPredictBtn.dataset.open !== "1";
  intentPredictBtn.dataset.open = willOpen ? "1" : "0";
  intentPredictBtn.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("click", (event) => {
  if (slashCommandMenu && !chatForm?.contains(event.target)) hideSlashCommandMenu();
  if (accessModeBtn && !accessModeBtn.contains(event.target)) {
    accessModeBtn.dataset.open = "0";
    accessModeBtn.setAttribute("aria-expanded", "false");
  }
  if (reasoningWaterControl && !reasoningWaterControl.contains(event.target)) {
    reasoningWaterControl.dataset.open = "0";
    reasoningWaterControl.setAttribute("aria-expanded", "false");
  }
  if (intentPredictBtn && !intentPredictBtn.contains(event.target)) {
    intentPredictBtn.dataset.open = "0";
    intentPredictBtn.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (consciousCenterLayer && !consciousCenterLayer.hidden) closeConsciousCenter();
  if (accessModeBtn) {
    accessModeBtn.dataset.open = "0";
    accessModeBtn.setAttribute("aria-expanded", "false");
  }
  if (reasoningWaterControl) {
    reasoningWaterControl.dataset.open = "0";
    reasoningWaterControl.setAttribute("aria-expanded", "false");
  }
  if (intentPredictBtn) {
    intentPredictBtn.dataset.open = "0";
    intentPredictBtn.setAttribute("aria-expanded", "false");
  }
});

$("newSessionBtn").addEventListener("click", async () => {
  const session = await api.createSession();
  state.db = await api.init();
  state.selectedSessionId = session.id;
  await renderAll();
});

$("newProjectBtn")?.addEventListener("click", () => openProjectDialog());

$("batchManageBtn")?.addEventListener("click", () => {
  if (state.batchDeleteMode) {
    exitBatchDeleteMode();
    return;
  }
  state.batchDeleteMode = true;
  state.selectedBatchSessionIds.clear();
  setBatchManageButtonState(true);
  renderSessions();
});

sessionSearch?.addEventListener("input", () => {
  state.sessionQuery = sessionSearch.value || "";
  renderSessions();
  // Phase 2: 深度搜索（防抖 300ms）
  clearTimeout(state.deepSearchTimer);
  const query = state.sessionQuery.trim();
  if (query.length >= 2) {
    state.deepSearchTimer = setTimeout(async () => {
      try {
        const results = await window.heiqiu.memorySearch(query, { limit: 50 });
        const map = new Map();
        for (const r of (results || [])) {
          if (!map.has(r.session_id)) map.set(r.session_id, []);
          if (map.get(r.session_id).length < 2) {
            map.get(r.session_id).push(r.content || '');
          }
        }
        state.deepSearchResults = map;
        renderSessions();
      } catch (e) {
        // 忽略
      }
    }, 300);
  } else {
    state.deepSearchResults = new Map();
  }
});

$("settingsBtn").addEventListener("click", () => openSettingsTab("skin", "settings"));
consciousBtn?.addEventListener("click", openConsciousCenter);
currentModelBadge?.addEventListener("click", () => openSettingsTab("model"));
chatMoreBtn?.addEventListener("click", () => openTaskBoard("overview"));
skinBtn?.addEventListener("click", () => openSettingsTab("skin"));
updateQuickBtn?.addEventListener("click", async () => {
  await runQuickUpdate();
});
async function closeSettingsDialog(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (!modelConfigLayer?.hidden && !await requestCloseModelConfigDrawer()) return;
  if (settingsDialog?.open) settingsDialog.close("close");
}

settingsCloseBtn?.addEventListener("click", closeSettingsDialog);
addModelBtn?.addEventListener("click", () => openModelConfigDrawer("deepseek", "add"));
modelConfigCloseBtn?.addEventListener("click", requestCloseModelConfigDrawer);
modelConfigLayer?.querySelector("[data-model-config-close]")?.addEventListener("click", requestCloseModelConfigDrawer);
modelConfigCancelBtn?.addEventListener("click", requestCloseModelConfigDrawer);
testModelConnectionBtn?.addEventListener("click", () => {
  const key = state.modelConfigKey;
  if (key) refreshProviderModels(key, testModelConnectionBtn, $("modelDiscoveryStatus"), "test");
});
saveModelConfigBtn?.addEventListener("click", () => saveModelConfig());
document.addEventListener("click", (event) => {
  if (!event.target.closest(".configured-model-controls")) closeModelCardMenus();
});
settingsCloseBtn?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
});
settingsDialog?.addEventListener("close", () => {
  releaseDebugCenterSurfaceSize();
  if (state.licenseStatus?.locked && !state.licenseStatus?.unlocked && licenseOverlay) licenseOverlay.hidden = false;
});
settingsDialog?.addEventListener("pointerup", (event) => {
  if (!settingsDialog?.open || !settingsCloseBtn) return;
  const rect = settingsCloseBtn.getBoundingClientRect();
  const hit = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (hit) closeSettingsDialog(event);
});
bindDialogOutsideDismiss(settingsDialog, closeSettingsDialog);
bindDialogOutsideDismiss(renameDialog, () => {
  if (renameDialog?.open) renameDialog.close("cancel");
});
bindDialogOutsideDismiss(personaDialog, () => {
  if (personaDialog?.open) personaDialog.close("cancel");
});
saveSettingsBtn?.addEventListener("click", async (event) => {
  event.preventDefault();
  state.db.settings = readSettingsFromDialog();
  await api.saveSettings(state.db.settings);
  await api.setAutoLaunch?.(Boolean(autoLaunchInput?.checked));
  state.db = await api.init();
  renderSettings();
  setSettingsDirty(false);
  settingsDialog.close();
});
settingsDialog?.querySelector("form")?.addEventListener("input", (event) => {
  if (event.target.closest('[data-settings-page="skills"]')) return;
  if (event.target.closest('[data-settings-page="skin"]')) return;
  if (event.target.closest('[data-settings-page="invite"]')) return;
  if (event.target.closest("#modelConfigLayer")) return;
  if (event.target.matches("input, textarea, select")) setSettingsDirty(true);
});
settingsDialog?.querySelector("form")?.addEventListener("change", (event) => {
  if (event.target.closest('[data-settings-page="skills"]')) return;
  if (event.target.closest('[data-settings-page="skin"]')) return;
  if (event.target.closest('[data-settings-page="invite"]')) return;
  if (event.target.closest("#modelConfigLayer")) return;
  if (event.target.matches("input, textarea, select")) setSettingsDirty(true);
});
providerSelect.addEventListener("change", () => {
  renderProviderDetails();
});
skinSelect?.addEventListener("change", () => applySkinPreset(skinSelect.value));
[textColorInput, accentColorInput, backgroundColorInput, panelColorInput].forEach((input) => {
  input?.addEventListener("input", () => {
    syncThemeHexInputs();
    applyCustomThemeColors();
  });
});
[fontSizeInput].forEach((input) => {
  input?.addEventListener("input", () => {
    state.db.settings.appearance = {
      ...(state.db.settings.appearance || {}),
      fontSize: Number(fontSizeInput?.value || 16)
    };
    applyAppearance();
    setThemeSettingsDirty(true);
  });
});
[
  [textColorHexInput, textColorInput],
  [accentColorHexInput, accentColorInput],
  [backgroundColorHexInput, backgroundColorInput],
  [panelColorHexInput, panelColorInput]
].forEach(([hexInput, picker]) => {
  hexInput?.addEventListener("input", () => {
    const value = normalizeHexColor(hexInput.value);
    hexInput.classList.toggle("invalid", Boolean(hexInput.value) && !value);
    if (!value || !picker) return;
    picker.value = value;
    applyCustomThemeColors();
  });
  hexInput?.addEventListener("blur", () => {
    if (!picker) return;
    hexInput.value = String(picker.value || "").toUpperCase();
    hexInput.classList.remove("invalid");
  });
});
document.querySelectorAll("[data-theme-palette]").forEach((button) => {
  button.addEventListener("click", () => applyThemeColorPalette(button.dataset.themePalette || ""));
});
skinImageInput?.addEventListener("change", async () => {
  const file = skinImageInput.files?.[0];
  if (!file) return;
  if (!String(file.type || "").startsWith("image/")) {
    if (skinImageStatus) {
      skinImageStatus.textContent = "请选择图片文件。";
      skinImageStatus.hidden = false;
    }
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
  state.db.settings.appearance = {
    ...(state.db.settings.appearance || {}),
    skin: "custom",
    palette: "",
    skinImage: dataUrl,
    skinImageFit: skinImageFitSelect?.value || "cover"
  };
  if (skinSelect) skinSelect.value = "custom";
  updateThemePaletteSelection("");
  applyAppearance();
  setThemeSettingsDirty(true);
  skinImageInput.value = "";
});
skinImageFitSelect?.addEventListener("change", () => {
  state.db.settings.appearance = {
    ...(state.db.settings.appearance || {}),
    skinImageFit: skinImageFitSelect.value || "cover"
  };
  applyAppearance();
  setThemeSettingsDirty(true);
});
clearSkinImageBtn?.addEventListener("click", () => {
  state.db.settings.appearance = {
    ...(state.db.settings.appearance || {}),
    skin: "custom",
    palette: "",
    skinImage: ""
  };
  if (skinSelect) skinSelect.value = "custom";
  updateThemePaletteSelection("");
  applyAppearance();
  setThemeSettingsDirty(true);
});
saveThemeSettingsBtn?.addEventListener("click", async () => {
  state.db.settings = readSettingsFromDialog();
  await api.saveSettings(state.db.settings);
  state.db = await api.init();
  renderSettings();
  setThemeSettingsDirty(false);
  showCopyToast("主题设置已保存", 2000);
});
document.querySelectorAll(".settings-tab").forEach((button) => {
  button.addEventListener("click", () => switchSettingsTab(button.dataset.settingsTab || "model"));
});
consciousSearchInput?.addEventListener("input", () => renderConsciousCenter());
consciousArchivedToggle?.addEventListener("change", () => renderConsciousCenter());
document.querySelectorAll("[data-black-core-motion]").forEach((button) => {
  button.addEventListener("click", () => setBlackCoreMotion(button.dataset.blackCoreMotion || "static"));
});
let agentHealthProgressChain = Promise.resolve();
let pendingAgentHealthProgress = null;
let agentHealthProgressFrame = 0;
let agentHealthProgressResolvers = [];
let blackBallScanState = null;
let blackBallRepairLastResult = null;
let blackBallFlowState = "idle";
let blackBallLogState = null;

function setBlackBallIssueCount(value = null) {
  if (!agentHealthScore) return;
  if (value === null || value === undefined || value === "") {
    agentHealthScore.textContent = "--";
    agentHealthScore.removeAttribute("data-has-issues");
    return;
  }
  const count = Math.max(0, Number(value) || 0);
  agentHealthScore.textContent = String(count);
  agentHealthScore.dataset.hasIssues = String(count > 0);
}

function queueAgentHealthProgress(progress) {
  pendingAgentHealthProgress = progress;
  const nextFrame = new Promise((resolve) => agentHealthProgressResolvers.push(resolve));
  agentHealthProgressChain = nextFrame;
  if (agentHealthProgressFrame) return nextFrame;
  agentHealthProgressFrame = requestAnimationFrame(() => {
    agentHealthProgressFrame = 0;
    const latest = pendingAgentHealthProgress;
    pendingAgentHealthProgress = null;
    if (latest) renderAgentHealthProgress(latest);
    const resolvers = agentHealthProgressResolvers.splice(0);
    resolvers.forEach((resolve) => resolve());
  });
  return nextFrame;
}

api.onAgentHealthProgress?.((progress) => {
  queueAgentHealthProgress(progress);
});

api.onAgentHealthToolProgress?.((progress = {}) => {
  const capabilityId = String(progress.capabilityId || "");
  if (!capabilityId || !agentHealthGaps) return;
  const button = [...agentHealthGaps.querySelectorAll("[data-health-capability]")]
    .find((item) => item.dataset.healthCapability === capabilityId);
  if (button) updateHealthGapInstallState(button, progress.stage, progress.detail, progress.progress);
});

function renderBlackBallProgress(progress = {}) {
  const percent = Math.max(0, Math.min(100, Number(progress.progress) || 0));
  const completed = progress.completed === true || progress.status === "completed";
  const failed = progress.status === "failed";
  blackBallFlowState = failed ? "failed" : completed ? "completed" : progress.status === "repairing" ? "repairing" : "detecting";
  if (agentHealthOrbit) {
    agentHealthOrbit.dataset.status = failed ? "failed" : blackBallFlowState;
    agentHealthOrbit.dataset.display = "progress";
    agentHealthOrbit.style.setProperty("--health-progress", String(percent));
    agentHealthOrbit.style.setProperty("--health-progress-offset", String(264 * (1 - percent / 100)));
  }
  if (blackBallRingLabel) blackBallRingLabel.textContent = failed ? "!" : `${percent}%`;
  if (agentHealthRun) agentHealthRun.dataset.active = String(!completed && !failed);
  if (agentHealthPhase) agentHealthPhase.textContent = progress.stepLabel || (completed ? "检测完成" : "检测中");
  if (agentHealthProgressCount) agentHealthProgressCount.textContent = `${Number(progress.stepIndex || 0)}/${Number(progress.totalSteps || 5)}`;
  if (agentHealthStatus) agentHealthStatus.textContent = failed ? "检测失败" : completed ? "检测完成" : `${progress.status === "repairing" ? "修复中" : "检测中"} ${percent}%`;
  if (agentHealthMeta) agentHealthMeta.textContent = progress.detail || (completed ? "本地规则检测已完成" : "正在读取本地数据");
  if (agentHealthCurrentTask) agentHealthCurrentTask.textContent = progress.stepLabel || "等待开始检测";
  if (agentHealthCurrentDetail) agentHealthCurrentDetail.textContent = progress.detail || "";
  if (blackBallRepairStatus && !completed && !failed) blackBallRepairStatus.textContent = progress.status === "repairing" ? "正在按规则修复" : "正在检测";
  if (blackBallRepairMeta && !completed && !failed) blackBallRepairMeta.textContent = progress.detail || "不调用网络、模型或 LLM";
}

api.onBlackBallProgress?.((progress) => {
  renderBlackBallProgress(progress);
});

let debugCenterSurfaceSize = null;
let debugCenterSizeLockFrame = 0;

function lockDebugCenterSurfaceSize() {
  if (!settingsDialog?.open || settingsDialog.dataset.activeTab !== "debug") return null;
  const page = settingsDialog.querySelector('.debug-center-page[data-settings-page="debug"]');
  const modalRect = settingsDialog.getBoundingClientRect();
  const pageRect = page?.getBoundingClientRect();
  if (modalRect.width <= 0 || modalRect.height <= 0 || !pageRect?.width || !pageRect?.height) return null;
  debugCenterSurfaceSize = Object.freeze({
    width: modalRect.width,
    height: modalRect.height,
    pageWidth: pageRect.width,
    pageHeight: pageRect.height
  });
  settingsDialog.style.setProperty("--debug-modal-width", `${modalRect.width}px`);
  settingsDialog.style.setProperty("--debug-modal-height", `${modalRect.height}px`);
  settingsDialog.dataset.debugSizeLocked = "true";
  page.style.setProperty("--debug-page-width", `${pageRect.width}px`);
  page.style.setProperty("--debug-page-height", `${pageRect.height}px`);
  page.dataset.sizeLocked = "true";
  return debugCenterSurfaceSize;
}

function scheduleDebugCenterSurfaceSizeLock() {
  cancelAnimationFrame(debugCenterSizeLockFrame);
  debugCenterSizeLockFrame = requestAnimationFrame(() => {
    debugCenterSizeLockFrame = 0;
    lockDebugCenterSurfaceSize();
  });
}

function releaseDebugCenterSurfaceSize() {
  cancelAnimationFrame(debugCenterSizeLockFrame);
  debugCenterSizeLockFrame = 0;
  debugCenterSurfaceSize = null;
  settingsDialog?.removeAttribute("data-debug-size-locked");
  settingsDialog?.style.removeProperty("--debug-modal-width");
  settingsDialog?.style.removeProperty("--debug-modal-height");
  const page = settingsDialog?.querySelector('.debug-center-page[data-settings-page="debug"]');
  page?.removeAttribute("data-size-locked");
  page?.style.removeProperty("--debug-page-width");
  page?.style.removeProperty("--debug-page-height");
}

function setDebugCenterRunPresentation({ running = false, current = 0, total = 9, label = "", passed = null, failed = null, skipped = null, error = "" } = {}) {
  if (debugCenterRunLabel) debugCenterRunLabel.textContent = running ? "正在检测" : "运行全链路自检";
  if (!debugCenterRunMeta) return;
  if (running) {
    debugCenterRunMeta.textContent = `阶段 ${current}/${total} · ${label || "执行真实探针"}`;
  } else if (error) {
    debugCenterRunMeta.textContent = "检测中断 · 可重新运行";
  } else if (Number.isFinite(passed) && Number.isFinite(failed)) {
    debugCenterRunMeta.textContent = `完成 · ${passed} 通过 · ${failed} 失败${Number(skipped) ? ` · ${skipped} 跳过` : ""}`;
  } else {
    debugCenterRunMeta.textContent = `${total} 项真实系统探针`;
  }
}

function debugEvidenceText(evidence) {
  if (!evidence) return "";
  if (typeof evidence === "string") return evidence;
  return Object.entries(evidence)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 8)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" · ");
}

function renderDebugCheck(check = {}) {
  const row = debugCenterChecks?.querySelector(`[data-debug-check="${CSS.escape(check.id || "")}"]`);
  if (!row) return;
  const status = String(check.status || "IDLE").toUpperCase();
  row.dataset.status = status;
  const statusNode = row.querySelector(":scope > b");
  const detailNode = row.querySelector(":scope > p");
  if (statusNode) statusNode.textContent = status === "RUNNING" ? "检测中" : status === "SUCCESS" ? "通过" : status === "FAILED" ? "失败" : status === "SKIPPED" || status === "DISABLED" ? "未启用" : "未检测";
  if (detailNode) detailNode.textContent = status === "FAILED" ? (check.error || "未通过真实探针") : (check.detail || debugEvidenceText(check.evidence) || (status === "SKIPPED" ? "客户版未启用，已跳过" : ""));
}

function renderDebugReport(report = null) {
  const checks = report?.checks || [];
  checks.forEach(renderDebugCheck);
  const total = Number(report?.summary?.total || 9);
  const passed = Number(report?.summary?.passed || 0);
  const failed = Number(report?.summary?.failed || 0);
  const skipped = Number(report?.summary?.skipped || 0);
  if (debugCenterStatus) debugCenterStatus.textContent = report ? "检测完成" : "未检测";
  if (debugCenterStage) debugCenterStage.textContent = report ? (failed ? `发现 ${failed} 项问题` : skipped ? `通过，${skipped} 项未启用已跳过` : "全部项目已执行") : "等待开始";
  if (debugCenterPassed) debugCenterPassed.textContent = `${passed} / ${total}`;
  if (debugCenterFailed) debugCenterFailed.textContent = String(failed);
  const finishedAt = report?.finishedAt ? new Date(report.finishedAt).toLocaleString("zh-CN") : "--";
  if (debugCenterReport) {
    debugCenterReport.innerHTML = report
      ? `<span>报告位置</span><strong>data/qa-agent/latest-report.json</strong><small>${escapeHtml(finishedAt)} · QA 报告 ${escapeHtml(report.id)} · ${passed} 项通过，${failed} 项失败${skipped ? `，${skipped} 项跳过` : ""}</small>`
      : `<span>报告位置</span><strong>尚未生成 QA 测试报告</strong><small>--</small>`;
  }
  if (!state.debugCenterRunning) setDebugCenterRunPresentation({ total, passed: report ? passed : null, failed: report ? failed : null, skipped: report ? skipped : null });
  setSettingsTabSummary("debug", report ? `${passed}/${total} 项通过${skipped ? ` · ${skipped} 跳过` : ""}` : "尚未自检");
}

async function renderDebugCenter() {
  if (!debugCenterChecks) return;
  const report = await api.latestDebugReport?.().catch(() => null);
  renderDebugReport(report);
}

const debugCenterRunChecks = new Map();

api.onDebugCenterProgress?.((progress) => {
  if (!state.debugCenterRunning) return;
  debugCenterRunChecks.set(progress.id, progress);
  renderDebugCheck(progress);
  if (debugCenterStatus) debugCenterStatus.textContent = "QA Agent 检测中";
  const status = String(progress.status || "").toUpperCase();
  const current = Math.max(1, status === "RUNNING" ? Number(progress.index || 0) + 1 : Number(progress.index || 1));
  if (debugCenterStage) debugCenterStage.textContent = `${current} / ${Number(progress.total || 9)} · ${progress.label || "执行真实探针"}`;
  const checks = [...debugCenterRunChecks.values()];
  const passed = checks.filter((item) => item.status === "SUCCESS").length;
  const failed = checks.filter((item) => item.status === "FAILED").length;
  const skipped = checks.filter((item) => String(item.status || "").toUpperCase() === "SKIPPED").length;
  if (debugCenterPassed) debugCenterPassed.textContent = `${passed} / ${Number(progress.total || 9)}`;
  if (debugCenterFailed) debugCenterFailed.textContent = String(failed);
  setDebugCenterRunPresentation({ running: true, current, total: Number(progress.total || 9), label: skipped ? `${progress.label || "执行真实探针"} · ${skipped} 项已跳过` : progress.label || "执行真实探针" });
});

runDebugCenterBtn?.addEventListener("click", async () => {
  if (runDebugCenterBtn.disabled) return;
  const page = runDebugCenterBtn.closest(".debug-center-page");
  const pageScrollTop = page?.scrollTop || 0;
  lockDebugCenterSurfaceSize();
  state.debugCenterRunning = true;
  debugCenterRunChecks.clear();
  runDebugCenterBtn.disabled = true;
  runDebugCenterBtn.classList.add("running");
  runDebugCenterBtn.setAttribute("aria-busy", "true");
  setDebugCenterRunPresentation({ running: true, current: 0, total: 9, label: "初始化真实探针" });
  page?.setAttribute("aria-busy", "true");
  page?.setAttribute("data-running", "true");
  debugCenterChecks?.querySelectorAll("[data-debug-check]").forEach((row) => renderDebugCheck({ id: row.dataset.debugCheck, status: "IDLE" }));
  if (debugCenterStatus) debugCenterStatus.textContent = "QA Agent 检测中";
  if (debugCenterStage) debugCenterStage.textContent = "正在初始化真实探针";
  if (debugCenterPassed) debugCenterPassed.textContent = "0 / 9";
  if (debugCenterFailed) debugCenterFailed.textContent = "0";
  if (debugCenterReport) debugCenterReport.innerHTML = `<span>当前状态</span><strong>QA Agent 正在执行真实全链路检测</strong><small>完成后将在此显示报告位置</small>`;
  if (page) page.scrollTop = pageScrollTop;
  let completedReport = null;
  let runError = "";
  try {
    const report = await api.runDebugCenter();
    completedReport = report;
    renderDebugReport(report);
  } catch (error) {
    runError = error?.message || String(error);
    if (debugCenterStatus) debugCenterStatus.textContent = "自检中断";
    if (debugCenterStage) debugCenterStage.textContent = "检测未完成";
    if (debugCenterReport) debugCenterReport.innerHTML = `<span>失败原因</span><strong>${escapeHtml(runError)}</strong><small>未生成成功报告</small>`;
  } finally {
    state.debugCenterRunning = false;
    runDebugCenterBtn.disabled = false;
    runDebugCenterBtn.classList.remove("running");
    runDebugCenterBtn.removeAttribute("aria-busy");
    const passed = Number(completedReport?.summary?.passed || 0);
    const failed = Number(completedReport?.summary?.failed || 0);
    const skipped = Number(completedReport?.summary?.skipped || 0);
    setDebugCenterRunPresentation({ total: Number(completedReport?.summary?.total || 9), passed: completedReport ? passed : null, failed: completedReport ? failed : null, skipped: completedReport ? skipped : null, error: runError });
    page?.removeAttribute("aria-busy");
    page?.removeAttribute("data-running");
    if (page) page.scrollTop = pageScrollTop;
  }
});
function setBlackBallLogState({ report = null, result = null, error = "" } = {}) {
  blackBallLogState = { report, result, error };
  const remaining = Number(result?.verification?.remainingIssues || 0);
  const issueCount = Number(report?.summary?.totalIssues || remaining || (error ? 1 : 0));
  if (blackBallLogBtn) blackBallLogBtn.hidden = issueCount <= 0;
}

function renderBlackBallLogContent() {
  if (!blackBallLogContent) return;
  const { report, result, error } = blackBallLogState || {};
  const categories = report?.categories || result?.verification?.categories || [];
  const diffs = Array.isArray(result?.diffs) ? result.diffs : [];
  const parts = [];
  if (error) parts.push(`<p class="black-ball-log-error">${escapeHtml(error)}</p>`);
  if (categories.length) {
    parts.push(`<div class="black-ball-log-groups">${categories.map((category) => `
      <section><header><strong>${escapeHtml(category.label || category.id || "问题类别")}</strong><b>${Number(category.count || 0)} 项</b></header>
        ${(category.findings || []).map((finding) => `<p><strong>${escapeHtml(finding.entityId || "未命名数据")}</strong><span>${escapeHtml(finding.detail || "未提供详细说明")}</span></p>`).join("")}
      </section>`).join("")}</div>`);
  }
  if (diffs.length) {
    parts.push(`<section class="black-ball-log-diffs"><header><strong>修复后的真实 diff</strong><b>${diffs.length} 条</b></header>${diffs.map((diff) => `<p><code>${escapeHtml(`${diff.file || ""} · ${diff.path || ""}`)}</code><del>${escapeHtml(diff.beforeText || "<不存在>")}</del><ins>${escapeHtml(diff.afterText || "<不存在>")}</ins></p>`).join("")}</section>`);
  }
  blackBallLogContent.innerHTML = parts.join("") || `<p class="black-ball-log-empty">本次没有错误日志。</p>`;
}

blackBallLogBtn?.addEventListener("click", () => {
  renderBlackBallLogContent();
  if (blackBallLogDialog?.showModal && !blackBallLogDialog.open) blackBallLogDialog.showModal();
});

function renderBlackBallScan(report = null, { autoRepair = false } = {}) {
  if (!blackBallRepairSummary) return;
  blackBallScanState = report;
  blackBallFlowState = "completed";
  const summary = report?.summary || { totalIssues: 0, fixableIssues: 0, confirmationRequired: 0, categoryCount: 0 };
  setBlackBallIssueCount(summary.totalIssues || 0);
  setBlackBallLogState({ report });
  if (agentHealthOrbit) {
    agentHealthOrbit.dataset.status = "completed";
    agentHealthOrbit.dataset.display = "progress";
    agentHealthOrbit.style.setProperty("--health-progress", "100");
    agentHealthOrbit.style.setProperty("--health-progress-offset", "0");
  }
  if (agentHealthRun) agentHealthRun.dataset.active = "false";
  if (agentHealthPhase) agentHealthPhase.textContent = "检测完成";
  if (agentHealthProgressCount) agentHealthProgressCount.textContent = "8/8";
  if (agentHealthStatus) agentHealthStatus.textContent = report ? (summary.totalIssues ? "检测完成" : "检测完成") : "等待检测";
  if (agentHealthMeta) agentHealthMeta.textContent = report ? `本地规则检测 · ${new Date(report.generatedAt).toLocaleString("zh-CN")}` : "本地数据检查与确定性修复";
  if (agentHealthVersion) agentHealthVersion.textContent = report?.scanId || "--";
  if (agentHealthReportTitle) agentHealthReportTitle.textContent = "问题类别与处理计划";
  blackBallRepairStatus.textContent = report ? (summary.totalIssues ? "已完成检测" : "未发现已知问题") : "尚未检测";
  blackBallRepairMeta.textContent = report
    ? `${summary.categoryCount} 类问题 · ${summary.fixableIssues} 项将自动处理 · ${summary.confirmationRequired} 项已写入问题日志`
    : "由黑球故障恢复器按真实字段规则自动处理，不依赖人工确认";
  blackBallRepairSummary.textContent = report
    ? (summary.totalIssues
      ? `问题分布：${summary.categoryCount} 类，共 ${summary.totalIssues} 项。可确定修复项将自动处理，无法安全重建的错误写入日志。`
      : "已扫描任务、意识快照和项目树，当前没有发现已知问题。")
    : "点击“开始检测”扫描历史任务、意识快照和项目树结构。";
  if (runAgentHealthBtn) {
    runAgentHealthBtn.disabled = autoRepair;
    runAgentHealthBtn.classList.toggle("running", autoRepair);
    runAgentHealthBtn.textContent = autoRepair ? "自动修复中" : "重新检测";
  }
}

function renderBlackBallRepairResult(result = {}) {
  const diffs = Array.isArray(result.diffs) ? result.diffs : [];
  const verification = result.verification || {};
  blackBallScanState = null;
  blackBallFlowState = result.ok ? "completed" : "failed";
  blackBallRepairLastResult = result;
  setBlackBallIssueCount(verification.remainingIssues || 0);
  setBlackBallLogState({ report: blackBallLogState?.report || null, result });
  if (agentHealthStatus) agentHealthStatus.textContent = result.ok ? "修复已验证" : "修复未执行";
  if (agentHealthMeta) agentHealthMeta.textContent = result.ok ? `重新读取完成 · ${result.changedCount || 0} 项真实字段变化` : (result.message || "需要重新检测");
  blackBallRepairStatus.textContent = result.ok ? "修复完成并已复核" : "数据发生变化";
  blackBallRepairMeta.textContent = result.ok ? `重新读取后仍有 ${Number(verification.remainingIssues || 0)} 项问题` : "未写入任何文件，请重新检测";
  blackBallRepairSummary.textContent = result.ok
    ? `实际修改 ${result.changedFiles?.length || 0} 个文件，读取后生成 ${diffs.length} 条真实 diff。${verification.remainingIssues ? `仍有 ${verification.remainingIssues} 项需要处理。` : "已没有剩余已知问题。"}`
    : (result.message || "检测结果已失效，请重新检测。");
  if (blackBallLogBtn) blackBallLogBtn.hidden = !(Number(verification.remainingIssues || 0) || diffs.length);
  if (runAgentHealthBtn) {
    runAgentHealthBtn.disabled = false;
    runAgentHealthBtn.classList.remove("running");
    runAgentHealthBtn.textContent = "重新检测";
  }
}

function renderBlackBallFailure(error = {}) {
  blackBallFlowState = "failed";
  blackBallScanState = null;
  const message = error.message || error.error || "黑球检测或修复未完成";
  setBlackBallIssueCount(1);
  setBlackBallLogState({ error: message });
  if (agentHealthOrbit) {
    agentHealthOrbit.dataset.status = "failed";
    agentHealthOrbit.dataset.display = "progress";
    agentHealthOrbit.style.setProperty("--health-progress", "0");
    agentHealthOrbit.style.setProperty("--health-progress-offset", "264");
  }
  if (blackBallRingLabel) blackBallRingLabel.textContent = "!";
  if (agentHealthRun) agentHealthRun.dataset.active = "false";
  if (agentHealthStatus) agentHealthStatus.textContent = "检测失败";
  if (agentHealthMeta) agentHealthMeta.textContent = message;
  if (agentHealthPhase) agentHealthPhase.textContent = "处理失败";
  if (agentHealthCurrentTask) agentHealthCurrentTask.textContent = "未写入任何数据";
  if (agentHealthCurrentDetail) agentHealthCurrentDetail.textContent = "请重新检测确认数据状态后再试";
  if (blackBallRepairStatus) blackBallRepairStatus.textContent = "处理失败";
  if (blackBallRepairMeta) blackBallRepairMeta.textContent = message;
  if (blackBallRepairSummary) blackBallRepairSummary.textContent = "本次没有确认写入任何数据。请点击“重新检测”后再处理。";
  if (runAgentHealthBtn) {
    runAgentHealthBtn.disabled = false;
    runAgentHealthBtn.classList.remove("running");
    runAgentHealthBtn.textContent = "重新检测";
  }
}

function setBlackBallBusyState(mode = "scan") {
  const repairing = mode === "repair";
  if (agentHealthOrbit) {
    agentHealthOrbit.dataset.status = "detecting";
    agentHealthOrbit.dataset.display = "progress";
    agentHealthOrbit.style.setProperty("--health-progress", "0");
    agentHealthOrbit.style.setProperty("--health-progress-offset", "264");
  }
  if (blackBallRingLabel) blackBallRingLabel.textContent = "0%";
  if (agentHealthRun) agentHealthRun.dataset.active = "true";
  blackBallFlowState = repairing ? "repairing" : "detecting";
  if (agentHealthOrbit) agentHealthOrbit.dataset.status = blackBallFlowState;
  if (agentHealthPhase) agentHealthPhase.textContent = repairing ? "准备修复" : "开始检测";
  if (agentHealthProgressCount) agentHealthProgressCount.textContent = "0/" + (repairing ? "3" : "5");
  setBlackBallIssueCount(null);
  if (agentHealthStatus) agentHealthStatus.textContent = repairing ? "修复中 0%" : "检测中 0%";
  if (agentHealthMeta) agentHealthMeta.textContent = repairing ? "准备重新读取并按确定性规则修复" : "准备扫描历史任务";
}

async function runRealCoreHealthCheck() {
  if (typeof api.runAgentHealthCheck !== "function") return null;
  try {
    const report = await api.runAgentHealthCheck();
    if (report) await renderAgentHealth(report);
    return report;
  } catch (error) {
    if (agentHealthStatus) agentHealthStatus.textContent = "核心能力检测失败";
    if (agentHealthMeta) agentHealthMeta.textContent = error?.message || String(error);
    return null;
  }
}

async function autoRepairBlackBallReport(report, { retryOnConflict = true } = {}) {
  if (!report?.hasRepairableChanges || !report?.scanId) return null;
  const result = await api.blackBallRepair(report.scanId);
  if (result?.conflict) {
    const refreshed = result.scan;
    const canRetry = Boolean(retryOnConflict && refreshed?.hasRepairableChanges && refreshed?.scanId);
    renderBlackBallScan(refreshed, { autoRepair: canRetry });
    if (canRetry) return autoRepairBlackBallReport(refreshed, { retryOnConflict: false });
    return result;
  }
  if (result?.ok === false) renderBlackBallFailure(result);
  else renderBlackBallRepairResult(result);
  return result;
}

async function runAgentHealthCheck({ silent = false } = {}) {
  if (runAgentHealthBtn.disabled) return;
  const repairing = Boolean(blackBallScanState?.hasRepairableChanges && blackBallScanState.scanId);
  runAgentHealthBtn.disabled = true;
  runAgentHealthBtn.classList.add("running");
  runAgentHealthBtn.textContent = repairing ? "正在修复并复核" : "检测中";
  setBlackBallBusyState(repairing ? "repair" : "scan");
  try {
    if (repairing) {
      const result = await autoRepairBlackBallReport(blackBallScanState);
      await runRealCoreHealthCheck();
      return result;
    }
    const report = await api.blackBallScan();
    if (report?.status === "failed" || report?.ok === false) renderBlackBallFailure(report);
    else {
      const autoRepair = Boolean(report?.hasRepairableChanges && report?.scanId);
      renderBlackBallScan(report, { autoRepair });
      if (autoRepair) await autoRepairBlackBallReport(report);
      await runRealCoreHealthCheck();
    }
    return report;
  } catch (error) {
    if (!silent) {
      blackBallFlowState = "failed";
      if (agentHealthOrbit) {
        agentHealthOrbit.dataset.status = "failed";
        agentHealthOrbit.dataset.display = "progress";
      }
      if (agentHealthStatus) agentHealthStatus.textContent = "检测失败";
      if (agentHealthMeta) agentHealthMeta.textContent = error?.message || String(error);
      blackBallRepairStatus.textContent = "检测失败";
      blackBallRepairMeta.textContent = error?.message || String(error);
      blackBallRepairSummary.textContent = "本次没有写入任何数据。请点击“重新检测”确认数据状态后再试。";
    }
    return null;
  } finally {
    if (runAgentHealthBtn) {
      runAgentHealthBtn.disabled = false;
      runAgentHealthBtn.classList.remove("running");
      runAgentHealthBtn.textContent = "重新检测";
    }
    if (agentHealthRun && !blackBallScanState?.hasRepairableChanges) agentHealthRun.dataset.active = "false";
  }
}

runAgentHealthBtn?.addEventListener("click", async () => {
  await runAgentHealthCheck().catch(() => null);
});
async function saveSettingsFromDialogSilently() {
  state.db.settings = readSettingsFromDialog();
  await api.saveSettings(state.db.settings);
  await api.setAutoLaunch?.(Boolean(autoLaunchInput?.checked));
  state.db = await api.init();
}

updateCheckBtn?.addEventListener("click", async () => {
  if (updateOperationActive) return;
  await saveSettingsFromDialogSilently();
  await renderUpdateInfo();
});
applyOnlineUpdateBtn?.addEventListener("click", async () => {
  if (!updateContent || updateOperationActive || !availableUpdateInfo?.hasUpdate) return;
  const downloadUrl = String(availableUpdateInfo.downloadUrl || availableUpdateInfo.packageUrl || "").trim();
  const checksum = String(availableUpdateInfo.sha256 || availableUpdateInfo.checksum || "").replace(/^sha256:/i, "").trim();
  if (!/^https?:\/\//i.test(downloadUrl)) {
    renderUpdateStatus({ phase: "error", title: "下载地址无效", detail: "版本清单没有提供有效的更新包 HTTP(S) 地址。", info: availableUpdateInfo });
    return;
  }
  if (!/^[a-f0-9]{64}$/i.test(checksum)) {
    renderUpdateStatus({ phase: "error", title: "更新清单无效", detail: "版本清单缺少有效的 SHA-256 校验值，已阻止安装。", info: availableUpdateInfo });
    return;
  }
  updateOperationActive = true;
  applyOnlineUpdateBtn.disabled = true;
  let restartScheduled = false;
  try {
    const result = await api.applyOnlineUpdate({ autoApply: true });
    if (!result?.ok) throw new Error(result?.error || "更新安装器未能启动。");
    restartScheduled = Boolean(result.restart);
    paintUpdateProgress({ phase: restartScheduled ? "restarting" : "preparing", progress: 100 });
  } catch (error) {
    renderUpdateStatus({ phase: "error", title: "更新失败", detail: String(error.message || error).replace(/Error:|Exception:|Failed:/gi, "").trim(), info: availableUpdateInfo });
  } finally {
    updateOperationActive = false;
    if (!restartScheduled) {
      applyOnlineUpdateBtn.disabled = false;
      applyOnlineUpdateBtn.textContent = "重试更新";
    }
  }
});
publishUpdateBtn?.addEventListener("click", async () => {
  if (!updateContent) return;
  const version = publishVersionInput?.value?.trim() || appVersion?.textContent?.trim() || "";
  const notes = publishNotesInput?.value?.trim() || "客户版更新。";
  if (!version) {
    updateContent.textContent = "请输入新版本号。";
    return;
  }
  if (!await showAppConfirm({
    title: "发布客户版更新",
    message: `发布客户版 ${version}？客户将可以在更新里下载。`,
    primary: "发布",
    secondary: "取消"
  })) return;
  publishUpdateBtn.disabled = true;
  updateContent.textContent = "正在发布客户更新包。";
  try {
    const result = await api.publishUpdate({ version, notes });
    updateContent.innerHTML = `<p>${escapeHtml(result.message || "发布完成。")}</p><pre>${escapeHtml(`${result.packageFile || ""}\n${result.manifestPath || ""}`)}</pre>`;
  } catch (error) {
    updateContent.textContent = `发布失败：${String(error.message || error).replace(/Error:|Exception:|Failed:/gi, "").trim()}`;
  } finally {
    publishUpdateBtn.disabled = false;
  }
});
startUpdateServerBtn?.addEventListener("click", async () => {
  if (!updateContent) return;
  startUpdateServerBtn.disabled = true;
  updateContent.textContent = "正在启动更新服务器。";
  try {
    const result = await api.startUpdateServer();
    updateContent.textContent = `${result.message || "更新服务器已启动。"} 地址：${result.url || "http://localhost:3000"}`;
  } catch (error) {
    updateContent.textContent = `启动失败：${error.message || error}`;
  } finally {
    startUpdateServerBtn.disabled = false;
  }
});
chooseSaveLocationBtn?.addEventListener("click", async () => {
  const folder = await api.chooseSaveLocation();
  if (!folder || !saveLocationInput) return;
  saveLocationInput.value = folder;
  state.db.settings = readSettingsFromDialog();
  await api.saveSettings(state.db.settings);
  await api.setAutoLaunch?.(Boolean(autoLaunchInput?.checked));
  state.db = await api.init();
  renderSettings();
});
resetSaveLocationBtn?.addEventListener("click", async () => {
  if (!saveLocationInput) return;
  saveLocationInput.value = state.db?.settings?.files?.defaultSaveLocation || "D:\\白球AI\\data\\workspace";
  state.db.settings = readSettingsFromDialog();
  await api.saveSettings(state.db.settings);
  await api.setAutoLaunch?.(Boolean(autoLaunchInput?.checked));
  state.db = await api.init();
  renderSettings();
});
unlockInviteBtn?.addEventListener("click", async () => {
  const code = (inviteInput?.value || "").trim();
  if (!code) {
    if (inviteStatus) inviteStatus.textContent = "请输入兑换码。";
    return;
  }
  const customer = state.db?.settings?.customerProfile || {};
  const result = await (window.license.confirmActivation?.({ code, ...customer }) || window.license.verifyCode(code, customer));
  state.db = await api.init();
  if (inviteInput) inviteInput.value = result.code || code;
  await refreshLicenseStatus();
  await renderLicenseControls();
  const activated = Boolean(result.ok || result.success);
  if (inviteStatus) {
    inviteStatus.textContent = activated ? "✓ 激活成功" : (result.message || "兑换码无效。");
    inviteStatus.dataset.tone = activated ? "success" : "error";
    inviteStatus.classList.remove("activated");
    if (activated) {
      void inviteStatus.offsetWidth;
      inviteStatus.classList.add("activated");
    }
  }
  if (activated) showCopyToast("会员激活成功", 2000);
});
inviteInput?.addEventListener("input", () => {
  inviteInput.value = formatLicenseCode(inviteInput.value);
});
licenseCodeInput?.addEventListener("input", () => {
  licenseCodeInput.value = formatLicenseCode(licenseCodeInput.value);
});
licenseActivateBtn?.addEventListener("click", async () => {
  const code = licenseCodeInput?.value || "";
  if (!code) {
    if (licenseOverlayStatus) licenseOverlayStatus.textContent = "请输入兑换码。";
    return;
  }
  if (licenseOverlayStatus) licenseOverlayStatus.textContent = "正在验证兑换码...";
  const customer = state.db?.settings?.customerProfile || {};
  const result = await (window.license.confirmActivation?.({ code, ...customer }) || window.license.verifyCode(code, customer));
  if (licenseOverlayStatus) licenseOverlayStatus.textContent = result.message || (result.ok ? "激活成功。" : "兑换码无效。");
  if (result.ok || result.success) {
    state.db = await api.init();
    await refreshLicenseStatus();
    await renderLicenseControls();
    setTimeout(() => {
      if (licenseOverlay) licenseOverlay.hidden = true;
      if (licenseActivateBtn) licenseActivateBtn.textContent = "验证确认";
    }, 1500);
  }
});
licenseMonthlyBtn?.addEventListener("click", () => activateMembershipPlan("monthly"));
licenseSixMonthsBtn?.addEventListener("click", () => activateMembershipPlan("six_months"));
licenseYearlyBtn?.addEventListener("click", () => activateMembershipPlan("yearly"));
function selectMembershipPlan(plan) {
  document.querySelectorAll("[data-membership-plan]").forEach((button) => {
    const selected = button.dataset.membershipPlan === plan;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  activateMembershipPlan(plan);
}
settingsMonthlyBtn?.addEventListener("click", () => selectMembershipPlan("monthly"));
settingsSixMonthsBtn?.addEventListener("click", () => selectMembershipPlan("six_months"));
settingsYearlyBtn?.addEventListener("click", () => selectMembershipPlan("yearly"));
document.querySelectorAll("[data-payment-method]").forEach((button) => {
  button.addEventListener("click", async () => {
    const method = button.dataset.paymentMethod || "wechat";
    if (method === selectedPaymentMethod || paymentPanel?.dataset.state === "loading") return;
    selectPaymentMethod(method);
    await createMembershipOrder(pendingPaymentPlan, selectedPaymentMethod);
  });
});
document.querySelectorAll("[data-payment-preview]").forEach((button) => {
  button.addEventListener("click", () => openPaymentQrPreview(button.dataset.paymentPreview, button));
});
paymentQrPreviewClose?.addEventListener("click", closePaymentQrPreview);
paymentQrPreview?.addEventListener("click", (event) => {
  if (event.target === paymentQrPreview) closePaymentQrPreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !paymentQrPreview?.hidden) closePaymentQrPreview();
});
paymentCheckBtn?.addEventListener("click", () => checkPaymentOrder());
paymentCloseBtn?.addEventListener("click", closeMembershipPayment);
paymentReturnBtn?.addEventListener("click", closeMembershipPayment);
paymentCopyBtn?.addEventListener("click", async () => {
  const orderId = pendingPaymentOrder?.orderId || "";
  if (!orderId) return;
  await api.copyText?.(orderId);
  setPaymentStatus("订单号已复制。", "success");
});
customerProfilePhone?.addEventListener("input", () => {
  customerProfilePhone.value = customerProfilePhone.value.replace(/\D/g, "").slice(0, 11);
});
customerProfileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = customerProfileName?.value?.trim() || "";
  const phone = customerProfilePhone?.value?.trim() || "";
  if (customerProfileError) customerProfileError.textContent = "";
  if (customerProfileSubmit) customerProfileSubmit.disabled = true;
  try {
    const result = await api.completeCustomerProfile({ name, phone });
    if (!result?.ok) {
      if (customerProfileError) customerProfileError.textContent = result?.message || "资料保存失败，请检查后重试。";
      return;
    }
    state.db = await api.init();
    renderCustomerProfileGate();
  } catch (error) {
    if (customerProfileError) customerProfileError.textContent = error?.message || "资料保存失败，请稍后重试。";
  } finally {
    if (customerProfileSubmit) customerProfileSubmit.disabled = false;
  }
});
licenseBuyBtn?.addEventListener("click", () => {
  showAppConfirm({
    title: "会员价格",
    message: "月卡首次 ¥19.9（原价 ¥49.9），6个月 ¥88（原价 ¥99）。也可以输入管理员发放的永久兑换码。",
    primary: "知道了",
    secondary: "关闭"
  });
});
let selectedSkillSourceType = "text";
let skillLearningLogEntries = [];
const SKILL_PROGRESS_STAGES = ["RESEARCHING", "GENERATING", "INSTALLING", "REGISTERING", "TESTING", "VERIFYING", "READY"];

function appendSkillLearningLog(message, stage = "") {
  const text = String(message || "").trim();
  if (!text) return;
  skillLearningLogEntries.push({ time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), stage, text });
  skillLearningLogEntries = skillLearningLogEntries.slice(-24);
  if (learnSkillLog) learnSkillLog.innerHTML = skillLearningLogEntries.map((entry) => `<div><time>${escapeHtml(entry.time)}</time><span>${entry.stage ? `<b>${escapeHtml(entry.stage)}</b>` : ""}${escapeHtml(entry.text)}</span></div>`).join("");
}

function renderSkillLearningProgress(stage, message = "") {
  const normalized = String(stage || "IDLE").toUpperCase();
  if (learnSkillProgress) {
    learnSkillProgress.dataset.stage = normalized;
    const currentIndex = SKILL_PROGRESS_STAGES.indexOf(normalized);
    learnSkillProgress.querySelectorAll("i[data-stage]").forEach((node, index) => {
      node.classList.toggle("complete", normalized === "READY" || currentIndex > index);
      node.classList.toggle("active", currentIndex === index && normalized !== "READY");
      node.classList.toggle("failed", normalized === "FAILED" && index === Math.max(0, currentIndex));
    });
  }
  const label = message || SKILL_LEARNING_LABELS[normalized] || "处理中";
  if (learnSkillStatus) {
    learnSkillStatus.textContent = `${normalized} · ${label}`;
    learnSkillStatus.dataset.stage = normalized;
  }
}

function selectSkillSourceType(type) {
  selectedSkillSourceType = ["file", "web"].includes(type) ? type : "text";
  document.querySelectorAll("[data-skill-source]").forEach((button) => {
    const active = button.dataset.skillSource === selectedSkillSourceType;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (learnSkillSourceLabel) learnSkillSourceLabel.textContent = selectedSkillSourceType === "web" ? "资料网页" : selectedSkillSourceType === "file" ? "文件内容" : "资料或专业主题";
  if (learnSkillSourceInput) {
    learnSkillSourceInput.placeholder = selectedSkillSourceType === "web" ? "https://example.com/professional-guide" : selectedSkillSourceType === "file" ? "选择文件后将在这里读取文本内容" : "输入专业资料、规则或需要学习的主题";
    learnSkillSourceInput.readOnly = selectedSkillSourceType === "file";
  }
  if (selectedSkillSourceType === "file") learnSkillSourceFile?.click();
  else if (learnSkillFileName) learnSkillFileName.hidden = true;
}

openCustomSkillBtn?.addEventListener("click", () => {
  if (!customSkillEditor) return;
  customSkillEditor.hidden = false;
  skillNameInput?.focus();
});
cancelCustomSkillBtn?.addEventListener("click", () => {
  if (customSkillEditor) customSkillEditor.hidden = true;
});
document.querySelectorAll("[data-skill-source]").forEach((button) => button.addEventListener("click", () => selectSkillSourceType(button.dataset.skillSource)));
learnSkillSourceFile?.addEventListener("change", async () => {
  const file = learnSkillSourceFile.files?.[0];
  if (!file) return;
  const text = await file.text().catch(() => "");
  if (learnSkillSourceInput) learnSkillSourceInput.value = text.slice(0, 120000);
  if (learnSkillFileName) {
    learnSkillFileName.hidden = false;
    learnSkillFileName.textContent = `${file.name} · ${formatTaskBoardBytes(file.size)}`;
  }
  appendSkillLearningLog(`已读取学习文件：${file.name}`, "SOURCE");
});
clearSkillLearnLogBtn?.addEventListener("click", () => {
  skillLearningLogEntries = [];
  if (learnSkillLog) learnSkillLog.innerHTML = "<div><time>--:--</time><span>等待学习任务</span></div>";
});
manageMemoriesBtn?.addEventListener("click", () => {
  if (!memoryList) return;
  const expanded = memoryList.classList.toggle("expanded");
  manageMemoriesBtn.textContent = expanded ? "收起记忆" : "管理全部记忆";
  if (expanded) memoryList.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
addSkillBtn?.addEventListener("click", async () => {
  const name = skillNameInput?.value?.trim() || "";
  const body = skillBodyInput?.value?.trim() || "";
  if (!name || !body) return;
  await api.addSkill({ name, body });
  skillNameInput.value = "";
  skillBodyInput.value = "";
  if (customSkillEditor) customSkillEditor.hidden = true;
  if (skillList) skillList.dataset.loaded = "0";
  await renderSkills(true);
});
addMemoryBtn?.addEventListener("click", async () => {
  const text = memoryInput?.value?.trim() || "";
  if (!text) return;
  await api.addMemory({ text, source: "手动记忆" });
  if (memoryInput) memoryInput.value = "";
  if (skillList) skillList.dataset.loaded = "0";
  await renderSkills(true);
});
verifyMemoryBtn?.addEventListener("click", async () => {
  if (verifyMemoryBtn.disabled) return;
  verifyMemoryBtn.disabled = true;
  if (memoryProofStatus) memoryProofStatus.textContent = "验证中";
  try {
    const result = await api.verifyMemoryRecall?.();
    if (!result?.success) throw new Error(result?.checks?.find((item) => !item.passed)?.detail || "跨会话未召回探针标记");
    if (memoryProofStatus) memoryProofStatus.textContent = "已验证跨会话召回";
  } catch (error) {
    if (memoryProofStatus) memoryProofStatus.textContent = `未通过：${error.message || error}`;
  } finally {
    verifyMemoryBtn.disabled = false;
  }
});
learnSkillBtn?.addEventListener("click", async () => {
  const source = learnSkillSourceInput?.value?.trim() || "";
  const name = learnSkillNameInput?.value?.trim() || "";
  if (!source) {
    renderSkillLearningProgress("FAILED", "请输入学习资料来源");
    appendSkillLearningLog("未检测到可学习的文件、网页或文本资料", "FAILED");
    return;
  }
  if (learnSkillBtn) learnSkillBtn.disabled = true;
  renderSkillLearningProgress("RESEARCHING", "正在分析技能需求与学习来源");
  appendSkillLearningLog(`开始学习：${name || "自动识别技能"} · 来源 ${selectedSkillSourceType}`, "RESEARCHING");
  try {
    let result = await api.learnSkill({ source, name });
    if (result?.confirmationRequired) {
      const detail = result.confirmation || {};
      const repository = detail.source?.repository || "GitHub";
      const permissions = detail.permissions?.length ? detail.permissions.join("、") : "仅文本读取";
      const hash = String(result.confirmationHash || "").slice(0, 12);
      const confirmed = await showAppConfirm({
        title: "确认安装黑球技能",
        message: `来源：${blackBallBrandText(repository)}\n本地操作：${blackBallBrandText(permissions)}\n确认标识：${hash}\n\n确认后由黑球安装，并以真实技能文件与检查结果作为成功依据。`,
        primary: "确认安装",
        secondary: "取消"
      });
      if (!confirmed) {
        renderSkillLearningProgress("FAILED", "已取消黑球技能安装");
        appendSkillLearningLog("用户取消了黑球技能安装", "FAILED");
        return;
      }
      result = await api.learnSkill({ source: result.selectedSource || source, name, confirmed: true, confirmationHash: result.confirmationHash });
    }
    if (!result?.success || result?.status !== "READY" || !result?.verification?.verified) {
      throw new Error(result?.error || "技能未通过实际调用验证，未进入 READY 状态");
    }
    const skillName = result.item?.name || name || source;
    renderSkillLearningProgress("READY", `已学习 / 已启用：${skillName}`);
    appendSkillLearningLog(`${skillName} 已通过黑球安装清单与实际复检`, "READY");
    if (learnSkillNameInput) learnSkillNameInput.value = "";
    if (learnSkillSourceInput) learnSkillSourceInput.value = "";
    if (skillList) skillList.dataset.loaded = "0";
    await renderSkills(true);
    await runAgentHealthCheck({ silent: true });
  } catch (error) {
    renderSkillLearningProgress("FAILED", `学习失败：${error.message || error}`);
    appendSkillLearningLog(error.message || String(error), "FAILED");
  } finally {
    if (learnSkillBtn) learnSkillBtn.disabled = false;
  }
});

const SKILL_LEARNING_LABELS = {
  IDLE: "准备学习",
  RESEARCHING: "分析需求、来源与技术方案",
  GENERATING: "生成 Skill",
  INSTALLING: "安装 Skill 文件",
  REGISTERING: "注册到 Global Skill Pool",
  TESTING: "执行运行测试",
  VERIFYING: "验证 Registry 与 Agent 调用",
  READY: "技能已验证并启用",
  FAILED: "技能学习失败"
};

api.onSkillLearningProgress?.((progress = {}) => {
  const stage = String(progress.stage || progress.status || "IDLE").toUpperCase();
  const label = SKILL_LEARNING_LABELS[stage] || "处理中";
  renderSkillLearningProgress(stage, label);
  appendSkillLearningLog(progress.message || label, stage);
  if (activeHealthSkillInstall?.button?.isConnected) {
    updateHealthGapInstallState(activeHealthSkillInstall.button, stage, progress.message || healthGapStageLabel(stage), progress.progress);
  }
});
savePersonaBtn?.addEventListener("click", async (event) => {
  event.preventDefault();
  await savePersona(true);
  personaDialog?.close();
});
adminRefreshCodesBtn?.addEventListener("click", renderAdminCodeList);
adminCodeSearchInput?.addEventListener("input", renderAdminCodeList);
adminExportCodesBtn?.addEventListener("click", async () => {
  try {
    const csv = await window.admin.exportCodes("csv");
    await api.copyText(csv);
    showCopyToast("CSV已复制");
  } catch (error) {
    if (adminCodeListOutput) adminCodeListOutput.value = `导出失败：${error.message || error}`;
  }
});
refreshDeveloperLogsBtn?.addEventListener("click", renderDeveloperLogs);
developerLogTypeSelect?.addEventListener("change", renderDeveloperLogs);
exportDeveloperLogsBtn?.addEventListener("click", async () => {
  if (!developerLogOutput) return;
  try {
    const result = await window.admin.exportLogs();
    developerLogOutput.value = `已导出：${result.file}`;
  } catch (error) {
    developerLogOutput.value = `导出失败：${error.message || error}`;
  }
});
generateInviteBtn?.addEventListener("click", async () => {
  const count = Number(inviteCountInput?.value || 5);
  const codes = await api.generateInvite(count).catch((error) => [`生成失败：${error.message || error}`]);
  if (generatedInviteOutput) generatedInviteOutput.value = codes.join("\n");
});
sideReasoningSelect?.addEventListener("change", async () => {
  state.db.settings.reasoning = sideReasoningSelect.value || "minimal";
  reasoningSelect.value = state.db.settings.reasoning;
  await api.saveSettings(state.db.settings);
  await api.setAutoLaunch?.(Boolean(autoLaunchInput?.checked));
  state.db = await api.init();
  renderSettings();
  renderMetricBars(selectedSession(), []);
});
document.querySelectorAll("[data-window]").forEach((button) => {
  button.addEventListener("click", () => api.windowControl(button.dataset.window));
});

closeHideBtn?.addEventListener("click", async () => {
  hideCloseConfirm();
  await api.windowControl("close-hide");
});
closeQuitBtn?.addEventListener("click", async () => {
  hideCloseConfirm();
  await api.windowControl("close-quit");
});
closeCancelBtn?.addEventListener("click", hideCloseConfirm);
closeConfirmLayer?.addEventListener("click", (event) => {
  if (event.target === closeConfirmLayer) hideCloseConfirm();
});

contextMenu.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const id = contextMenu.dataset.id;
  const kind = contextMenu.dataset.kind;
  contextMenu.hidden = true;
  if (kind === "project") await handleProjectAction(button.dataset.action, id);
  else await handleSessionAction(button.dataset.action, id);
});

messageQuoteBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  const quote = state.messageContextTarget;
  messageContextMenu.hidden = true;
  if (quote) setComposerQuote(quote);
});
presetTaskEditBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  const target = state.presetTaskContextTarget;
  presetTaskContextMenu.hidden = true;
  state.presetTaskContextTarget = null;
  if (!target) return;
  const session = state.db?.sessions?.find((item) => item.id === target.sessionId);
  const task = sessionTaskQueue.list(target.sessionId).find((item) => item.id === target.taskId);
  if (session && task) restoreQueuedTaskToComposer(session, task);
});
composerQuoteClose?.addEventListener("click", clearComposerQuote);
composerQuoteJump?.addEventListener("click", () => {
  if (state.composerQuote?.messageId) scrollToQuotedMessage(state.composerQuote.messageId);
});
messageList?.addEventListener("scroll", () => {
  if (messageContextMenu) messageContextMenu.hidden = true;
  if (presetTaskContextMenu) presetTaskContextMenu.hidden = true;
}, { passive: true });
queueList?.addEventListener("scroll", () => {
  if (presetTaskContextMenu) presetTaskContextMenu.hidden = true;
}, { passive: true });

document.addEventListener("click", () => {
  contextMenu.hidden = true;
  if (messageContextMenu) messageContextMenu.hidden = true;
  if (presetTaskContextMenu) presetTaskContextMenu.hidden = true;
});

let lastGatewayRenderAt = 0;
let lastGatewayRenderState = "";
api.onGatewayStatus((status) => {
  const key = `${status.state || ""}:${status.message || ""}`;
  const now = Date.now();
  if (key === lastGatewayRenderState && now - lastGatewayRenderAt < 30000) return;
  lastGatewayRenderAt = now;
  lastGatewayRenderState = key;
  const map = {
    connecting: "白球内核启动中",
    connected: "白球内核已就绪",
    disconnected: "白球内核重连中",
    error: `白球内核异常 ${status.message || ""}`,
    auth_failed: "白球内核鉴权失败"
  };
  if (gatewayStatus) gatewayStatus.textContent = map[status.state] || status.state || "白球内核";
});

let taskBoardLiveRenderTimer = null;
function recordTaskBoardLiveEvent(frame = {}) {
  const sessionId = String(frame.sessionId || "");
  if (!sessionId) return;
  const update = frame.update && typeof frame.update === "object" ? frame.update : {};
  let event = null;
  if (frame.type === "hermes_tool_update") {
    const toolId = String(update.toolCallId || update.id || update.toolCall?.id || `${Date.now()}`);
    const rawInput = update.rawInput || update.input || update.toolCall?.rawInput || update.toolCall?.input || {};
    const detail = typeof rawInput === "string" ? rawInput : Object.keys(rawInput).length ? JSON.stringify(rawInput) : "Hermes 正在执行真实工具调用";
    event = {
      id: `live-tool:${toolId}`,
      source: "Hermes 工具",
      label: update.title || update.name || update.toolCall?.title || update.toolCall?.name || "工具调用",
      detail: String(update.error || update.message || detail).slice(0, 260),
      status: update.status || (update.sessionUpdate === "tool_call_update" ? "running" : "running"),
      createdAt: Date.now()
    };
  } else if (frame.type === "hermes-delegation-update") {
    event = {
      id: `live-delegation:${update.id || update.taskId || Date.now()}`,
      source: "Hermes 委派",
      label: update.title || update.name || "子任务更新",
      detail: String(update.message || update.summary || update.error || "Hermes 委派状态更新").slice(0, 260),
      status: update.status || "running",
      createdAt: Date.now()
    };
  } else if (frame.type === "project-assignment-status") {
    const status = String(frame.status || update.status || "").toLowerCase();
    const tone = status === "completed" ? "success" : status === "failed" ? "failed" : "running";
    event = {
      id: `project-assignment:${frame.runId || ""}:${frame.assignmentId || sessionId}`,
      source: "Hermes 员工",
      label: status === "completed" ? "员工完成" : status === "failed" ? "员工失败" : "员工执行",
      detail: String(update.message || update.summary || update.error || frame.resultMessageId || "员工任务状态更新").slice(0, 260),
      status: tone,
      createdAt: update.updatedAt || update.finishedAt || update.startedAt || Date.now()
    };
  } else if (frame.type === "browser_navigation") {
    event = {
      id: `live-browser:${frame.url || Date.now()}`,
      source: "黑球浏览器",
      label: frame.title || "打开网页",
      detail: frame.url || "浏览器页面已加载",
      status: "success",
      createdAt: frame.createdAt || Date.now()
    };
  }
  if (!event) return;
  const list = Array.isArray(state.taskBoardLiveEvents[sessionId]) ? state.taskBoardLiveEvents[sessionId] : [];
  const existing = list.findIndex((item) => item.id === event.id);
  if (existing >= 0) list[existing] = { ...list[existing], ...event };
  else list.unshift(event);
  state.taskBoardLiveEvents[sessionId] = list.slice(0, 80);
  state.taskBoardEventCache = { signature: "", value: null };
  const drawer = document.getElementById("taskBoardDrawer");
  if (sessionId !== state.selectedSessionId || !drawer || drawer.hidden || !["overview", "timeline"].includes(state.taskBoardTab)) return;
  clearTimeout(taskBoardLiveRenderTimer);
  taskBoardLiveRenderTimer = setTimeout(renderTaskBoard, 80);
}

api.onGatewayEvent?.(recordTaskBoardLiveEvent);
api.onBrowserState?.((browserState) => {
  state.blackBallBrowser = { ...state.blackBallBrowser, ...(browserState || {}) };
  const drawer = document.getElementById("taskBoardDrawer");
  if (drawer && !drawer.hidden && state.taskBoardTab === "links") renderTaskBoard();
});
api.onBrowserOpenRequest?.((payload = {}) => {
  const target = String(payload.target || "").trim();
  if (!target) return;
  openTaskBoard("links");
  requestAnimationFrame(() => requestEmbeddedBrowserLayout(target, payload.source || "hermes"));
});
api.browserState?.().then((browserState) => {
  state.blackBallBrowser = { ...state.blackBallBrowser, ...(browserState || {}) };
}).catch(() => null);
api.onBrowserAnalyzeRequest?.((payload = {}) => {
  const content = String(payload.content || "").slice(0, 60000);
  if (!content) return showCopyToast("当前网页没有可分析文字");
  const targetSessionId = payload.sessionId || state.selectedSessionId;
  const attachment = {
    id: `browser-page-${Date.now()}`,
    name: `${String(payload.title || "网页").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.txt`,
    mimeType: "text/plain",
    textContent: content,
    sourceUrl: payload.url || "",
    source: "黑球浏览器当前页面"
  };
  void sendCurrentTask({ text: `请分析黑球浏览器当前页面「${payload.title || "网页"}」，总结关键信息并给出可执行结论。`, attachments: [attachment] }, targetSessionId);
});

api.onChatStream?.(handleChatStreamFrame);

function scheduleConsciousBackupSettlement(projectId) {
  const sourceId = projectId;
  const previous = state.consciousBackupTimers.get(sourceId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    state.consciousBackupProgress.delete(sourceId);
    state.consciousBackupCompleted.delete(sourceId);
    state.consciousBackupTimers.delete(sourceId);
  }, 1600);
  state.consciousBackupTimers.set(sourceId, timer);
}

const CONSCIOUS_SAVE_FLOW = ["整理当前意识", "分析工作上下文", "提取关键决策", "保存工作状态", "意识提取成功"];

const BLACK_CORE_POTENTIAL_KEYS = ["cognition", "learning", "creation", "judgment", "adaptation", "execution", "insight", "leadership"];
const BLACK_CORE_STAGE_META = {
  collecting: { progress: 8, phase: "scanning", code: "INITIAL STATE", text: "正在捕获生命行为信号", label: "SIGNAL ACQUISITION" },
  analyzing: { progress: 26, phase: "scanning", code: "EXPERIENCE", text: "扫描认知与学习轨迹", label: "POTENTIAL SCAN" },
  decisions: { progress: 45, phase: "scanning", code: "EXPERIENCE", text: "分析判断与决策模式", label: "BEHAVIOR ANALYSIS" },
  distilling: { progress: 64, phase: "scanning", code: "ADAPTATION", text: "重构关键意识结构", label: "CONSCIOUSNESS MAPPING" },
  resonance: { progress: 82, phase: "resonance", code: "ADAPTATION", text: "检测潜能共鸣", label: "RESONANCE DETECTED" },
  rebuilding: { progress: 92, phase: "resonance", code: "EVOLUTION", text: "生成生命潜能档案", label: "EVOLUTION SEQUENCE" },
  completed: { progress: 96, phase: "resonance", code: "NEW POTENTIAL", text: "潜能档案已建立", label: "ANALYSIS COMPLETE" }
};
const blackCoreRuntime = {
  active: false,
  running: false,
  sourceKey: "",
  startedAt: 0,
  frameId: 0,
  lastFrameAt: 0,
  progress: 0,
  targetProgress: 0,
  particles: [],
  stars: [],
  pulses: [],
  profile: null,
  status: null,
  resizeObserver: null,
  returnToConsciousCenter: false,
  mode: "idle",
  motion: "static",
  selectedSnapshotId: ""
};

function blackCoreDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function blackCoreSourceKey(scope, sourceId) {
  return `${scope}:${sourceId}`;
}

function setBlackCoreText(node, value) {
  if (node) node.textContent = value;
}

function blackCorePotentialNode(key) {
  return blackCoreLayer?.querySelector(`[data-core-potential="${key}"]`) || null;
}

function syncBlackCoreTheme() {
  if (!blackCoreLayer) return "dark";
  const theme = browserThemeFromCurrentDocument();
  blackCoreLayer.dataset.theme = theme.scheme;
  blackCoreLayer.style.setProperty("--black-core-accent", theme.accent);
  blackCoreLayer.style.setProperty("--black-core-accent-soft", theme.accentSoft);
  blackCoreLayer.style.setProperty("--black-core-app-panel", theme.panel);
  blackCoreLayer.style.setProperty("--black-core-app-surface", theme.surface);
  blackCoreLayer.style.setProperty("--black-core-app-text", theme.text);
  blackCoreLayer.style.setProperty("--black-core-app-muted", theme.muted);
  blackCoreLayer.style.setProperty("--black-core-app-line", theme.line);
  return theme.scheme;
}

function setBlackCoreCenterVisibility(visible) {
  blackCoreLayer?.querySelectorAll("[data-black-core-center-only]").forEach((node) => {
    node.hidden = !visible;
  });
}

function renderBlackCoreCanvas() {
  cancelAnimationFrame(blackCoreRuntime.frameId);
  blackCoreRuntime.frameId = requestAnimationFrame(drawBlackCoreFrame);
}

function setBlackCoreMotion(mode) {
  blackCoreRuntime.motion = mode === "dynamic" ? "dynamic" : "static";
  if (blackCoreLayer) blackCoreLayer.dataset.motion = blackCoreRuntime.motion;
  blackCoreLayer?.querySelectorAll("[data-black-core-motion]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.blackCoreMotion === blackCoreRuntime.motion));
  });
  renderBlackCoreCanvas();
}

function resetBlackCoreReadout() {
  setBlackCoreText(blackCoreConfidence, "SIGNAL ACQUIRING");
  setBlackCoreText(blackCoreEvidence, "0000");
  setBlackCoreText(blackCoreGrowthStage, "Growth Stage --");
  setBlackCoreText(blackCoreDiscovered, "--");
  setBlackCoreText(blackCorePending, "--");
  setBlackCoreText(blackCoreUnknown, "--");
  setBlackCoreText(blackCoreAwakening, "ANALYZING...");
  setBlackCoreText(blackCoreRecommendation, "正在分析生命行为轨迹");
  blackCoreLayer?.querySelectorAll("[data-core-potential]").forEach((node, index) => {
    node.style.setProperty("--potential-order", String(index));
    node.dataset.level = "";
    const value = node.querySelector("b");
    if (value) value.textContent = "--";
  });
  blackCoreLayer?.querySelectorAll("[data-core-metric]").forEach((node) => {
    const bar = node.querySelector("i > b");
    const value = node.querySelector("strong");
    if (bar) bar.style.width = "2%";
    if (value) value.textContent = "--";
  });
}

function updateBlackCoreProgress(progress, stage = "collecting") {
  if (!blackCoreRuntime.active) return;
  const meta = BLACK_CORE_STAGE_META[stage] || BLACK_CORE_STAGE_META.collecting;
  blackCoreRuntime.targetProgress = Math.max(blackCoreRuntime.targetProgress, Math.min(100, Number(progress) || meta.progress));
  blackCoreLayer.dataset.phase = meta.phase;
  setBlackCoreText(blackCoreStageLabel, meta.label);
  setBlackCoreText(blackCoreAnalysisState, meta.phase === "resonance" ? "RESONANCE" : "SCANNING");
  setBlackCoreText(blackCorePhaseCode, meta.code);
  setBlackCoreText(blackCorePhaseText, meta.text);
}

function renderBlackCoreProfile(profile = {}) {
  if (!profile || typeof profile !== "object") return;
  blackCoreRuntime.profile = profile;
  setBlackCoreText(blackCoreSubject, profile.subjectId || blackCoreRuntime.status?.subjectId || "HUMAN-UNKNOWN");
  setBlackCoreText(blackCoreConfidence, `${String(profile.confidence || "LOW").toUpperCase()} CONFIDENCE`);
  setBlackCoreText(blackCoreEvidence, String(Math.max(0, Number(profile.evidenceTotal) || 0)).padStart(4, "0"));
  setBlackCoreText(blackCoreGrowthStage, `Growth Stage ${String(Math.max(1, Number(profile.growthStage) || 1)).padStart(2, "0")}`);
  setBlackCoreText(blackCoreDiscovered, String(Math.max(0, Number(profile.discoveredPotential) || 0)));
  setBlackCoreText(blackCorePending, String(Math.max(0, Number(profile.pendingAwakening) || 0)));
  setBlackCoreText(blackCoreUnknown, String(Math.max(0, Number(profile.unknownDomains) || 0)));
  const potentials = new Map((profile.potentials || []).map((item) => [item.key, item]));
  for (const key of BLACK_CORE_POTENTIAL_KEYS) {
    const potential = potentials.get(key) || { score: 0, level: "E" };
    const score = Math.max(0, Math.min(100, Number(potential.score) || 0));
    const node = blackCorePotentialNode(key);
    if (node) {
      node.dataset.level = potential.level || "E";
      const value = node.querySelector("b");
      if (value) value.textContent = `${score}% · ${potential.level || "E"}`;
    }
    const metric = blackCoreLayer?.querySelector(`[data-core-metric="${key}"]`);
    if (metric) {
      const bar = metric.querySelector("i > b");
      const value = metric.querySelector("strong");
      if (bar) bar.style.width = `${score}%`;
      if (value) value.textContent = `${score}%`;
    }
  }
  const awakenings = Array.isArray(profile.awakenings) ? profile.awakenings : [];
  const awakening = awakenings.find((item) => item.state === "awakened")
    || awakenings.find((item) => item.state === "pending")
    || awakenings.sort((left, right) => Number(right.resonance || 0) - Number(left.resonance || 0))[0];
  const awakeningState = awakening?.state === "awakened" ? "AWAKENED" : awakening?.state === "pending" ? "RESONANCE" : "LATENT";
  setBlackCoreText(blackCoreAwakening, awakening ? `${awakening.name} · ${awakeningState} ${Math.max(0, Number(awakening.resonance) || 0)}%` : "潜能样本持续积累中");
  setBlackCoreText(blackCoreRecommendation, profile.recommendation || "继续积累真实任务行为样本");
}

function resizeBlackCoreCanvas() {
  if (!blackCoreCanvas || !blackCoreLayer || blackCoreLayer.hidden) return;
  const width = Math.max(1, blackCoreLayer.clientWidth);
  const height = Math.max(1, blackCoreLayer.clientHeight);
  const density = Math.min(1.75, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * density);
  const pixelHeight = Math.round(height * density);
  if (blackCoreCanvas.width !== pixelWidth || blackCoreCanvas.height !== pixelHeight) {
    blackCoreCanvas.width = pixelWidth;
    blackCoreCanvas.height = pixelHeight;
    blackCoreCanvas.style.width = `${width}px`;
    blackCoreCanvas.style.height = `${height}px`;
  }
  blackCoreRuntime.density = density;
  if (!blackCoreRuntime.stars.length) {
    blackCoreRuntime.stars = Array.from({ length: Math.max(170, Math.min(430, Math.floor(width * height / 3800))) }, (_, index) => ({
      x: ((index * 73) % 997) / 997,
      y: ((index * 151 + 47) % 991) / 991,
      size: 0.32 + ((index * 31) % 100) / 92,
      phase: ((index * 43) % 360) * Math.PI / 180
    }));
  }
}

function blackCoreCenter() {
  const canvasRect = blackCoreCanvas?.getBoundingClientRect();
  const objectRect = blackCoreLayer?.querySelector(".black-core-object")?.getBoundingClientRect();
  if (!canvasRect || !objectRect) return { x: (canvasRect?.width || 1) / 2, y: (canvasRect?.height || 1) / 2 };
  return { x: objectRect.left + objectRect.width / 2 - canvasRect.left, y: objectRect.top + objectRect.height / 2 - canvasRect.top };
}

function drawBlackCoreFrame(timestamp = 0) {
  if (!blackCoreRuntime.active || !blackCoreCanvas || blackCoreLayer?.hidden) {
    blackCoreRuntime.frameId = 0;
    return;
  }
  const completed = blackCoreLayer.dataset.phase === "complete";
  if (completed && blackCoreRuntime.motion === "dynamic" && timestamp - blackCoreRuntime.lastFrameAt < 40) {
    blackCoreRuntime.frameId = requestAnimationFrame(drawBlackCoreFrame);
    return;
  }
  blackCoreRuntime.lastFrameAt = timestamp;
  resizeBlackCoreCanvas();
  const context = blackCoreCanvas.getContext("2d", { alpha: false });
  if (!context) return;
  const density = blackCoreRuntime.density || 1;
  const width = blackCoreCanvas.width / density;
  const height = blackCoreCanvas.height / density;
  const time = timestamp / 1000;
  const center = blackCoreCenter();
  const lightTheme = blackCoreLayer.dataset.theme === "light";
  context.setTransform(density, 0, 0, density, 0, 0);
  context.fillStyle = lightTheme ? "#f7f9fc" : "#020306";
  context.fillRect(0, 0, width, height);

  const spaceGlow = context.createRadialGradient(center.x, center.y, 20, center.x, center.y, Math.max(width, height) * 0.58);
  spaceGlow.addColorStop(0, blackCoreLayer.dataset.phase === "awakening" ? (lightTheme ? "rgba(47, 111, 237, .16)" : "rgba(48, 174, 213, .19)") : (lightTheme ? "rgba(47, 111, 237, .08)" : "rgba(32, 111, 137, .11)"));
  spaceGlow.addColorStop(0.45, lightTheme ? "rgba(47, 111, 237, .035)" : "rgba(6, 24, 31, .08)");
  spaceGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = spaceGlow;
  context.fillRect(0, 0, width, height);

  for (const star of blackCoreRuntime.stars) {
    const alpha = 0.14 + (Math.sin(time * 0.72 + star.phase) + 1) * 0.13;
    context.fillStyle = lightTheme ? `rgba(47, 111, 237, ${alpha * 0.72})` : `rgba(174, 222, 235, ${alpha})`;
    context.fillRect(star.x * width, star.y * height, star.size, star.size);
  }

  const potentialCenters = [];
  const canvasRect = blackCoreCanvas.getBoundingClientRect();
  blackCoreLayer.querySelectorAll("[data-core-potential]").forEach((node) => {
    const rect = node.getBoundingClientRect();
    potentialCenters.push({ x: rect.left + 7 - canvasRect.left, y: rect.top + rect.height / 2 - canvasRect.top });
  });
  context.lineWidth = 0.7;
  for (let index = 0; index < potentialCenters.length; index += 1) {
    const point = potentialCenters[index];
    const strength = 0.055 + Math.max(0, Math.sin(time * 1.4 + index)) * 0.055;
    context.strokeStyle = lightTheme ? `rgba(47, 111, 237, ${strength * 1.4})` : `rgba(106, 217, 247, ${strength})`;
    context.beginPath();
    context.moveTo(center.x, center.y);
    context.quadraticCurveTo((center.x + point.x) / 2 + Math.sin(time + index) * 12, (center.y + point.y) / 2, point.x, point.y);
    context.stroke();
  }

  const phase = blackCoreLayer.dataset.phase;
  const speed = phase === "awakening" ? 2.8 : phase === "resonance" ? 1.65 : 0.75;
  if (!blackCoreRuntime.particles.length) {
    blackCoreRuntime.particles = Array.from({ length: 62 }, (_, index) => ({
      angle: (Math.PI * 2 * index) / 62,
      radius: 105 + (index * 47) % 245,
      speed: 0.08 + ((index * 17) % 22) / 100,
      size: 0.7 + ((index * 13) % 12) / 10,
      depth: 0.36 + ((index * 29) % 64) / 100
    }));
  }
  for (const particle of blackCoreRuntime.particles) {
    const angle = particle.angle + time * particle.speed * speed;
    const breathe = Math.sin(time * 0.9 + particle.angle * 3) * 7;
    const radius = Math.max(48, particle.radius + breathe);
    const x = center.x + Math.cos(angle) * radius;
    const y = center.y + Math.sin(angle) * radius * 0.62;
    context.fillStyle = lightTheme ? `rgba(47, 111, 237, ${0.10 + particle.depth * 0.32})` : `rgba(103, 216, 246, ${0.16 + particle.depth * 0.44})`;
    context.beginPath();
    context.arc(x, y, particle.size, 0, Math.PI * 2);
    context.fill();
  }

  context.save();
  context.translate(center.x, center.y);
  context.rotate(time * (phase === "awakening" ? 1.9 : 0.42));
  context.strokeStyle = phase === "awakening" ? "rgba(185, 242, 255, .72)" : "rgba(101, 216, 246, .28)";
  context.lineWidth = phase === "awakening" ? 1.4 : 0.8;
  context.setLineDash([3, 13, 1, 8]);
  context.beginPath();
  context.arc(0, 0, phase === "awakening" ? 198 + Math.sin(time * 7) * 9 : 184, -0.7, 2.45);
  context.stroke();
  context.restore();
  context.setLineDash([]);

  if (phase === "awakening") {
    const pulse = (time * 1.7 % 1) * 240;
    context.strokeStyle = `rgba(132, 226, 250, ${Math.max(0, 0.54 - pulse / 430)})`;
    context.lineWidth = 1;
    context.beginPath();
    context.arc(center.x, center.y, 88 + pulse, 0, Math.PI * 2);
    context.stroke();
  }

  blackCoreRuntime.progress = blackCoreRuntime.motion === "static" && !blackCoreRuntime.running
    ? blackCoreRuntime.targetProgress
    : blackCoreRuntime.progress + (blackCoreRuntime.targetProgress - blackCoreRuntime.progress) * 0.055;
  const shownProgress = Math.max(0, Math.min(100, Math.round(blackCoreRuntime.progress)));
  if (blackCoreProgressBar) blackCoreProgressBar.style.width = `${shownProgress}%`;
  setBlackCoreText(blackCoreProgressValue, `${shownProgress}%`);
  blackCoreRuntime.frameId = (blackCoreRuntime.running || blackCoreRuntime.motion === "dynamic")
    ? requestAnimationFrame(drawBlackCoreFrame)
    : 0;
}

async function openBlackCoreCenter() {
  if (!blackCoreLayer || !blackCoreCanvas || blackCoreRuntime.running) return;
  blackCoreRuntime.active = true;
  blackCoreRuntime.running = false;
  blackCoreRuntime.mode = "center";
  blackCoreRuntime.progress = 100;
  blackCoreRuntime.targetProgress = 100;
  blackCoreRuntime.particles = [];
  blackCoreRuntime.stars = [];
  blackCoreLayer.hidden = false;
  blackCoreLayer.dataset.mode = "center";
  blackCoreLayer.dataset.phase = "complete";
  blackCoreLayer.removeAttribute("aria-busy");
  setBlackCoreCenterVisibility(true);
  syncBlackCoreTheme();
  document.body.classList.add("black-core-open", "conscious-center-open");
  if (blackCoreCloseBtn) blackCoreCloseBtn.hidden = false;
  setBlackCoreText(blackCoreStageLabel, "LIFE POTENTIAL ARCHIVE");
  setBlackCoreText(blackCoreAnalysisState, "ARCHIVE");
  setBlackCoreText(blackCorePhaseCode, "CONSCIOUS ARCHIVE");
  setBlackCoreText(blackCorePhaseText, "生命潜能档案已连接");
  const status = await api.blackCoreStatus?.().catch(() => null);
  if (status) {
    blackCoreRuntime.status = status;
    setBlackCoreText(blackCoreSubject, status.subjectId || "HUMAN-UNKNOWN");
    if (status.current) renderBlackCoreProfile(status.current);
  } else resetBlackCoreReadout();
  setBlackCoreMotion("static");
  resizeBlackCoreCanvas();
  await renderConsciousCenter();
  requestAnimationFrame(() => consciousSearchInput?.focus());
}

async function openBlackCore(scope, sourceId, title = "") {
  if (!blackCoreLayer || !blackCoreCanvas) return;
  blackCoreRuntime.active = true;
  blackCoreRuntime.running = true;
  blackCoreRuntime.mode = "extracting";
  blackCoreRuntime.motion = "dynamic";
  blackCoreRuntime.sourceKey = blackCoreSourceKey(scope, sourceId);
  blackCoreRuntime.startedAt = performance.now();
  blackCoreRuntime.progress = 0;
  blackCoreRuntime.targetProgress = 4;
  blackCoreRuntime.profile = null;
  blackCoreRuntime.particles = [];
  blackCoreRuntime.stars = [];
  blackCoreLayer.hidden = false;
  blackCoreLayer.dataset.mode = "extracting";
  blackCoreLayer.dataset.motion = "dynamic";
  blackCoreLayer.dataset.phase = "scanning";
  blackCoreLayer.dataset.scope = scope;
  blackCoreLayer.dataset.sourceId = sourceId;
  blackCoreLayer.setAttribute("aria-busy", "true");
  setBlackCoreCenterVisibility(false);
  syncBlackCoreTheme();
  document.body.classList.add("black-core-open");
  document.body.classList.remove("conscious-center-open");
  if (blackCoreCloseBtn) blackCoreCloseBtn.hidden = true;
  resetBlackCoreReadout();
  setBlackCoreText(blackCorePhaseText, title ? `正在解析「${title}」的生命行为轨迹` : "正在捕获生命行为信号");
  const status = blackCoreRuntime.status || await api.blackCoreStatus?.().catch(() => null);
  if (status) {
    blackCoreRuntime.status = status;
    setBlackCoreText(blackCoreSubject, status.subjectId || "HUMAN-UNKNOWN");
  }
  resizeBlackCoreCanvas();
  cancelAnimationFrame(blackCoreRuntime.frameId);
  blackCoreRuntime.frameId = requestAnimationFrame(drawBlackCoreFrame);
}

function closeBlackCore({ force = false } = {}) {
  if (!blackCoreLayer || (blackCoreRuntime.running && !force)) return;
  const returnToConsciousCenter = blackCoreRuntime.returnToConsciousCenter;
  blackCoreRuntime.returnToConsciousCenter = false;
  blackCoreRuntime.active = false;
  blackCoreRuntime.running = false;
  blackCoreRuntime.motion = "static";
  blackCoreRuntime.mode = "idle";
  blackCoreRuntime.sourceKey = "";
  cancelAnimationFrame(blackCoreRuntime.frameId);
  blackCoreRuntime.frameId = 0;
  blackCoreLayer.hidden = true;
  blackCoreLayer.dataset.phase = "idle";
  blackCoreLayer.dataset.mode = "idle";
  blackCoreLayer.removeAttribute("aria-busy");
  document.body.classList.remove("black-core-open", "conscious-center-open");
  closeConsciousContextMenu();
  if (consciousSnapshotDetail) consciousSnapshotDetail.hidden = true;
  if (consciousSnapshotList) consciousSnapshotList.hidden = false;
  if (returnToConsciousCenter) {
    void (async () => {
      state.db = await api.init().catch(() => state.db);
      await renderAll({ refreshSettings: false, refreshSecondary: false });
      await openBlackCoreCenter();
    })();
  }
}

async function completeBlackCore(profile) {
  renderBlackCoreProfile(profile);
  const remainingToResonance = Math.max(0, 2900 - (performance.now() - blackCoreRuntime.startedAt));
  await blackCoreDelay(remainingToResonance);
  if (!blackCoreRuntime.active) return;
  blackCoreLayer.dataset.phase = "awakening";
  blackCoreRuntime.targetProgress = 99;
  setBlackCoreText(blackCoreStageLabel, "ABILITY AWAKENING");
  setBlackCoreText(blackCoreAnalysisState, "EVOLVING");
  setBlackCoreText(blackCorePhaseCode, "NEW POTENTIAL");
  setBlackCoreText(blackCorePhaseText, "能力共鸣正在重组");
  await blackCoreDelay(1050);
  if (!blackCoreRuntime.active) return;
  blackCoreRuntime.progress = 100;
  blackCoreRuntime.targetProgress = 100;
  blackCoreLayer.dataset.phase = "complete";
  blackCoreLayer.setAttribute("aria-busy", "false");
  blackCoreRuntime.running = false;
  setBlackCoreText(blackCoreStageLabel, "EVOLUTION RECORDED");
  setBlackCoreText(blackCoreAnalysisState, "COMPLETE");
  setBlackCoreText(blackCorePhaseCode, "EVOLUTION COMPLETE");
  setBlackCoreText(blackCorePhaseText, "生命潜能档案已独立保存");
  if (blackCoreProgressBar) blackCoreProgressBar.style.width = "100%";
  setBlackCoreText(blackCoreProgressValue, "100%");
  if (blackCoreCloseBtn) blackCoreCloseBtn.hidden = false;
  blackCoreCloseBtn?.focus();
}

function failBlackCore(error) {
  if (!blackCoreLayer || !blackCoreRuntime.active) return;
  blackCoreRuntime.running = false;
  blackCoreLayer.dataset.phase = "error";
  blackCoreLayer.setAttribute("aria-busy", "false");
  setBlackCoreText(blackCoreStageLabel, "ANALYSIS INTERRUPTED");
  setBlackCoreText(blackCoreAnalysisState, "ERROR");
  setBlackCoreText(blackCorePhaseCode, "SYSTEM ERROR");
  setBlackCoreText(blackCorePhaseText, error?.message || String(error) || "意识提取失败");
  setBlackCoreText(blackCoreRecommendation, "原有意识档案未被覆盖，请关闭后重试");
  if (blackCoreCloseBtn) blackCoreCloseBtn.hidden = false;
}

async function runBlackCoreExtraction(scope, sourceId, title = "") {
  if (blackCoreRuntime.running) return null;
  await openBlackCore(scope, sourceId, title);
  try {
    const result = await api.saveConsciousState(scope, sourceId);
    await completeBlackCore(result?.potentialProfile || await api.blackCoreProfile?.(scope, sourceId));
    return result;
  } catch (error) {
    failBlackCore(error);
    return null;
  }
}

function routeBlackCoreProgress(progress = {}) {
  const sourceId = progress.sourceId || progress.projectId || progress.sessionId;
  const scope = progress.scope || (progress.projectId ? "project" : "session");
  if (!blackCoreRuntime.active || blackCoreRuntime.sourceKey !== blackCoreSourceKey(scope, sourceId)) return false;
  const meta = BLACK_CORE_STAGE_META[progress.stage] || BLACK_CORE_STAGE_META.collecting;
  if (Number(progress.progress) >= blackCoreRuntime.targetProgress || meta.progress >= blackCoreRuntime.targetProgress) {
    updateBlackCoreProgress(Math.max(Number(progress.progress) || 0, meta.progress), progress.stage);
  }
  if (progress.potentialProfile) renderBlackCoreProfile(progress.potentialProfile);
  return true;
}

blackCoreCloseBtn?.addEventListener("click", closeBlackCore);
window.addEventListener("resize", resizeBlackCoreCanvas);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && blackCoreRuntime.active && !blackCoreRuntime.running) closeBlackCore();
});

function paintConsciousProgress(panel) {
  const step = Math.max(0, Math.min(CONSCIOUS_SAVE_FLOW.length - 1, Number(panel._flowStep) || 0));
  const complete = step === CONSCIOUS_SAVE_FLOW.length - 1;
  const meta = panel._completionMeta || {};
  panel.innerHTML = complete ? `
    <div class="conscious-save-title"><i></i><div><span>意识提取完成</span></div></div>
    <div class="conscious-save-meta"><span>更新时间</span><b>${escapeHtml(consciousDate(meta.updatedAt || Date.now()))}</b><span>压缩率</span><b>${Math.max(0, Number(meta.reductionPercent) || 0)}%</b></div>
  ` : `
    <div class="conscious-save-title"><i></i><div><span>整理当前意识</span><strong>${escapeHtml(CONSCIOUS_SAVE_FLOW[step])}</strong></div></div>
    <div class="conscious-save-flow">${CONSCIOUS_SAVE_FLOW.slice(1, 4).map((label, index) => `<span class="${index + 1 < step ? "done" : index + 1 === step ? "active" : ""}">${escapeHtml(label)}</span>`).join("")}</div>
  `;
  panel.classList.toggle("complete", complete);
  if (!complete) return;
  clearInterval(panel._flowTimer);
  panel._flowTimer = null;
  clearTimeout(panel._settleTimer);
  const elapsed = Date.now() - Number(panel._startedAt || Date.now());
  panel._settleTimer = setTimeout(() => panel.remove(), Math.max(1200, 2800 - elapsed));
}

function showConsciousProgress(progress = {}) {
  if (routeBlackCoreProgress(progress)) return;
  let panel = document.querySelector(".conscious-save-progress");
  if (!panel) {
    panel = document.createElement("aside");
    panel.className = "conscious-save-progress";
    panel.setAttribute("aria-live", "polite");
    document.body.appendChild(panel);
    panel._startedAt = Date.now();
    panel._flowStep = 0;
    panel._flowTarget = 0;
  }
  const stageIndex = ({ collecting: 0, analyzing: 1, decisions: 2, distilling: 3, resonance: 3, rebuilding: 3, completed: 4 })[progress.stage] ?? 0;
  panel._flowTarget = Math.max(Number(panel._flowTarget) || 0, stageIndex);
  if (stageIndex === 4) panel._completionMeta = { updatedAt: progress.updatedAt, reductionPercent: progress.reductionPercent };
  paintConsciousProgress(panel);
  if (!panel._flowTimer) {
    panel._flowTimer = setInterval(() => {
      if ((Number(panel._flowStep) || 0) < (Number(panel._flowTarget) || 0)) {
        panel._flowStep += 1;
        paintConsciousProgress(panel);
      }
    }, 520);
  }
}

api.onProjectConsciousBackupProgress?.((progress = {}) => {
  if (!progress.projectId) return;
  state.consciousBackupProgress.set(progress.projectId, Math.max(1, Math.min(100, Number(progress.progress) || 1)));
  if (progress.status === "completed") {
    state.consciousBackupCompleted.add(progress.projectId);
    scheduleConsciousBackupSettlement(progress.projectId);
  }
  showConsciousProgress(progress);
});

api.onConsciousCenterProgress?.((progress = {}) => {
  const sourceId = progress.sourceId || progress.projectId || progress.sessionId;
  if (!sourceId) return;
  state.consciousBackupProgress.set(sourceId, Math.max(1, Math.min(100, Number(progress.progress) || 1)));
  if (progress.status === "completed") {
    state.consciousBackupCompleted.add(sourceId);
    scheduleConsciousBackupSettlement(sourceId);
  }
  showConsciousProgress(progress);
});

window.updater?.onUpdateAvailable((data) => {
  const notes = Array.isArray(data.releaseNotes) ? data.releaseNotes.filter(Boolean) : [data.updateNote || data.releaseNotes].filter(Boolean);
  availableUpdateInfo = {
    configured: true,
    hasUpdate: true,
    currentVersion: data.currentVersion || appVersion?.textContent || "",
    latestVersion: data.version,
    downloadUrl: data.downloadUrl || "",
    sha256: data.sha256 || data.checksum || "",
    checksum: data.checksum || data.sha256 || "",
    updateNote: data.updateNote || notes[0] || "",
    notes
  };
  showUpdateBadge(availableUpdateInfo);
  if (settingsDialog?.open && settingsDialog.dataset.activeTab === "update") {
    if (applyOnlineUpdateBtn) {
      applyOnlineUpdateBtn.hidden = false;
      applyOnlineUpdateBtn.disabled = false;
      applyOnlineUpdateBtn.textContent = "立即更新";
    }
    renderUpdateStatus({ phase: "available", title: "发现新版本", detail: "可在白球内下载、校验并自动安装。", info: availableUpdateInfo });
  }
});

window.updater?.onDownloadProgress((progress) => {
  console.log(`下载进度：${progress}%`);
  paintUpdateProgress({ phase: "downloading", progress });
});

function paintUpdateProgress(status) {
  const progress = Math.max(0, Math.min(100, Number(status?.progress || 0)));
  const phase = status?.phase || (progress >= 100 ? "verifying" : "downloading");
  const labels = {
    checking: ["正在确认更新", "正在读取版本和更新包信息。"],
    downloading: ["正在下载更新", "下载在白球设置中心内进行，请保持网络连接。"],
    verifying: ["正在校验更新包", "正在执行 SHA-256 完整性校验。"],
    preparing: ["正在准备安装", "校验已通过，正在准备替换程序文件。"],
    restarting: ["即将重启白球", "更新已下载并校验，正在重启白球完成安装。"]
  };
  const [title, detail] = labels[phase] || labels.downloading;
  renderUpdateStatus({ phase, title, detail, progress });
  if (applyOnlineUpdateBtn) {
    applyOnlineUpdateBtn.textContent = phase === "downloading" ? `下载 ${progress}%` : title;
    applyOnlineUpdateBtn.disabled = true;
  }
}

api.onUpdateProgress?.((status) => {
  pendingUpdateProgressStatus = status;
  if (updateProgressFrame) return;
  updateProgressFrame = requestAnimationFrame(() => {
    updateProgressFrame = 0;
    const latest = pendingUpdateProgressStatus;
    pendingUpdateProgressStatus = null;
    paintUpdateProgress(latest);
  });
});

window.license?.onTrialUpdate((status) => renderLicenseStatus(status));
window.license?.onLocked((status) => renderLicenseStatus(status));
window.license?.onTrialWarning((status) => {
  renderLicenseStatus(status);
  if (!sessionStorage.getItem("baiqiuTrialWarned")) {
    sessionStorage.setItem("baiqiuTrialWarned", "1");
    showAppConfirm({
      title: "试用即将结束",
      message: `白球 AI 试用还剩 ${formatTrialTime(status.trialRemainingSeconds)}，请及时开通会员激活。`,
      primary: "知道了",
      secondary: "稍后"
    });
  }
});

api.onWindowActivity?.((activity) => {
  const moving = activity === "moving";
  const resizing = activity === "resizing";
  document.body.classList.toggle("window-moving", moving);
  document.body.classList.toggle("window-resizing", resizing);
  if (activity === "idle") {
    requestAnimationFrame(() => {
      appShell.style.transform = "translateZ(0)";
      void appShell.offsetHeight;
      appShell.style.transform = "";
    });
  }
});

api.onCloseRequest?.((data) => showCloseConfirm(data));

function formatTaskBoardBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isSpreadsheetFile(file = {}) {
  return /\.(xlsx|xls|csv)$/i.test(String(file.name || "")) || /spreadsheet|excel|csv/i.test(String(file.mimeType || ""));
}

function spreadsheetColumnLabel(index) {
  let value = Math.max(0, Number(index) || 0) + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function ensureTaskBoardSheetDraft(file = {}, rows = []) {
  const key = taskBoardFileKey(file);
  if (!state.taskBoardSheetDrafts[key]) {
    const normalized = rows.slice(0, 5000).map((row) => row.slice(0, 100).map((cell) => String(cell ?? "")));
    const columns = Math.max(1, ...normalized.map((row) => row.length));
    state.taskBoardSheetDrafts[key] = {
      rows: normalized.length ? normalized : [Array(columns).fill("")],
      dirty: false,
      sourcePath: state.taskBoardPreviewContent[key]?.sourcePath || file.sourcePath || file.path || file.originalPath || file.filePath || "",
      savedPath: "",
      lastDraftAt: "",
      selectedRow: 0,
      selectedColumn: 0,
      columnWidths: {},
      rowHeights: {}
    };
  }
  return state.taskBoardSheetDrafts[key];
}

function taskBoardSheetEditorHtml(file = {}, rows = []) {
  const draft = ensureTaskBoardSheetDraft(file, rows);
  const columns = Math.max(1, ...draft.rows.map((row) => row.length));
  const query = String(state.taskBoardPreviewQuery || "").trim().toLowerCase();
  const filtered = draft.rows.map((row, rowIndex) => ({ row, rowIndex })).filter(({ row }) => !query || row.some((cell) => String(cell || "").toLowerCase().includes(query)));
  const pageSize = 80;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(state.taskBoardPreviewPage || 1)));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const zoom = Math.min(1.5, Math.max(.75, Number(state.taskBoardPreviewZoom || 1)));
  const selectedAddress = `${spreadsheetColumnLabel(draft.selectedColumn)}${draft.selectedRow + 1}`;
  return `
    <div class="baiqiu-sheet-editor" data-sheet-key="${escapeHtml(taskBoardFileKey(file))}">
      <header class="baiqiu-sheet-appbar">
        <button type="button" data-board-preview-close title="返回${state.taskBoardTab === "tables" ? "表格" : "文件"}列表">←</button>
        <div class="baiqiu-sheet-file"><strong>${escapeHtml(file.name || "白球表格.xlsx")}</strong><span>白球AI 内置表格编辑器</span></div>
        <div class="baiqiu-sheet-file-actions"><button type="button" data-sheet-save="save">保存</button><button type="button" data-sheet-save="saveAs">另存为</button><button type="button" data-sheet-save="export">导出Excel</button><button type="button" data-board-file-open="${escapeHtml(taskBoardFileKey(file))}">打开原文件</button><button type="button" data-board-file-location="${escapeHtml(taskBoardFileKey(file))}">所在位置</button></div>
      </header>
      <div class="baiqiu-sheet-toolbar">
        <button type="button" data-sheet-list-toggle>${state.taskBoardFileListHidden ? "显示文件" : "隐藏文件"}</button>
        <span class="baiqiu-sheet-separator"></span>
        <button type="button" data-sheet-add-row>＋ 行</button><button type="button" data-sheet-add-column>＋ 列</button><button type="button" data-sheet-clear>清空单元格</button>
        <span class="baiqiu-sheet-separator"></span>
        <button type="button" data-sheet-column-width="decrease">列宽 −</button><button type="button" data-sheet-column-width="increase">列宽 ＋</button><button type="button" data-sheet-row-height="decrease">行高 −</button><button type="button" data-sheet-row-height="increase">行高 ＋</button>
        <span class="baiqiu-sheet-separator"></span>
        <button type="button" data-sheet-sort="asc">升序</button><button type="button" data-sheet-sort="desc">降序</button>
        <label class="task-board-sheet-search"><span>筛选</span><input data-board-sheet-search value="${escapeHtml(state.taskBoardPreviewQuery || "")}" placeholder="搜索表格"></label>
        <div class="task-board-sheet-tools"><button type="button" data-board-sheet-zoom="out" title="缩小">−</button><span>${Math.round(zoom * 100)}%</span><button type="button" data-board-sheet-zoom="in" title="放大">＋</button><button type="button" data-board-sheet-page="prev" ${page <= 1 ? "disabled" : ""}>‹</button><span>${page}/${pages}</span><button type="button" data-board-sheet-page="next" ${page >= pages ? "disabled" : ""}>›</button></div>
      </div>
      <div class="task-board-table-wrap baiqiu-sheet-grid" style="--sheet-zoom:${zoom}">
        <table class="task-board-table"><thead><tr><th class="sheet-corner"></th>${Array.from({ length: columns }, (_, columnIndex) => `<th style="width:${Number(draft.columnWidths[columnIndex] || 112)}px" data-sheet-column="${columnIndex}">${spreadsheetColumnLabel(columnIndex)}<i data-sheet-column-resize="${columnIndex}"></i></th>`).join("")}</tr></thead><tbody>${pageRows.map(({ row, rowIndex }) => `<tr style="height:${Number(draft.rowHeights[rowIndex] || 30)}px"><th class="sheet-row-number">${rowIndex + 1}<i data-sheet-row-resize="${rowIndex}"></i></th>${Array.from({ length: columns }, (_, columnIndex) => `<td contenteditable="true" spellcheck="false" data-sheet-row="${rowIndex}" data-sheet-column="${columnIndex}" class="${draft.selectedRow === rowIndex && draft.selectedColumn === columnIndex ? "selected" : ""}">${escapeHtml(row[columnIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>
      </div>
      <footer class="baiqiu-sheet-statusbar"><span>当前：${draft.rows.length} 行 × ${columns} 列</span><span>单元格 ${selectedAddress}</span><b data-sheet-dirty>${draft.dirty ? "已修改" : "未修改"}</b><span data-sheet-autosave>${draft.lastDraftAt ? `草稿已保存 ${draft.lastDraftAt}` : "自动保存：等待修改"}</span></footer>
    </div>`;
}

function taskBoardInternalPreviewHtml(file = {}) {
  const cachedRows = state.taskBoardPreviewRows[file.id || file.name || ""];
  if (Array.isArray(cachedRows) && cachedRows.length) {
    return taskBoardSheetEditorHtml(file, cachedRows);
  }
  const generic = state.taskBoardPreviewContent[file.id || file.name || ""];
  if (generic?.kind === "image" && generic.dataUrl) return `<div class="task-board-inline-media"><img src="${escapeHtml(generic.dataUrl)}" alt="${escapeHtml(file.name || "图片预览")}"></div>`;
  if (generic?.kind === "frame" && generic.fileUrl) return `<div class="task-board-inline-frame"><iframe src="${escapeHtml(generic.fileUrl)}" title="${escapeHtml(file.name || "文件预览")}"></iframe></div>`;
  if (generic?.kind === "slides" && Array.isArray(generic.slides)) return `<div class="task-board-slide-deck">${generic.slides.map((slide) => `<section class="task-board-slide"><span>${String(slide.number).padStart(2, "0")}</span><div><strong>${escapeHtml(slide.title || `幻灯片 ${slide.number}`)}</strong>${(slide.lines || []).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div></section>`).join("")}</div>`;
  if (generic?.kind === "document" && generic.previewText) return `<article class="task-board-document-preview">${String(generic.previewText).split(/\n{2,}/).filter(Boolean).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}</article>`;
  if (generic?.previewText) return `<pre class="task-board-file-preview">${escapeHtml(generic.previewText)}</pre>`;
  const text = String(file.textContent || "").trim();
  if (!text) {
    return `<div class="task-board-file-preview muted-preview">${isSpreadsheetFile(file) ? "表格内部预览待生成：请先发送附件让白球完成分析，或使用外部打开查看完整表格。" : "暂不支持此类文件的内部预览。"}</div>`;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 32);
  const tableLines = lines.filter((line) => line.includes("|"));
  if (isSpreadsheetFile(file) && tableLines.length >= 2) {
    const rows = tableLines
      .filter((line) => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line))
      .slice(0, 18)
      .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()).slice(0, 8));
    if (rows.length) {
      return `<div class="task-board-table-wrap"><table class="task-board-table">${rows.map((row, rowIndex) => `<tr>${row.map((cell) => rowIndex === 0 ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</table></div>`;
    }
  }
  return `<div class="task-board-file-preview">${escapeHtml(text.slice(0, 1800))}</div>`;
}

function collectTaskBoardLinks(messages = []) {
  const found = new Map();
  const pattern = /https?:\/\/[^\s<>"')]+/gi;
  for (const message of messages) {
    const text = String(message?.text || message?.content || "");
    const matches = text.match(pattern) || [];
    for (const url of matches) {
      if (!found.has(url)) found.set(url, { url, source: message.role === "user" ? "用户消息" : "白球回复" });
    }
  }
  return [...found.values()];
}

function taskBoardAssetIdentity(file = {}) {
  let location = file.path || file.sourcePath || file.originalPath || file.filePath || file.outputPath || file.savedPath || file.url || file.dataUrl || "";
  if (String(location).startsWith("data:")) location = `data:${String(location).length}:${String(location).slice(-64)}`;
  return `${String(location).toLowerCase()}|${String(file.name || "").toLowerCase()}|${Number(file.sizeBytes || file.size || 0)}`;
}

function isTaskBoardImage(file = {}) {
  return /^image\//i.test(String(file.mimeType || "")) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(file.name || file.path || ""));
}

function collectTaskBoardAssets(messages = []) {
  const files = [];
  const images = [];
  for (const message of messages) {
    for (const attachment of generatedFilesFromMessage(message)) {
      const item = {
        ...attachment,
        source: message.role === "user" ? "用户附件" : "任务生成"
      };
      files.push(item);
      if (isTaskBoardImage(item)) images.push(item);
    }
    for (const image of message.images || []) {
      const imageItem = image && typeof image === "object"
        ? image
        : { id: `${message.id || Date.now()}-${images.length}-img`, name: "会话图片", mimeType: "image/png", dataUrl: image };
      images.push({
        ...imageItem,
        id: imageItem.id || `${message.id || Date.now()}-${images.length}-img`,
        name: imageItem.name || "会话图片",
        mimeType: imageItem.mimeType || "image/png",
        source: message.role === "user" ? "用户图片" : "白球图片"
      });
    }
  }
  const uniqueFiles = new Map();
  for (const file of files) {
    const key = taskBoardAssetIdentity(file);
    const richness = (file.dataUrl ? 8 : 0) + (file.path || file.filePath || file.originalPath ? 4 : 0) + (file.textContent ? 2 : 0);
    const previous = uniqueFiles.get(key);
    if (!previous || richness > previous.richness) uniqueFiles.set(key, { file, richness });
  }
  const uniqueImages = new Map();
  for (const image of images) {
    const key = taskBoardAssetIdentity(image);
    if (!uniqueImages.has(key) || (!uniqueImages.get(key).dataUrl && image.dataUrl)) uniqueImages.set(key, image);
  }
  const links = new Map(collectTaskBoardLinks(messages).map((item) => [item.url, item]));
  return {
    files: [...uniqueFiles.values()].map((entry) => entry.file),
    images: [...uniqueImages.values()],
    links: [...links.values()].slice(-30)
  };
}

function taskBoardMessageRevision(messages = []) {
  const compactValue = (value) => {
    if (typeof value !== "string") return "";
    return value.startsWith("data:") ? `data:${value.length}:${value.slice(-48)}` : value.slice(-180);
  };
  const signature = messages.map((message) => {
    const attachments = (message.attachments || []).map((item) => [item.id, item.path, item.name, item.mimeType, item.sizeBytes, compactValue(item.dataUrl)].join("~")).join(",");
    const images = (message.images || []).map((item) => typeof item === "string" ? compactValue(item) : [item.id, item.path, item.name, item.mimeType, item.sizeBytes, compactValue(item.dataUrl)].join("~")).join(",");
    const rawKeys = message.raw && typeof message.raw === "object" ? Object.keys(message.raw).sort().join(",") : "";
    return [message.id, message.createdAt || message.timestamp, String(message.text || message.content || "").length, attachments, images, rawKeys].join("|");
  }).join("||");
  return `${state.selectedSessionId || ""}|${messages.length}|${signature}`;
}

function cachedTaskBoardAssets(messages = []) {
  const signature = taskBoardMessageRevision(messages);
  if (state.taskBoardAssetCache.signature !== signature || !state.taskBoardAssetCache.value) {
    state.taskBoardAssetCache = { signature, value: collectTaskBoardAssets(messages) };
  }
  return state.taskBoardAssetCache.value;
}

function taskBoardFileKey(file = {}) {
  return String(file.id || file.path || file.sourcePath || file.originalPath || file.filePath || file.url || file.name || "");
}

function taskBoardEventTimestamp(value, fallback = 0) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Number(fallback || 0);
}

function taskBoardExecutionStatus(status = "") {
  return ({ success: "完成", completed: "完成", done: "完成", running: "执行中", verifying: "验证中", waiting: "等待", failed: "失败", cancelled: "已终止", timeout: "超时" })[String(status || "").toLowerCase()] || String(status || "已记录");
}

function collectTaskBoardExecutionEvents(session = selectedSession(), messages = []) {
  if (!session) return [];
  const events = [];
  const seen = new Set();
  const add = ({ id = "", source = "本地记录", label = "执行记录", detail = "", status = "", createdAt = 0 } = {}) => {
    const timestamp = taskBoardEventTimestamp(createdAt);
    const identity = id || `${source}|${label}|${detail}|${status}|${timestamp}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    events.push({ id: identity, source, label, detail, status: taskBoardExecutionStatus(status), createdAt: timestamp });
  };

  (state.db?.queue || []).filter((task) => task.sessionId === session.id).slice(-40).forEach((task) => add({
    id: `queue:${task.id || task.taskId || task.title}`,
    source: "Task Brain",
    label: task.title || task.name || task.type || "任务",
    detail: task.error || task.toolId || task.verification?.message || "本地任务状态记录",
    status: task.status,
    createdAt: task.finishedAt || task.updatedAt || task.startedAt || task.createdAt
  }));

  (state.taskBoardLiveEvents[session.id] || []).forEach((event) => add(event));

  const execution = session.lastExecution || {};
  if (execution.startedAt) add({ id: `execution:start:${execution.taskId || session.id}`, source: "Hermes", label: "开始执行", detail: execution.traceId || execution.taskId || "Hermes 会话已启动", status: "running", createdAt: execution.startedAt });
  if (execution.finishedAt) add({ id: `execution:finish:${execution.taskId || session.id}`, source: "Hermes", label: "执行结束", detail: execution.result || execution.summary || execution.traceId || "Hermes 会话已结束", status: execution.status, createdAt: execution.finishedAt });
  (Array.isArray(execution.delegatedTasks) ? execution.delegatedTasks : []).forEach((task, index) => add({ id: `delegate:${task.id || index}`, source: "Hermes 委派", label: task.title || task.name || "delegate_task", detail: task.error || task.summary || task.result || "真实委派工具记录", status: task.status, createdAt: task.finishedAt || task.updatedAt || task.startedAt || execution.finishedAt || execution.startedAt }));
  const executionEvidence = execution.evidence || {};
  const executionTools = Array.isArray(executionEvidence.toolResults) ? executionEvidence.toolResults : Array.isArray(execution.toolResults) ? execution.toolResults : [];
  executionTools.forEach((item, index) => add({ id: `execution-tool:${item.id || index}`, source: "工具调用", label: item.title || item.toolId || item.type || item.name || "工具", detail: item.error || item.message || item.result?.message || "真实工具返回", status: item.status || (item.success === false ? "failed" : "success"), createdAt: item.finishedAt || item.updatedAt || item.createdAt || execution.finishedAt || execution.startedAt }));

  messages.forEach((message) => {
    const raw = message?.raw;
    if (!raw || typeof raw !== "object") return;
    const fallback = message.createdAt || message.timestamp || 0;
    const visited = new Set();
    const visit = (value, key = "", depth = 0) => {
      if (!value || typeof value !== "object" || depth > 7 || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        if (["baiqiuActions", "toolCalls", "tool_calls", "toolResults", "delegatedTasks", "assignments"].includes(key)) {
          value.forEach((item, index) => {
            if (!item || typeof item !== "object") return;
            const response = item.response || item.result || {};
            add({
              id: `message:${message.id || fallback}:${key}:${item.id || item.callId || index}`,
              source: key === "delegatedTasks" || key === "assignments" ? "Hermes 委派" : "工具调用",
              label: item.title || item.toolId || item.type || item.name || item.function?.name || "工具",
              detail: item.error || response.error || response.message || item.summary || "真实消息结果记录",
              status: item.status || response.status || (item.success === false || response.success === false ? "failed" : "success"),
              createdAt: item.finishedAt || item.updatedAt || item.createdAt || fallback
            });
          });
        }
        value.forEach((item) => visit(item, key, depth + 1));
        return;
      }
      Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey, depth + 1));
    };
    visit(raw);
    const verification = raw.verification || raw.report?.verification || raw.productResult?.verification || raw.productResult?.report?.verification;
    if (verification && typeof verification === "object") add({ id: `verification:${message.id || fallback}`, source: "结果验证", label: verification.title || "验证结果", detail: verification.message || verification.detail || verification.error || "真实验证记录", status: verification.status || (verification.success === false ? "failed" : "success"), createdAt: verification.finishedAt || verification.updatedAt || fallback });
  });
  return events.sort((left, right) => right.createdAt - left.createdAt).slice(0, 80);
}

function cachedTaskBoardExecutionEvents(session, messages = []) {
  const queueRevision = (state.db?.queue || []).filter((task) => task.sessionId === session?.id).slice(-40).map((task) => `${task.id || task.taskId}:${task.status}:${task.updatedAt || task.finishedAt || ""}`).join("|");
  const execution = session?.lastExecution || {};
  const executionRevision = `${execution.taskId || ""}:${execution.traceId || ""}:${execution.status || ""}:${execution.finishedAt || execution.startedAt || ""}:${Array.isArray(execution.delegatedTasks) ? execution.delegatedTasks.length : 0}`;
  const liveRevision = (state.taskBoardLiveEvents[session?.id] || []).map((event) => `${event.id}:${event.status}:${event.createdAt}`).join("|");
  const signature = `${taskBoardMessageRevision(messages)}|${queueRevision}|${executionRevision}|${liveRevision}`;
  if (state.taskBoardEventCache.signature !== signature || !state.taskBoardEventCache.value) {
    state.taskBoardEventCache = { signature, value: collectTaskBoardExecutionEvents(session, messages) };
  }
  return state.taskBoardEventCache.value;
}

function taskBoardExecutionEventsHtml(events = [], limit = 8) {
  if (!events.length) return taskBoardEmptyHtml("暂无真实执行记录", "完成任务或调用工具后，这里只显示可核对的本地证据。");
  return `<div class="task-board-evidence-list">${events.slice(0, limit).map((event) => {
    const time = event.createdAt ? new Date(event.createdAt).toLocaleString("zh-CN", { hour12: false }) : "未记录时间";
    return `<article><time>${escapeHtml(time)}</time><div><strong>${escapeHtml(event.label)}</strong><span>${escapeHtml(event.detail || event.source)}</span></div><small>${escapeHtml(event.source)} · ${escapeHtml(event.status)}</small></article>`;
  }).join("")}</div>`;
}

function taskBoardFileType(file = {}) {
  const name = String(file.name || "");
  if (/\.(xlsx|xls|csv)$/i.test(name)) return "表格";
  if (/\.docx?$/i.test(name)) return "Word";
  if (/\.pdf$/i.test(name)) return "PDF";
  if (/\.pptx?$/i.test(name)) return "PPT";
  if (/^image\//i.test(file.mimeType || "") || /\.(png|jpe?g|webp|gif)$/i.test(name)) return "图片";
  if (/\.(txt|md|json|log|html?)$/i.test(name)) return "文本";
  return "文件";
}

function taskBoardFileStatus(file = {}) {
  const key = taskBoardFileKey(file);
  const content = state.taskBoardPreviewContent[key];
  if (content?.kind === "loading") return { tone: "reading", label: "解析中" };
  if (state.taskBoardPreviewRows[key]?.length || content?.ok || file.textContent) return { tone: "ready", label: "已读取" };
  return { tone: "idle", label: "未处理" };
}

function taskBoardEmptyHtml(title, hint) {
  return `<div class="task-board-empty-state"><i aria-hidden="true"></i><strong>${escapeHtml(title)}</strong><span>${escapeHtml(hint)}</span></div>`;
}

function taskBoardFileCardHtml(file, index, active = false, compact = false) {
  const id = taskBoardFileKey(file);
  const status = taskBoardFileStatus(file);
  const type = taskBoardFileType(file);
  return `
    <article class="task-board-file-card${active ? " active" : ""}${compact ? " compact" : ""}">
      <button class="task-board-file-main" type="button" data-board-file-internal="${escapeHtml(id)}">
        <span class="task-board-file-mark">${escapeHtml(type.slice(0, 3).toUpperCase())}</span>
        <span class="task-board-file-copy"><strong>${escapeHtml(file.name || `附件 ${index + 1}`)}</strong><small>${escapeHtml(type)} · ${formatTaskBoardBytes(file.sizeBytes)} · ${escapeHtml(file.source || "会话附件")}</small></span>
        <span class="task-board-file-state" data-tone="${status.tone}"><i></i>${status.label}</span>
      </button>
      ${compact ? "" : `<div class="task-board-file-actions"><button type="button" data-board-file-internal="${escapeHtml(id)}">内置打开</button><button type="button" data-board-file-open="${escapeHtml(id)}">打开原文件</button><button type="button" data-board-file-location="${escapeHtml(id)}">所在位置</button></div>`}
    </article>`;
}

function bindTaskBoardLocationButtons(body, items = []) {
  body.querySelectorAll("[data-board-file-location]").forEach((button) => button.addEventListener("click", () => {
    const current = items.find((item) => taskBoardFileKey(item) === (button.dataset.boardFileLocation || ""));
    if (current) void showAttachmentInFolder(current);
  }));
}

function ensureTaskBoardDrawer() {
  let drawer = document.getElementById("taskBoardDrawer");
  if (drawer) return drawer;
  const chat = document.querySelector(".chat");
  if (!chat) return null;
  drawer = document.createElement("section");
  drawer.id = "taskBoardDrawer";
  drawer.className = "task-board-drawer";
  drawer.hidden = true;
  drawer.innerHTML = `
    <div class="task-board-head">
      <div>
        <strong>任务看板</strong>
        <small>AI 执行中心 · 资料、过程与交付</small>
      </div>
      <button id="taskBoardCloseBtn" type="button" aria-label="关闭">&times;</button>
    </div>
    <div class="task-board-tabs">
      <button type="button" data-board-tab="overview" class="active">概览</button>
      <button type="button" data-board-tab="tables">表格</button>
      <button type="button" data-board-tab="images">图片</button>
      <button type="button" data-board-tab="files">文件</button>
      <button type="button" data-board-tab="links">黑球浏览器</button>
      <button type="button" data-board-tab="timeline">执行日志</button>
    </div>
    <div id="taskBoardBody" class="task-board-body"></div>
  `;
  chat.appendChild(drawer);
  drawer.querySelectorAll("[data-board-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.taskBoardTab = button.dataset.boardTab || "overview";
      state.taskBoardFocusId = "";
      drawer.dataset.tab = state.taskBoardTab;
      renderTaskBoard();
    });
  });
  drawer.querySelector("#taskBoardCloseBtn")?.addEventListener("click", closeTaskBoard);
  return drawer;
}

function positionTaskBoard() {
  const drawer = document.getElementById("taskBoardDrawer");
  const chat = document.querySelector(".chat");
  if (!drawer || !chat || drawer.hidden) return;
  const chatRect = chat.getBoundingClientRect();
  const blockers = [productTaskStrip, attachmentPreview, queuePanel, chatForm]
    .filter((element) => element && !element.hidden && element.getClientRects().length)
    .map((element) => element.getBoundingClientRect().top)
    .filter((top) => Number.isFinite(top));
  const boundary = blockers.length ? Math.min(...blockers) : chatRect.bottom;
  drawer.style.bottom = `${Math.max(0, Math.ceil(chatRect.bottom - boundary + 8))}px`;
  requestEmbeddedBrowserLayout();
}

function openTaskBoard(tab = "overview", focusId = "") {
  const drawer = ensureTaskBoardDrawer();
  if (!drawer) return;
  state.taskBoardTab = tab || "overview";
  state.taskBoardFocusId = focusId || "";
  drawer.hidden = false;
  drawer.dataset.tab = state.taskBoardTab;
  drawer.classList.add("open");
  if (taskBoardToggleBtn) {
    taskBoardToggleBtn.hidden = true;
    taskBoardToggleBtn.dataset.expanded = "1";
    taskBoardToggleBtn.title = "收起任务看板";
    taskBoardToggleBtn.setAttribute("aria-label", "收起任务看板");
    updateTaskBoardTogglePresentation();
  }
  renderTaskBoard();
  positionTaskBoard();
}

function closeTaskBoard() {
  const drawer = document.getElementById("taskBoardDrawer");
  if (!drawer) return;
  drawer.classList.remove("open");
  drawer.hidden = true;
  void api.browserEmbed?.({ visible: false });
  if (taskBoardToggleBtn) {
    taskBoardToggleBtn.hidden = false;
    taskBoardToggleBtn.dataset.expanded = "0";
    taskBoardToggleBtn.title = "展开任务看板";
    taskBoardToggleBtn.setAttribute("aria-label", "展开任务看板");
    updateTaskBoardTogglePresentation();
  }
}

async function loadTaskBoardFilePreview(file) {
  const key = taskBoardFileKey(file);
  if (!key) return;
  state.taskBoardFocusId = key;
  state.taskBoardPreviewPage = 1;
  state.taskBoardPreviewQuery = "";
  if (state.taskBoardPreviewRows[key]?.length || state.taskBoardPreviewContent[key]?.ok) {
    renderTaskBoard();
    return;
  }
  state.taskBoardPreviewContent[key] = { kind: "loading", previewText: "正在软件内部解析文件..." };
  renderTaskBoard();
  if (isSpreadsheetFile(file) && typeof api.spreadsheetPreview === "function") {
    const preview = await api.spreadsheetPreview(file).catch(() => null);
    if (preview?.rows?.length) {
      state.taskBoardPreviewRows[key] = preview.rows;
      state.taskBoardPreviewContent[key] = { ok: true, kind: "spreadsheet", sourcePath: preview.sourcePath || "", rowsCount: preview.rowsCount || preview.rows.length, columnsCount: preview.columnsCount || 0 };
      delete state.taskBoardSheetDrafts[key];
    } else {
      state.taskBoardPreviewContent[key] = { ok: false, kind: "error", previewText: "无法读取该表格，请确认文件仍在原位置。" };
    }
  } else if (typeof api.previewAttachment === "function") {
    state.taskBoardPreviewContent[key] = await api.previewAttachment(file).catch((error) => ({ ok: false, kind: "error", previewText: error?.message || "当前文件暂不支持内部预览。" }));
  }
  renderTaskBoard();
}

function taskBoardImageSource(image = {}) {
  const cached = state.taskBoardPreviewContent[taskBoardFileKey(image)];
  return image.dataUrl || (cached?.kind === "image" ? cached.dataUrl : "") || "";
}

function taskBoardImageVisualHtml(image = {}, alt = "图片") {
  const source = taskBoardImageSource(image);
  return source
    ? `<img src="${escapeHtml(source)}" loading="lazy" decoding="async" alt="${escapeHtml(alt)}">`
    : `<span class="task-board-image-placeholder" aria-label="图片等待读取">IMG</span>`;
}

async function loadTaskBoardImagePreview(image) {
  const key = taskBoardFileKey(image);
  if (!key) return;
  state.taskBoardFocusId = key;
  if (taskBoardImageSource(image)) {
    renderTaskBoard();
    return;
  }
  state.taskBoardPreviewContent[key] = { kind: "loading", previewText: "正在读取图片..." };
  renderTaskBoard();
  state.taskBoardPreviewContent[key] = await api.previewAttachment?.(image).catch((error) => ({ ok: false, kind: "error", previewText: error?.message || "图片读取失败" })) || { ok: false, kind: "error", previewText: "图片预览能力不可用" };
  renderTaskBoard();
}

async function preloadTaskBoardImages(images = []) {
  const pending = images.filter((image) => {
    const key = taskBoardFileKey(image);
    return key && !taskBoardImageSource(image) && !state.taskBoardPreviewContent[key];
  }).slice(-16);
  if (!pending.length || typeof api.previewAttachment !== "function") return;
  pending.forEach((image) => {
    state.taskBoardPreviewContent[taskBoardFileKey(image)] = { kind: "loading", previewText: "正在读取图片..." };
  });
  await Promise.all(pending.map(async (image) => {
    const key = taskBoardFileKey(image);
    state.taskBoardPreviewContent[key] = await api.previewAttachment(image).catch((error) => ({
      ok: false,
      kind: "error",
      previewText: error?.message || "图片读取失败"
    }));
  }));
  if (state.taskBoardTab === "images") renderTaskBoard();
}

function taskBoardEmbeddedBrowserHtml() {
  const browser = state.blackBallBrowser || {};
  return `<section class="task-board-embedded-browser">
    <header class="task-board-browser-toolbar">
      <nav aria-label="网页导航">
        <button type="button" data-browser-nav="back" title="后退" aria-label="后退" ${browser.canGoBack ? "" : "disabled"}>←</button>
        <button type="button" data-browser-nav="forward" title="前进" aria-label="前进" ${browser.canGoForward ? "" : "disabled"}>→</button>
        <button type="button" data-browser-nav="reload" title="${browser.loading ? "停止加载" : "刷新"}" aria-label="${browser.loading ? "停止加载" : "刷新"}">${browser.loading ? "×" : "↻"}</button>
      </nav>
      <form data-embedded-browser-form><input name="target" value="${escapeHtml(browser.url || "")}" autocomplete="off" spellcheck="false" placeholder="输入网址或搜索词" aria-label="网址或搜索词"></form>
      <div class="task-board-browser-actions"><button type="button" data-browser-analyze ${browser.url ? "" : "disabled"}>AI分析</button><button type="button" data-browser-external ${/^https?:\/\//i.test(browser.url || "") ? "" : "disabled"}>独立窗口</button></div>
    </header>
    ${browser.error ? `<div class="task-board-browser-error">${escapeHtml(browser.error)}</div>` : ""}
    <div id="blackBallBrowserViewport" class="task-board-browser-viewport"><span>${browser.standalone ? "已在独立窗口打开" : browser.loading ? "网页加载中" : "正在启动黑球浏览器"}</span></div>
  </section>`;
}

function embeddedBrowserBounds() {
  const viewport = document.getElementById("blackBallBrowserViewport");
  if (!viewport || !viewport.getClientRects().length) return null;
  const rect = viewport.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

let embeddedBrowserLayoutFrame = 0;
function requestEmbeddedBrowserLayout(target = "", source = "task-board") {
  cancelAnimationFrame(embeddedBrowserLayoutFrame);
  embeddedBrowserLayoutFrame = requestAnimationFrame(() => {
    embeddedBrowserLayoutFrame = 0;
    const drawer = document.getElementById("taskBoardDrawer");
    const bounds = embeddedBrowserBounds();
    const visible = Boolean(drawer && !drawer.hidden && state.taskBoardTab === "links" && bounds && !state.blackBallBrowser?.standalone);
    const theme = browserThemeFromCurrentDocument();
    void api.browserEmbed?.({ visible, bounds, sessionId: state.selectedSessionId, theme });
    if (visible && target) {
      void api.browserOpen?.({ target, sessionId: state.selectedSessionId, source, embedded: true, bounds, theme })
        .catch((error) => showCopyToast(error?.message || "网页打开失败"));
    }
  });
}

function bindTaskBoardEmbeddedBrowser(body) {
  body.querySelector("[data-embedded-browser-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = String(event.currentTarget.elements.target?.value || "").trim();
    if (!target) return;
    await api.browserNavigate?.(target).catch((error) => showCopyToast(error?.message || "网页打开失败"));
  });
  body.querySelectorAll("[data-browser-nav]").forEach((button) => button.addEventListener("click", async () => {
    const action = button.dataset.browserNav;
    if (action === "back") await api.browserBack?.();
    if (action === "forward") await api.browserForward?.();
    if (action === "reload") {
      if (state.blackBallBrowser?.loading) await api.browserStop?.();
      else await api.browserReload?.();
    }
  }));
  body.querySelector("[data-browser-analyze]")?.addEventListener("click", async () => {
    const result = await api.browserAnalyzeCurrent?.().catch((error) => ({ success: false, error: error?.message || "页面分析失败" }));
    showCopyToast(result?.success ? "当前页面已提交分析" : (result?.error || "页面分析失败"));
  });
  body.querySelector("[data-browser-external]")?.addEventListener("click", async () => {
    const url = state.blackBallBrowser?.url || "";
    if (!url) return;
    const result = await api.browserOpen?.({ target: url, sessionId: state.selectedSessionId, source: "task-board-standalone", embedded: false, theme: browserThemeFromCurrentDocument() }).catch((error) => ({ success: false, error: error?.message || "独立窗口打开失败" }));
    showCopyToast(result?.success ? "已在独立窗口打开" : (result?.error || "独立窗口打开失败"));
  });
  requestEmbeddedBrowserLayout();
}

function markTaskBoardSheetDirty(editor, draft) {
  draft.dirty = true;
  draft.lastDraftAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dirty = editor?.querySelector("[data-sheet-dirty]");
  const autosave = editor?.querySelector("[data-sheet-autosave]");
  if (dirty) dirty.textContent = "已修改";
  if (autosave) autosave.textContent = `草稿已保存 ${draft.lastDraftAt}`;
}

function bindTaskBoardSheetControls(body, file = null, collections = null) {
  const editor = body.querySelector(".baiqiu-sheet-editor");
  const key = file ? taskBoardFileKey(file) : "";
  const draft = key ? state.taskBoardSheetDrafts[key] : null;
  body.querySelector("[data-board-sheet-search]")?.addEventListener("change", (event) => {
    state.taskBoardPreviewQuery = event.currentTarget.value || "";
    state.taskBoardPreviewPage = 1;
    renderTaskBoard();
  });
  body.querySelectorAll("[data-board-sheet-zoom]").forEach((button) => {
    button.addEventListener("click", () => {
      const delta = button.dataset.boardSheetZoom === "in" ? .1 : -.1;
      state.taskBoardPreviewZoom = Math.min(1.5, Math.max(.75, Number(state.taskBoardPreviewZoom || 1) + delta));
      renderTaskBoard();
    });
  });
  body.querySelectorAll("[data-board-sheet-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.taskBoardPreviewPage = Math.max(1, Number(state.taskBoardPreviewPage || 1) + (button.dataset.boardSheetPage === "next" ? 1 : -1));
      renderTaskBoard();
    });
  });
  if (!editor || !draft || !file) return;
  const selectCell = (cell) => {
    if (!cell) return;
    draft.selectedRow = Number(cell.dataset.sheetRow || 0);
    draft.selectedColumn = Number(cell.dataset.sheetColumn || 0);
    editor.querySelectorAll("td.selected").forEach((node) => node.classList.remove("selected"));
    cell.classList.add("selected");
    const address = editor.querySelector(".baiqiu-sheet-statusbar span:nth-child(2)");
    if (address) address.textContent = `单元格 ${spreadsheetColumnLabel(draft.selectedColumn)}${draft.selectedRow + 1}`;
  };
  editor.querySelectorAll("td[data-sheet-row]").forEach((cell) => {
    cell.addEventListener("focus", () => selectCell(cell));
    cell.addEventListener("input", () => {
      const row = Number(cell.dataset.sheetRow || 0);
      const column = Number(cell.dataset.sheetColumn || 0);
      draft.rows[row] ||= [];
      draft.rows[row][column] = cell.innerText.replace(/\r?\n/g, " ");
      markTaskBoardSheetDirty(editor, draft);
    });
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Delete") {
        event.preventDefault();
        cell.textContent = "";
        cell.dispatchEvent(new Event("input"));
      }
      if (event.key === "Enter") {
        event.preventDefault();
        editor.querySelector(`td[data-sheet-row="${Number(cell.dataset.sheetRow) + 1}"][data-sheet-column="${cell.dataset.sheetColumn}"]`)?.focus();
      }
    });
    cell.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain") || "";
      if (!/[\t\r\n]/.test(text)) return;
      event.preventDefault();
      const startRow = Number(cell.dataset.sheetRow || 0);
      const startColumn = Number(cell.dataset.sheetColumn || 0);
      text.replace(/\r/g, "").split("\n").filter((line, index, list) => line || index < list.length - 1).forEach((line, rowOffset) => {
        const rowIndex = startRow + rowOffset;
        if (rowIndex >= 5000) return;
        draft.rows[rowIndex] ||= [];
        line.split("\t").slice(0, 100 - startColumn).forEach((value, columnOffset) => { draft.rows[rowIndex][startColumn + columnOffset] = value; });
      });
      markTaskBoardSheetDirty(editor, draft);
      renderTaskBoard();
    });
  });
  editor.querySelector("[data-sheet-add-row]")?.addEventListener("click", () => {
    if (draft.rows.length >= 5000) return showCopyToast("最多支持 5000 行");
    draft.rows.push(Array(Math.max(1, ...draft.rows.map((row) => row.length))).fill(""));
    draft.selectedRow = draft.rows.length - 1;
    markTaskBoardSheetDirty(editor, draft);
    state.taskBoardPreviewPage = Math.ceil(draft.rows.length / 80);
    renderTaskBoard();
  });
  editor.querySelector("[data-sheet-add-column]")?.addEventListener("click", () => {
    const columns = Math.max(1, ...draft.rows.map((row) => row.length));
    if (columns >= 100) return showCopyToast("最多支持 100 列");
    draft.rows.forEach((row) => row.push(""));
    draft.selectedColumn = columns;
    markTaskBoardSheetDirty(editor, draft);
    renderTaskBoard();
  });
  editor.querySelector("[data-sheet-clear]")?.addEventListener("click", () => {
    draft.rows[draft.selectedRow] ||= [];
    draft.rows[draft.selectedRow][draft.selectedColumn] = "";
    markTaskBoardSheetDirty(editor, draft);
    renderTaskBoard();
  });
  editor.querySelectorAll("[data-sheet-column-width]").forEach((button) => button.addEventListener("click", () => {
    const column = draft.selectedColumn;
    const delta = button.dataset.sheetColumnWidth === "increase" ? 16 : -16;
    draft.columnWidths[column] = Math.max(56, Math.min(360, Number(draft.columnWidths[column] || 112) + delta));
    markTaskBoardSheetDirty(editor, draft);
    renderTaskBoard();
  }));
  editor.querySelectorAll("[data-sheet-row-height]").forEach((button) => button.addEventListener("click", () => {
    const row = draft.selectedRow;
    const delta = button.dataset.sheetRowHeight === "increase" ? 4 : -4;
    draft.rowHeights[row] = Math.max(22, Math.min(120, Number(draft.rowHeights[row] || 30) + delta));
    markTaskBoardSheetDirty(editor, draft);
    renderTaskBoard();
  }));
  editor.querySelectorAll("[data-sheet-sort]").forEach((button) => button.addEventListener("click", () => {
    if (draft.rows.length <= 1) return;
    const direction = button.dataset.sheetSort === "desc" ? -1 : 1;
    const header = draft.rows[0];
    const column = draft.selectedColumn;
    const sorted = draft.rows.slice(1).sort((left, right) => String(left[column] ?? "").localeCompare(String(right[column] ?? ""), "zh-CN", { numeric: true }) * direction);
    draft.rows = [header, ...sorted];
    markTaskBoardSheetDirty(editor, draft);
    renderTaskBoard();
  }));
  editor.querySelector("[data-sheet-list-toggle]")?.addEventListener("click", () => {
    state.taskBoardFileListHidden = !state.taskBoardFileListHidden;
    renderTaskBoard();
  });
  editor.querySelectorAll("[data-sheet-save]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = "保存中...";
    try {
      const saveMode = button.dataset.sheetSave;
      const result = await api.spreadsheetSave?.({ attachment: { ...file, sourcePath: draft.savedPath || draft.sourcePath || file.sourcePath }, sourcePath: draft.savedPath || draft.sourcePath, rows: draft.rows, columnWidths: draft.columnWidths, rowHeights: draft.rowHeights, mode: saveMode });
      if (result?.canceled) return;
      if (!result?.ok) throw new Error(result?.message || "保存失败");
      if (saveMode !== "export") {
        draft.dirty = false;
        draft.savedPath = result.file || draft.savedPath;
        draft.sourcePath = result.file || draft.sourcePath;
      }
      const dirty = editor.querySelector("[data-sheet-dirty]");
      const autosave = editor.querySelector("[data-sheet-autosave]");
      if (dirty) dirty.textContent = saveMode === "export" ? (draft.dirty ? "已修改" : "未修改") : "已保存";
      if (autosave) {
        const actionLabel = saveMode === "export" ? "Excel 已导出" : "文件已保存";
        autosave.textContent = `${actionLabel} ${new Date(result.savedAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      }
      showCopyToast(button.dataset.sheetSave === "export" ? "Excel 已导出" : "表格已保存");
    } catch (error) {
      showCopyToast(error?.message || "表格保存失败");
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }));
  const bindResize = (selector, axis) => {
    editor.querySelectorAll(selector).forEach((handle) => handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const index = Number(axis === "column" ? handle.dataset.sheetColumnResize : handle.dataset.sheetRowResize);
      const start = axis === "column" ? event.clientX : event.clientY;
      const initial = Number((axis === "column" ? draft.columnWidths[index] : draft.rowHeights[index]) || (axis === "column" ? 112 : 30));
      const move = (moveEvent) => {
        const value = initial + (axis === "column" ? moveEvent.clientX : moveEvent.clientY) - start;
        if (axis === "column") {
          draft.columnWidths[index] = Math.max(56, Math.min(360, value));
          handle.closest("th")?.style.setProperty("width", `${draft.columnWidths[index]}px`);
        } else {
          draft.rowHeights[index] = Math.max(22, Math.min(120, value));
          handle.closest("tr")?.style.setProperty("height", `${draft.rowHeights[index]}px`);
        }
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        markTaskBoardSheetDirty(editor, draft);
        renderTaskBoard();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    }));
  };
  bindResize("[data-sheet-column-resize]", "column");
  bindResize("[data-sheet-row-resize]", "row");
}

function renderTaskBoard() {
  const drawer = ensureTaskBoardDrawer();
  const body = document.getElementById("taskBoardBody");
  if (!drawer || !body || drawer.hidden) return;
  positionTaskBoard();
  const tab = state.taskBoardTab || drawer.dataset.tab || "overview";
  drawer.dataset.tab = tab;
  drawer.classList.toggle("preview-expanded", ["tables", "files", "images", "links"].includes(tab) && Boolean(state.taskBoardFocusId));
  drawer.querySelectorAll("[data-board-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.boardTab === tab);
  });

  const session = selectedSession();
  const messages = state.currentMessages || [];
  const boardMessages = messages.slice(-120);
  const assets = cachedTaskBoardAssets(boardMessages);
  const allFiles = assets.files.slice(-40);
  const tables = allFiles.filter(isSpreadsheetFile).slice(-24);
  const images = assets.images.slice(-16);
  const files = allFiles.filter((file) => !isSpreadsheetFile(file) && !isTaskBoardImage(file)).slice(-24);
  const links = assets.links.slice(-30);
  const currentModel = modelState?.textContent || "DeepSeek / Minimal";
  const currentTask = taskState?.textContent || statusText(session?.status);
  const progressStages = collectTaskProgressStages(session);
  const executionEvents = cachedTaskBoardExecutionEvents(session, boardMessages);
  const collections = { files: allFiles, tables, documents: files, images, links };

  if (tab === "overview") {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const taskTitle = compactMonitorText(lastUser?.text || currentTask || "等待新任务", 64);
    const running = sessionIsRunning(session);
    const taskStatus = running ? "执行中" : session?.status === "done" ? "已完成" : session?.status === "failed" ? "需检查" : "等待";
    const duration = formatTaskDuration(messageDurationMs(lastAssistant));
    const tokenUsage = conversationUsage(messages);
    const resultText = compactMonitorText(lastAssistant?.text || "任务完成后，白球 AI 的交付结果会显示在这里。", 260);
    const outputs = generatedFilesFromMessage(lastAssistant || {}).slice(0, 5);
    body.innerHTML = `
      <section class="task-board-task-hero" data-status="${running ? "running" : "idle"}" aria-label="当前任务状态">
        <div><span>当前任务</span><strong>${escapeHtml(taskTitle)}</strong><small><i></i>${taskStatus}</small></div>
        <dl><div><dt>使用模型</dt><dd>${escapeHtml(currentModel)}</dd></div><div><dt>执行时间</dt><dd>${duration}</dd></div><div><dt>Token 消耗</dt><dd>${compactNumber(tokenUsage.used)}${tokenUsage.exact ? "" : " 估算"}</dd></div></dl>
      </section>
      <div class="task-board-overview-grid">
        <section class="task-board-result-band">
          <header><div><span>真实交付</span><strong>${lastAssistant ? "最近一次 AI 回复" : "等待任务交付"}</strong></div><b>${taskStatus}</b></header>
          <p>${escapeHtml(resultText)}</p>
          ${outputs.length ? `<ul>${outputs.map((item) => `<li>${escapeHtml(item.name || "交付文件")}</li>`).join("")}</ul>` : ""}
        </section>
        <section class="task-board-evidence-summary">
          <header><div><span>真实执行证据</span><strong>${executionEvents.length ? `已记录 ${executionEvents.length} 项` : "暂无记录"}</strong></div><button type="button" data-board-jump="timeline">查看日志</button></header>
          ${taskBoardExecutionEventsHtml(executionEvents, 3)}
        </section>
      </div>
      <div class="task-board-resource-stats"><button type="button" data-board-jump="tables"><b>${tables.length}</b><span>表格</span></button><button type="button" data-board-jump="images"><b>${images.length}</b><span>图片</span></button><button type="button" data-board-jump="files"><b>${files.length}</b><span>文件</span></button><button type="button" data-board-jump="links"><b>${links.length}</b><span>黑球浏览器</span></button></div>
      ${taskBoardAgentSummaryHtml(session)}
      <details class="task-board-collapsible"><summary><span>状态推断（非执行日志）</span><b>${progressStages.filter((stage) => stage.status === "done").length}/${progressStages.length}</b></summary><div>${taskProgressTimelineHtml(progressStages)}</div></details>
    `;
    body.querySelectorAll("[data-board-jump]").forEach((button) => button.addEventListener("click", () => openTaskBoard(button.dataset.boardJump)));
    body.querySelector("[data-agent-log-open]")?.addEventListener("click", () => showAgentExecutionLog(session));
    return;
  }

  if (tab === "tables") {
    if (!tables.length) {
      body.innerHTML = taskBoardEmptyHtml("暂无表格", "会话中的 XLSX、XLS 和 CSV 会在这里集中显示并可直接编辑。");
      return;
    }
    const activeFile = tables.find((file) => taskBoardFileKey(file) === state.taskBoardFocusId);
    const activeEditor = Boolean(activeFile && state.taskBoardPreviewRows[taskBoardFileKey(activeFile)]?.length);
    body.innerHTML = activeFile ? `
      <div class="task-board-file-workspace spreadsheet-workspace" data-list-hidden="${state.taskBoardFileListHidden ? "true" : "false"}">
        <aside class="task-board-resource-list"><header><strong>会话表格</strong><span>${tables.length}</span></header>${tables.map((file, index) => taskBoardFileCardHtml(file, index, file === activeFile, true)).join("")}</aside>
        <main class="task-board-reader">${activeEditor ? taskBoardInternalPreviewHtml(activeFile) : `<header><div><span>表格 · ${formatTaskBoardBytes(activeFile.sizeBytes)}</span><strong>${escapeHtml(activeFile.name || "表格预览")}</strong></div><div><button type="button" data-board-file-open="${escapeHtml(taskBoardFileKey(activeFile))}">打开原文件</button><button type="button" data-board-file-location="${escapeHtml(taskBoardFileKey(activeFile))}">所在位置</button><button type="button" data-board-preview-close>关闭预览</button></div></header>${taskBoardInternalPreviewHtml(activeFile)}`}</main>
      </div>` : `<div class="task-board-resource-heading"><div><strong>表格工作区</strong><span>选择表格后直接进入白球 AI 内置编辑器</span></div><b>${tables.length} 个表格</b></div><div class="task-board-resource-grid">${tables.map((file, index) => taskBoardFileCardHtml(file, index)).join("")}</div>`;
    body.querySelectorAll("[data-board-file-internal]").forEach((button) => button.addEventListener("click", () => {
      const current = tables.find((item) => taskBoardFileKey(item) === (button.dataset.boardFileInternal || ""));
      if (current) loadTaskBoardFilePreview(current);
    }));
    body.querySelectorAll("[data-board-file-open]").forEach((button) => button.addEventListener("click", async () => {
      const current = tables.find((item) => taskBoardFileKey(item) === (button.dataset.boardFileOpen || ""));
      if (!current) return;
      const result = await api.openOriginalAttachment?.(current).catch(() => null);
      if (!result?.ok) showCopyToast(result?.message || "当前表格暂无可打开的原始路径");
    }));
    body.querySelectorAll("[data-board-preview-close]").forEach((button) => button.addEventListener("click", () => { state.taskBoardFocusId = ""; renderTaskBoard(); }));
    bindTaskBoardLocationButtons(body, tables);
    bindTaskBoardSheetControls(body, activeEditor ? activeFile : null, collections);
    return;
  }

  if (tab === "files") {
    if (!files.length) {
      body.innerHTML = taskBoardEmptyHtml("暂无文件", "上传文件后，白球 AI 将自动读取并准备分析。 ");
      return;
    }
    const activeFile = files.find((file) => taskBoardFileKey(file) === state.taskBoardFocusId);
    const activeSpreadsheet = Boolean(activeFile && isSpreadsheetFile(activeFile));
    const activeSpreadsheetEditor = Boolean(activeSpreadsheet && state.taskBoardPreviewRows[taskBoardFileKey(activeFile)]?.length);
    body.innerHTML = activeFile ? `
      <div class="task-board-file-workspace${activeSpreadsheet ? " spreadsheet-workspace" : ""}" data-list-hidden="${state.taskBoardFileListHidden ? "true" : "false"}">
        <aside class="task-board-resource-list"><header><strong>项目文件</strong><span>${files.length}</span></header>${files.map((file, index) => taskBoardFileCardHtml(file, index, file === activeFile, true)).join("")}</aside>
        <main class="task-board-reader">${activeSpreadsheetEditor ? taskBoardInternalPreviewHtml(activeFile) : `<header><div><span>${taskBoardFileType(activeFile)} · ${formatTaskBoardBytes(activeFile.sizeBytes)}</span><strong>${escapeHtml(activeFile.name || "文件预览")}</strong></div><div><button type="button" data-board-file-open="${escapeHtml(taskBoardFileKey(activeFile))}">打开原文件</button><button type="button" data-board-file-location="${escapeHtml(taskBoardFileKey(activeFile))}">所在位置</button><button type="button" data-board-preview-close>关闭预览</button></div></header>${taskBoardInternalPreviewHtml(activeFile)}`}</main>
      </div>` : `<div class="task-board-resource-heading"><div><strong>AI 文件工作区</strong><span>选择文件即可在白球 AI 内部阅读</span></div><b>${files.length} 个文件</b></div><div class="task-board-resource-grid">${files.map((file, index) => taskBoardFileCardHtml(file, index)).join("")}</div>`;
    body.querySelectorAll("[data-board-file-internal]").forEach((button) => {
      button.addEventListener("click", () => {
        const current = files.find((item) => taskBoardFileKey(item) === (button.dataset.boardFileInternal || ""));
        if (current) loadTaskBoardFilePreview(current);
      });
    });
    body.querySelectorAll("[data-board-file-open]").forEach((button) => {
      button.addEventListener("click", async () => {
        const current = files.find((item) => taskBoardFileKey(item) === (button.dataset.boardFileOpen || ""));
        if (!current) return;
        const result = await api.openOriginalAttachment?.(current).catch(() => null);
        if (!result?.ok) showCopyToast(result?.message || "当前文件暂无可打开的原始路径");
      });
    });
    body.querySelectorAll("[data-board-preview-close]").forEach((button) => {
      button.addEventListener("click", () => {
        state.taskBoardFocusId = "";
        renderTaskBoard();
      });
    });
    bindTaskBoardLocationButtons(body, files);
    bindTaskBoardSheetControls(body, activeSpreadsheetEditor ? activeFile : null, collections);
    return;
  }

  if (tab === "images") {
    if (!images.length) {
      body.innerHTML = taskBoardEmptyHtml("暂无图片", "上传图片后，白球 AI 将自动识别并准备分析。 ");
      return;
    }
    const activeImage = images.find((image) => taskBoardFileKey(image) === state.taskBoardFocusId);
    const activeSource = activeImage ? taskBoardImageSource(activeImage) : "";
    const activeContent = activeImage ? state.taskBoardPreviewContent[taskBoardFileKey(activeImage)] : null;
    body.innerHTML = activeImage ? `<div class="task-board-media-workspace"><aside class="task-board-image-strip">${images.map((image, index) => `<button type="button" data-board-image-preview="${escapeHtml(taskBoardFileKey(image))}" class="${image === activeImage ? "active" : ""}">${taskBoardImageVisualHtml(image, image.name || `图片 ${index + 1}`)}<span>${escapeHtml(image.name || `图片 ${index + 1}`)}</span></button>`).join("")}</aside><main class="task-board-image-viewer"><header><strong>${escapeHtml(activeImage.name || "图片预览")}</strong><div><button type="button" data-board-image-open>打开原图</button><button type="button" data-board-image-location>所在位置</button><button type="button" data-board-preview-close>关闭预览</button></div></header><div>${activeSource ? `<img src="${escapeHtml(activeSource)}" alt="${escapeHtml(activeImage.name || "图片预览")}">` : activeContent?.kind === "loading" ? `<div class="task-board-loading-state"><i></i><span>正在读取本地图片...</span></div>` : `<div class="task-board-error-state">${escapeHtml(activeContent?.previewText || "图片暂时无法读取")}</div>`}</div></main></div>` : `<div class="task-board-resource-heading"><div><strong>图片资源库</strong><span>任务生成图片和本地路径图片均会进入这里</span></div><b>${images.length} 张图片</b></div><div class="task-board-gallery">${images.map((image, index) => `<button class="task-board-image-card" type="button" data-board-image-preview="${escapeHtml(taskBoardFileKey(image))}">${taskBoardImageVisualHtml(image, image.name || `图片 ${index + 1}`)}<span>${escapeHtml(image.name || `图片 ${index + 1}`)}</span><small>${escapeHtml(image.source || "会话图片")}</small></button>`).join("")}</div>`;
    body.querySelectorAll("[data-board-image-preview]").forEach((button) => button.addEventListener("click", () => {
      const current = images.find((image) => taskBoardFileKey(image) === (button.dataset.boardImagePreview || ""));
      if (current) loadTaskBoardImagePreview(current);
    }));
    body.querySelector("[data-board-preview-close]")?.addEventListener("click", () => { state.taskBoardFocusId = ""; renderTaskBoard(); });
    body.querySelector("[data-board-image-open]")?.addEventListener("click", async () => {
      const result = await api.openOriginalAttachment?.(activeImage).catch(() => null);
      if (!result?.ok) showCopyToast(result?.message || "当前图片没有可打开的原文件");
    });
    body.querySelector("[data-board-image-location]")?.addEventListener("click", () => showAttachmentInFolder(activeImage));
    void preloadTaskBoardImages(images);
    return;
  }

  if (tab === "links") {
    body.innerHTML = taskBoardEmbeddedBrowserHtml();
    bindTaskBoardEmbeddedBrowser(body);
    return;
  }

  body.innerHTML = `
    <div class="task-board-log-head"><div><strong>执行日志</strong><span>只显示 Task Brain、Hermes、真实工具调用和验证记录</span></div><b>${executionEvents.length} 条记录</b></div>
    ${taskBoardExecutionEventsHtml(executionEvents, 80)}
  `;
}

let taskBoardTogglePositionState = { edge: "right", ratio: 0.5 };
let taskBoardToggleDragState = null;
let suppressTaskBoardToggleClick = false;

function loadTaskBoardTogglePosition() {
  try {
    return taskBoardEdgePosition.normalizePosition(JSON.parse(localStorage.getItem(TASK_BOARD_TOGGLE_POSITION_KEY) || "{}"));
  } catch {
    return taskBoardEdgePosition.normalizePosition();
  }
}

function saveTaskBoardTogglePosition() {
  localStorage.setItem(TASK_BOARD_TOGGLE_POSITION_KEY, JSON.stringify(taskBoardTogglePositionState));
}

function taskBoardToggleViewportOptions() {
  const titlebarHeight = Math.max(0, document.querySelector(".titlebar")?.getBoundingClientRect().bottom || 42);
  return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, titlebarHeight, gap: 8 };
}

function updateTaskBoardTogglePresentation() {
  if (!taskBoardToggleBtn) return;
  const edge = taskBoardTogglePositionState.edge || "right";
  const expanded = taskBoardToggleBtn.dataset.expanded === "1";
  const icons = {
    right: expanded ? "›" : "‹",
    left: expanded ? "‹" : "›",
    top: expanded ? "▲" : "▼",
    bottom: expanded ? "▼" : "▲"
  };
  taskBoardToggleBtn.textContent = icons[edge];
}

function applyTaskBoardTogglePosition(position = taskBoardTogglePositionState) {
  if (!taskBoardToggleBtn || !taskBoardEdgePosition) return;
  taskBoardTogglePositionState = taskBoardEdgePosition.normalizePosition(position);
  taskBoardToggleBtn.dataset.edge = taskBoardTogglePositionState.edge;
  const rect = taskBoardToggleBtn.getBoundingClientRect();
  const docked = taskBoardEdgePosition.calculateDockPosition({
    ...taskBoardToggleViewportOptions(),
    ...taskBoardTogglePositionState,
    elementWidth: rect.width,
    elementHeight: rect.height
  });
  taskBoardToggleBtn.style.left = `${docked.left}px`;
  taskBoardToggleBtn.style.top = `${docked.top}px`;
  taskBoardToggleBtn.dataset.positionReady = "1";
  updateTaskBoardTogglePresentation();
}

function bindTaskBoardToggleDrag() {
  if (!taskBoardToggleBtn || !taskBoardEdgePosition) return;
  taskBoardTogglePositionState = loadTaskBoardTogglePosition();
  applyTaskBoardTogglePosition();
  taskBoardToggleBtn.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    taskBoardToggleDragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    taskBoardToggleBtn.setPointerCapture?.(event.pointerId);
  });
  taskBoardToggleBtn.addEventListener("pointermove", (event) => {
    if (!taskBoardToggleDragState || taskBoardToggleDragState.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - taskBoardToggleDragState.startX, event.clientY - taskBoardToggleDragState.startY);
    if (!taskBoardToggleDragState.dragging && distance < 6) return;
    taskBoardToggleDragState.dragging = true;
    taskBoardToggleBtn.classList.add("dragging");
    taskBoardToggleBtn.setAttribute("aria-grabbed", "true");
    const edge = taskBoardEdgePosition.closestEdge({ ...taskBoardToggleViewportOptions(), clientX: event.clientX, clientY: event.clientY });
    taskBoardToggleBtn.dataset.edge = edge;
    const rect = taskBoardToggleBtn.getBoundingClientRect();
    taskBoardTogglePositionState = taskBoardEdgePosition.positionFromPointer({
      ...taskBoardToggleViewportOptions(),
      clientX: event.clientX,
      clientY: event.clientY,
      elementWidth: rect.width,
      elementHeight: rect.height
    });
    applyTaskBoardTogglePosition();
    event.preventDefault();
  });
  const finishDrag = (event) => {
    if (!taskBoardToggleDragState || taskBoardToggleDragState.pointerId !== event.pointerId) return;
    const dragged = taskBoardToggleDragState.dragging;
    taskBoardToggleDragState = null;
    taskBoardToggleBtn.classList.remove("dragging");
    taskBoardToggleBtn.setAttribute("aria-grabbed", "false");
    taskBoardToggleBtn.releasePointerCapture?.(event.pointerId);
    if (dragged) {
      applyTaskBoardTogglePosition();
      saveTaskBoardTogglePosition();
      suppressTaskBoardToggleClick = true;
      setTimeout(() => { suppressTaskBoardToggleClick = false; }, 0);
    }
  };
  taskBoardToggleBtn.addEventListener("pointerup", finishDrag);
  taskBoardToggleBtn.addEventListener("pointercancel", finishDrag);
}

function bindTaskBoardEntrances() {
  bindTaskBoardToggleDrag();
  taskBoardToggleBtn?.addEventListener("click", () => {
    if (suppressTaskBoardToggleClick) {
      suppressTaskBoardToggleClick = false;
      return;
    }
    const drawer = ensureTaskBoardDrawer();
    if (drawer?.classList.contains("open")) closeTaskBoard();
    else openTaskBoard(state.taskBoardTab || "overview");
  });
  document.querySelector(".mini-monitor")?.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    openTaskBoard("timeline");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTaskBoard();
  });
  document.addEventListener("pointerdown", (event) => {
    const drawer = document.getElementById("taskBoardDrawer");
    const target = event.target instanceof Node ? event.target : null;
    if (!drawer?.classList.contains("open") || !target) return;
    if (target instanceof Element && target.closest(".agent-log-layer")) return;
    if (drawer.contains(target) || taskBoardToggleBtn?.contains(target)) return;
    closeTaskBoard();
  }, true);
  window.addEventListener("resize", () => {
    adjustComposerHeight();
    applyTaskBoardTogglePosition();
    positionTaskBoard();
  });
}

api.onSessionChanged((db) => {
  state.db = ensureClientDb(db);
  for (const session of state.db.sessions || []) {
    if (sessionIsRunning(session)) continue;
    sessionTaskQueue.setActive(session.id, false);
    discardLiveChatStreamsForSession(session.id);
  }
  if (state.debugCenterRunning) return;
  clearTimeout(sessionChangedRenderTimer);
  sessionChangedRenderTimer = setTimeout(() => {
    sessionChangedRenderTimer = null;
    renderAll({ refreshSettings: false, refreshSecondary: false }).catch((error) => console.error("[SessionRender]", error));
  }, 48);
});

api.init().then(async (db) => {
  applySavedLayout();
  setupSplitters();
  setupComposerResize();
  bindComposerClarificationDrag();
  resetMonitorEffects();
  ensureTaskBoardDrawer();
  bindTaskBoardEntrances();
  state.db = ensureClientDb(db);
  renderCustomerProfileGate();
  if (state.db.settings?.webSearch?.enabled !== true) {
    state.db.settings.webSearch = { ...(state.db.settings.webSearch || {}), enabled: true };
    setTimeout(() => api.saveSettings(state.db.settings).catch(() => null), 0);
  }
  state.selectedSessionId = state.db.selectedSessionId;

  // 恢复意图预测开关状态
  if (intentPredictBtn) {
    const enabled = Boolean(state.db.settings?.intentPredict);
    intentPredictBtn.dataset.enabled = enabled ? "1" : "0";
    if (intentPredictLabel) intentPredictLabel.textContent = enabled ? "开" : "关";
    intentPredictBtn.querySelectorAll(".intent-predict-option").forEach((o) => {
      o.classList.toggle("active", o.dataset.value === (enabled ? "1" : "0"));
    });
  }
  adjustComposerHeight();
  await renderAll();
  startMembershipCountdown();
  api.onToolConfirmation?.((request) => showConfirmCard(request));
  setTimeout(async () => {
    await refreshLicenseStatus().catch(() => null);
    try {
      const info = await api.updateInfo();
      if (info?.hasUpdate) showUpdateBadge(info);
    } catch {}
  }, 1500);
});
