import { NavLink } from 'react-router-dom';
import { LayoutGridIcon, GitBranchIcon, BarChart3Icon, FolderGit2Icon, ActivityIcon, SettingsIcon, LayersIcon } from './Icons';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

const items: NavItem[] = [
  { to: '/', label: 'Fleet Grid', icon: <LayoutGridIcon /> },
  { to: '/issues', label: 'Issue Tree', icon: <GitBranchIcon /> },
  { to: '/usage', label: 'Usage View', icon: <BarChart3Icon /> },
  { to: '/projects', label: 'Projects', icon: <FolderGit2Icon /> },
  { to: '/execution-plan', label: 'Execution Plan', icon: <LayersIcon size={20} /> },
  { to: '/lifecycle', label: 'Lifecycle', icon: <ActivityIcon size={20} /> },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon size={20} /> },
];

export function SideNav() {
  return (
    <nav className="w-14 min-w-[56px] bg-dark-surface border-r border-dark-border flex flex-col items-center pt-2 gap-1">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          title={item.label}
          className={({ isActive }) =>
            `w-10 h-10 flex items-center justify-center rounded-md text-lg transition-colors ${
              isActive
                ? 'text-dark-accent bg-dark-accent/10'
                : 'text-dark-muted hover:text-dark-text hover:bg-dark-border/50'
            }`
          }
        >
          {item.icon}
        </NavLink>
      ))}
    </nav>
  );
}
