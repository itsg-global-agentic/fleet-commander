import { NavLink } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const items: NavItem[] = [
  { to: '/', label: 'Fleet Grid', icon: '\u229E' },       // ⊞
  { to: '/issues', label: 'Issue Tree', icon: '\uD83C\uDF33' },  // 🌳
  { to: '/costs', label: 'Cost View', icon: '$' },
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
