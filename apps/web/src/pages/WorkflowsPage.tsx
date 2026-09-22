/**
 * Workflows page.
 *
 * Its own page rather than a block on the home page: the library is where you go
 * to *manage* something (add, delete, see which model files are missing), and the
 * home page is where you start work. Mixing the two made the home page long and
 * the library hard to find again.
 *
 * What you add here shows up in the canvas's prompt window immediately — the
 * server re-reads the library on every request, so there is no cache to bust and
 * nothing to restart.
 */
import { WorkflowLibrary } from '../components/WorkflowLibrary.tsx'

/** Props for the workflows page. */
export interface WorkflowsPageProps {
  /** Bumped by the shell after a change elsewhere. */
  refreshToken: number
  /** Tell the shell the list changed. */
  onChanged: () => void
}

/**
 * Render the workflow library page.
 * @param props - refresh signal and change callback.
 * @returns the page.
 */
export function WorkflowsPage({ refreshToken, onChanged }: WorkflowsPageProps) {
  return (
    <div className="page workflows-page">
      <WorkflowLibrary refreshToken={refreshToken} onChanged={onChanged} />
    </div>
  )
}
