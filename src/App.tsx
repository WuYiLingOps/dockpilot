import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar, type PageKey } from "./components/Sidebar";
import { Containers } from "./pages/Containers";
import { Images } from "./pages/Images";
import { Logs } from "./pages/Logs";
import { Monitor } from "./pages/Monitor";
import { Terminal } from "./pages/Terminal";
import { api } from "./lib/api";

export default function App() {
  const [page, setPage] = useState<PageKey>("containers");
  const qc = useQueryClient();

  useEffect(
    () =>
      api.subscribeEvents((ev) => {
        if (ev.kind === "container") {
          void qc.invalidateQueries({ queryKey: ["containers"] });
        }
        if (ev.kind === "image") {
          void qc.invalidateQueries({ queryKey: ["images"] });
        }
      }),
    [qc],
  );

  return (
    <div className="flex h-full">
      <Sidebar page={page} onChange={setPage} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {page === "containers" && <Containers />}
        {page === "images" && <Images />}
        {page === "logs" && <Logs />}
        {page === "terminal" && <Terminal />}
        {page === "monitor" && <Monitor />}
      </main>
    </div>
  );
}
