const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "renderer-v2", "index.html"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer-v2", "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "renderer-v2", "styles.css"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const voiceWorkerSource = fs.readFileSync(path.join(root, "services", "voice-stt-worker.py"), "utf8");

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source block must exist`);
  return source.slice(start, end);
}

test("voice input button stays before send and still inserts transcript locally", () => {
  assert.match(indexSource, /id="voiceBtn"[\s\S]*id="sendBtn"/);
  assert.match(indexSource, /id="voiceBtn"[^>]+type="button"[^>]+aria-label="语音输入"/);
  assert.match(rendererSource, /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/);
  assert.match(rendererSource, /new MediaRecorder\(/);
  assert.match(rendererSource, /api\.transcribeAudio\(/);
  assert.match(rendererSource, /insertVoiceTranscript\(result\.text\)/);
  assert.doesNotMatch(rendererSource, /await speakVoiceReply\(state\.selectedSessionId\)/);
});

test("voice IPC still reaches bundled HMS transcription", () => {
  assert.match(preloadSource, /transcribeAudio:\s*\(payload\) => ipcRenderer\.invoke\("voice:transcribe", payload \|\| \{\}\)/);
  assert.match(mainSource, /ipcMain\.handle\("voice:transcribe"/);
  assert.match(mainSource, /ensureVoiceSttWorker\(\)\.transcribe/);
  assert.match(voiceWorkerSource, /from tools\.transcription_tools import transcribe_audio/);
  assert.match(mainSource, /fs\.rmSync\(tempDir, \{ recursive: true, force: true \}\)/);
});

test("voice control keeps stable dimensions and listening state", () => {
  assert.match(stylesSource, /#voiceBtn\s*\{[\s\S]*width: 34px;[\s\S]*height: 32px/);
  assert.match(stylesSource, /#voiceBtn\[data-state="listening"\]/);
  assert.match(rendererSource, /const VOICE_SILENCE_STOP_MS = 700;/);
  assert.match(rendererSource, /stopVoiceRecording\(\{ transcribe: false \}\)/);
});

test("voice composer entry defaults off and migrates missing old settings to off", () => {
  assert.match(indexSource, /id="voiceShowInComposerInput"/);
  assert.match(rendererSource, /voice:\s*\{[\s\S]*?showInComposer:\s*false/);
  assert.match(mainSource, /voice:\s*\{[\s\S]*?showInComposer:\s*false/);
  assert.match(rendererSource, /voice:\s*\{[\s\S]*?\.\.\.CLIENT_DEFAULT_SETTINGS\.voice[\s\S]*?\.\.\.\(next\.settings\.voice \|\| \{\}\)/);
  assert.match(mainSource, /db\.settings\.voice\s*=\s*\{[\s\S]*?\.\.\.base\.settings\.voice[\s\S]*?\.\.\.\(db\.settings\.voice \|\| \{\}\)/);
  assert.match(mainSource, /fresh\.settings\.voice\s*=\s*\{[\s\S]*?\.\.\.fresh\.settings\.voice[\s\S]*?\.\.\.\(previous\.settings\?\.voice \|\| \{\}\)/);
});

test("voice composer entry setting saves, reloads, and toggles the input controls", () => {
  const renderVoiceSettings = functionSource(rendererSource, "renderVoiceSettings", "readVoiceSettingsFromDialog");
  const readVoiceSettings = functionSource(rendererSource, "readVoiceSettingsFromDialog", "renderProfileSettingsInputs");
  const renderComposerEntry = functionSource(rendererSource, "renderVoiceComposerEntry", "voiceSpeechEnabled");
  const setHidden = functionSource(rendererSource, "setVoiceComposerControlsHidden", "stopVoiceComposerResources");

  assert.match(renderVoiceSettings, /voiceShowInComposerInput\)\s*voiceShowInComposerInput\.checked\s*=\s*voice\.showInComposer === true/);
  assert.match(readVoiceSettings, /showInComposer:\s*voiceShowInComposerInput\?\.checked === true/);
  assert.match(renderVoiceSettings, /renderVoiceComposerEntry\(\)/);
  assert.match(renderComposerEntry, /voiceComposerEntryVisible\(\)/);
  assert.match(renderComposerEntry, /setVoiceComposerControlsHidden\(false\)/);
  assert.match(renderComposerEntry, /setVoiceComposerControlsHidden\(true\)/);
  assert.match(setHidden, /voiceBtn\.hidden\s*=\s*hidden/);
  assert.match(setHidden, /voiceModeControl\.hidden\s*=\s*hidden/);
  assert.match(setHidden, /button\.disabled\s*=\s*hidden/);
  assert.match(stylesSource, /\.composer-tools > #voiceBtn\[hidden\],[\s\S]*?\.composer-tools > #voiceModeControl\[hidden\]\s*\{\s*display:\s*none !important;/);
});

test("turning off voice composer entry releases active voice resources", () => {
  const stopResources = functionSource(rendererSource, "stopVoiceComposerResources", "renderVoiceComposerEntry");
  const finishTranscription = functionSource(rendererSource, "finishVoiceTranscription", "startVoiceRecording");

  assert.match(stopResources, /voiceFeatureStopToken \+= 1/);
  assert.match(stopResources, /voiceConversationActive = false/);
  assert.match(stopResources, /voiceSpeechAbortTurn\(\)/);
  assert.match(stopResources, /stopVoiceSpeechPlayback\(\)/);
  assert.match(stopResources, /stopVoiceSilenceMonitor\(\)/);
  assert.match(stopResources, /stopVoiceRecording\(\{ transcribe: false \}\)/);
  assert.match(stopResources, /voiceStream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(stopResources, /abortVoiceConversationTurn\(\{ cancelSpeech: true \}\)/);
  assert.match(stopResources, /window\.speechSynthesis\?\.cancel\?\.\(\)/);
  assert.match(finishTranscription, /const stopToken = voiceFeatureStopToken/);
  assert.match(finishTranscription, /stopToken !== voiceFeatureStopToken \|\| !voiceComposerEntryVisible\(\)/);
  assert.match(rendererSource, /async function startVoiceRecording\(\{ conversation = false \} = \{\}\) \{\s*if \(!voiceComposerEntryVisible\(\)\) return;/);
  assert.match(rendererSource, /async function startVoiceConversation\(\) \{\s*if \(!voiceComposerEntryVisible\(\)\) return;/);
});

test("main window only grants media permission to its own renderer", () => {
  assert.match(mainSource, /setPermissionRequestHandler\([\s\S]*permission === "media"/);
  assert.match(mainSource, /setPermissionCheckHandler\([\s\S]*permission === "media"/);
});
