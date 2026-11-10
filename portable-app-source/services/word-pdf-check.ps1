param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(1, 60)][int]$TimeoutSeconds = 45,
    [string]$WorkerState = ''
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourcePath).Path
$destination = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.Path]::GetExtension($source) -ne '.docx' -or [System.IO.Path]::GetExtension($destination) -ne '.pdf') {
    throw 'Expected a DOCX source and a PDF output.'
}
if (Test-Path -LiteralPath $destination) { throw 'PDF output already exists. Choose a new validation output path.' }

if ($WorkerState) {
    $existingWordIds = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $word = $null
    $document = $null
    $ownsWord = $false
    try {
        Write-Output 'WORD_STARTING'
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BaiqiuWordWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId); }'
        $word = New-Object -ComObject Word.Application
        [uint32]$wordProcessId = 0
        [BaiqiuWordWindow]::GetWindowThreadProcessId([IntPtr]$word.Hwnd, [ref]$wordProcessId) | Out-Null
        if (!$wordProcessId -or $existingWordIds -contains $wordProcessId) { throw 'Could not acquire a dedicated Word process; existing Word sessions were left untouched.' }
        $ownedProcess = Get-Process -Id $wordProcessId
        $ownsWord = $true
        @{ processId = $wordProcessId; startedAt = $ownedProcess.StartTime.Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath $WorkerState -Encoding UTF8
        $word.Visible = $false
        $word.DisplayAlerts = 0
        $word.AutomationSecurity = 3
        Write-Output 'WORD_OPENING_DOCUMENT'
        $document = $word.Documents.Open($source, $false, $true)
        Write-Output 'WORD_EXPORTING_PDF'
        $document.ExportAsFixedFormat($destination, 17)
        if (!(Test-Path -LiteralPath $destination) -or (Get-Item -LiteralPath $destination).Length -eq 0) { throw 'Word did not produce a nonempty PDF.' }
        Write-Output 'WORD_PDF_CREATED'
    } finally {
        if ($document) { try { $document.Close(0) } catch {} }
        if ($ownsWord) { try { $word.Quit() } catch {} }
        if ($word) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null }
    }
    exit 0
}

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('baiqiu-word-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$workerStatePath = Join-Path $scratch 'word-process.json'
$stdoutPath = Join-Path $scratch 'stdout.txt'
$stderrPath = Join-Path $scratch 'stderr.txt'
$quote = { param([string]$value) "'" + $value.Replace("'", "''") + "'" }
$command = '& ' + (& $quote $PSCommandPath) + ' -SourcePath ' + (& $quote $source) + ' -OutputPath ' + (& $quote $destination) + ' -WorkerState ' + (& $quote $workerStatePath)
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$worker = $null
$verified = $false
try {
    $worker = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedCommand) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    if (!$worker.WaitForExit($TimeoutSeconds * 1000)) {
        throw "Word PDF verification exceeded ${TimeoutSeconds}s. The DOCX remains available; PDF verification is incomplete."
    }
    $worker.WaitForExit()
    if ($worker.ExitCode -ne 0) { throw 'Word PDF verification failed. The DOCX remains available.' }
    $verified = $true
} catch {
    Write-Output $_.Exception.Message
} finally {
    if ($worker -and !$worker.HasExited) { $worker.Kill(); $worker.WaitForExit(3000) | Out-Null }
    if (Test-Path -LiteralPath $workerStatePath) {
        $owned = Get-Content -LiteralPath $workerStatePath -Raw | ConvertFrom-Json
        $remaining = Get-Process -Id $owned.processId -ErrorAction SilentlyContinue
        if ($remaining -and $remaining.ProcessName -eq 'WINWORD' -and $remaining.StartTime.Ticks -eq $owned.startedAt) {
            $remaining.Kill()
        }
    }
    if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath }
    if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath }
}
@{ verified = $verified; layoutVerified = $false; sourcePath = $source; outputPath = $destination; diagnosticsPath = $scratch } | ConvertTo-Json -Compress
if (!$verified) { exit 2 }
