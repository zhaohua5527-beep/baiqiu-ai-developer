"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer-v2", "app.js"), "utf8");
const generatedFileSource = rendererSource.slice(
  rendererSource.indexOf("const GENERATED_FILE_PATH_KEYS"),
  rendererSource.indexOf("function productResultText")
);
const sandbox = { URL };
vm.runInNewContext(`${generatedFileSource}\nthis.generatedFilesFromMessage = generatedFilesFromMessage;`, sandbox);

test("web tool results are not exposed as generated file cards", () => {
  const message = {
    role: "assistant",
    raw: {
      productResult: {
        raw: {
          raw: {
            baiqiuActions: [{
              result: {
                url: "https://wttr.in/Beijing?lang=zh&format=3",
                title: "wttr.in",
                content: ""
              },
              evidence: [{
                url: "https://wttr.in/Beijing?lang=zh&format=3",
                title: "wttr.in"
              }]
            }]
          }
        }
      }
    }
  };

  assert.equal(sandbox.generatedFilesFromMessage(message).length, 0);
});

test("real local deliverables remain visible and are deduplicated", () => {
  const message = {
    role: "assistant",
    raw: {
      result: {
        type: "spreadsheet_artifact",
        path: "D:\\deliverables\\weather.xlsx",
        name: "weather.xlsx"
      }
    }
  };

  const files = sandbox.generatedFilesFromMessage(message);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "weather.xlsx");
  assert.equal(files[0].path, "D:\\deliverables\\weather.xlsx");
});

test("explicit message attachments remain visible even when their URL has no file extension", () => {
  const attachment = {
    id: "attachment-1",
    name: "用户附件",
    mimeType: "application/octet-stream",
    url: "https://files.example.test/download?id=42"
  };

  const files = sandbox.generatedFilesFromMessage({ attachments: [attachment] });
  assert.equal(files.length, 1);
  assert.equal(files[0].id, attachment.id);
  assert.equal(files[0].url, attachment.url);
});

test("direct download URLs with a recognized extension remain visible", () => {
  const files = sandbox.generatedFilesFromMessage({
    raw: { result: { url: "https://files.example.test/reports/weather.pdf?download=1" } }
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "weather.pdf");
  assert.equal(files[0].mimeType, "application/pdf");
});

test("internal verification scripts and tool input paths are hidden", () => {
  const files = sandbox.generatedFilesFromMessage({
    attachments: [
      { name: "verify_v1.py", path: "C:\\work\\verify_v1.py" },
      { name: "final.xlsx", path: "C:\\deliverables\\final.xlsx" }
    ],
    raw: {
      toolCalls: [{ rawInput: { path: "C:\\source\\input.xlsx" } }],
      generatedFiles: [{ name: "verify_final.py", path: "C:\\work\\verify_final.py" }]
    }
  });

  assert.deepEqual(Array.from(files, (item) => item.name), ["final.xlsx"]);
});

test("generic file labels fall back to the real basename", () => {
  const files = sandbox.generatedFilesFromMessage({
    raw: {
      result: {
        type: "spreadsheet_artifact",
        path: "C:\\Users\\Lenovo\\Desktop\\表4可上传的活动V2.xlsx",
        name: "生成文件"
      }
    }
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "表4可上传的活动V2.xlsx");
});

test("skill inventory and verification paths stay internal", () => {
  const files = sandbox.generatedFilesFromMessage({
    raw: {
      result: {
        item: { name: "internal-skill", path: "D:\\runtime\\skills\\internal-skill\\SKILL.md" },
        skills: [{ name: "other-skill", path: "D:\\runtime\\skills\\other-skill\\SKILL.md" }],
        verification: { reportFile: "D:\\runtime\\reports\\verify.json" },
        installEvidence: { manifest: "D:\\runtime\\skills\\internal-skill\\SKILL.md" }
      }
    }
  });

  assert.equal(files.length, 0);
});
