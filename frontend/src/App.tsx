import { Routes, Route, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
import { LoadingScreen } from './components/LoadingScreen';
import { AppShell } from './components/AppShell';
import { authApi } from './services/api';

const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const SetupPage = lazy(() => import('./pages/SetupPage').then(m => ({ default: m.SetupPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
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
const OAuthDevicePage = lazy(() => import('./pages/OAuthDevicePage').then(m => ({ default: m.OAuthDevicePage })));
const RunsPage = lazy(() => import('./pages/RunsPage').then(m => ({ default: m.RunsPage })));
const SearchPage = lazy(() => import('./pages/SearchPage').then(m => ({ default: m.SearchPage })));
const TemplateMarketplacePage = lazy(() => import('./pages/TemplateMarketplacePage').then(m => ({ default: m.TemplateMarketplacePage })));
const OnboardingWizardPage = lazy(() => import('./pages/OnboardingWizardPage').then(m => ({ default: m.OnboardingWizardPage })));
const PublicBoardPage = lazy(() => import('./pages/PublicBoardPage').then(m => ({ default: m.PublicBoardPage })));

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
          navigate('/dashboard', { replace: true });
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

interface ShellWrapperProps {
  children: React.ReactNode;
}

function ShellWrapper({ children }: ShellWrapperProps) {
  return <AppShell>{children}</AppShell>;
}

function App() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/board/:boardId" element={<ShellWrapper><BoardPage /></ShellWrapper>} />
        <Route path="/board/:boardId/column/:columnId" element={<ShellWrapper><ColumnDetailPage /></ShellWrapper>} />
        <Route path="/dashboard" element={<ShellWrapper><DashboardPage /></ShellWrapper>} />
        <Route path="/boards" element={<ShellWrapper><BoardsPage /></ShellWrapper>} />
        <Route path="/drafts" element={<ShellWrapper><DraftsPage /></ShellWrapper>} />
        <Route path="/history" element={<ShellWrapper><HistoryPage /></ShellWrapper>} />
        <Route path="/columns" element={<ShellWrapper><ColumnsPage /></ShellWrapper>} />
        <Route path="/completed" element={<ShellWrapper><CompletedPage /></ShellWrapper>} />
        <Route path="/settings" element={<ShellWrapper><SettingsPage /></ShellWrapper>} />
        <Route path="/activities" element={<ShellWrapper><ActivityLogPage /></ShellWrapper>} />
        <Route path="/activity" element={<ShellWrapper><ActivityLogPage /></ShellWrapper>} />
        <Route path="/agent-activity" element={<ShellWrapper><AgentActivityPage /></ShellWrapper>} />
        <Route path="/user/:userId" element={<ShellWrapper><UserDetailPage /></ShellWrapper>} />
        <Route path="/oauth/device" element={<OAuthDevicePage />} />
        <Route path="/runs" element={<ShellWrapper><RunsPage /></ShellWrapper>} />
        <Route path="/search" element={<ShellWrapper><SearchPage /></ShellWrapper>} />
        <Route path="/templates/marketplace" element={<ShellWrapper><TemplateMarketplacePage /></ShellWrapper>} />
        <Route path="/onboarding" element={<ShellWrapper><OnboardingWizardPage /></ShellWrapper>} />
        <Route path="/public/b/:token" element={<PublicBoardPage />} />
      </Routes>
    </Suspense>
  );
}

export default App;
