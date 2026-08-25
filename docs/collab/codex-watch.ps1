Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Codex")
$codexDoc = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (!$codexDoc) { Write-Output "NO_CODEX_DOC"; exit }
$items = @()
$stack = New-Object System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]
$stack.Push($codexDoc)
$count = 0
while ($stack.Count -gt 0) {
  $e = $stack.Pop()
  try {
    $t = $e.Current.ControlType.ProgrammaticName
    $n = $e.Current.Name
    $r = $e.Current.BoundingRectangle
    if ($t -match "Text|Button|Edit" -and $n -and $r.Width -gt 0 -and $r.Height -gt 0) {
      $y = [int]$r.Y
      $label = $n
      if ($label.Length -gt 110) { $label = $label.Substring(0,110) + "..." }
      $items += @{ y=$y; line=("{0,-8} y={1,5}  {2}" -f $t, $y, $label) }
    }
  } catch {}
  foreach ($c in $e.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { $stack.Push($c) }
  $count++
  if ($count -gt 1200) { break }
}
$sorted = $items | Sort-Object y -Descending | Select-Object -First 15
foreach ($item in $sorted) { Write-Output $item.line }
Write-Output "=== 元素总数: $count ==="
