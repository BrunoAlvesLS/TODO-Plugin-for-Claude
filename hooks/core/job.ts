const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** `PT10M` style repeat interval; Task Scheduler accepts minutes up to the 1439 the settings allow. */
const intervalOf = (everyMinutes: number): string => {
  const h = Math.floor(everyMinutes / 60)
  const m = everyMinutes % 60
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}` || 'PT1M'
}

/**
 * Task Scheduler definition for the Auto-sync job (import with `schtasks /Create /XML`).
 * `schtasks /Create` flags alone cannot turn off the battery restrictions: by default the job would not
 * start on battery and would be stopped when unplugged, so a laptop would silently stop syncing.
 * No XML declaration on purpose: schtasks rejects "encoding=UTF-8" ("unable to switch the encoding") and
 * the file is written as UTF-8, so it must not claim UTF-16 either.
 * StartWhenAvailable runs a missed run after sleep or shutdown. `startBoundary` is local time, e.g. 2026-01-31T09:00:00.
 */
export const buildJobXml = (script: string, everyMinutes: number, startBoundary: string): string =>
  `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>${intervalOf(everyMinutes)}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowHardTerminate>true</AllowHardTerminate>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${escapeXml(`--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`
