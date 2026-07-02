/**
 * DemosPage — dedicated surface for the pre-recorded session playbacks.
 *
 * Hosts the existing <DemoGallery /> component as a primary route. The onboarding
 * Welcome tour's final step navigates here so a new user immediately watches the
 * multi-agent loop in action without paying for an LLM run.
 */
import DemoGallery from '../components/demo/DemoGallery'

export default function DemosPage() {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6">
          <h1 className="text-3xl font-bold text-cf-text mb-2">Demos</h1>
          <p className="text-cf-text-muted text-sm leading-relaxed max-w-3xl">
            Full multi-agent runs replayed at 60× speed. Watch how Coders, Testers, a
            Summarizer and Finalizer collaborate on a real task — then build your own
            version from the same spec, no LLM cost while watching.
          </p>
        </header>
        <DemoGallery />
      </div>
    </div>
  )
}
