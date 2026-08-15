import { Routes, Route, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
import { LoadingScreen } from './components/LoadingScreen';
import { authApi } from './services/api';

const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const SetupPage = lazy(() => import('./pages/SetupPage').then(m => ({ default: m.SetupPage })));
const BoardsPage = lazy(() => import('./pages/BoardsPage').then(m => ({ default: m.BoardsPage })));
const BoardPage = lazy(() => import('./pages/BoardPage').then(m => ({ default: m.BoardPage })));
const DraftsPage = lazy(() => import('./pages/DraftsPage').then(m => ({ default: m.DraftsPage })));
const HistoryPage = lazy(() => import('./pages/HistoryPage').then(m => ({ default: m.HistoryPage })));
const ColumnsPage = lazy(() => import('./pages/ColumnsPage').then(m => ({ default: m.ColumnsPage })));
const CompletedPage = lazy(() => import('./pages/CompletedPage').then(m => ({ default: m.CompletedPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const ActivityLogPage = lazy(() => import('./pages/ActivityLogPage').then(m => ({ default: m.ActivityLogPage })));
const AgentActivityPage = lazy(() => import('./pages/AgentActivityPage').then(m => ({ default: m.AgentActivityPage })));
const UserDetailPage = lazy(() => import('./pages/UserDetailPage').then(m => ({ default: m.UserDetailPage })));
const ColumnDetailPage = lazy(() => import('./pages/ColumnDetailPage').then(m => ({ default: m.ColumnDetailPage })));

function HomeRedirect() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((data) => {
        if (cancelled) return;
        if (data.needsSetup) {
          navigate('/setup', { replace: true });
        } else if (data.user) {
          navigate('/boards', { replace: true });
        } else {
          navigate('/login', { replace: true });
        }
      })
      .catch(() => {
        if (!cancelled) navigate('/login', { replace: true });
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  if (!ready) return <LoadingScreen />;
  return null;
}

function App() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/board/:boardId" element={<BoardPage />} />
        <Route path="/board/:boardId/column/:columnId" element={<ColumnDetailPage />} />
        <Route path="/boards" element={<BoardsPage />} />
        <Route path="/drafts" element={<DraftsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/columns" element={<ColumnsPage />} />
        <Route path="/completed" element={<CompletedPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/activities" element={<ActivityLogPage />} />
        <Route path="/activity" element={<ActivityLogPage />} />
        <Route path="/agent-activity" element={<AgentActivityPage />} />
        <Route path="/user/:userId" element={<UserDetailPage />} />
      </Routes>
    </Suspense>
  );
}

export default App;
