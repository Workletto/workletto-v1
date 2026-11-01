import { useContext, useEffect } from "react";
import { NotFoundSignal } from "../Shell.tsx";
import { Link } from "../router.tsx";
import { PageHeader } from "../ui.tsx";

// Shown for an address that doesn't exist, and for one this person may not open. It says
// nothing about what the page would have held.
export function NotFound() {
  const markNotFound = useContext(NotFoundSignal);
  // No item of the main navigation is highlighted while this shows.
  useEffect(() => {
    markNotFound(true);
    return () => markNotFound(false);
  }, [markNotFound]);
  return (
    <>
      <PageHeader title="Page not found" intro="This address doesn't exist, or you don't have access to it." />
      <div>
        <Link to="/" className="wl-link wl-link-alone">
          Go to your time
        </Link>
      </div>
    </>
  );
}
