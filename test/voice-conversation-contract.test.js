const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("voice conversation binds a voice session to a streamed turn", () => {
  const html = read("renderer-v2/index.html");
  const renderer = read("renderer-v2/app.js");
  assert.match(html, /id="voiceModeControl"/);
  assert.match(html, /data-voice-mode="input"/);
  assert.match(html, /data-voice-mode="conversation"/);
  assert.match(renderer, /let voiceConversationSessionId = "";/);
  assert.match(renderer, /let voiceConversationChatSessionId = "";/);
  assert.match(renderer, /let voiceConversationTurnId = "";/);
  assert.match(renderer, /voiceSessionId,/);
  assert.match(renderer, /function createVoiceConversationTurnId\(\)/);
  assert.match(renderer, /handleVoiceConversationStreamFrame\(frame = \{\}\)/);
  assert.match(renderer, /handleVoiceConversationStreamFrame\(frame\);/);
  assert.match(renderer, /beginVoiceSpeechTurn\(voiceConversationSessionId, sessionId, turnId\)/);
  assert.match(renderer, /await sendCurrentTask\(null, sessionId, \{ streamId: turnId \}\)/);
  assert.match(renderer, /await voiceSpeechWaitForIdle\(turnId\)/);
});

test("voice conversation can interrupt, cancel, and restart recording", () => {
  const renderer = read("renderer-v2/app.js");
  assert.match(renderer, /const VOICE_MIN_SPEECH_MS = 500;/);
  assert.match(renderer, /const VOICE_SILENCE_STOP_MS = 700;/);
  assert.match(renderer, /async function stopVoiceConversation\(\)/);
  assert.match(renderer, /await abortVoiceConversationTurn\(\)/);
  assert.match(renderer, /api\.abortChat\(\{ sessionId, runId: turnId \}\)/);
  assert.match(renderer, /voiceConversationTurnId = "";/);
  assert.match(renderer, /void stopVoiceConversation\(\)/);
});
