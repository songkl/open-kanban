import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { BoardPage } from './pages/BoardPage';
import { BoardsPage } from './pages/BoardsPage';
import { DraftsPage } from './pages/DraftsPage';
import { HistoryPage } from './pages/HistoryPage';
import { ColumnsPage } from './pages/ColumnsPage';
import { CompletedPage } from './pages/CompletedPage';
import { SettingsPage } from './pages/SettingsPage';
import { ActivityLogPage } from './pages/ActivityLogPage';
import { AgentActivityPage } from './pages/AgentActivityPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/boards" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/board/:boardId" element={<BoardPage />} />
      <Route path="/boards" element={<BoardsPage />} />
      <Route path="/drafts" element={<DraftsPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/columns" element={<ColumnsPage />} />
      <Route path="/completed" element={<CompletedPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/activities" element={<ActivityLogPage />} />
      <Route path="/agent-activity" element={<AgentActivityPage />} />
    </Routes>
  );
}

export default App;
