import type { Source } from '../../types'
import { ado } from './ado'

/**
 * Every source the pane reads. Add a source here and give its tasks a key prefix of its own
 * (for example `jira:`), so it never closes or prunes another source's tasks.
 */
export const SOURCES: Source[] = [ado]
