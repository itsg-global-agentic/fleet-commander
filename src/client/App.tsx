import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { FleetProvider } from './context/FleetContext';
import { TopBar } from './components/TopBar';
import { SideNav } from './components/SideNav';
import { StatusBar } from './components/StatusBar';
import { TeamDetail } from './components/TeamDetail';
import { FleetGridView } from './views/FleetGridView';
import { IssueTreeView } from './views/IssueTreeView';
import { CostViewPage } from './views/CostViewPage';

export function App() {
  return (
    <BrowserRouter>
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
                <Route path="/costs" element={<CostViewPage />} />
              </Routes>
            </main>
          </div>

          {/* Status bar — fixed 24px */}
          <StatusBar />
        </div>

        {/* Team detail slide-over panel — rendered as overlay outside the main layout */}
        <TeamDetail />
      </FleetProvider>
    </BrowserRouter>
  );
}
