param(
  [string]$RootDir = '',
  [int]$Port = 17890
)
$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrWhiteSpace($RootDir)) {
  $RootDir = Split-Path -Parent $PSScriptRoot
}
$RootDir = [System.IO.Path]::GetFullPath($RootDir)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$patchPs1 = Join-Path $RootDir 'configuracoes\patch-aba-configuracoes.ps1'
$cfgFile = Join-Path $RootDir 'configuracoes\clinic-settings.json'

function Get-OrderedExistingDataFiles([string]$fileName) {
  $rawList = @(
    (Join-Path $RootDir ('dados\' + $fileName)),
    (Join-Path $RootDir ('resources\app\dados\' + $fileName))
  )
  if ($env:APPDATA) { $rawList += (Join-Path $env:APPDATA ('mm-sender\dados\' + $fileName)) }
  if ($env:LOCALAPPDATA) { $rawList += (Join-Path $env:LOCALAPPDATA ('mm-sender\dados\' + $fileName)) }
  $foundItems = @()
  foreach ($candidate in $rawList) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      try { $foundItems += (Get-Item -LiteralPath $candidate -ErrorAction Stop) } catch {}
    }
  }
  return @($foundItems | Sort-Object LastWriteTimeUtc -Descending | ForEach-Object { $_.FullName })
}

function Get-CurrentSettingsObj {
  $cfgCandidates = @($cfgFile, (Join-Path $RootDir 'clinic-settings.json'))
  if ($env:APPDATA) { $cfgCandidates += (Join-Path $env:APPDATA 'mm-sender\configuracoes\clinic-settings.json') }
  foreach ($cf in $cfgCandidates) {
    if ($cf -and (Test-Path -LiteralPath $cf)) {
      try {
        return ([System.IO.File]::ReadAllText($cf, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
      } catch {}
    }
  }
  return @{ clinicName = 'OdontoCompany Bela Vista Osasco'; clinicAddress = 'Av Antonio Carlos Costa 991'; address = 'Av Antonio Carlos Costa 991'; zeldaGroupTarget = '' }
}

function Get-WhatsAppConnectionObj {
  $waFiles = Get-OrderedExistingDataFiles 'whatsapp-connection-status.json'
  foreach ($wf in $waFiles) {
    try {
      $wObj = [System.IO.File]::ReadAllText($wf, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $nowEpoch = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      $hb = if ($wObj.heartbeatEpochMs) { [int64]$wObj.heartbeatEpochMs } else { [int64]0 }
      $age = $nowEpoch - $hb
      $ph = if ($wObj.connectedPhone) { [string]$wObj.connectedPhone } else { [string]$wObj.phone }
      $upd = if ($wObj.updatedAt) { [string]$wObj.updatedAt } else { [string]$wObj.lastUpdatedAt }
      if (($wObj.connected -eq $true) -and ($age -ge 0) -and ($age -le 180000)) {
        return @{ connected = $true; stateLabel = 'Conectada (WhatsApp Online)'; phone = $ph; connectedPhone = $ph; lastUpdatedAt = $upd; updatedAt = $upd; source = 'mm_sender_live' }
      }
    } catch {}
  }
  return @{ connected = $false; stateLabel = 'Desconectada (WhatsApp Offline)'; phone = ''; connectedPhone = ''; lastUpdatedAt = (Get-Date -Format 'dd/MM/yyyy HH:mm:ss'); updatedAt = (Get-Date -Format 'dd/MM/yyyy HH:mm:ss'); source = 'mm_sender_live' }
}

function ConvertTo-BrtDateKey([object]$rawVal) {
  if ($null -eq $rawVal) { return '' }
  $s = ([string]$rawVal).Trim()
  if ($s.Length -eq 0) { return '' }
  if ($s -match '^(\d{4}-\d{2}-\d{2})$') { return $Matches[1] }
  if ($s -match '^(\d{2})/(\d{2})/(\d{4})') { return ($Matches[3] + '-' + $Matches[2] + '-' + $Matches[1]) }
  try {
    $dto = [DateTimeOffset]::Parse($s)
    return $dto.ToOffset([TimeSpan]::FromHours(-3)).ToString('yyyy-MM-dd')
  } catch {}
  if ($s -match '^(\d{4}-\d{2}-\d{2})') { return $Matches[1] }
  return ''
}

function Get-SerenaDashboardMetricsObj([string]$dateFilter) {
  $df = if ([string]::IsNullOrWhiteSpace($dateFilter)) { 'all' } else { $dateFilter.Trim().ToLowerInvariant() }
  $isAll = ($df -eq 'all' -or $df -eq 'todos' -or $df -eq 'total' -or $df -eq '*')
  $targetDate = if ($isAll) { 'all' } else { ConvertTo-BrtDateKey $df }
  if (-not $isAll -and [string]::IsNullOrWhiteSpace($targetDate)) { $isAll = $true; $targetDate = 'all' }

  $leadsEntrada = 0
  $novosLeads = 0
  $agendados = 0
  $transbordoHumano = 0
  $naoLidas = 0
  $mensagensRecebidas = 0
  $mensagensRespondidas = 0
  $seenPhones = @{}

  $evFiles = @((Join-Path $RootDir 'dados\serena-daily-events.json'))
  if ($env:APPDATA) { $evFiles += (Join-Path $env:APPDATA 'mm-sender\dados\serena-daily-events.json') }
  foreach ($ef in $evFiles) {
    if (Test-Path -LiteralPath $ef) {
      try {
        $evObj = [System.IO.File]::ReadAllText($ef, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($evObj.leads) {
          foreach ($prop in $evObj.leads.PSObject.Properties) {
            $phKey = [string]$prop.Name
            $ld = $prop.Value
            $seenPhones[$phKey] = $true
            $firstDay = ConvertTo-BrtDateKey $ld.firstSeenDate
            $inDays = @(); if ($ld.inboundDates) { foreach ($d in $ld.inboundDates) { $inDays += (ConvertTo-BrtDateKey $d) } }
            $bkDays = @(); if ($ld.bookedDates) { foreach ($d in $ld.bookedDates) { $bkDays += (ConvertTo-BrtDateKey $d) } }
            $hdDays = @(); if ($ld.handoffDates) { foreach ($d in $ld.handoffDates) { $hdDays += (ConvertTo-BrtDateKey $d) } }
            $isUnread = ($ld.unreadForHuman -ne $false)

            if ($isAll) {
              $leadsEntrada++
              $novosLeads++
              if (($ld.stage -eq 'AGENDADO') -or ($bkDays.Count -gt 0)) { $agendados++ }
              if (($ld.stage -eq 'TRANSBORDO_HUMANO') -or ($hdDays.Count -gt 0)) { $transbordoHumano++ }
              if ($isUnread) { $naoLidas++ }
              if ($ld.inboundCountByDate) { foreach ($cp in $ld.inboundCountByDate.PSObject.Properties) { $mensagensRecebidas += [int]$cp.Value } }
              if ($ld.repliedCountByDate) { foreach ($rp in $ld.repliedCountByDate.PSObject.Properties) { $mensagensRespondidas += [int]$rp.Value } }
            } else {
              $activeDay = ($firstDay -eq $targetDate) -or ($inDays -contains $targetDate) -or ($bkDays -contains $targetDate) -or ($hdDays -contains $targetDate)
              if ($firstDay -eq $targetDate) { $novosLeads++ }
              if ($activeDay) {
                $leadsEntrada++
                if ($isUnread) { $naoLidas++ }
              }
              if ($bkDays -contains $targetDate) { $agendados++ }
              if ($hdDays -contains $targetDate) { $transbordoHumano++ }
              if ($ld.inboundCountByDate -and $ld.inboundCountByDate.PSObject.Properties[$targetDate]) { $mensagensRecebidas += [int]$ld.inboundCountByDate.$targetDate }
              if ($ld.repliedCountByDate -and $ld.repliedCountByDate.PSObject.Properties[$targetDate]) { $mensagensRespondidas += [int]$ld.repliedCountByDate.$targetDate }
            }
          }
        }
        break
      } catch {}
    }
  }

  $agFiles = @((Join-Path $RootDir 'dados\agenda-serena-v2.json'))
  if ($env:APPDATA) { $agFiles += (Join-Path $env:APPDATA 'mm-sender\dados\agenda-serena-v2.json') }
  foreach ($af in $agFiles) {
    if (Test-Path -LiteralPath $af) {
      try {
        $agArr = @([System.IO.File]::ReadAllText($af, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
        foreach ($bk in $agArr) {
          if ($null -eq $bk) { continue }
          $bPh = (([string]$bk.phone) -replace '\D', '')
          if ($bPh.Length -gt 11 -and $bPh.StartsWith('55')) { $bPh = $bPh.Substring(2) }
          if ($bPh.Length -gt 0 -and $seenPhones.ContainsKey($bPh)) { continue }
          $bDay = ConvertTo-BrtDateKey $bk.createdAt
          if ($isAll -or ($bDay -eq $targetDate)) {
            $agendados++
            $leadsEntrada++
          }
        }
        break
      } catch {}
    }
  }

  $convRate = if ($leadsEntrada -gt 0) { [int][Math]::Round(($agendados * 100.0) / $leadsEntrada) } else { 0 }
  return @{
    ok = $true
    mode = if ($isAll) { 'all' } else { 'day' }
    date = $targetDate
    dateFilter = $targetDate
    isAllDays = $isAll
    leadsEntrada = $leadsEntrada
    novosLeads = $novosLeads
    atendimentosAtivos = $leadsEntrada
    mensagensRecebidas = $mensagensRecebidas
    mensagensRespondidas = $mensagensRespondidas
    agendados = $agendados
    transbordoHumano = $transbordoHumano
    naoLidas = $naoLidas
    taxaConversao = $convRate
    totalLeads = $leadsEntrada
    bookedCount = $agendados
    conversionRate = $convRate
  }
}

function Get-ZeldaActivitiesArr {
  foreach ($af in (Get-OrderedExistingDataFiles 'zelda-condominio-atividades.json')) {
    try {
      $parsedAct = [System.IO.File]::ReadAllText($af, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      if ($null -ne $parsedAct) { return @($parsedAct) }
    } catch {}
  }
  return @()
}

function Get-ZeldaDiscoveredGroupsArr {
  foreach ($gf in (Get-OrderedExistingDataFiles 'zelda-discovered-groups.json')) {
    try {
      $parsedGrp = [System.IO.File]::ReadAllText($gf, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      if ($null -ne $parsedGrp) { return @($parsedGrp) }
    } catch {}
  }
  return @()
}

function Get-ZeldaGroupDebugArr {
  foreach ($df in (Get-OrderedExistingDataFiles 'zelda-group-debug.json')) {
    try {
      $parsedDbg = [System.IO.File]::ReadAllText($df, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      if ($null -ne $parsedDbg) { return @($parsedDbg) }
    } catch {}
  }
  return @()
}

function Get-ProjectSnapshotObj {
  $skipDirs = @('node_modules', '.git', 'dist', 'build', 'release', 'out', '.venv', 'venv', '__pycache__', '.wwebjs_auth', '.wwebjs_cache', 'auth_serena', 'configuracoes', 'dados')
  $all = Get-ChildItem -LiteralPath $RootDir -Recurse -File -ErrorAction SilentlyContinue
  $tree = New-Object System.Collections.Generic.List[string]
  $scored = New-Object System.Collections.Generic.List[object]
  $totalBytes = [int64]0

  foreach ($f in $all) {
    $rel = $f.FullName.Substring($RootDir.Length).TrimStart('\', '/').Replace('\', '/')
    $parts = $rel -split '/'
    $skip = $false
    foreach ($p in $parts) {
      $lp = $p.ToLowerInvariant()
      if (($skipDirs -contains $lp) -or $lp.StartsWith('backup_antes_serena')) { $skip = $true; break }
    }
    if ($skip) { continue }
    $tree.Add($rel)
    $totalBytes += $f.Length

    $ext = $f.Extension.ToLowerInvariant()
    $validExts = @('.html', '.htm', '.ejs', '.tsx', '.jsx', '.vue', '.js', '.cjs', '.mjs', '.ts', '.py', '.cs', '.xaml', '.json', '.bat', '.cmd', '.ps1', '.iss')
    if (($validExts -contains $ext) -and ($f.Length -gt 0) -and ($f.Length -le 450000) -and (-not $rel.EndsWith('package-lock.json')) -and (-not $rel.EndsWith('.min.js'))) {
      $score = 10
      $lowRel = $rel.ToLowerInvariant()
      if ($lowRel -match '(zelda|serena|dashboard|lead|stat|metric|atendimento|grupo|group|disparo|massa|campanha|config|setting|aba|painel|gui|window)') { $score += 170 }
      if ($lowRel -match '(index|app|main|renderer|bot|whatsapp)') { $score += 80 }
      try {
        $txt = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
        if ($txt -match '(?i)(zelda|serena|dashboard|lead|@g\.us|isGroup|configura|settings|sendMessage)') { $score += 180 }
        $scored.Add([PSCustomObject]@{ path = $rel; full = $f.FullName; score = $score; content = $txt })
      } catch {}
    }
  }

  $topFiles = $scored | Sort-Object -Property score -Descending | Select-Object -First 30
  $keyFiles = @()
  foreach ($tf in $topFiles) {
    $textVal = [string]$tf.content
    $trunc = $false
    if ($textVal.Length -gt 90000) {
      $textVal = $textVal.Substring(0, 90000)
      $trunc = $true
    }
    $keyFiles += @{
      path = $tf.path
      content = $textVal
      truncated = $trunc
    }
  }

  return @{
    folderName = (Split-Path -Leaf $RootDir)
    targetDir = $RootDir
    fileTree = $tree.ToArray()
    keyFiles = $keyFiles
    totalSizeKb = [Math]::Max(1, [int][Math]::Round($totalBytes / 1024.0))
  }
}

function Send-HttpJson($stream, [int]$statusCode, [string]$statusText, [string]$jsonBody) {
  $bodyBytes = $utf8NoBom.GetBytes($jsonBody)
  $headers = @(
    ('HTTP/1.1 ' + $statusCode + ' ' + $statusText),
    'Content-Type: application/json; charset=utf-8',
    'Access-Control-Allow-Origin: *',
    'Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers: *',
    'Access-Control-Allow-Private-Network: true',
    ('Content-Length: ' + $bodyBytes.Length),
    'Connection: close',
    '',
    ''
  ) -join "`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($bodyBytes.Length -gt 0) {
    $stream.Write($bodyBytes, 0, $bodyBytes.Length)
  }
  $stream.Flush()
}

try {
  $ip = [System.Net.IPAddress]::Parse('127.0.0.1')
  $listener = New-Object System.Net.Sockets.TcpListener($ip, $Port)
  $listener.Start()
} catch {
  exit 0
}

$running = $true
while ($running) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $stream.ReadTimeout = 15000
    $stream.WriteTimeout = 15000

    $ms = New-Object System.IO.MemoryStream
    $buf = New-Object byte[] 8192
    $headerEnd = -1

    while ($headerEnd -lt 0) {
      $read = $stream.Read($buf, 0, $buf.Length)
      if ($read -le 0) { break }
      $ms.Write($buf, 0, $read)
      $arr = $ms.ToArray()
      $startScan = [Math]::Max(0, $arr.Length - $read - 4)
      for ($i = $startScan; $i -le ($arr.Length - 4); $i++) {
        if ($arr[$i] -eq 13 -and $arr[$i+1] -eq 10 -and $arr[$i+2] -eq 13 -and $arr[$i+3] -eq 10) {
          $headerEnd = $i + 4
          break
        }
      }
      if ($arr.Length -gt 65536 -and $headerEnd -lt 0) { break }
    }

    if ($headerEnd -lt 4) {
      $client.Close()
      continue
    }

    $allRead = $ms.ToArray()
    $headerStr = [System.Text.Encoding]::ASCII.GetString($allRead, 0, $headerEnd - 4)
    $firstLine = ($headerStr -split "`r`n")[0]
    $reqParts = $firstLine -split ' '
    $method = if ($reqParts.Length -ge 1) { $reqParts[0].ToUpperInvariant() } else { 'GET' }
    $rawUrl = if ($reqParts.Length -ge 2) { $reqParts[1] } else { '/' }
    $urlSplit = $rawUrl -split '\?', 2
    $urlPath = $urlSplit[0]
    $queryStr = if ($urlSplit.Length -ge 2) { $urlSplit[1] } else { '' }

    if ($method -eq 'OPTIONS') {
      $optHeaders = @(
        'HTTP/1.1 204 No Content',
        'Access-Control-Allow-Origin: *',
        'Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers: *',
        'Access-Control-Allow-Private-Network: true',
        'Content-Length: 0',
        'Connection: close',
        '',
        ''
      ) -join "`r`n"
      $optBytes = [System.Text.Encoding]::ASCII.GetBytes($optHeaders)
      $stream.Write($optBytes, 0, $optBytes.Length)
      $stream.Flush()
      $client.Close()
      continue
    }

    $contentLen = 0
    $lenMatch = [System.Text.RegularExpressions.Regex]::Match($headerStr, '(?im)^Content-Length:\s*(\d+)')
    if ($lenMatch.Success) {
      $contentLen = [int]$lenMatch.Groups[1].Value
    }

    $bodyMs = New-Object System.IO.MemoryStream
    $extraBytes = $allRead.Length - $headerEnd
    if ($extraBytes -gt 0) {
      $bodyMs.Write($allRead, $headerEnd, $extraBytes)
    }
    while ($bodyMs.Length -lt $contentLen) {
      $rem = [Math]::Min($buf.Length, [int]($contentLen - $bodyMs.Length))
      $r2 = $stream.Read($buf, 0, $rem)
      if ($r2 -le 0) { break }
      $bodyMs.Write($buf, 0, $r2)
    }
    $bodyStr = [System.Text.Encoding]::UTF8.GetString($bodyMs.ToArray())

    if ($method -eq 'POST' -and $urlPath -eq '/shutdown') {
      Send-HttpJson $stream 200 'OK' '{"ok":true}'
      $client.Close()
      $running = $false
      break
    }

    if ($method -eq 'GET' -and $urlPath -eq '/status') {
      $stJson = @{
        ok = $true
        targetDir = $RootDir
        settings = (Get-CurrentSettingsObj)
        whatsappConnection = (Get-WhatsAppConnectionObj)
        zeldaActivities = (Get-ZeldaActivitiesArr)
        zeldaDiscoveredGroups = (Get-ZeldaDiscoveredGroupsArr)
        zeldaGroupDebug = (Get-ZeldaGroupDebugArr)
      } | ConvertTo-Json -Depth 8 -Compress
      Send-HttpJson $stream 200 'OK' $stJson
      $client.Close()
      continue
    }

    if ($method -eq 'GET' -and $urlPath -eq '/dashboard-metrics') {
      $dateParam = 'all'
      if ($queryStr -match '(?:^|&)date=([^&]+)') {
        $dateParam = [System.Uri]::UnescapeDataString($Matches[1])
      }
      $mJson = (Get-SerenaDashboardMetricsObj $dateParam) | ConvertTo-Json -Depth 6 -Compress
      Send-HttpJson $stream 200 'OK' $mJson
      $client.Close()
      continue
    }

    if ($method -eq 'GET' -and $urlPath -eq '/zelda-activities') {
      $zaJson = @{ ok = $true; activities = (Get-ZeldaActivitiesArr) } | ConvertTo-Json -Depth 8 -Compress
      Send-HttpJson $stream 200 'OK' $zaJson
      $client.Close()
      continue
    }

    if ($method -eq 'POST' -and $urlPath -eq '/zelda-activities') {
      $pAct = $bodyStr | ConvertFrom-Json
      $dadosDir = Join-Path $RootDir 'dados'
      if (-not (Test-Path -LiteralPath $dadosDir)) { New-Item -ItemType Directory -Force -Path $dadosDir | Out-Null }
      $actOutFile = Join-Path $dadosDir 'zelda-condominio-atividades.json'
      $arrToSave = if ($null -ne $pAct.activities) { @($pAct.activities) } else { @() }
      $actJsonStr = ConvertTo-Json -InputObject $arrToSave -Depth 8
      if ($arrToSave.Count -eq 0) { $actJsonStr = '[]' }
      [System.IO.File]::WriteAllText($actOutFile, $actJsonStr, $utf8NoBom)
      if ($env:APPDATA) {
        $appDados = Join-Path $env:APPDATA 'mm-sender\dados'
        if (-not (Test-Path -LiteralPath $appDados)) { New-Item -ItemType Directory -Force -Path $appDados | Out-Null }
        [System.IO.File]::WriteAllText((Join-Path $appDados 'zelda-condominio-atividades.json'), $actJsonStr, $utf8NoBom)
      }
      if ($pAct.outboxText -and ([string]$pAct.outboxText).Trim().Length -gt 0) {
        $outboxFile = Join-Path $dadosDir 'zelda-outbox-queue.json'
        $qList = @()
        if (Test-Path -LiteralPath $outboxFile) {
          try { $qList = @([System.IO.File]::ReadAllText($outboxFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) } catch {}
        }
        $curCfg = Get-CurrentSettingsObj
        $grpTarget = if ($curCfg.zeldaGroupTarget) { [string]$curCfg.zeldaGroupTarget } elseif ($curCfg.grupoZelda) { [string]$curCfg.grupoZelda } else { '' }
        $qList += @{ id = ('out_' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); targetGroup = $grpTarget; text = [string]$pAct.outboxText; sent = $false; createdAt = (Get-Date -Format 'dd/MM/yyyy HH:mm:ss') }
        $qJson = ConvertTo-Json -InputObject $qList -Depth 6
        [System.IO.File]::WriteAllText($outboxFile, $qJson, $utf8NoBom)
      }
      $respAct = @{ ok = $true; count = $arrToSave.Count } | ConvertTo-Json -Compress
      Send-HttpJson $stream 200 'OK' $respAct
      $client.Close()
      continue
    }

    if ($method -eq 'GET' -and $urlPath -eq '/project-files') {
      $snapObj = Get-ProjectSnapshotObj
      $snapJson = $snapObj | ConvertTo-Json -Depth 8 -Compress
      Send-HttpJson $stream 200 'OK' $snapJson
      $client.Close()
      continue
    }

    if ($method -eq 'POST' -and $urlPath -eq '/sync-settings') {
      $parsed = $bodyStr | ConvertFrom-Json
      $cur = Get-CurrentSettingsObj
      $writtenCount = 0

      if ($parsed.settings) {
        $newName = if ($parsed.settings.clinicName) { [string]$parsed.settings.clinicName } else { [string]$cur.clinicName }
        $newAddr = if ($parsed.settings.clinicAddress) { [string]$parsed.settings.clinicAddress } elseif ($parsed.settings.address) { [string]$parsed.settings.address } else { [string]$cur.clinicAddress }
        $newPark = if ($null -ne $parsed.settings.parkingInfo) { [string]$parsed.settings.parkingInfo } else { [string]$cur.parkingInfo }
        $incZeldaGrp = if ($null -ne $parsed.settings.zeldaGroupTarget) { ([string]$parsed.settings.zeldaGroupTarget).Trim() } else { '' }
        $curZeldaGrp = if ($cur.zeldaGroupTarget) { ([string]$cur.zeldaGroupTarget).Trim() } elseif ($cur.grupoZelda) { ([string]$cur.grupoZelda).Trim() } else { '' }
        $newZeldaGrp = if ($incZeldaGrp.Length -gt 0) { $incZeldaGrp } elseif ($parsed.clearZeldaGroup -eq $true) { '' } else { $curZeldaGrp }
        $newZeldaCaretaker = if ($null -ne $parsed.settings.zeldaCaretakerPhone -and ([string]$parsed.settings.zeldaCaretakerPhone).Trim().Length -gt 0) { [string]$parsed.settings.zeldaCaretakerPhone } elseif ($cur.zeldaCaretakerPhone) { [string]$cur.zeldaCaretakerPhone } else { '' }
        $newZeldaQuorum = if ($parsed.settings.zeldaApprovalQuorum) { [int]$parsed.settings.zeldaApprovalQuorum } elseif ($cur.zeldaApprovalQuorum) { [int]$cur.zeldaApprovalQuorum } else { 3 }
        $newZeldaOn = if ($null -ne $parsed.settings.zeldaGroupEnabled) { [bool]$parsed.settings.zeldaGroupEnabled } else { $true }
        $newHourly = if ($parsed.settings.maxActiveMessagesPerHour) { [int]$parsed.settings.maxActiveMessagesPerHour } else { 30 }
        $newReactMin = if ($parsed.settings.reactionDelayMinMs) { [int]$parsed.settings.reactionDelayMinMs } else { 3000 }
        $newReactMax = if ($parsed.settings.reactionDelayMaxMs) { [int]$parsed.settings.reactionDelayMaxMs } else { 7000 }
        $newTypeMin = if ($parsed.settings.typingStateMinMs) { [int]$parsed.settings.typingStateMinMs } else { 2000 }
        $newTypeMax = if ($parsed.settings.typingStateMaxMs) { [int]$parsed.settings.typingStateMaxMs } else { 5000 }

        $newKeepUnread = if ($null -ne $parsed.settings.serenaKeepUnreadForHuman) { [bool]$parsed.settings.serenaKeepUnreadForHuman } elseif ($null -ne $cur.serenaKeepUnreadForHuman) { [bool]$cur.serenaKeepUnreadForHuman } else { $true }

        $mergedMap = @{
          clinicName = $newName.Trim()
          clinicAddress = $newAddr.Trim()
          address = $newAddr.Trim()
          parkingInfo = $newPark.Trim()
          zeldaGroupEnabled = $newZeldaOn
          zeldaGroupTarget = $newZeldaGrp.Trim()
          grupoZelda = $newZeldaGrp.Trim()
          zeldaCaretakerPhone = $newZeldaCaretaker.Trim()
          whatsappZelador = $newZeldaCaretaker.Trim()
          zeldaApprovalQuorum = $newZeldaQuorum
          zeldaTriggerMode = 'mention_only'
          zeldaTriggerKeyword = 'zelda'
          zeldaAllowFromMeTest = $true
          serenaKeepUnreadForHuman = $newKeepUnread
          maxActiveMessagesPerHour = $newHourly
          reactionDelayMinMs = $newReactMin
          reactionDelayMaxMs = $newReactMax
          typingStateMinMs = $newTypeMin
          typingStateMaxMs = $newTypeMax
          betweenBubblesMinMs = 4000
          betweenBubblesMaxMs = 8000
          maxMessageChars = 450
          enableSpintax = $true
          enableOptOutBlacklist = $true
          timezone = 'America/Sao_Paulo'
          workingHoursLabel = 'Seg-Sex 08:00 as 18:00 e Sabados 08:00 as 13:00 (Horario de Brasilia)'
          slotDurationMinutes = 30
          updatedAt = (Get-Date -Format 'dd/MM/yyyy HH:mm:ss')
          updatedAtEpochMs = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        }
        $mergedJson = $mergedMap | ConvertTo-Json -Depth 6
        $cfgTargets = @($cfgFile, (Join-Path $RootDir 'clinic-settings.json'))
        if ($env:APPDATA) { $cfgTargets += (Join-Path $env:APPDATA 'mm-sender\configuracoes\clinic-settings.json') }
        if ($env:LOCALAPPDATA) { $cfgTargets += (Join-Path $env:LOCALAPPDATA 'mm-sender\configuracoes\clinic-settings.json') }
        if (Test-Path -LiteralPath (Join-Path $RootDir 'resources\app')) { $cfgTargets += (Join-Path $RootDir 'resources\app\configuracoes\clinic-settings.json') }
        foreach ($ct in $cfgTargets) {
          try {
            $ctDir = Split-Path -Parent $ct
            if ($ctDir -and -not (Test-Path -LiteralPath $ctDir)) {
              New-Item -ItemType Directory -Force -Path $ctDir | Out-Null
            }
            [System.IO.File]::WriteAllText($ct, $mergedJson, $utf8NoBom)
          } catch {}
        }
        $writtenCount++
      }

      if ($parsed.files) {
        $latestCur = Get-CurrentSettingsObj
        $preserveGrp = if ($latestCur.zeldaGroupTarget) { ([string]$latestCur.zeldaGroupTarget).Trim() } elseif ($latestCur.grupoZelda) { ([string]$latestCur.grupoZelda).Trim() } else { '' }
        foreach ($fItem in $parsed.files) {
          $relP = (([string]$fItem.path) -replace '^[/\\]+', '').Replace('/', '\')
          if ([string]::IsNullOrWhiteSpace($relP) -or $relP.Contains('..')) { continue }
          $destP = Join-Path $RootDir $relP
          $destPDir = Split-Path -Parent $destP
          if ($destPDir -and -not (Test-Path -LiteralPath $destPDir)) {
            New-Item -ItemType Directory -Force -Path $destPDir | Out-Null
          }
          $contentToWrite = [string]$fItem.content
          if ($relP.ToLowerInvariant().EndsWith('clinic-settings.json') -and $preserveGrp.Length -gt 0 -and ($parsed.clearZeldaGroup -ne $true)) {
            try {
              $fObj = $contentToWrite | ConvertFrom-Json
              if ([string]::IsNullOrWhiteSpace([string]$fObj.zeldaGroupTarget)) {
                $fObj | Add-Member -NotePropertyName 'zeldaGroupTarget' -NotePropertyValue $preserveGrp -Force
                $fObj | Add-Member -NotePropertyName 'grupoZelda' -NotePropertyValue $preserveGrp -Force
                $contentToWrite = $fObj | ConvertTo-Json -Depth 6
              }
            } catch {}
          }
          [System.IO.File]::WriteAllText($destP, $contentToWrite, $utf8NoBom)
          $writtenCount++
        }
      }

      if ($parsed.surgicalEdits) {
        foreach ($ed in $parsed.surgicalEdits) {
          $relEd = (([string]$ed.path) -replace '^[/\\]+', '').Replace('/', '\')
          if ([string]::IsNullOrWhiteSpace($relEd) -or $relEd.Contains('..')) { continue }
          $destEd = Join-Path $RootDir $relEd
          if (-not (Test-Path -LiteralPath $destEd)) { continue }
          $origT = [System.IO.File]::ReadAllText($destEd, [System.Text.Encoding]::UTF8)
          $sT = [string]$ed.search
          $rT = [string]$ed.replace
          $nextT = $null
          if ($sT.Length -gt 0 -and $origT.Contains($sT)) {
            $idxP = $origT.IndexOf($sT)
            $nextT = $origT.Substring(0, $idxP) + $rT + $origT.Substring($idxP + $sT.Length)
          } else {
            $hasCrlf = $origT.Contains("`r`n")
            $nOrig = $origT.Replace("`r`n", "`n")
            $nSearch = $sT.Replace("`r`n", "`n").Trim()
            $nRep = $rT.Replace("`r`n", "`n")
            if ($nSearch.Length -gt 0 -and $nOrig.Contains($nSearch)) {
              $idxN = $nOrig.IndexOf($nSearch)
              $tmpOut = $nOrig.Substring(0, $idxN) + $nRep + $nOrig.Substring($idxN + $nSearch.Length)
              $nextT = if ($hasCrlf) { $tmpOut.Replace("`n", "`r`n") } else { $tmpOut }
            }
          }
          if ($null -ne $nextT) {
            [System.IO.File]::WriteAllText($destEd, $nextT, $utf8NoBom)
            $writtenCount++
          }
        }
      }

      if (Test-Path -LiteralPath $patchPs1) {
        if ($parsed.runBuild) {
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patchPs1 -RootDir $RootDir -RunBuild | Out-Null
        } else {
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patchPs1 -RootDir $RootDir | Out-Null
        }
      }

      $okResp = @{
        ok = $true
        targetDir = $RootDir
        writtenCount = $writtenCount
        settings = (Get-CurrentSettingsObj)
      } | ConvertTo-Json -Depth 8 -Compress
      Send-HttpJson $stream 200 'OK' $okResp
      $client.Close()
      continue
    }

    Send-HttpJson $stream 404 'Not Found' '{"error":"Not found"}'
    $client.Close()
  } catch {
    if ($client) {
      try { $client.Close() } catch {}
    }
  }
}
try { $listener.Stop() } catch {}