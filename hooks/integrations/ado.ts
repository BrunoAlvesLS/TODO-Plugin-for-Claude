import type { Source } from '../../types'

/** Azure DevOps: shown as "Auto-sync". The watcher script is read-only against Azure DevOps. */
export const ado: Source = {
  id: 'ado',
  label: 'Auto-sync',
  inboxFile: 'inbox.json',
  settingsFile: 'alerts.json',
  scriptFile: 'ado-watch.ps1',
  jobName: 'TodoPaneAdoWatch',
  owns: /^(wi|pr)-[a-z]+:/,
  // A child item that gets assigned to me is the same work item: keep its task (tester and mention are other jobs).
  sameItem: /^wi-(?:assigned|child):(\d+)$/,
  // A failing build must come back while it is still red, even if the user ticked it off.
  keepOnUserExpire: /^pr-build:/,
}
