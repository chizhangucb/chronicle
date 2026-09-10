import { Link } from 'wouter';
import { ROUTES } from './routes.ts';

// The fallback surface: the page a path with no page of its own lands on.
//
// Without it an unrouted URL rendered the sidebar and topbar around an empty
// main area, which reads as a broken app rather than a wrong address. It sits
// in the same `page center empty-state` grammar as the welcome empty state, so
// a wrong address still looks like Chronicle.
//
// The copy says one thing: the address has no page, and here is the way back.
// It never guesses WHY: a mistyped path and a bookmark from an older release
// are indistinguishable from here, and a guess would be wrong for one of them.
export default function NotFoundPage() {
  return (
    <div className="page center empty-state">
      <div className="empty-icon">◷</div>
      <h2>This page does not exist</h2>
      <p className="muted">Chronicle has no page at this address. Check the link, or start again from Insights.</p>
      <Link className="btn primary lg" href={ROUTES.home}>Go to Insights</Link>
    </div>
  );
}
