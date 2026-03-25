import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { FleetProvider } from './context/FleetContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopBar } from './components/TopBar';
import { SideNav } from './components/SideNav';
import { StatusBar } from './components/StatusBar';
import { TeamDetail } from './components/TeamDetail';
import { FleetGridView } from './views/FleetGridView';
import { IssueTreeView } from './views/IssueTreeView';
import { UsageViewPage } from './views/UsageViewPage';
import { ProjectsPage } from './views/ProjectsPage';
import { SettingsPage } from './views/SettingsPage';
import { StateMachinePage } from './views/StateMachinePage';

export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <FleetProvider>
          <div className="h-screen w-screen flex flex-col bg-dark-base text-dark-text overflow-hidden">
            {/* Top bar — fixed 48px */}
            <TopBar />

            {/* Middle section: SideNav + main content */}
            <div className="flex flex-1 min-h-0">
              {/* Side navigation — fixed 56px wide */}
              <SideNav />

              {/* Main content area — fills remaining space */}
              <main className="flex-1 min-w-0 overflow-auto">
                <Routes>
                  <Route path="/" element={<FleetGridView />} />
                  <Route path="/issues" element={<IssueTreeView />} />
                  <Route path="/usage" element={<UsageViewPage />} />
                  <Route path="/projects" element={<ProjectsPage />} />
                  <Route path="/lifecycle" element={<StateMachinePage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Routes>
              </main>
            </div>

            {/* Status bar — fixed 24px */}
            <StatusBar />
          </div>

          {/* Team detail slide-over panel — rendered as overlay outside the main layout */}
          <TeamDetail />
        </FleetProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
