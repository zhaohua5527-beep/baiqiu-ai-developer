"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const quote = value => `'${String(value).replace(/'/g, "''")}'`;
const helper = path.join(__dirname, "..", "services", "word-pdf-check.ps1");

for (const matchingIdentity of [true, false]) {
  test(`Word watchdog preserves DOCX and cleans only a matching process (${matchingIdentity})`, { skip: process.platform !== "win32" }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baiqiu-word-check-test-"));
    try {
      const source = path.join(directory, "input.docx");
      fs.writeFileSync(source, "keep this generated document");
      const script = `
function Start-Process {
  param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
  if ($WindowStyle -ne 'Hidden') { throw 'worker must be hidden' }
  $statePath = Join-Path (Split-Path $RedirectStandardOutput) 'word-process.json'
  @{processId=12345;startedAt=100} | ConvertTo-Json | Set-Content -LiteralPath $statePath
  Set-Content -LiteralPath $RedirectStandardOutput -Value 'WORD_OPENING_DOCUMENT'
  Set-Content -LiteralPath $RedirectStandardError -Value ''
  $fake = [pscustomobject]@{HasExited=$false;ExitCode=0}
  $fake | Add-Member ScriptMethod WaitForExit { param($timeout) return $false }
  $fake | Add-Member ScriptMethod Kill { $this.HasExited=$true; Write-Output 'WORKER_KILLED' }
  return $fake
}
function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -ne 12345) { throw 'unexpected process lookup' }
  $fake = [pscustomobject]@{ProcessName='WINWORD';StartTime=[datetime]::new(${matchingIdentity ? 100 : 200})}
  $fake | Add-Member ScriptMethod Kill { Write-Output 'OWN_WORD_KILLED' }
  return $fake
}
& ${quote(helper)} -SourcePath ${quote(source)} -OutputPath ${quote(path.join(directory, "check.pdf"))} -TimeoutSeconds 1
exit $LASTEXITCODE
`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout, /verification exceeded 1s/);
      assert.match(result.stdout, /WORKER_KILLED/);
      assert.equal(result.stdout.includes("OWN_WORD_KILLED"), matchingIdentity);
      assert.match(result.stdout, /WORD_OPENING_DOCUMENT/);
      assert.match(result.stdout, /"verified":false/);
      assert.equal(fs.readFileSync(source, "utf8"), "keep this generated document");
      const diagnostics = result.stdout.split(/\r?\n/).find(line => line.startsWith("{") && line.includes('"diagnosticsPath"'));
      if (diagnostics) {
        const scratch = JSON.parse(diagnostics).diagnosticsPath;
        assert.equal(path.dirname(scratch).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
        assert.match(path.basename(scratch), /^baiqiu-word-check-[a-f0-9]{32}$/);
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
