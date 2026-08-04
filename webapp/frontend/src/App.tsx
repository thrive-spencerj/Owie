import { useEffect, useState } from "react";
import BoardDetail from "./views/BoardDetail";
import Fleet from "./views/Fleet";
import Sessions from "./views/Sessions";

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
  if (boardMatch) view = <BoardDetail chipId={boardMatch[1]} />;
  else if (hash === "#/sessions") view = <Sessions />;
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
