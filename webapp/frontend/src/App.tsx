import { useEffect, useState } from "react";
import Fleet from "./views/Fleet";

// Task 9 adds these imports and route branches:
// import BoardDetail from "./views/BoardDetail";
// import Sessions from "./views/Sessions";

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const fn = () => setHash(location.hash || "#/");
    addEventListener("hashchange", fn);
    return () => removeEventListener("hashchange", fn);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  let view = <Fleet />;
  const boardMatch = hash.match(/^#\/board\/([^/]+)$/);
  if (boardMatch) {
    view = <p className="placeholder">Board view coming in Task 9 ({boardMatch[1]})</p>;
  } else if (hash === "#/sessions") {
    view = <p className="placeholder">Sessions view coming in Task 9</p>;
  }
  return (
    <div className="app">
      <nav>
        <a href="#/" className="brand">⚡ Owie Telemetry</a>
        <a href="#/">Fleet</a>
        <a href="#/sessions">Sessions</a>
      </nav>
      <main>{view}</main>
    </div>
  );
}
