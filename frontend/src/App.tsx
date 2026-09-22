import { useState } from "react";
import UploadScreen from "./UploadScreen";
import Dashboard from "./Dashboard";

type View = "upload" | "dashboard";

export default function App() {
  const [view, setView] = useState<View>("upload");
  const [lastUploadId, setLastUploadId] = useState<string | null>(null);

  function handleUploaded(uploadId: string) {
    setLastUploadId(uploadId);
    setView("dashboard");
  }

  return (
    <main className="mx-auto min-h-screen max-w-4xl bg-white px-4 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <nav className="mb-8 flex gap-1 border-b border-slate-300 dark:border-slate-700">
        <TabButton active={view === "upload"} onClick={() => setView("upload")}>
          Upload
        </TabButton>
        <TabButton active={view === "dashboard"} onClick={() => setView("dashboard")}>
          Dashboard
        </TabButton>
      </nav>

      {view === "upload" ? <UploadScreen onUploaded={handleUploaded} /> : <Dashboard preferredUploadId={lastUploadId} />}
    </main>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
        active
          ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100"
          : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}
